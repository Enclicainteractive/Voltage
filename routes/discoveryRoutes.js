import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { adminService, discoveryService, serverService, userService } from '../services/dataService.js'
import config from '../config/config.js'

const router = express.Router()
const MAX_LIMIT = 100
const MAX_OFFSET = 5000
const MAX_SERVER_ID_LENGTH = 128
const MAX_SUBMISSION_ID_LENGTH = 128
const MAX_DESCRIPTION_LENGTH = 2000
const MAX_CATEGORY_LENGTH = 64
const MAX_SEARCH_LENGTH = 120
const SAFE_ID_PATTERN = /^[A-Za-z0-9:_-]+$/
const SAFE_CATEGORY_PATTERN = /^[A-Za-z0-9_-]+$/

const getUserId = (req) => req.user?.id || req.user?.userId || null

const isConfiguredAdmin = (userId) => {
  if (!userId) return false
  const adminUsers = config.config.security?.adminUsers || []
  const persistedUser = userService.getUser(userId)
  const persistedUsername = persistedUser?.username || null
  return adminUsers.includes(userId) || (persistedUsername && adminUsers.includes(persistedUsername))
}

const isAdminRequest = (req) => {
  const userId = getUserId(req)
  return !!(isConfiguredAdmin(userId) || (userId && adminService.isAdmin(userId)))
}

const isModeratorRequest = (req) => {
  const userId = getUserId(req)
  return !!(isConfiguredAdmin(userId) || (userId && adminService.isModerator(userId)))
}

const requireModerator = (req, res, next) => {
  if (!isModeratorRequest(req)) {
    return res.status(403).json({ error: 'Moderator access required' })
  }
  next()
}

const requireAdmin = (req, res, next) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

const isServerOwner = (serverId, userId) => {
  if (!serverId || !userId) return false
  const server = serverService.getServer(serverId)
  return !!(server && server.ownerId === userId)
}

const canManageDiscoveryServer = (req, serverId) => {
  const userId = getUserId(req)
  return isModeratorRequest(req) || isServerOwner(serverId, userId)
}

const parseBoundedInt = (rawValue, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(max, Math.max(min, parsed))
}

const sanitizeIdentifier = (value, { maxLength = MAX_SERVER_ID_LENGTH } = {}) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) return null
  if (!SAFE_ID_PATTERN.test(trimmed)) return null
  return trimmed
}

const sanitizeCategory = (value) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || trimmed.length > MAX_CATEGORY_LENGTH) return null
  if (!SAFE_CATEGORY_PATTERN.test(trimmed)) return null
  return trimmed
}

const sanitizeSearch = (value) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_SEARCH_LENGTH) return null
  return trimmed
}

const sanitizeOptionalDescription = (value) => {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) return null
  return trimmed
}

/**
 * Return an allow-listed public payload for discovery entries.
 * This prevents accidental exposure of internal identity/audit fields if the
 * storage schema expands in the future.
 */
const toPublicDiscoveryEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return entry
  return {
    id: entry.id || null,
    serverId: entry.serverId || null,
    name: entry.name || '',
    icon: entry.icon || '',
    description: entry.description || '',
    category: entry.category || 'community',
    memberCount: Number.isFinite(Number(entry.memberCount)) ? Number(entry.memberCount) : 0,
    guildTag: entry.guildTag ?? null,
    guildTagPrivate: entry.guildTagPrivate === true,
    approvedAt: entry.approvedAt || null,
    addedAt: entry.addedAt || null
  }
}

const toDiscoveryStatusView = (submission, { includeSubmitter = false } = {}) => {
  if (!submission || typeof submission !== 'object') return null
  const payload = {
    id: submission.id || null,
    serverId: submission.serverId || null,
    name: submission.name || '',
    icon: submission.icon || '',
    description: submission.description || '',
    category: submission.category || 'community',
    memberCount: Number.isFinite(Number(submission.memberCount)) ? Number(submission.memberCount) : 0,
    status: submission.status || 'pending',
    submittedAt: submission.submittedAt || null,
    approvedAt: submission.approvedAt || null,
    rejectedAt: submission.rejectedAt || null
  }
  if (includeSubmitter) {
    payload.submittedBy = submission.submittedBy || null
  }
  return payload
}

router.get('/', async (req, res) => {
  const { limit = 50, offset = 0, category, search } = req.query
  const safeLimit = parseBoundedInt(limit, 50, { min: 1, max: MAX_LIMIT })
  const safeOffset = parseBoundedInt(offset, 0, { min: 0, max: MAX_OFFSET })
  const safeCategory = sanitizeCategory(category)
  const safeSearch = sanitizeSearch(search)

  if (category !== undefined && safeCategory === null) {
    return res.status(400).json({ error: 'Invalid category' })
  }
  if (search !== undefined && safeSearch === null) {
    return res.status(400).json({ error: 'Invalid search query' })
  }

  const result = await discoveryService.getApprovedServers(
    safeLimit,
    safeOffset,
    safeCategory,
    safeSearch
  )

  // Sanitize each server entry; preserve ordering + pagination metadata.
  if (result && Array.isArray(result.servers)) {
    res.json({
      ...result,
      servers: result.servers.map(toPublicDiscoveryEntry)
    })
    return
  }
  res.json(result)
})

router.get('/categories', (req, res) => {
  const categories = discoveryService.getCategories()
  res.json(categories)
})

router.post('/submit', authenticateToken, async (req, res) => {
  const { serverId, description, category } = req.body
  const safeServerId = sanitizeIdentifier(serverId)
  const safeDescription = sanitizeOptionalDescription(description)
  const safeCategory = sanitizeCategory(category)

  if (!safeServerId) {
    return res.status(400).json({ error: 'Server ID is required' })
  }
  if (safeDescription === null) {
    return res.status(400).json({ error: 'Invalid description' })
  }
  if (category !== undefined && safeCategory === null) {
    return res.status(400).json({ error: 'Invalid category' })
  }

  const userId = getUserId(req)
  if (!userId) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  const server = serverService.getServer(safeServerId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!isModeratorRequest(req) && server.ownerId !== userId) {
    return res.status(403).json({ error: 'Only the server owner can submit this server to discovery' })
  }
  
  const result = await discoveryService.submitServer(
    safeServerId,
    safeDescription,
    safeCategory || undefined,
    userId
  )
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  res.status(201).json(toDiscoveryStatusView(result))
})

router.delete('/:serverId', authenticateToken, async (req, res) => {
  const safeServerId = sanitizeIdentifier(req.params.serverId)
  if (!safeServerId) {
    return res.status(400).json({ error: 'Invalid server ID' })
  }
  if (!canManageDiscoveryServer(req, safeServerId)) {
    return res.status(403).json({ error: 'Not authorized to remove this server from discovery' })
  }
  const result = await discoveryService.removeFromDiscovery(safeServerId)
  res.json(result)
})

router.get('/status/:serverId', authenticateToken, (req, res) => {
  const serverId = sanitizeIdentifier(req.params.serverId)
  if (!serverId) {
    return res.status(400).json({ error: 'Invalid server ID' })
  }
  const userId = getUserId(req)
  const isModerator = isModeratorRequest(req)
  const isInDiscovery = discoveryService.isInDiscovery(serverId)
  const submissions = discoveryService.getPendingSubmissions()
  const submission = submissions.find((s) => s.serverId === serverId) || null
  const canViewSubmission = !!submission && (
    isModerator ||
    submission.submittedBy === userId ||
    isServerOwner(serverId, userId)
  )
  
  res.json({
    isInDiscovery,
    submission: canViewSubmission
      ? toDiscoveryStatusView(submission, { includeSubmitter: isModerator })
      : null
  })
})

router.get('/admin/pending', authenticateToken, requireAdmin, (req, res) => {
  const submissions = discoveryService.getPendingSubmissions()
  res.json(submissions.map((submission) => toDiscoveryStatusView(submission, { includeSubmitter: true })))
})

// Get detailed server info for discovery profile
router.get('/server/:serverId', async (req, res) => {
  const serverId = sanitizeIdentifier(req.params.serverId)
  if (!serverId) {
    return res.status(400).json({ error: 'Invalid server ID' })
  }

  const discoveryEntry = discoveryService.getDiscoveryEntry(serverId)
  if (!discoveryEntry) {
    return res.status(404).json({ error: 'Server not found' })
  }

  const server = serverService.getServer(serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  // Return public info only.
  // NOTE: ownerId / submitter identifiers are intentionally omitted —
  // a public discovery profile must not leak who created or submitted
  // the server (PII / targeted-attack vector).
  const publicInfo = {
    id: server.id,
    name: server.name,
    icon: server.icon,
    bannerUrl: server.bannerUrl,
    description: discoveryEntry?.description || server.description || '',
    category: discoveryEntry?.category || 'community',
    memberCount: server.members?.length || 0,
    onlineCount: server.members?.filter(m => m.status === 'online').length || 0,
    // Channel count (public channels only)
    channelCount: server.channels?.length || 0,
    // Roles info (just names, not permissions)
    roleCount: server.roles?.length || 0,
    // Theme color
    themeColor: server.themeColor,
    // Guild tag (only include if not private)
    guildTag: server.guildTagPrivate ? null : (server.guildTag || null),
    guildTagPrivate: server.guildTagPrivate === true
  }

  res.json(publicInfo)
})

router.post('/admin/approve/:submissionId', authenticateToken, requireModerator, async (req, res) => {
  const submissionId = sanitizeIdentifier(req.params.submissionId, { maxLength: MAX_SUBMISSION_ID_LENGTH })
  if (!submissionId) {
    return res.status(400).json({ error: 'Invalid submission ID' })
  }

  const result = await discoveryService.approveSubmission(submissionId)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  res.json(toDiscoveryStatusView(result, { includeSubmitter: isAdminRequest(req) }))
})

router.post('/admin/reject/:submissionId', authenticateToken, requireModerator, async (req, res) => {
  const submissionId = sanitizeIdentifier(req.params.submissionId, { maxLength: MAX_SUBMISSION_ID_LENGTH })
  if (!submissionId) {
    return res.status(400).json({ error: 'Invalid submission ID' })
  }

  const result = await discoveryService.rejectSubmission(submissionId)
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  res.json(result)
})

export default router
