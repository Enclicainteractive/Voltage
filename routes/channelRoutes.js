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
  console.log(`[findChannelById] Looking for channelId: ${channelId}`)
  console.log(`[findChannelById] Channels object keys: ${Object.keys(channels || {}).length}`)
  
  // Handle different channel data structures
  if (!channels) return null
  
  // If channels is an array directly
  if (Array.isArray(channels)) {
    const found = channels.find(c => c && c.id === channelId)
    if (found) return found
  }
  
  // If channels is an object with serverId keys
  for (const [serverId, list] of Object.entries(channels)) {
    if (!list) continue
    
    // Handle array of channels
    if (Array.isArray(list)) {
      if (list.length === 0) continue
      const found = list.find(c => c && c.id === channelId)
      if (found) {
        console.log(`[findChannelById] Found channel in server ${serverId}:`, found.id)
        return found
      }
    }
    // Handle single channel object
    else if (list && list.id === channelId) {
      console.log(`[findChannelById] Found channel in server ${serverId}:`, list.id)
      return list
    }
  }
  
  console.log(`[findChannelById] Channel not found after checking ${Object.keys(channels).length} servers`)
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
  console.log(`[canViewChannel] channelId: ${channelId}, userId: ${userId}`)
  
  const channel = findChannelById(channelId)
  if (!channel) {
    console.log(`[canViewChannel] Channel not found`)
    return false
  }
  
  // For DM channels, check if user is part of the conversation
  if (channel.type === 'dm' || channelId.startsWith('dm_')) {
    console.log(`[canViewChannel] DM channel - allowing`)
    return true
  }
  
  // For server channels, check server membership
  const serverInfo = getChannelServer(channelId)
  if (!serverInfo) {
    console.log(`[canViewChannel] Server not found for channel`)
    return false
  }
  console.log(`[canViewChannel] Server ID: ${serverInfo.serverId}`)
  
  // Load the specific server directly instead of using cached list
  const server = serverService.getServer(serverInfo.serverId)
  if (!server) {
    console.log(`[canViewChannel] Server ${serverInfo.serverId} not found in database`)
    return false
  }
  console.log(`[canViewChannel] Server found: ${server.name}, ownerId: ${server.ownerId}`)
  
  // Check if user is the owner
  if (server.ownerId === userId) {
    console.log(`[canViewChannel] User is owner - allowing`)
    return true
  }
  
  // Check if user is a member
  const member = server.members?.find(m => m && m.id === userId)
  if (!member) {
    console.log(`[canViewChannel] User not a member`)
    return false
  }
  console.log(`[canViewChannel] Member found: ${JSON.stringify(member.roles)}`)
  
  // Check role permissions for view_channels
  // Get member's role IDs (can be array or single string)
  const roleIds = Array.isArray(member.roles) ? member.roles : (member.role ? [member.role] : [])
  
  // If member has no roles, allow by default (default member role)
  if (roleIds.length === 0) {
    console.log(`[canViewChannel] No roles, allowing`)
    return true
  }
  
  // Check each role for view_channels permission
  for (const roleId of roleIds) {
    const role = server.roles?.find(r => r.id === roleId)
    console.log(`[canViewChannel] Checking role ${roleId}:`, role?.permissions)
    if (role?.permissions?.includes('view_channels') || role?.permissions?.includes('admin')) {
      console.log(`[canViewChannel] Role has permission - allowing`)
      return true
    }
  }
  
  // Check default @member role
  const defaultMemberRole = server.roles?.find(r => r.id === 'member')
  console.log(`[canViewChannel] Default role:`, defaultMemberRole?.permissions)
  if (defaultMemberRole?.permissions?.includes('view_channels')) {
    console.log(`[canViewChannel] Default role has permission - allowing`)
    return true
  }
  
  // No role has view_channels permission - deny
  console.log(`[canViewChannel] No roles have permission - denying`)
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

const loadPinnedMessages = () => {
  if (supportsDirectQuery()) {
    try {
      const rows = directQuery('SELECT * FROM pinned_messages')
      return rows || []
    } catch (err) {
      console.error('[ChannelRoutes] Error loading pinned from DB:', err.message)
    }
  }
  return loadData(PINNED_FILE, {})
}

const savePinnedMessages = async (pinned) => {
  if (supportsDirectQuery()) {
    try {
      await directQuery('DELETE FROM pinned_messages')
      for (const msg of pinned) {
        await directQuery(
          'INSERT INTO pinned_messages (id, channelId, userId, username, avatar, content, timestamp, pinnedAt, pinnedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [msg.id, msg.channelId, msg.userId, msg.username, msg.avatar, msg.content, msg.timestamp, msg.pinnedAt, msg.pinnedBy]
        )
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
  
  const message = {
    id: uuidv4(),
    channelId,
    userId: req.user.id,
    username: req.user.username || req.user.email,
    avatar: req.user.avatar || getAvatarUrl(req.user.id),
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
  const found = getChannelServer(req.params.channelId)
  if (!found) return res.status(404).json({ error: 'Channel not found' })

  const servers = loadServers()
  const server = servers.find(s => s.id === found.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to edit channels' })
  }

  // Validate categoryId if provided
  if (req.body.categoryId !== undefined) {
    const allCategories = loadCategoriesGrouped()
    const categories = allCategories[found.serverId] || []
    
    if (req.body.categoryId && !categories.find(c => c.id === req.body.categoryId)) {
      return res.status(400).json({ error: 'Invalid category' })
    }
  }

  const allChannels = found.channels
  const list = allChannels[found.serverId] || []
  const idx = list.findIndex(c => c.id === req.params.channelId)
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' })

  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() }
  allChannels[found.serverId] = list
  await saveChannels(allChannels)
  
  if (req.body.isDefault) {
    server.defaultChannelId = req.params.channelId
    const serverIdx = servers.findIndex(s => s.id === found.serverId)
    servers[serverIdx] = server
    await saveServers(servers)
    io.to(`server:${found.serverId}`).emit('server:updated', server)
  }
  
  io.to(`server:${found.serverId}`).emit('channel:updated', list[idx])
  
  console.log(`[API] Updated channel ${req.params.channelId}`)
  res.json(list[idx])
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
  const pinned = loadPinnedMessages()
  const channelPins = pinned[req.params.channelId] || []
  res.json(channelPins)
})

router.put('/:channelId/pins/:messageId', authenticateToken, async (req, res) => {
  const { channelId, messageId } = req.params
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  const message = messages.find(m => m.id === messageId)
  
  if (!message) {
    return res.status(404).json({ error: 'Message not found' })
  }
  
  const pinned = loadPinnedMessages()
  if (!pinned[channelId]) {
    pinned[channelId] = []
  }
  
  const existingIndex = pinned[channelId].findIndex(p => p.id === messageId)
  if (existingIndex >= 0) {
    return res.status(400).json({ error: 'Message already pinned' })
  }
  
  pinned[channelId].push({
    ...message,
    pinnedAt: new Date().toISOString(),
    pinnedBy: req.user.id
  })
  await savePinnedMessages(pinned)
  
  console.log(`[API] Pinned message ${messageId} in channel ${channelId}`)
  res.json({ success: true })
})

router.delete('/:channelId/pins/:messageId', authenticateToken, async (req, res) => {
  const { channelId, messageId } = req.params
  
  const pinned = loadPinnedMessages()
  if (!pinned[channelId]) {
    return res.status(404).json({ error: 'No pinned messages in this channel' })
  }
  
  const index = pinned[channelId].findIndex(p => p.id === messageId)
  if (index === -1) {
    return res.status(404).json({ error: 'Pinned message not found' })
  }
  
  pinned[channelId].splice(index, 1)
  await savePinnedMessages(pinned)
  
  console.log(`[API] Unpinned message ${messageId} from channel ${channelId}`)
  res.json({ success: true })
})

export default router
