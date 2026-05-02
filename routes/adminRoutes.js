import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { adminService, globalBanService, serverBanService, userService, discoveryService, serverService, channelService, messageService, FILES } from '../services/dataService.js'
import { toSafeUser, toSafeUsers } from '../services/userService.js'
import config from '../config/config.js'
import { getOnlineUsers } from '../services/socketService.js'
import { supportsDirectQuery, directQuery } from '../services/dataService.js'

const SELF_VOLT_FILE = FILES.selfVolts

let cachedServerStart = null
let cachedSelfVolts = null

const loadData = async (file, defaultValue = {}) => {
  if (file === FILES.serverStart) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM server_start LIMIT 1')
      cachedServerStart = rows?.[0] || defaultValue
      return cachedServerStart
    }
  }
  if (file === SELF_VOLT_FILE) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM self_volt')
      cachedSelfVolts = rows?.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })) || defaultValue
      return cachedSelfVolts
    }
  }
  if (file === FILES.servers) {
    return serverService.getAllServers()
  }
  if (file === FILES.users) {
    return userService.getAllUsers()
  }
  if (file === FILES.messages) {
    return messageService.getAllMessages()
  }
  if (file === FILES.dmMessages) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM dm_messages')
      return rows || defaultValue
    }
  }
  if (file === FILES.files) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM files')
      return rows || defaultValue
    }
  }
  return defaultValue
}

const saveData = async (file, data) => {
  if (file === FILES.serverStart) {
    if (supportsDirectQuery()) {
      await directQuery('DELETE FROM server_start')
      const keys = Object.keys(data)
      const values = Object.values(data)
      if (keys.length > 0) {
        await directQuery(`INSERT INTO server_start (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, values)
      }
      cachedServerStart = data
      console.log(`[Admin] Saved server_start`)
      return true
    }
    return false
  }
  if (file === SELF_VOLT_FILE) {
    if (supportsDirectQuery()) {
      await directQuery('DELETE FROM self_volt')
      for (const item of data) {
        await directQuery('INSERT INTO self_volt (id, data) VALUES (?, ?)', [item.id, JSON.stringify(item)])
      }
      cachedSelfVolts = data
      console.log(`[Admin] Saved self_volt`)
      return true
    }
    return false
  }
  return false
}

const router = express.Router()

const toIsoOrNull = (value) => {
  if (!value) return null
  const ts = new Date(value).getTime()
  if (Number.isNaN(ts)) return null
  return new Date(ts).toISOString()
}

const durationToMs = (value, unit) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  const unitMs = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000
  }
  const msPerUnit = unitMs[unit]
  if (!msPerUnit) return null
  return Math.round(n * msPerUnit)
}

const normalizePlatformState = (raw) => {
  if (!raw || typeof raw !== 'object') return {}
  // json_blob tables can come back as { server_start: { ...actualState } }
  if (raw.server_start && typeof raw.server_start === 'object') return raw.server_start
  return raw
}

const getPlatformState = () => normalizePlatformState(cachedServerStart || {})
const getPlatformStateAsync = async () => normalizePlatformState(await loadData(FILES.serverStart, {}))
const savePlatformState = async (state) => await saveData(FILES.serverStart, normalizePlatformState(state))
const getMaintenanceWindow = () => getPlatformState()?.maintenanceWindow || null

const computeMaintenanceStatus = (windowData) => {
  if (!windowData || !windowData.enabled) {
    return { enabled: false, active: false, scheduled: false, status: 'inactive', window: null }
  }
  const now = Date.now()
  const startAtMs = new Date(windowData.startAt || windowData.createdAt || Date.now()).getTime()
  const endAtMs = windowData.endAt ? new Date(windowData.endAt).getTime() : null

  if (endAtMs && now >= endAtMs) {
    return { enabled: false, active: false, scheduled: false, status: 'ended', window: windowData }
  }
  if (startAtMs > now) {
    return { enabled: true, active: false, scheduled: true, status: 'scheduled', window: windowData }
  }
  return { enabled: true, active: true, scheduled: false, status: 'active', window: windowData }
}

const isTruthy = (value) => value === true || value === 1 || value === '1' || value === 'true'

const isExternalImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value))

const getAvatarUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ROLE_LEVEL = Object.freeze({
  user: 0,
  moderator: 1,
  admin: 2,
  owner: 3
})
const ASSIGNABLE_ROLES = new Set(['user', 'moderator', 'admin', 'owner'])
const BAN_TYPE_ALLOWLIST = new Set(['permanent', 'temporary'])

const normalizeText = (value) => typeof value === 'string' ? value.trim() : ''
const normalizeRole = (value) => normalizeText(value).toLowerCase()

const isSafeId = (value) => {
  const normalized = normalizeText(value)
  if (!normalized || normalized.length > 160) return false
  if (RESERVED_OBJECT_KEYS.has(normalized)) return false
  return /^[a-zA-Z0-9_.:@-]+$/.test(normalized)
}

const parseBoundedInt = (value, fallback, { min = 0, max = 500 } = {}) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < min) return min
  if (parsed > max) return max
  return parsed
}

const getConfiguredAdminEntries = () => {
  return (config.config.security?.adminUsers || [])
    .map(entry => normalizeText(entry))
    .filter(Boolean)
}

const isConfiguredAdminUser = (userId) => {
  const entries = getConfiguredAdminEntries()
  if (entries.length === 0) return false

  const normalizedId = normalizeText(userId)
  const lowerEntries = new Set(entries.map(entry => entry.toLowerCase()))

  if (normalizedId && (entries.includes(normalizedId) || lowerEntries.has(normalizedId.toLowerCase()))) {
    return true
  }
  return false
}

const getTrustedPrivilege = (userId, cachedUser = null) => {
  const normalizedUserId = normalizeText(userId)
  const persistedUser = cachedUser || (normalizedUserId ? userService.getUser(normalizedUserId) : null)

  if (isConfiguredAdminUser(normalizedUserId)) {
    return { user: persistedUser, role: 'owner', level: ROLE_LEVEL.owner, configuredAdmin: true }
  }

  const persistedRole = normalizeRole(persistedUser?.adminRole || persistedUser?.role)
  if (Object.prototype.hasOwnProperty.call(ROLE_LEVEL, persistedRole)) {
    return { user: persistedUser, role: persistedRole, level: ROLE_LEVEL[persistedRole], configuredAdmin: false }
  }

  if (normalizedUserId && adminService.isAdmin(normalizedUserId)) {
    return { user: persistedUser, role: 'admin', level: ROLE_LEVEL.admin, configuredAdmin: false }
  }

  if (normalizedUserId && adminService.isModerator(normalizedUserId)) {
    return { user: persistedUser, role: 'moderator', level: ROLE_LEVEL.moderator, configuredAdmin: false }
  }

  return { user: persistedUser, role: 'user', level: ROLE_LEVEL.user, configuredAdmin: false }
}

const readSafeRouteId = (req, res, paramName, label) => {
  const value = normalizeText(req.params?.[paramName])
  if (!isSafeId(value)) {
    res.status(400).json({ error: `Invalid ${label}` })
    return null
  }
  return value
}

const getTargetUserContext = (req, res, {
  minActorLevel = ROLE_LEVEL.moderator,
  allowSelfTarget = false,
  requireExistingTarget = true,
  actionLabel = 'perform this action'
} = {}) => {
  const actorId = normalizeText(req.user?.id || req.user?.userId)
  if (!isSafeId(actorId)) {
    res.status(403).json({ error: 'Invalid authenticated user context' })
    return null
  }

  const targetId = readSafeRouteId(req, res, 'userId', 'user id')
  if (!targetId) return null

  if (!allowSelfTarget && actorId === targetId) {
    res.status(403).json({ error: `You cannot ${actionLabel} on your own account` })
    return null
  }

  const actorPrivilege = getTrustedPrivilege(actorId)
  if (actorPrivilege.level < minActorLevel) {
    res.status(403).json({ error: 'Insufficient privilege level for this action' })
    return null
  }

  const targetUser = userService.getUser(targetId)
  if (requireExistingTarget && !targetUser) {
    res.status(404).json({ error: 'User not found' })
    return null
  }

  const targetPrivilege = getTrustedPrivilege(targetId, targetUser)
  if (actorId !== targetId && actorPrivilege.level <= targetPrivilege.level) {
    res.status(403).json({ error: 'Insufficient privilege to manage this account' })
    return null
  }

  return { actorId, targetId, actorPrivilege, targetPrivilege, targetUser }
}

const buildMemberSnapshot = (serverId, member = {}) => {
  const profile = member?.id ? userService.getUser(member.id) : null
  const username = member.username || profile?.username || profile?.displayName || profile?.email || member.id || 'Unknown user'
  const avatar = member.avatar || member.imageUrl || member.avatarUrl || profile?.avatar
  const resolvedAvatar = isExternalImage(avatar) ? avatar : getAvatarUrl(member.id)
  const roles = Array.isArray(member.roles)
    ? member.roles
    : (member.role ? [member.role] : [])

  return {
    id: member.id,
    username,
    displayName: profile?.displayName || null,
    avatar: resolvedAvatar,
    status: member.status || profile?.status || 'offline',
    joinedAt: member.joinedAt || null,
    roles,
    role: member.role || roles[0] || null,
    isBot: isTruthy(member.isBot),
    host: member.host || profile?.host || null,
    guildTag: profile?.guildTag || null
  }
}

const collectMessageEntries = (value, bucket, depth = 0) => {
  if (!value || depth > 4) return
  if (Array.isArray(value)) {
    value.forEach(item => collectMessageEntries(item, bucket, depth + 1))
    return
  }
  if (typeof value !== 'object') return
  if ((value.channelId || value.id) && Object.prototype.hasOwnProperty.call(value, 'content')) {
    bucket.push(value)
    return
  }
  Object.values(value).forEach(item => collectMessageEntries(item, bucket, depth + 1))
}

const getAllMessageEntries = async () => {
  const rawMessages = await loadData(FILES.messages, {})
  const bucket = []
  collectMessageEntries(rawMessages, bucket)
  return bucket
}

const buildServerMetrics = async () => {
  const serversData = await loadData(FILES.servers, {})
  const servers = Array.isArray(serversData) ? serversData : Object.values(serversData || {})
  const channelsByServer = channelService.getAllChannelsGrouped()
  const messageEntries = await getAllMessageEntries()
  const channelToServerId = {}

  for (const [serverId, channels] of Object.entries(channelsByServer || {})) {
    for (const channel of channels || []) {
      if (channel?.id) channelToServerId[channel.id] = serverId
    }
  }

  const serverMessageStats = {}
  const channelMessageStats = {}
  const now = Date.now()
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000)

  for (const server of servers) {
    const serverChannels = channelsByServer[server.id] || []
    serverMessageStats[server.id] = {
      totalMessages: 0,
      recentMessages7d: 0,
      lastMessageAt: null,
      channelCount: serverChannels.length
    }
  }

  for (const message of messageEntries) {
    const channelId = message?.channelId
    if (!channelId) continue
    channelMessageStats[channelId] = channelMessageStats[channelId] || { count: 0, lastMessageAt: null }
    channelMessageStats[channelId].count += 1
    const stamp = message.createdAt || message.timestamp || message.updatedAt || null
    if (stamp && (!channelMessageStats[channelId].lastMessageAt || new Date(stamp) > new Date(channelMessageStats[channelId].lastMessageAt))) {
      channelMessageStats[channelId].lastMessageAt = stamp
    }
    const serverId = channelToServerId[channelId]
    if (!serverId || !serverMessageStats[serverId]) continue
    serverMessageStats[serverId].totalMessages += 1
    if (stamp) {
      const ts = new Date(stamp).getTime()
      if (!Number.isNaN(ts)) {
        if (ts >= sevenDaysAgo) {
          serverMessageStats[serverId].recentMessages7d += 1
        }
        if (!serverMessageStats[serverId].lastMessageAt || ts > new Date(serverMessageStats[serverId].lastMessageAt).getTime()) {
          serverMessageStats[serverId].lastMessageAt = stamp
        }
      }
    }
  }

  return { servers, channelsByServer, channelMessageStats, serverMessageStats }
}

const requireAdmin = (req, res, next) => {
  const userId = normalizeText(req.user?.id || req.user?.userId)
  const privilege = getTrustedPrivilege(userId)
  if (privilege.level < ROLE_LEVEL.admin) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

const requireModerator = (req, res, next) => {
  const userId = normalizeText(req.user?.id || req.user?.userId)
  const privilege = getTrustedPrivilege(userId)
  if (privilege.level < ROLE_LEVEL.moderator) {
    return res.status(403).json({ error: 'Moderator access required' })
  }
  next()
}

router.get('/stats', authenticateToken, requireModerator, (req, res) => {
  const stats = adminService.getStats()
  res.json(stats)
})

router.get('/stats/online-users', authenticateToken, requireModerator, (req, res) => {
  const onlineUsers = getOnlineUsers().length
  res.json({
    onlineCount: onlineUsers,
    timestamp: new Date().toISOString()
  })
})

router.get('/online-users', authenticateToken, requireModerator, (req, res) => {
  res.json(getOnlineUsers())
})

router.get('/users', authenticateToken, requireModerator, (req, res) => {
  const { search, role, limit = 50, offset = 0 } = req.query
  let users = adminService.getAllUsers()
  const safeLimit = parseBoundedInt(limit, 50, { min: 1, max: 250 })
  const safeOffset = parseBoundedInt(offset, 0, { min: 0, max: 5000 })
  
  if (search) {
    const searchLower = String(search).toLowerCase()
    users = users.filter(u => 
      u.username?.toLowerCase().includes(searchLower) ||
      u.email?.toLowerCase().includes(searchLower)
    )
  }
  
  if (role) {
    const normalizedRole = normalizeRole(role)
    if (!ASSIGNABLE_ROLES.has(normalizedRole)) {
      return res.status(400).json({ error: 'Invalid role filter' })
    }
    users = users.filter(u => normalizeRole(u.adminRole || u.role || 'user') === normalizedRole)
  }
  
  const total = users.length
  users = toSafeUsers(users.slice(safeOffset, safeOffset + safeLimit))
  
  res.json({ users, total })
})

router.get('/users/:userId', authenticateToken, requireModerator, (req, res) => {
  const targetUserId = readSafeRouteId(req, res, 'userId', 'user id')
  if (!targetUserId) return

  const user = userService.getUser(targetUserId)
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }
  
  const isBanned = globalBanService.isBanned(targetUserId)
  const adminRole = adminService.getUserRole(targetUserId)
  
  res.json({ ...toSafeUser(user), isBanned, adminRole })
})

router.put('/users/:userId/role', authenticateToken, requireAdmin, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.admin,
    actionLabel: 'change roles',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  const desiredRole = normalizeRole(req.body?.role)
  if (!ASSIGNABLE_ROLES.has(desiredRole)) {
    return res.status(400).json({ error: 'Invalid role value' })
  }

  if ((desiredRole === 'owner' || desiredRole === 'admin') && context.actorPrivilege.level < ROLE_LEVEL.owner) {
    return res.status(403).json({ error: 'Only owner-level staff can assign admin/owner roles' })
  }

  const user = await adminService.setUserRole(context.targetId, desiredRole)
  
  await adminService.logAction(context.actorId, 'set_role', context.targetId, { role: desiredRole })
  
  res.json(toSafeUser(user))
})

router.post('/users/:userId/ban', authenticateToken, requireModerator, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.moderator,
    actionLabel: 'ban this user',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  const reason = normalizeText(req.body?.reason)
  const requestedBanType = normalizeRole(req.body?.banType)
  const normalizedBanType = BAN_TYPE_ALLOWLIST.has(requestedBanType) ? requestedBanType : 'permanent'
  
  if (globalBanService.isBanned(context.targetId)) {
    return res.status(400).json({ error: 'User already banned' })
  }
  
  const ban = await globalBanService.banUser(context.targetId, {
    reason: reason || null,
    bannedBy: context.actorId,
    banType: normalizedBanType
  })
  
  await adminService.logAction(context.actorId, 'ban_user', context.targetId, {
    reason: reason || null,
    banType: normalizedBanType
  })
  
  res.json(ban)
})

router.delete('/users/:userId/ban', authenticateToken, requireModerator, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.moderator,
    actionLabel: 'unban this user',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  if (!globalBanService.isBanned(context.targetId)) {
    return res.status(400).json({ error: 'User not banned' })
  }
  
  await globalBanService.unbanUser(context.targetId)
  
  await adminService.logAction(context.actorId, 'unban_user', context.targetId, {})
  
  res.json({ success: true })
})

router.post('/users/:userId/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.admin,
    actionLabel: 'reset password',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  const result = await adminService.resetUserPassword(context.targetId)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  await adminService.logAction(context.actorId, 'reset_password', context.targetId, {})
  
  res.json(result)
})

router.delete('/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.admin,
    actionLabel: 'delete this user',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  const result = await adminService.deleteUser(context.targetId)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  await adminService.logAction(context.actorId, 'delete_user', context.targetId, {})
  
  res.json(result)
})

// Age Verification Management
router.post('/users/:userId/age-verify', authenticateToken, requireModerator, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.moderator,
    actionLabel: 'verify age',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  const { category, method, age, birthYear, expiresInDays } = req.body
  const existingUser = context.targetUser
  
  const verification = {
    verified: true,
    method: method || 'admin_manual',
    category: category || 'adult',
    birthYear: birthYear || null,
    age: age || null,
    estimatedAge: age || null,
    verifiedAt: new Date().toISOString(),
    expiresAt: category === 'adult' ? null : 
      (expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null),
    device: 'admin_panel',
    source: 'admin_manual',
    jurisdictionCode: existingUser?.ageVerificationJurisdiction || existingUser?.ageVerification?.jurisdictionCode
  }
  
  const user = await userService.setAgeVerification(context.targetId, verification)
  
  await adminService.logAction(context.actorId, 'age_verify', context.targetId, { category, method })
  
  res.json(toSafeUser(user))
})

router.delete('/users/:userId/age-verification', authenticateToken, requireModerator, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.moderator,
    actionLabel: 'remove age verification',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  await userService.updateProfile(context.targetId, {
    ageVerification: null,
    ageVerificationJurisdiction: null
  })

  await adminService.logAction(context.actorId, 'remove_age_verify', context.targetId, {})

  res.json({ success: true })
})

// User Status Management
router.put('/users/:userId/status', authenticateToken, requireModerator, async (req, res) => {
  const context = getTargetUserContext(req, res, {
    minActorLevel: ROLE_LEVEL.moderator,
    actionLabel: 'change status',
    allowSelfTarget: false,
    requireExistingTarget: true
  })
  if (!context) return

  const { status, customStatus } = req.body
  const normalizedStatus = normalizeText(status)
  
  if (!normalizedStatus || normalizedStatus.length > 50) {
    return res.status(400).json({ error: 'Invalid status value' })
  }

  const user = await userService.setStatus(context.targetId, normalizedStatus, customStatus)
  
  await adminService.logAction(context.actorId, 'set_status', context.targetId, { status: normalizedStatus, customStatus })
  
  res.json(toSafeUser(user))
})

router.get('/servers', authenticateToken, requireModerator, async (req, res) => {
  const { search, limit = 50, offset = 0 } = req.query
  const { servers, serverMessageStats } = await buildServerMetrics()
  const safeLimit = parseBoundedInt(limit, 50, { min: 1, max: 250 })
  const safeOffset = parseBoundedInt(offset, 0, { min: 0, max: 5000 })
  
  let filtered = servers
  
  if (search) {
    const searchLower = String(search).toLowerCase()
    filtered = filtered.filter(s => s.name.toLowerCase().includes(searchLower))
  }
  
  const total = filtered.length
  filtered = filtered.slice(safeOffset, safeOffset + safeLimit)
  
  const serversWithBanned = filtered.map(s => ({
    ...s,
    isBanned: serverBanService.isServerBanned(s.id),
    memberCount: s.members?.length || 0,
    joined: (s.members || []).some(member => member?.id === req.user.id),
    owner: (() => {
      const owner = userService.getUser(s.ownerId)
      return owner ? {
        id: owner.id,
        username: owner.username || owner.displayName || owner.email || s.ownerId,
        avatar: owner.avatar || getAvatarUrl(owner.id)
      } : {
        id: s.ownerId,
        username: s.ownerId,
        avatar: getAvatarUrl(s.ownerId)
      }
    })(),
    metrics: serverMessageStats[s.id] || {
      totalMessages: 0,
      recentMessages7d: 0,
      lastMessageAt: null,
      channelCount: 0
    }
  }))
  
  res.json({ servers: serversWithBanned, total })
})

router.get('/servers/:serverId', authenticateToken, requireModerator, async (req, res) => {
  const serverId = readSafeRouteId(req, res, 'serverId', 'server id')
  if (!serverId) return

  const { servers, channelsByServer, channelMessageStats, serverMessageStats } = await buildServerMetrics()
  const server = servers.find(item => item.id === serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  const owner = userService.getUser(server.ownerId)
  const members = Array.isArray(server.members)
    ? server.members.map(member => buildMemberSnapshot(server.id, member))
    : []
  const channels = (channelsByServer[server.id] || []).map(channel => {
    const stats = channelMessageStats[channel.id] || { count: 0, lastMessageAt: null }
    return {
      ...channel,
      messageCount: stats.count,
      lastMessageAt: stats.lastMessageAt
    }
  }).sort((a, b) => {
    const aPos = Number.isFinite(Number(a.position)) ? Number(a.position) : 999999
    const bPos = Number.isFinite(Number(b.position)) ? Number(b.position) : 999999
    return aPos - bPos
  })

  res.json({
    ...server,
    isBanned: serverBanService.isServerBanned(server.id),
    joined: members.some(member => member.id === req.user.id),
    owner: owner ? {
      id: owner.id,
      username: owner.username || owner.displayName || owner.email || server.ownerId,
      avatar: owner.avatar || getAvatarUrl(owner.id)
    } : {
      id: server.ownerId,
      username: server.ownerId,
      avatar: getAvatarUrl(server.ownerId)
    },
    metrics: serverMessageStats[server.id] || {
      totalMessages: 0,
      recentMessages7d: 0,
      lastMessageAt: null,
      channelCount: channels.length
    },
    members,
    channels
  })
})

router.post('/servers/:serverId/join', authenticateToken, requireModerator, async (req, res) => {
  const serverId = readSafeRouteId(req, res, 'serverId', 'server id')
  if (!serverId) return

  const server = serverService.getServer(serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  server.members = Array.isArray(server.members) ? server.members : []
  const existingMember = server.members.find(member => member?.id === req.user.id)
  if (existingMember) {
    return res.status(400).json({ error: 'Already a member' })
  }

  const memberEntry = {
    id: req.user.id,
    username: req.user.username || req.user.email || req.user.id,
    imageUrl: req.user?.imageUrl || req.user?.imageurl || req.user?.avatarUrl || req.user?.avatarURL || (isExternalImage(req.user?.avatar) ? req.user.avatar : null),
    avatar: isExternalImage(req.user?.avatar) ? req.user.avatar : getAvatarUrl(req.user.id),
    host: req.user.host || config.getHost(),
    avatarHost: config.getImageServerUrl(),
    roles: ['member'],
    role: 'member',
    status: 'online',
    joinedAt: new Date().toISOString()
  }

  server.members.push(memberEntry)
  const updated = await serverService.updateServer(server.id, { members: server.members })
  await adminService.logAction(req.user.id, 'join_server_admin', serverId, { serverName: server.name })

  res.json({
    success: true,
    server: {
      id: updated?.id || server.id,
      name: updated?.name || server.name
    },
    member: buildMemberSnapshot(server.id, memberEntry)
  })
})

router.post('/servers/:serverId/ban', authenticateToken, requireModerator, async (req, res) => {
  const serverId = readSafeRouteId(req, res, 'serverId', 'server id')
  if (!serverId) return
  const { reason } = req.body

  const server = serverService.getServer(serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (serverBanService.isServerBanned(serverId)) {
    return res.status(400).json({ error: 'Server already banned' })
  }
  
  const result = await serverBanService.banServer(serverId, normalizeText(reason) || null, req.user.id)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  await adminService.logAction(req.user.id, 'ban_server', serverId, { reason: normalizeText(reason) || null })
  
  res.json(result)
})

router.delete('/servers/:serverId/ban', authenticateToken, requireModerator, async (req, res) => {
  const serverId = readSafeRouteId(req, res, 'serverId', 'server id')
  if (!serverId) return

  if (!serverBanService.isServerBanned(serverId)) {
    return res.status(400).json({ error: 'Server not banned' })
  }
  
  await serverBanService.unbanServer(serverId)
  
  await adminService.logAction(req.user.id, 'unban_server', serverId, {})
  
  res.json({ success: true })
})

router.get('/banned-users', authenticateToken, requireModerator, (req, res) => {
  const bans = globalBanService.getAllBans()
  res.json(bans)
})

router.get('/banned-servers', authenticateToken, requireModerator, (req, res) => {
  const bans = serverBanService.getAllServerBans()
  res.json(bans)
})

router.get('/logs', authenticateToken, requireModerator, (req, res) => {
  const { limit = 100 } = req.query
  const safeLimit = parseBoundedInt(limit, 100, { min: 1, max: 500 })
  const logs = adminService.getLogs(safeLimit)
  res.json(logs)
})

router.get('/my-role', authenticateToken, (req, res) => {
  const isAdmin = adminService.isAdmin(req.user.id)
  const isModerator = adminService.isModerator(req.user.id)

  // For non-privileged users, do NOT echo back any admin-side metadata
  // (role names, moderator flags, role-permission lists). They simply learn
  // they are not staff. This prevents the endpoint from being used to
  // enumerate admin role identifiers / structures.
  if (!isAdmin && !isModerator) {
    return res.json({ role: null, isAdmin: false })
  }

  const role = adminService.getUserRole(req.user.id)
  res.json({ role, isAdmin, isModerator })
})

router.get('/maintenance', authenticateToken, requireModerator, async (req, res) => {
  const windowData = getMaintenanceWindow()
  const status = computeMaintenanceStatus(windowData)
  
  const discoveryData = await discoveryService.getApprovedServers(1000, 0)
  const pendingData = discoveryService.getPendingSubmissions()
  
  res.json({
    ...status,
    discovery: {
      approvedServers: discoveryData.total,
      pendingSubmissions: pendingData.length
    }
  })
})

router.put('/maintenance', authenticateToken, requireModerator, async (req, res) => {
  const {
    title,
    message,
    severity = 'warning',
    startAt,
    endAt,
    durationValue,
    durationUnit
  } = req.body || {}

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' })
  }

  const normalizedTitle = typeof title === 'string' && title.trim().length > 0
    ? title.trim().slice(0, 120)
    : 'Scheduled maintenance'
  const normalizedMessage = message.trim().slice(0, 1000)
  const normalizedSeverity = ['info', 'warning', 'critical'].includes(severity) ? severity : 'warning'
  const normalizedStartAt = toIsoOrNull(startAt) || new Date().toISOString()
  const explicitEndAt = toIsoOrNull(endAt)
  const durationMs = durationToMs(durationValue, durationUnit)
  const computedEndAt = explicitEndAt || (durationMs ? new Date(new Date(normalizedStartAt).getTime() + durationMs).toISOString() : null)

  const payload = {
    id: `mw_${Date.now()}`,
    enabled: true,
    title: normalizedTitle,
    message: normalizedMessage,
    severity: normalizedSeverity,
    startAt: normalizedStartAt,
    endAt: computedEndAt,
    durationValue: Number(durationValue) || null,
    durationUnit: durationUnit || null,
    durationMs: durationMs || null,
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  const platformState = await getPlatformStateAsync()
  await savePlatformState({
    ...platformState,
    maintenanceWindow: payload
  })
  adminService.logAction(req.user.id, 'set_maintenance_window', 'platform', {
    title: payload.title,
    startAt: payload.startAt,
    endAt: payload.endAt
  })
  res.json(computeMaintenanceStatus(payload))
})

router.delete('/maintenance', authenticateToken, requireModerator, async (req, res) => {
  const existing = getMaintenanceWindow()
  if (existing) {
    adminService.logAction(req.user.id, 'clear_maintenance_window', 'platform', {
      previousId: existing.id || null
    })
  }
  const platformState = await getPlatformStateAsync()
  await savePlatformState({
    ...platformState,
    maintenanceWindow: null
  })
  res.json({ success: true })
})

// Discovery Management
router.get('/discovery/pending', authenticateToken, requireModerator, (req, res) => {
  const submissions = discoveryService.getPendingSubmissions()
  res.json(submissions)
})

router.get('/discovery/approved', authenticateToken, requireModerator, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query
  const safeLimit = parseBoundedInt(limit, 50, { min: 1, max: 250 })
  const safeOffset = parseBoundedInt(offset, 0, { min: 0, max: 5000 })
  const result = await discoveryService.getApprovedServers(safeLimit, safeOffset)
  res.json(result)
})

router.post('/discovery/approve/:submissionId', authenticateToken, requireModerator, (req, res) => {
  const submissionId = readSafeRouteId(req, res, 'submissionId', 'submission id')
  if (!submissionId) return
  const result = discoveryService.approveSubmission(submissionId)
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  adminService.logAction(req.user.id, 'approve_discovery', submissionId, { serverName: result.name })
  res.json(result)
})

router.post('/discovery/reject/:submissionId', authenticateToken, requireModerator, (req, res) => {
  const submissionId = readSafeRouteId(req, res, 'submissionId', 'submission id')
  if (!submissionId) return
  const result = discoveryService.rejectSubmission(submissionId)
  adminService.logAction(req.user.id, 'reject_discovery', submissionId, {})
  res.json(result)
})

router.delete('/discovery/remove/:serverId', authenticateToken, requireModerator, (req, res) => {
  const serverId = readSafeRouteId(req, res, 'serverId', 'server id')
  if (!serverId) return
  const result = discoveryService.removeFromDiscovery(serverId)
  adminService.logAction(req.user.id, 'remove_discovery', serverId, {})
  res.json(result)
})

// Self-Volt / Platform Analytics
router.get('/platform/health', authenticateToken, requireModerator, async (req, res) => {
  const stats = adminService.getStats()
  
  // Get uptime info
  const platformState = await getPlatformStateAsync()
  const parsedStart = new Date(platformState.startTime || '').getTime()
  const fallbackStart = Date.now() - Math.round(process.uptime() * 1000)
  const startMs = Number.isFinite(parsedStart) ? parsedStart : fallbackStart
  const startTimeIso = new Date(startMs).toISOString()
  const uptimeMs = Math.max(0, Date.now() - startMs)
  const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60))
  const uptimeDays = Math.floor(uptimeHours / 24)
  
  // Get discovery stats
  const discoveryData = discoveryService.getSubmissions()
  
  // Get file storage usage
  const filesData = await loadData(FILES.files, {})
  
  res.json({
    uptime: {
      startTime: startTimeIso,
      uptimeMs,
      uptimeHours,
      uptimeDays,
      formatted: `${uptimeDays}d ${uptimeHours % 24}h`
    },
    stats,
    discovery: {
      pendingSubmissions: discoveryData.submissions?.length || 0,
      approvedServers: discoveryData.approved?.length || 0
    },
    storage: {
      totalFiles: Object.keys(filesData).length
    }
  })
})

router.get('/platform/activity', authenticateToken, requireModerator, async (req, res) => {
  // Get recent activity stats
  const messages = await loadData(FILES.messages, {})
  const dmMessages = await loadData(FILES.dmMessages, {})
  
  let totalMessages = 0
  let totalDMMessages = 0
  
  Object.values(messages || {}).forEach((entry) => {
    if (Array.isArray(entry)) {
      totalMessages += entry.length
    } else if (entry && typeof entry === 'object') {
      totalMessages += 1
    }
  })
  
  Object.values(dmMessages || {}).forEach((entry) => {
    if (Array.isArray(entry)) {
      totalDMMessages += entry.length
    } else if (entry && typeof entry === 'object') {
      totalDMMessages += 1
    }
  })
  
  const serversData = await loadData(FILES.servers, {})
  const servers = Array.isArray(serversData) ? serversData : Object.values(serversData || {})
  const users = await loadData(FILES.users, {})
  
  res.json({
    totalMessages,
    totalDMMessages,
    totalServers: servers.length,
    totalUsers: Object.keys(users).length,
    averageMembersPerServer: servers.length > 0 ? 
      Math.round(servers.reduce((acc, s) => acc + (s.members?.length || 0), 0) / servers.length) : 0
  })
})

// Save server start time on load
const initialPlatformState = await getPlatformStateAsync()
if (!initialPlatformState?.startTime) {
  await saveData(FILES.serverStart, {
    ...initialPlatformState,
    startTime: new Date().toISOString()
  })
}

// Self-Volt Management

router.get('/self-volts', authenticateToken, requireModerator, async (req, res) => {
  const selfVolts = await loadData(SELF_VOLT_FILE, [])
  res.json(selfVolts)
})

router.get('/self-volts/:voltId', authenticateToken, requireModerator, async (req, res) => {
  const voltId = readSafeRouteId(req, res, 'voltId', 'self-volt id')
  if (!voltId) return
  const selfVolts = await loadData(SELF_VOLT_FILE, [])
  const volt = selfVolts.find(v => v.id === voltId)
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt not found' })
  }
  res.json(volt)
})

router.delete('/self-volts/:voltId', authenticateToken, requireModerator, async (req, res) => {
  const voltId = readSafeRouteId(req, res, 'voltId', 'self-volt id')
  if (!voltId) return
  let selfVolts = await loadData(SELF_VOLT_FILE, [])
  const beforeCount = selfVolts.length
  selfVolts = selfVolts.filter(v => v.id !== voltId)
  if (selfVolts.length === beforeCount) {
    return res.status(404).json({ error: 'Self-Volt not found' })
  }
  await saveData(SELF_VOLT_FILE, selfVolts)
  
  adminService.logAction(req.user.id, 'delete_self_volt', voltId, {})
  res.json({ success: true })
})

router.post('/self-volts/:voltId/test', authenticateToken, requireModerator, async (req, res) => {
  const voltId = readSafeRouteId(req, res, 'voltId', 'self-volt id')
  if (!voltId) return

  const selfVolts = await loadData(SELF_VOLT_FILE, [])
  const volt = selfVolts.find(v => v.id === voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt not found' })
  }

  let targetUrl = null
  try {
    targetUrl = new URL(`${volt.url || ''}`)
  } catch {
    return res.status(400).json({ error: 'Self-Volt URL is invalid' })
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: 'Self-Volt URL protocol must be http or https' })
  }

  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost'])
  const hostLower = targetUrl.hostname.toLowerCase()
  if (loopbackHosts.has(hostLower) || hostLower.endsWith('.local')) {
    return res.status(400).json({ error: 'Loopback and local network hosts are not allowed for probe tests' })
  }
  
  try {
    const response = await fetch(`${targetUrl.toString().replace(/\/+$/, '')}/api/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000)
    })
    
    if (response.ok) {
      const data = await response.json()
      res.json({ status: 'online', data })
    } else {
      res.json({ status: 'error', error: `HTTP ${response.status}` })
    }
  } catch (err) {
    res.json({ status: 'offline', error: err.message })
  }
})

export default router
