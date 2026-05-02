import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { userService, dmService, serverService } from '../services/dataService.js'

const router = express.Router()
const DEFAULT_SETTINGS = { serverMutes: [], dmMutes: [] }
const MAX_MUTE_DURATION_MS = 365 * 24 * 60 * 60 * 1000
const MAX_MUTES_PER_TYPE = 500

const normalizeEntityId = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized) return null
  return normalized.slice(0, 200)
}

const toIsoTimestamp = (value) => {
  if (!value) return null
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString()
}

const sanitizeMuteEntries = (entries, key) => {
  if (!Array.isArray(entries)) return []
  const now = Date.now()
  const deduped = new Map()

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const entityId = normalizeEntityId(entry[key])
    if (!entityId) continue

    const mutedAt = toIsoTimestamp(entry.mutedAt) || new Date(now).toISOString()
    const expiresAt = toIsoTimestamp(entry.expiresAt)
    if (expiresAt && new Date(expiresAt).getTime() <= now) continue

    const safeEntry = {
      [key]: entityId,
      mutedAt
    }
    if (expiresAt) safeEntry.expiresAt = expiresAt
    deduped.set(entityId, safeEntry)
    if (deduped.size >= MAX_MUTES_PER_TYPE) break
  }

  return Array.from(deduped.values())
}

const normalizeSettings = (raw = DEFAULT_SETTINGS) => ({
  serverMutes: sanitizeMuteEntries(raw?.serverMutes, 'serverId'),
  dmMutes: sanitizeMuteEntries(raw?.dmMutes, 'conversationId')
})

const parseMutedFlag = (muted) => {
  if (muted === undefined) return true
  if (muted === true || muted === false) return muted
  if (muted === 'true') return true
  if (muted === 'false') return false
  return null
}

const parseDurationMs = (duration) => {
  if (duration === undefined || duration === null || duration === '') {
    return { value: null }
  }

  const parsed = Number(duration)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: 'Invalid duration' }
  }

  return { value: Math.min(Math.floor(parsed), MAX_MUTE_DURATION_MS) }
}

const isServerMember = (server, userId) => {
  if (!server) return false
  if (server.ownerId === userId) return true
  if (!Array.isArray(server.members)) return false
  return server.members.some(member => {
    if (typeof member === 'string') return member === userId
    return member?.id === userId
  })
}

const hasServerAccess = (userId, serverId) => {
  const server = serverService.getServer(serverId)
  return isServerMember(server, userId)
}

const hasConversationAccess = (userId, conversationId) => {
  return !!dmService.getConversationForUser(userId, conversationId)
}

const pruneInaccessibleMutes = (userId, settings) => ({
  serverMutes: settings.serverMutes.filter(mute => hasServerAccess(userId, mute.serverId)),
  dmMutes: settings.dmMutes.filter(mute => hasConversationAccess(userId, mute.conversationId))
})

const settingsChanged = (a, b) => JSON.stringify(a) !== JSON.stringify(b)

const persistNotificationSettings = async (userId, settings) => {
  const normalized = normalizeSettings(settings)
  if (typeof userService.updateProfile === 'function') {
    await userService.updateProfile(userId, { notificationSettings: normalized })
    return
  }
  if (typeof userService.saveUser === 'function') {
    await userService.saveUser(userId, { notificationSettings: normalized })
    return
  }
  throw new Error('No supported user update method')
}

const loadScopedSettings = async (userId) => {
  const user = await userService.getUser(userId)
  const normalized = normalizeSettings(user?.notificationSettings)
  const scoped = pruneInaccessibleMutes(userId, normalized)
  return {
    settings: scoped,
    shouldPersist: settingsChanged(normalized, scoped)
  }
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const { settings, shouldPersist } = await loadScopedSettings(req.user.id)
    if (shouldPersist) {
      await persistNotificationSettings(req.user.id, settings)
    }
    res.json(settings)
  } catch (err) {
    console.error('[Notifications] Error getting settings:', err)
    res.status(500).json({ error: 'Failed to get notification settings' })
  }
})

router.post('/server/:serverId/mute', authenticateToken, async (req, res) => {
  const serverId = normalizeEntityId(req.params.serverId)
  const { muted, duration } = req.body
  const mutedFlag = parseMutedFlag(muted)
  const { value: durationMs, error: durationError } = parseDurationMs(duration)

  if (!serverId) {
    return res.status(400).json({ error: 'Invalid server ID' })
  }
  if (!hasServerAccess(req.user.id, serverId)) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (mutedFlag === null) {
    return res.status(400).json({ error: 'Invalid muted value' })
  }
  if (durationError) {
    return res.status(400).json({ error: durationError })
  }
  
  try {
    const { settings } = await loadScopedSettings(req.user.id)
    let serverMutes = settings.serverMutes || []
    
    if (mutedFlag) {
      const muteEntry = { serverId, mutedAt: new Date().toISOString() }
      if (durationMs) {
        muteEntry.expiresAt = new Date(Date.now() + durationMs).toISOString()
      }
      serverMutes = serverMutes.filter(m => m.serverId !== serverId)
      serverMutes.push(muteEntry)
    } else {
      serverMutes = serverMutes.filter(m => m.serverId !== serverId)
    }
    
    settings.serverMutes = serverMutes
    await persistNotificationSettings(req.user.id, settings)
    
    res.json({ success: true, serverMutes })
  } catch (err) {
    console.error('[Notifications] Error muting server:', err)
    res.status(500).json({ error: 'Failed to mute server' })
  }
})

router.get('/server/:serverId/mute', authenticateToken, async (req, res) => {
  const serverId = normalizeEntityId(req.params.serverId)

  if (!serverId) {
    return res.status(400).json({ error: 'Invalid server ID' })
  }
  if (!hasServerAccess(req.user.id, serverId)) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  try {
    const { settings } = await loadScopedSettings(req.user.id)
    const serverMutes = settings.serverMutes || []
    const mute = serverMutes.find(m => m.serverId === serverId)
    
    if (!mute) {
      return res.json({ muted: false })
    }
    
    if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
      const newMutes = serverMutes.filter(m => m.serverId !== serverId)
      settings.serverMutes = newMutes
      await persistNotificationSettings(req.user.id, settings)
      return res.json({ muted: false })
    }
    
    res.json({ muted: true, ...mute })
  } catch (err) {
    console.error('[Notifications] Error getting mute status:', err)
    res.status(500).json({ error: 'Failed to get mute status' })
  }
})

router.post('/dm/:conversationId/mute', authenticateToken, async (req, res) => {
  const conversationId = normalizeEntityId(req.params.conversationId)
  const { muted, duration } = req.body
  const mutedFlag = parseMutedFlag(muted)
  const { value: durationMs, error: durationError } = parseDurationMs(duration)

  if (!conversationId) {
    return res.status(400).json({ error: 'Invalid conversation ID' })
  }
  if (!hasConversationAccess(req.user.id, conversationId)) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  if (mutedFlag === null) {
    return res.status(400).json({ error: 'Invalid muted value' })
  }
  if (durationError) {
    return res.status(400).json({ error: durationError })
  }
  
  try {
    const { settings } = await loadScopedSettings(req.user.id)
    let dmMutes = settings.dmMutes || []
    
    if (mutedFlag) {
      const muteEntry = { conversationId, mutedAt: new Date().toISOString() }
      if (durationMs) {
        muteEntry.expiresAt = new Date(Date.now() + durationMs).toISOString()
      }
      dmMutes = dmMutes.filter(m => m.conversationId !== conversationId)
      dmMutes.push(muteEntry)
    } else {
      dmMutes = dmMutes.filter(m => m.conversationId !== conversationId)
    }
    
    settings.dmMutes = dmMutes
    await persistNotificationSettings(req.user.id, settings)
    
    res.json({ success: true, dmMutes })
  } catch (err) {
    console.error('[Notifications] Error muting DM:', err)
    res.status(500).json({ error: 'Failed to mute DM' })
  }
})

router.get('/dm/:conversationId/mute', authenticateToken, async (req, res) => {
  const conversationId = normalizeEntityId(req.params.conversationId)

  if (!conversationId) {
    return res.status(400).json({ error: 'Invalid conversation ID' })
  }
  if (!hasConversationAccess(req.user.id, conversationId)) {
    return res.status(404).json({ error: 'Conversation not found' })
  }
  
  try {
    const { settings } = await loadScopedSettings(req.user.id)
    const dmMutes = settings.dmMutes || []
    const mute = dmMutes.find(m => m.conversationId === conversationId)
    
    if (!mute) {
      return res.json({ muted: false })
    }
    
    if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
      const newMutes = dmMutes.filter(m => m.conversationId !== conversationId)
      settings.dmMutes = newMutes
      await persistNotificationSettings(req.user.id, settings)
      return res.json({ muted: false })
    }
    
    res.json({ muted: true, ...mute })
  } catch (err) {
    console.error('[Notifications] Error getting mute status:', err)
    res.status(500).json({ error: 'Failed to get mute status' })
  }
})

router.get('/is-muted/:type/:id', authenticateToken, async (req, res) => {
  const { type, id } = req.params
  const targetId = normalizeEntityId(id)
  
  if (!targetId) {
    return res.status(400).json({ error: 'Invalid mute target ID' })
  }
  try {
    const { settings } = await loadScopedSettings(req.user.id)
    
    if (type === 'server') {
      if (!hasServerAccess(req.user.id, targetId)) {
        return res.status(404).json({ error: 'Server not found' })
      }
      const mutes = settings.serverMutes || []
      const mute = mutes.find(m => m.serverId === targetId)
      if (!mute) return res.json({ muted: false })
      if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
        return res.json({ muted: false })
      }
      return res.json({ muted: true })
    } else if (type === 'dm') {
      if (!hasConversationAccess(req.user.id, targetId)) {
        return res.status(404).json({ error: 'Conversation not found' })
      }
      const mutes = settings.dmMutes || []
      const mute = mutes.find(m => m.conversationId === targetId)
      if (!mute) return res.json({ muted: false })
      if (mute.expiresAt && new Date(mute.expiresAt) < new Date()) {
        return res.json({ muted: false })
      }
      return res.json({ muted: true })
    }
    
    res.status(400).json({ error: 'Invalid mute type' })
  } catch (err) {
    console.error('[Notifications] Error checking mute status:', err)
    res.status(500).json({ error: 'Failed to check mute status' })
  }
})

export default router
