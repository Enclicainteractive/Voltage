import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { FILES, userService, messageService, channelService, serverService, supportsDirectQuery, directQuery } from '../services/dataService.js'
import { io } from '../server.js'
import config from '../config/config.js'
import { normalizeAgeVerification } from '../utils/ageVerificationPolicy.js'
import { sendPushNotification } from './pushRoutes.js'
import rateLimiter from '../services/rateLimiter.js'

const router = express.Router()

const getAvatarUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PINNED_FILE = FILES.pinnedMessages
const MESSAGE_FLUSH_INTERVAL_MS = Math.max(10, Number(process.env.VOLT_MESSAGE_FLUSH_INTERVAL_MS || 40))
const MESSAGE_FLUSH_MAX_PENDING = Math.max(1, Number(process.env.VOLT_MESSAGE_FLUSH_MAX_PENDING || 100))
let messageStoreCache = null
export let pendingMessageWrites = 0
let messageFlushTimer = null
let messageFlushPromise = Promise.resolve()

// Slow mode tracking: { `${channelId}:${userId}` => lastMessageTimestamp (ms) }
const slowModeLastMessage = new Map()

// Helper function to load all messages (used internally and exported for botRoutes)
const loadMessages = () => {
  if (messageStoreCache) {
    return messageStoreCache
  }
  try {
    messageStoreCache = messageService.getAllMessages()
    return messageStoreCache
  } catch (err) {
    console.error('[ChannelRoutes] Error loading messages:', err.message)
    return {}
  }
}

// Reset message cache (for testing or after external modifications)
export const resetMessageCache = () => {
  messageStoreCache = null
}

// Export for use by other modules
export { loadMessages }

// Load data helper (similar to dataService)
const loadData = (filePath, defaultValue = {}) => {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(data)
    }
  } catch (err) {
    console.error(`[ChannelRoutes] Error loading ${filePath}:`, err.message)
  }
  return defaultValue
}

const saveData = async (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error(`[ChannelRoutes] Error saving ${filePath}:`, err.message)
    return false
  }
}

// Save channels helper
const saveChannels = async (channels) => {
  try {
    await channelService.saveChannels(channels)
    return true
  } catch (err) {
    console.error('[ChannelRoutes] Error saving channels:', err.message)
    return false
  }
}

// Save servers helper
const saveServers = async (servers) => {
  try {
    await serverService.saveServers(servers)
    return true
  } catch (err) {
    console.error('[ChannelRoutes] Error saving servers:', err.message)
    return false
  }
}

// Helper functions that are used in this file but may be defined elsewhere
const loadChannels = () => {
  try {
    return channelService.getAllChannels()
  } catch (err) {
    console.error('[ChannelRoutes] Error loading channels:', err.message)
    return {}
  }
}

const loadServers = () => {
  try {
    const servers = serverService.getAllServers()
    // Handle different return types from serverService
    if (!servers) return []
    // If it's already an array, return it
    if (Array.isArray(servers)) return servers
    // If it's an object with serverId keys, convert to array
    if (typeof servers === 'object') {
      return Object.values(servers)
    }
    return []
  } catch (err) {
    console.error('[ChannelRoutes] Error loading servers:', err.message)
    return []
  }
}

const hasPermission = (server, userId, permission) => {
  if (!server) return false
  if (server.ownerId === userId) return true
  const member = server.members?.find(m => m.id === userId)
  if (!member) return false
  const roleIds = Array.isArray(member.roles) ? member.roles : (member.role ? [member.role] : [])
  for (const roleId of roleIds) {
    const role = server.roles?.find(r => r.id === roleId)
    if (role?.permissions?.includes(permission) || role?.permissions?.includes('admin')) return true
  }
  return false
}

export const findChannelById = (channelId) => {
  const channels = loadChannels()
  
  // Handle different channel data structures
  if (!channels) return null
  
  // If channels is an array directly
  if (Array.isArray(channels)) {
    const found = channels.find(c => c && c.id === channelId)
    if (found) return found
  }
  
  // If channels is an object with serverId keys or flat { channelId: channelData }
  for (const [key, list] of Object.entries(channels)) {
    if (!list) continue
    
    // Handle array of channels (grouped by serverId)
    if (Array.isArray(list)) {
      if (list.length === 0) continue
      const found = list.find(c => c && c.id === channelId)
      if (found) return found
    }
    // Handle flat format: key IS the channelId
    else if (list && list.id === channelId) {
      return list
    }
  }
  
  return null
}

const getChannelServer = (channelId) => {
  const channels = loadChannels()
  if (!channels) return null
  
  for (const [key, value] of Object.entries(channels)) {
    if (!value) continue
    
    // Handle array of channels (legacy format: { serverId: [channels] })
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      const channel = value.find(c => c && c.id === channelId)
      if (channel) {
        return { serverId: key, channel, channels }
      }
    }
    // Handle flat format { channelId: channelData }
    else if (value && value.id === channelId) {
      // Use channel's serverId property if available, otherwise use key
      const serverId = value.serverId || key
      return { serverId, channel: value, channels }
    }
  }
  return null
}

// Check if user can view a channel - must be defined AFTER findChannelById and getChannelServer
export const canViewChannel = (channelId, userId) => {
  const channel = findChannelById(channelId)
  if (!channel) return false
  
  // For DM channels, check if user is part of the conversation
  if (channel.type === 'dm' || channelId.startsWith('dm_')) return true
  
  // For server channels, check server membership
  const serverInfo = getChannelServer(channelId)
  if (!serverInfo) return false
  
  // Load the specific server directly instead of using cached list
  const server = serverService.getServer(serverInfo.serverId)
  if (!server) return false
  
  // Check if user is the owner
  if (server.ownerId === userId) return true
  
  // Check if user is a member
  const member = server.members?.find(m => m && m.id === userId)
  if (!member) return false
  
  // Check role permissions for view_channels
  // Get member's role IDs (can be array or single string)
  const roleIds = Array.isArray(member.roles) ? member.roles : (member.role ? [member.role] : [])
  
  // If member has no roles, allow by default (default member role)
  if (roleIds.length === 0) return true
  
  // Check each role for view_channels permission
  for (const roleId of roleIds) {
    const role = server.roles?.find(r => r.id === roleId)
    if (role?.permissions?.includes('view_channels') || role?.permissions?.includes('admin')) return true
  }
  
  // Check default @member role
  const defaultMemberRole = server.roles?.find(r => r.id === 'member')
  if (defaultMemberRole?.permissions?.includes('view_channels')) return true
  
  // No role has view_channels permission - deny
  return false
}

const isUserAgeVerified = (userId) => {
  try {
    const user = userService.getUser(userId)
    return user?.ageVerified === true
  } catch {
    return false
  }
}

const getChannelDiagnostics = async (channelId, userId) => {
  return {
    channelId,
    userId,
    timestamp: new Date().toISOString()
  }
}

const buildFixSuggestions = (diagnostics) => {
  return ['Ensure you are a member of the server containing this channel']
}

const hydrateMessageShape = (message) => {
  if (!message) return null
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    username: message.username,
    avatar: message.avatar,
    content: message.content,
    embeds: message.embeds || [],
    attachments: message.attachments || [],
    ui: message.ui || null,
    replyTo: message.replyTo,
    timestamp: message.timestamp,
    edited: message.edited,
    editedAt: message.editedAt,
    pinned: message.pinned,
    reactions: message.reactions,
    bot: message.bot,
    sticker: message.sticker,
    deleted: message.deleted
  }
}

export const scheduleMessageFlush = ({ immediate = false } = {}) => {
  if (immediate || pendingMessageWrites >= MESSAGE_FLUSH_MAX_PENDING) {
    return flushQueuedMessages()
  }

  if (!messageFlushTimer) {
    messageFlushTimer = setTimeout(() => {
      void flushQueuedMessages().catch((err) => {
        console.error('[ChannelRoutes] Deferred message flush failed:', err.message)
      })
    }, MESSAGE_FLUSH_INTERVAL_MS)
  }

  return messageFlushPromise
}

const flushQueuedMessages = async () => {
  if (pendingMessageWrites === 0) {
    return Promise.resolve()
  }

  const writesToFlush = pendingMessageWrites
  pendingMessageWrites = 0
  
  try {
    const allMessages = loadMessages()
    await messageService.saveMessages(allMessages)
    messageFlushTimer = null
    console.log(`[Storage] Flushed ${writesToFlush} pending message writes`)
  } catch (err) {
    pendingMessageWrites = writesToFlush
    console.error('[ChannelRoutes] Failed to flush messages:', err.message)
    throw err
  }
}

const loadPinnedMessages = (channelId = null) => {
  if (supportsDirectQuery()) {
    try {
      if (channelId) {
        // Return flat array for a specific channel
        const rows = directQuery('SELECT * FROM pinned_messages WHERE channelId = ?', [channelId])
        return rows || []
      }
      // Return keyed object { channelId: [rows] } for bulk operations
      const rows = directQuery('SELECT * FROM pinned_messages') || []
      const grouped = {}
      for (const row of rows) {
        if (!grouped[row.channelId]) grouped[row.channelId] = []
        grouped[row.channelId].push(row)
      }
      return grouped
    } catch (err) {
      console.error('[ChannelRoutes] Error loading pinned from DB:', err.message)
    }
  }
  const all = loadData(PINNED_FILE, {})
  if (channelId) return all[channelId] || []
  return all
}

const savePinnedMessages = async (pinned) => {
  if (supportsDirectQuery()) {
    try {
      // pinned is a keyed object: { channelId: [messages] }
      // Collect all channel IDs being updated and replace only those rows
      const channelIds = Object.keys(pinned)
      for (const cid of channelIds) {
        await directQuery('DELETE FROM pinned_messages WHERE channelId = ?', [cid])
        for (const msg of (pinned[cid] || [])) {
          await directQuery(
            'INSERT INTO pinned_messages (id, channelId, userId, username, avatar, content, timestamp, pinnedAt, pinnedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [msg.id, msg.channelId || cid, msg.userId, msg.username, msg.avatar, msg.content, msg.timestamp, msg.pinnedAt, msg.pinnedBy]
          )
        }
      }
      return true
    } catch (err) {
      console.error('[ChannelRoutes] Error saving pinned to DB:', err.message)
    }
  }
  await saveData(PINNED_FILE, pinned)
}

const loadCategoriesGrouped = () => {
  return serverService.getAllCategoriesGrouped()
}

export const addMessage = async (channelId, message, options = {}) => {
  const { awaitPersist = true } = options
  const allMessages = loadMessages()
  if (!allMessages[channelId]) {
    allMessages[channelId] = []
  }
  const channelMessages = allMessages[channelId]
  if (typeof message.replyTo === 'string') {
    const target = channelMessages.find(m => m.id === message.replyTo)
    message.replyTo = target
      ? {
          id: target.id,
          userId: target.userId,
          username: target.username,
          content: target.content,
          timestamp: target.timestamp
        }
      : {
          id: message.replyTo,
          deleted: true
        }
  }
  allMessages[channelId].push(message)
  pendingMessageWrites += 1
  if (awaitPersist) {
    await scheduleMessageFlush({ immediate: true })
  } else {
    void scheduleMessageFlush().catch((err) => {
      console.error('[ChannelRoutes] Message persistence failed:', err.message)
    })
  }
  return hydrateMessageShape(message)
}

export const getChannelMessages = (channelId, limit = 50) => {
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  return messages.slice(-limit)
}

export const editMessage = async (channelId, messageId, userId, newContent, options = {}) => {
  const { ui, embeds } = options
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  const messageIndex = messages.findIndex(m => m.id === messageId)
  
  if (messageIndex === -1) return null
  if (messages[messageIndex].userId !== userId) return null
  
  messages[messageIndex].content = newContent
  messages[messageIndex].edited = true
  messages[messageIndex].editedAt = new Date().toISOString()
  
  if (ui !== undefined) {
    messages[messageIndex].ui = ui
  }
  if (embeds !== undefined) {
    messages[messageIndex].embeds = embeds
  }
  
  pendingMessageWrites += 1
  await scheduleMessageFlush({ immediate: true })
  return hydrateMessageShape(messages[messageIndex])
}

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

export const deleteMessage = async (channelId, messageId, userId) => {
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  const messageIndex = messages.findIndex(m => m.id === messageId)
  
  if (messageIndex === -1) return { success: false, error: 'Message not found' }
  
  const serverInfo = getChannelServer(channelId)
  const servers = loadServers()
  const server = servers.find(s => s.id === serverInfo?.serverId)
  const isAdmin = server ? hasPermission(server, userId, 'admin') : false
  const canManageMessages = server ? hasPermission(server, userId, 'manage_messages') : false
  
  if (messages[messageIndex].userId !== userId && !isAdmin && !canManageMessages) {
    return { success: false, error: 'Unauthorized' }
  }
  
  const message = messages[messageIndex]
  
  // Delete attached files
  if (message.attachments && message.attachments.length > 0) {
    message.attachments.forEach(attachment => {
      if (attachment.filename) {
        const filePath = path.join(UPLOADS_DIR, attachment.filename)
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath)
            console.log(`[File] Deleted attachment: ${attachment.filename}`)
          } catch (err) {
            console.error(`[File] Failed to delete attachment: ${attachment.filename}`, err)
          }
        }
      }
    })
  }
  
  messages[messageIndex] = {
    ...message,
    content: '',
    attachments: [],
    embeds: [],
    deleted: true,
    deletedAt: new Date().toISOString(),
    deletedBy: userId,
    edited: false,
    editedAt: null
  }
  pendingMessageWrites += 1
  await scheduleMessageFlush({ immediate: true })
  return { success: true, message: hydrateMessageShape(messages[messageIndex]) }
}

/**
 * Bulk delete messages in a channel.
 * Requires manage_messages or admin permission.
 * Returns { success, deleted: [messageIds], errors: [] }
 */
export const bulkDeleteMessages = async (channelId, messageIds, userId) => {
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return { success: false, error: 'No message IDs provided' }
  }
  if (messageIds.length > 100) {
    return { success: false, error: 'Cannot bulk delete more than 100 messages at once' }
  }

  const serverInfo = getChannelServer(channelId)
  const servers = loadServers()
  const server = servers.find(s => s.id === serverInfo?.serverId)
  const isAdmin = server ? hasPermission(server, userId, 'admin') : false
  const canManageMessages = server ? hasPermission(server, userId, 'manage_messages') : false

  if (!isAdmin && !canManageMessages) {
    return { success: false, error: 'Unauthorized: manage_messages permission required' }
  }

  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  const now = new Date().toISOString()
  const deleted = []
  const errors = []

  for (const messageId of messageIds) {
    const idx = messages.findIndex(m => m.id === messageId)
    if (idx === -1) {
      errors.push({ messageId, error: 'Not found' })
      continue
    }
    const message = messages[idx]
    // Delete attached files
    if (message.attachments && message.attachments.length > 0) {
      message.attachments.forEach(attachment => {
        if (attachment.filename) {
          const filePath = path.join(UPLOADS_DIR, attachment.filename)
          if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath) } catch { /* ignore */ }
          }
        }
      })
    }
    messages[idx] = {
      ...message,
      content: '',
      attachments: [],
      embeds: [],
      deleted: true,
      deletedAt: now,
      deletedBy: userId,
      edited: false,
      editedAt: null
    }
    deleted.push(messageId)
  }

  if (deleted.length > 0) {
    pendingMessageWrites += 1
    await scheduleMessageFlush({ immediate: true })
  }

  return { success: true, deleted, errors }
}

// Bulk delete messages - requires manage_messages or admin
router.post('/:channelId/messages/bulk-delete', authenticateToken, async (req, res) => {
  const { channelId } = req.params
  const { messageIds } = req.body

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds array is required' })
  }
  if (messageIds.length > 100) {
    return res.status(400).json({ error: 'Cannot bulk delete more than 100 messages at once' })
  }

  const result = await bulkDeleteMessages(channelId, messageIds, req.user.id)
  if (!result.success) {
    return res.status(result.error?.includes('Unauthorized') ? 403 : 400).json({ error: result.error })
  }

  // Broadcast bulk deletion to all channel members
  if (result.deleted.length > 0) {
    io.to(`channel:${channelId}`).emit('messages:bulk-deleted', {
      channelId,
      messageIds: result.deleted,
      deletedBy: req.user.id
    })
  }

  console.log(`[API] Bulk deleted ${result.deleted.length} messages in channel ${channelId} by ${req.user.id}`)
  res.json({ success: true, deleted: result.deleted, errors: result.errors })
})

router.get('/:channelId/messages', authenticateToken, async (req, res) => {
    const { limit = 50, before, after } = req.query
    const channelInfo = findChannelById(req.params.channelId)
    if (!channelInfo) {
        const diagnostics = await getChannelDiagnostics(req.params.channelId, req.user.id)
        const fixes = buildFixSuggestions(diagnostics)
        console.warn('[API] Message fetch failed: channel not found', diagnostics)
        return res.status(404).json({
          error: 'Channel not found',
          code: 'CHANNEL_NOT_FOUND',
          diagnostics,
          fixes
        })
    }
    if (channelInfo?.nsfw && !isUserAgeVerified(req.user.id)) {
        const diagnostics = await getChannelDiagnostics(req.params.channelId, req.user.id)
        const fixes = buildFixSuggestions(diagnostics)
        console.warn('[API] Message fetch blocked by age verification', diagnostics)
        return res.status(451).json({
          error: 'Age verification required for this channel',
          code: 'AGE_VERIFICATION_REQUIRED',
          diagnostics,
          fixes
        })
    }
    const canView = await canViewChannel(req.params.channelId, req.user.id)
    if (!canView) {
        const diagnostics = await getChannelDiagnostics(req.params.channelId, req.user.id)
        const fixes = buildFixSuggestions(diagnostics)
        console.warn('[API] Message fetch denied', diagnostics)
        return res.status(403).json({
          error: 'Cannot view channel',
          code: 'CHANNEL_ACCESS_DENIED',
          diagnostics,
          fixes
        })
    }
    let messages = await messageService.getChannelMessages(req.params.channelId, parseInt(limit, 10) || 50, before || null)
  
  let filtered = messages
  
  if (before) {
    filtered = messages.filter(m => new Date(m.timestamp) < new Date(before))
    filtered = filtered.slice(-parseInt(limit))
  } else if (after) {
    filtered = messages.filter(m => new Date(m.timestamp) > new Date(after))
    filtered = filtered.slice(0, parseInt(limit))
  } else {
    filtered = messages.slice(-parseInt(limit))
  }
  
  const byId = new Map(messages.map(m => [m.id, m]))
  const hydrated = filtered.map(msg => {
    const base = hydrateMessageShape(msg)
    if (!msg.replyTo || typeof msg.replyTo !== 'string') return base
    const target = byId.get(msg.replyTo)
    return {
      ...base,
      replyTo: target
        ? {
            id: target.id,
            userId: target.userId,
            username: target.username,
            content: target.deleted ? '' : target.content,
            timestamp: target.timestamp,
            deleted: Boolean(target.deleted)
          }
        : {
            id: msg.replyTo,
            deleted: true
          }
    }
  })

  console.log(`[API] Get messages for channel ${req.params.channelId} - returned ${hydrated.length} messages`)
  if (hydrated.length === 0) {
    const diagnostics = await getChannelDiagnostics(req.params.channelId, req.user.id)
    const fixes = buildFixSuggestions(diagnostics)
    console.warn('[API] Message fetch returned empty result', {
      ...diagnostics,
      query: { limit: parseInt(limit, 10) || 50, before: before || null, after: after || null },
      fixes
    })
    res.setHeader('X-Volt-Diagnostics', 'empty-channel')
  }
  res.json(hydrated)
})

router.post('/:channelId/messages', authenticateToken, async (req, res) => {
  const { content, attachments, replyTo, metadata } = req.body
  const channelId = req.params.channelId

  const rateLimit = await rateLimiter.checkMessageRateLimit(req.user.id)
  if (!rateLimit.allowed) {
    return res.status(429).json({ 
      error: 'Too many messages. Please slow down.', 
      retryAfter: rateLimit.retryAfter 
    })
  }

  const hfLimit = await rateLimiter.checkHighFrequencyLimit(req.user.id)
  if (!hfLimit.allowed) {
    console.warn(`[RateLimit] High frequency detected for user ${req.user.id}`)
    return res.status(429).json({ 
      error: 'You are sending messages too fast. Please wait a moment.', 
      retryAfter: 2 
    })
  }

  const hasCanvasAttachment = attachments?.some(a => 
    a?.type === 'image' && (a?.data?.startsWith('data:') || a?.url?.includes('canvas'))
  )
  if (hasCanvasAttachment) {
    const canvasLimit = await rateLimiter.checkCanvasRateLimit(req.user.id)
    if (!canvasLimit.allowed) {
      return res.status(429).json({ 
        error: 'Too many canvas/images. Rate limited to 3 per 10 seconds.', 
        retryAfter: canvasLimit.retryAfter 
      })
    }
  }

  const channelInfo = findChannelById(channelId)
  if (channelInfo?.nsfw && !isUserAgeVerified(req.user.id)) {
    return res.status(451).json({ error: 'Age verification required for this channel', code: 'AGE_VERIFICATION_REQUIRED' })
  }

  // Slow mode enforcement (skip for admins/manage_messages)
  const slowModeSecs = Number(channelInfo?.slowMode) || 0
  if (slowModeSecs > 0) {
    const channelServerInfo2 = getChannelServer(channelId)
    const servers2 = loadServers()
    const server2 = servers2.find(s => s.id === channelServerInfo2?.serverId)
    const isPrivileged = server2 && (hasPermission(server2, req.user.id, 'manage_messages') || hasPermission(server2, req.user.id, 'admin'))
    if (!isPrivileged) {
      const smKey = `${channelId}:${req.user.id}`
      const lastMs = slowModeLastMessage.get(smKey) || 0
      const nowMs = Date.now()
      const elapsed = (nowMs - lastMs) / 1000
      if (elapsed < slowModeSecs) {
        const retryAfter = Math.ceil(slowModeSecs - elapsed)
        return res.status(429).json({
          error: `Slow mode is enabled. Please wait ${retryAfter} second${retryAfter !== 1 ? 's' : ''} before sending another message.`,
          retryAfter,
          slowMode: slowModeSecs
        })
      }
      slowModeLastMessage.set(smKey, nowMs)
    }
  }

  // Include guild tag and server nick in message for global display
  const senderProfile = userService.getUser(req.user.id)
  const channelServerInfo = getChannelServer(channelId)
  const serverId = channelServerInfo?.serverId || null
  const serverNick = serverId ? (senderProfile?.serverNicks?.[serverId] || null) : null
  // Resolve display name: server nick > display name > username
  const messageUsername = serverNick || req.user.displayName || req.user.username || req.user.email

  const message = {
    id: uuidv4(),
    channelId,
    userId: req.user.id,
    username: messageUsername,
    avatar: req.user.avatar || getAvatarUrl(req.user.id),
    guildTag: senderProfile?.guildTag || null,
    content,
    attachments: attachments || [],
    replyTo: typeof replyTo === 'string' ? replyTo : null,
    storage: metadata ? { metadata } : {},
    timestamp: new Date().toISOString()
  }
  
  const created = await addMessage(channelId, message)
  
  console.log(`[API] Created message in channel ${channelId}`)
  res.status(201).json(created)
})

router.post('/:channelId/messages/:messageId/notify', authenticateToken, async (req, res) => {
  const { channelId, messageId } = req.params
  const serverInfo = getChannelServer(channelId)
  if (!serverInfo) return res.status(404).json({ error: 'Channel not found' })

  const servers = loadServers()
  const server = servers.find(item => item.id === serverInfo.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_messages') && !hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  const allMessages = loadMessages()
  const message = (allMessages[channelId] || []).find(item => item.id === messageId)
  if (!message) return res.status(404).json({ error: 'Message not found' })

  const hydratedMessage = hydrateMessageShape(message)
  const title = hydratedMessage.metadata?.title || serverInfo.channel?.name || 'Announcement'
  const body = hydratedMessage.content || title

  let notified = 0
  for (const member of server.members || []) {
    if (!member?.id || member.id === req.user.id) continue
    io.to(`user:${member.id}`).emit('notification:mention', {
      type: 'everyone',
      senderName: req.user.username || req.user.email || 'Announcement',
      content: body,
      serverId: server.id,
      channelId,
      messageId
    })
    sendPushNotification(member.id, {
      title: `${server.name}: ${title}`,
      body,
      data: { url: `/chat/${server.id}/${channelId}` }
    })
    notified += 1
  }

  res.json({ success: true, notified })
})

router.put('/:channelId', authenticateToken, async (req, res) => {
  const channelId = req.params.channelId

  // Load channel directly from channelService (handles both flat and legacy formats)
  const channel = channelService.getChannel(channelId)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })

  const serverId = channel.serverId
  const servers = loadServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to edit channels' })
  }

  // Validate categoryId if provided
  if (req.body.categoryId !== undefined) {
    const allCategories = loadCategoriesGrouped()
    const categories = allCategories[serverId] || []
    if (req.body.categoryId && !categories.find(c => c.id === req.body.categoryId)) {
      return res.status(400).json({ error: 'Invalid category' })
    }
  }

  // Sanitize allowed fields (don't let clients overwrite id/serverId/type arbitrarily)
  const ALLOWED_FIELDS = ['name', 'topic', 'slowMode', 'nsfw', 'isDefault', 'categoryId', 'position', 'permissions']
  const updates = {}
  for (const field of ALLOWED_FIELDS) {
    if (req.body[field] !== undefined) updates[field] = req.body[field]
  }
  updates.updatedAt = new Date().toISOString()

  const updated = await channelService.updateChannel(channelId, updates)
  if (!updated) return res.status(404).json({ error: 'Channel not found' })

  if (req.body.isDefault) {
    server.defaultChannelId = channelId
    const serverIdx = servers.findIndex(s => s.id === serverId)
    if (serverIdx >= 0) servers[serverIdx] = server
    await saveServers(servers)
    io.to(`server:${serverId}`).emit('server:updated', server)
  }

  io.to(`server:${serverId}`).emit('channel:updated', updated)

  console.log(`[API] Updated channel ${channelId}`)
  res.json(updated)
})

router.delete('/:channelId', authenticateToken, async (req, res) => {
  const found = getChannelServer(req.params.channelId)
  if (!found) return res.status(404).json({ error: 'Channel not found' })

  const servers = loadServers()
  const server = servers.find(s => s.id === found.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to delete channels' })
  }

  await channelService.deleteChannel(req.params.channelId)
  
  io.to(`server:${found.serverId}`).emit('channel:deleted', { channelId: req.params.channelId })
  
  console.log(`[API] Deleted channel ${req.params.channelId}`)
  res.json({ success: true })
})

// Move channel to a different category
router.put('/:channelId/move', authenticateToken, async (req, res) => {
  const { categoryId } = req.body
  const found = getChannelServer(req.params.channelId)
  if (!found) return res.status(404).json({ error: 'Channel not found' })

  const servers = loadServers()
  const server = servers.find(s => s.id === found.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to move channels' })
  }

  // Validate categoryId if provided (null is valid for uncategorized)
  if (categoryId) {
    const allCategories = loadCategoriesGrouped()
    const categories = allCategories[found.serverId] || []
    if (!categories.find(c => c.id === categoryId)) {
      return res.status(400).json({ error: 'Invalid category' })
    }
  }

  const allChannels = found.channels
  const list = allChannels[found.serverId] || []
  const idx = list.findIndex(c => c.id === req.params.channelId)
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' })

  list[idx] = { ...list[idx], categoryId: categoryId || null, updatedAt: new Date().toISOString() }
  allChannels[found.serverId] = list
  await saveChannels(allChannels)
  
  io.to(`server:${found.serverId}`).emit('channel:updated', list[idx])
  
  console.log(`[API] Moved channel ${req.params.channelId} to category ${categoryId || 'uncategorized'}`)
  res.json(list[idx])
})

router.get('/:channelId/messages/search', authenticateToken, (req, res) => {
  const { q, limit = 25 } = req.query
  if (!q || q.trim().length === 0) {
    return res.json([])
  }
  
  const allMessages = loadMessages()
  const messages = allMessages[req.params.channelId] || []
  const query = q.toLowerCase()
  
  const results = messages
    .filter(m => {
      const contentMatch = m.content && m.content.toLowerCase().includes(query)
      const attachmentMatch = m.attachments && m.attachments.some(a => 
        a.name && a.name.toLowerCase().includes(query)
      )
      return contentMatch || attachmentMatch
    })
    .slice(-parseInt(limit))
    .reverse()
  
  console.log(`[API] Search messages in channel ${req.params.channelId} for "${q}" - found ${results.length} results`)
  res.json(results)
})

router.get('/:channelId/pins', authenticateToken, (req, res) => {
  // Pass channelId so the DB path returns a flat array directly
  const channelPins = loadPinnedMessages(req.params.channelId)
  res.json(channelPins)
})

router.put('/:channelId/pins/:messageId', authenticateToken, async (req, res) => {
  const { channelId, messageId } = req.params

  // Try to find the message in the in-memory store first, then fall back to DB
  let message = null
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  message = messages.find(m => m.id === messageId)

  // If not found in memory cache, try querying the DB directly
  if (!message && supportsDirectQuery()) {
    try {
      const rows = directQuery('SELECT * FROM messages WHERE id = ? AND channelId = ?', [messageId, channelId])
      if (rows && rows.length > 0) message = rows[0]
    } catch (err) {
      console.error('[ChannelRoutes] DB message lookup failed:', err.message)
    }
  }

  if (!message) {
    return res.status(404).json({ error: 'Message not found' })
  }

  // Load existing pins for this channel (flat array)
  const channelPins = loadPinnedMessages(channelId)
  const existingIndex = channelPins.findIndex(p => p.id === messageId)
  if (existingIndex >= 0) {
    return res.status(400).json({ error: 'Message already pinned' })
  }

  // savePinnedMessages expects a keyed object
  const pinned = { [channelId]: [...channelPins, {
    ...message,
    channelId,
    pinnedAt: new Date().toISOString(),
    pinnedBy: req.user.id
  }] }
  await savePinnedMessages(pinned)

  console.log(`[API] Pinned message ${messageId} in channel ${channelId}`)
  res.json({ success: true })
})

router.delete('/:channelId/pins/:messageId', authenticateToken, async (req, res) => {
  const { channelId, messageId } = req.params

  // Load existing pins for this channel (flat array)
  const channelPins = loadPinnedMessages(channelId)
  if (!channelPins || channelPins.length === 0) {
    return res.status(404).json({ error: 'No pinned messages in this channel' })
  }

  const index = channelPins.findIndex(p => p.id === messageId)
  if (index === -1) {
    return res.status(404).json({ error: 'Pinned message not found' })
  }

  channelPins.splice(index, 1)
  // savePinnedMessages expects a keyed object
  await savePinnedMessages({ [channelId]: channelPins })

  console.log(`[API] Unpinned message ${messageId} from channel ${channelId}`)
  res.json({ success: true })
})

// ─── Channel Permissions ────────────────────────────────────────────────────
// Permissions are stored as an array on the channel object:
// [{ id: roleId|userId, type: 'role'|'member', allow: [...perms], deny: [...perms] }]

router.get('/:channelId/permissions', authenticateToken, (req, res) => {
  const channelId = req.params.channelId
  const channel = channelService.getChannel(channelId)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })

  // Only server members can view permissions
  const serverInfo = getChannelServer(channelId)
  if (serverInfo) {
    const server = serverService.getServer(serverInfo.serverId)
    if (server && server.ownerId !== req.user.id) {
      const member = server.members?.find(m => m && m.id === req.user.id)
      if (!member) return res.status(403).json({ error: 'Not a member of this server' })
    }
  }

  res.json(channel.permissions || [])
})

router.put('/:channelId/permissions', authenticateToken, async (req, res) => {
  const channelId = req.params.channelId
  const channel = channelService.getChannel(channelId)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })

  const serverId = channel.serverId
  const servers = loadServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to manage channel permissions' })
  }

  // Accept multiple body formats:
  //   { permissions: [...] }                    — replace all (array of overwrites)
  //   { overrides: { id: { allow, deny } } }    — keyed object (frontend format)
  //   { id, type, allow, deny }                 — single overwrite upsert
  let newPermissions
  if (Array.isArray(req.body.permissions)) {
    // Full replacement via array
    newPermissions = req.body.permissions
  } else if (req.body.overrides && typeof req.body.overrides === 'object') {
    // Frontend sends { overrides: { roleId: { allow: [], deny: [] }, '@everyone': { view, sendMessages } } }
    // Convert to canonical array format
    const existing = Array.isArray(channel.permissions) ? [...channel.permissions] : []
    for (const [id, overrideData] of Object.entries(req.body.overrides)) {
      // Normalise allow/deny — frontend may send string booleans for @everyone
      let allow = Array.isArray(overrideData.allow) ? overrideData.allow : []
      let deny = Array.isArray(overrideData.deny) ? overrideData.deny : []

      // Handle @everyone shorthand: { view: "false", sendMessages: "false" }
      if (id === '@everyone') {
        if (overrideData.view === 'false' || overrideData.view === false) {
          if (!deny.includes('view_channel')) deny = [...deny, 'view_channel']
        } else if (overrideData.view === 'true' || overrideData.view === true) {
          if (!allow.includes('view_channel')) allow = [...allow, 'view_channel']
        }
        if (overrideData.sendMessages === 'false' || overrideData.sendMessages === false) {
          if (!deny.includes('send_messages')) deny = [...deny, 'send_messages']
        } else if (overrideData.sendMessages === 'true' || overrideData.sendMessages === true) {
          if (!allow.includes('send_messages')) allow = [...allow, 'send_messages']
        }
      }

      const overwrite = {
        id,
        type: overrideData.type || (id === '@everyone' ? 'everyone' : 'role'),
        allow,
        deny
      }
      const idx = existing.findIndex(p => p.id === id)
      if (idx >= 0) {
        existing[idx] = overwrite
      } else {
        existing.push(overwrite)
      }
    }
    newPermissions = existing
  } else if (req.body.id) {
    // Single overwrite upsert
    const existing = Array.isArray(channel.permissions) ? [...channel.permissions] : []
    const idx = existing.findIndex(p => p.id === req.body.id)
    const overwrite = {
      id: req.body.id,
      type: req.body.type || 'role',
      allow: Array.isArray(req.body.allow) ? req.body.allow : [],
      deny: Array.isArray(req.body.deny) ? req.body.deny : []
    }
    if (idx >= 0) {
      existing[idx] = overwrite
    } else {
      existing.push(overwrite)
    }
    newPermissions = existing
  } else {
    return res.status(400).json({ error: 'Provide either permissions array, overrides object, or a single overwrite {id, type, allow, deny}' })
  }

  const updated = await channelService.updateChannel(channelId, {
    permissions: newPermissions,
    updatedAt: new Date().toISOString()
  })
  if (!updated) return res.status(404).json({ error: 'Channel not found' })

  io.to(`server:${serverId}`).emit('channel:updated', updated)
  console.log(`[API] Updated permissions for channel ${channelId}`)
  res.json(updated.permissions || [])
})

// DELETE a single permission overwrite
router.delete('/:channelId/permissions/:targetId', authenticateToken, async (req, res) => {
  const { channelId, targetId } = req.params
  const channel = channelService.getChannel(channelId)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })

  const serverId = channel.serverId
  const servers = loadServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to manage channel permissions' })
  }

  const existing = Array.isArray(channel.permissions) ? channel.permissions : []
  const filtered = existing.filter(p => p.id !== targetId)

  const updated = await channelService.updateChannel(channelId, {
    permissions: filtered,
    updatedAt: new Date().toISOString()
  })
  if (!updated) return res.status(404).json({ error: 'Channel not found' })

  io.to(`server:${serverId}`).emit('channel:updated', updated)
  console.log(`[API] Deleted permission overwrite ${targetId} from channel ${channelId}`)
  res.json({ success: true })
})

export default router
