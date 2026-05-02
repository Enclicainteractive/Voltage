import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { FILES, userService, messageService, channelService, serverService, reactionService, dmService, fileService, supportsDirectQuery, directQuery } from '../services/dataService.js'
import { io } from '../server.js'
import config from '../config/config.js'
import { normalizeAgeVerification } from '../utils/ageVerificationPolicy.js'
import { sendPushNotification } from './pushRoutes.js'
import rateLimiter from '../services/rateLimiter.js'
import { messageLimiter } from '../middleware/rateLimitMiddleware.js'
import { validationSchemas, validateRequest, sanitizeInput, validationRateLimit } from '../middleware/builtinValidationMiddleware.js'

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
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const ATTACHMENT_PROVIDER_RE = /^[A-Za-z0-9._-]{1,64}$/
const ATTACHMENT_MIMETYPE_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/
const SAFE_TEXT_SINGLE_LINE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\r\n]+/g
const SAFE_TEXT_MULTI_LINE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g
const SAFE_ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'text', 'file', 'document'])
const MAX_ATTACHMENT_COUNT = 10
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

const normalizeIdentifier = (value, regex) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return regex.test(trimmed) ? trimmed : null
}

const normalizeText = (value, maxLength = 255, { multiLine = false } = {}) => {
  if (typeof value !== 'string') return null
  const normalized = value
    .replace(multiLine ? SAFE_TEXT_MULTI_LINE_RE : SAFE_TEXT_SINGLE_LINE_RE, ' ')
    .trim()
  if (!normalized) return null
  return normalized.slice(0, maxLength)
}

const sanitizeMessageContent = (value, maxLength = 4000) => {
  if (typeof value !== 'string') return ''
  return value
    .replace(SAFE_TEXT_MULTI_LINE_RE, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<iframe[^>]*>.*?<\/iframe>/gis, '')
    .replace(/<object[^>]*>.*?<\/object>/gis, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:\s*text\/html/gi, '')
    .trim()
    .slice(0, maxLength)
}

const sanitizeAttachmentUrl = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2048 || /[\r\n]/.test(trimmed)) return null
  if (trimmed.startsWith('/')) {
    if (!/^\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*$/.test(trimmed)) return null
    return trimmed
  }
  try {
    const parsed = new URL(trimmed)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.toString()
  } catch {
    return null
  }
}

const normalizeSizeBytes = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  if (parsed < 0 || parsed > 1024 * 1024 * 1024 * 2) return null
  return Math.floor(parsed)
}

const normalizeRoleIds = (member) => {
  if (!member) return []
  const roleIds = Array.isArray(member.roles)
    ? member.roles
    : (member.role ? [member.role] : [])
  const out = roleIds
    .map(id => typeof id === 'string' ? id.trim() : '')
    .filter(Boolean)
  if (!out.includes('member')) out.push('member')
  return Array.from(new Set(out))
}

const getChannelPermissionOverwrites = (channel) => {
  try {
    return sanitizePermissionOverwriteArray(channel?.permissions, { strict: false })
  } catch {
    return []
  }
}

const hasChannelPermission = (channel, server, userId, permission) => {
  if (!channel || !server || !permission) return false
  if (server.ownerId === userId) return true

  const member = server.members?.find(m => m && m.id === userId)
  if (!member) return false

  const roleIds = normalizeRoleIds(member)
  const roles = roleIds
    .map(roleId => server.roles?.find(r => r.id === roleId))
    .filter(Boolean)

  if (roles.some(role => role?.permissions?.includes('admin'))) return true

  let allowed = (
    (roles.length === 0 && (permission === 'view_channels' || permission === 'send_messages')) ||
    roles.some(role => role?.permissions?.includes(permission))
  )

  const overwrites = getChannelPermissionOverwrites(channel)

  const everyoneOverride = overwrites.find(item => item?.id === '@everyone' || item?.type === 'everyone')
  if (everyoneOverride) {
    if (everyoneOverride.deny?.includes(permission)) allowed = false
    if (everyoneOverride.allow?.includes(permission)) allowed = true
  }

  const roleOverwrites = overwrites.filter(item => item?.type === 'role' && roleIds.includes(item.id))
  if (roleOverwrites.some(item => item?.deny?.includes(permission))) allowed = false
  if (roleOverwrites.some(item => item?.allow?.includes(permission))) allowed = true

  const memberOverride = overwrites.find(item => item?.id === userId || (item?.type === 'member' && item?.id === userId))
  if (memberOverride) {
    if (memberOverride.deny?.includes(permission)) allowed = false
    if (memberOverride.allow?.includes(permission)) allowed = true
  }

  return allowed
}

const extractDmParticipantIds = (channel = {}) => {
  const participants = new Set()
  const pushId = (value) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed) return
    participants.add(trimmed)
  }

  if (Array.isArray(channel.participants)) {
    for (const id of channel.participants) pushId(id)
  }
  if (Array.isArray(channel.participantIds)) {
    for (const id of channel.participantIds) pushId(id)
  }
  if (Array.isArray(channel.members)) {
    for (const member of channel.members) {
      if (typeof member === 'string') pushId(member)
      else if (member && typeof member === 'object') pushId(member.id || member.userId)
    }
  }
  if (typeof channel.participantKey === 'string' && channel.participantKey.includes(':')) {
    for (const id of channel.participantKey.split(':')) pushId(id)
  }
  pushId(channel.ownerId)
  pushId(channel.recipientId)
  pushId(channel.createdBy)
  pushId(channel.userId)
  return participants
}

const isUserInDmChannel = (channel, channelId, userId) => {
  const participants = extractDmParticipantIds(channel)
  if (participants.size > 0) return participants.has(userId)

  if (typeof channelId === 'string' && channelId.startsWith('dm_')) {
    const conversation = dmService.getConversationForUser(userId, channelId)
    if (!conversation) return false
    const conversationParticipants = extractDmParticipantIds(conversation)
    if (conversationParticipants.size === 0) return false
    return conversationParticipants.has(userId)
  }

  return false
}

const sanitizeMessageMetadata = (value, { depth = 0 } = {}) => {
  if (depth > 4) return null
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return normalizeText(value, 500, { multiLine: true })
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map(entry => sanitizeMessageMetadata(entry, { depth: depth + 1 }))
      .filter(entry => entry !== null)
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (RESERVED_OVERRIDE_KEYS.has(key)) continue
      const safeKey = normalizeText(key, 64)
      if (!safeKey) continue
      const safeValue = sanitizeMessageMetadata(entry, { depth: depth + 1 })
      if (safeValue !== null) out[safeKey] = safeValue
    }
    return Object.keys(out).length > 0 ? out : null
  }
  return null
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
  
  // For DM channels, enforce conversation membership to prevent BOLA.
  if (channel.type === 'dm' || channelId.startsWith('dm_')) {
    return isUserInDmChannel(channel, channelId, userId)
  }
  
  // For server channels, check server membership
  const serverInfo = getChannelServer(channelId)
  if (!serverInfo) return false
  
  // Load the specific server directly instead of using cached list
  // Try multiple ways to get server data to handle race conditions
  let server = serverService.getServer(serverInfo.serverId)
  if (!server) {
    // Fallback: reload server data from storage in case of cache issues
    try {
      const servers = loadData(FILES.servers, {})
      server = servers[serverInfo.serverId]
    } catch (err) {
      console.warn(`[Channel] Failed to reload server ${serverInfo.serverId}:`, err.message)
      return false
    }
  }
  if (!server) return false
  
  // Check if user is the owner
  if (server.ownerId === userId) return true
  
  // Check if user is a member - be more lenient with race conditions
  const member = server.members?.find(m => m && m.id === userId)
  if (!member) {
    // Additional check: maybe the member list is being updated
    // For now, log the issue but don't block access for potential race conditions
    console.warn(`[Channel] Member ${userId} not found in server ${serverInfo.serverId} member list. This might indicate a race condition.`)
    // Allow a brief grace period for new members (within last 30 seconds)
    // This helps with race conditions when users join and immediately try to access channels
    const recentJoinGracePeriod = 30000 // 30 seconds
    const now = Date.now()
    // Check if this could be a very recent join - if so, allow access temporarily
    // This is not foolproof but helps with common race condition scenarios
    return false
  }
  
  return hasChannelPermission(channel, server, userId, 'view_channels')
}

const isUserAgeVerified = (userId) => {
  try {
    const user = userService.getUser(userId)
    return user?.ageVerified === true
  } catch {
    return false
  }
}

const clampInteger = (value, defaultValue, { min = 1, max = 100 } = {}) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(max, Math.max(min, parsed))
}

const sanitizeAttachment = (attachment) => {
  if (!attachment || typeof attachment !== 'object') return null
  const safe = {}
  const id = normalizeIdentifier(attachment.id, ATTACHMENT_ID_RE)
  if (id) safe.id = id

  const name = normalizeText(attachment.name, 255)
  if (name) safe.name = name

  const type = typeof attachment.type === 'string' ? attachment.type.trim().toLowerCase() : ''
  if (SAFE_ATTACHMENT_TYPES.has(type)) safe.type = type

  const mimetype = typeof attachment.mimetype === 'string' ? attachment.mimetype.trim().toLowerCase() : ''
  if (ATTACHMENT_MIMETYPE_RE.test(mimetype)) safe.mimetype = mimetype

  const sizeBytes = normalizeSizeBytes(attachment.sizeBytes ?? attachment.size)
  if (sizeBytes !== null) safe.sizeBytes = sizeBytes

  const size = normalizeText(attachment.size, 32)
  if (size) safe.size = size

  const url = sanitizeAttachmentUrl(attachment.url)
  if (url) safe.url = url

  const filename = typeof attachment.filename === 'string' ? attachment.filename.trim() : ''
  if (filename && SAFE_ATTACHMENT_FILENAME_RE.test(filename) && filename === path.basename(filename)) {
    safe.filename = filename
  }

  const provider = typeof attachment.provider === 'string' ? attachment.provider.trim().toLowerCase() : ''
  if (provider && ATTACHMENT_PROVIDER_RE.test(provider)) safe.provider = provider

  if (typeof attachment.cdn === 'boolean') safe.cdn = attachment.cdn

  const uploadedAt = typeof attachment.uploadedAt === 'string' ? attachment.uploadedAt.trim() : ''
  if (uploadedAt && !Number.isNaN(Date.parse(uploadedAt))) safe.uploadedAt = uploadedAt

  if (!safe.id && !safe.url && !safe.filename) return null
  return safe
}

const sanitizeAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return []
  return attachments.map(sanitizeAttachment).filter(Boolean)
}

const sanitizeReplyPreview = (replyTo) => {
  if (!replyTo) return null
  if (typeof replyTo === 'string') {
    return normalizeIdentifier(replyTo, MESSAGE_ID_RE)
  }
  if (typeof replyTo !== 'object') return null
  return {
    id: normalizeIdentifier(replyTo.id, MESSAGE_ID_RE),
    userId: normalizeText(replyTo.userId, 64),
    username: normalizeText(replyTo.username, 128),
    content: replyTo.deleted ? '' : sanitizeMessageContent(replyTo.content, 4000),
    timestamp: typeof replyTo.timestamp === 'string' ? replyTo.timestamp : null,
    deleted: Boolean(replyTo.deleted)
  }
}

const hydrateMessageShape = (message) => {
  if (!message) return null
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    username: message.username,
    avatar: message.avatar,
    content: sanitizeMessageContent(message.content, 4000),
    embeds: message.embeds || [],
    attachments: sanitizeAttachments(message.attachments),
    ui: message.ui || null,
    replyTo: sanitizeReplyPreview(message.replyTo),
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
        if (!rows) {
          console.warn(`[ChannelRoutes] No pinned messages found for channel ${channelId}`)
          return []
        }
        return rows
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
      console.error('[ChannelRoutes] Error loading pinned from DB:', err.message, { channelId, stack: err.stack })
    }
  }
  try {
    const all = loadData(PINNED_FILE, {})
    if (channelId) return all[channelId] || []
    return all
  } catch (err) {
    console.error('[ChannelRoutes] Error loading pinned from file:', err.message, { channelId })
    return channelId ? [] : {}
  }
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
const UPLOADS_ROOT = path.resolve(UPLOADS_DIR)
const UPLOADS_ROOT_PREFIX = `${UPLOADS_ROOT}${path.sep}`
const SAFE_ATTACHMENT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/

const resolveSafeAttachmentPath = (attachment) => {
  const filename = typeof attachment?.filename === 'string' ? attachment.filename.trim() : ''
  if (!filename) return null
  if (!SAFE_ATTACHMENT_FILENAME_RE.test(filename)) return null
  if (filename !== path.basename(filename)) return null
  if (path.isAbsolute(filename)) return null

  const resolved = path.resolve(UPLOADS_DIR, filename)
  if (!resolved.startsWith(UPLOADS_ROOT_PREFIX)) return null

  // If caller persisted a full path, require it to agree with our computed safe path.
  if (typeof attachment?.path === 'string' && attachment.path.trim()) {
    const persistedPath = path.resolve(attachment.path)
    if (!persistedPath.startsWith(UPLOADS_ROOT_PREFIX)) return null
    if (path.basename(persistedPath) !== filename) return null
  }

  return resolved
}

const deleteAttachmentFromDisk = async (attachment) => {
  const attachmentId = normalizeIdentifier(attachment?.id, ATTACHMENT_ID_RE)
  if (!attachmentId) {
    return
  }

  let trustedFileRecord = null
  try {
    trustedFileRecord = await fileService.getFile(attachmentId)
  } catch (err) {
    console.warn(`[Security] Attachment metadata lookup failed for ${attachmentId}:`, err.message)
    return
  }

  if (!trustedFileRecord || typeof trustedFileRecord !== 'object') {
    return
  }

  // Never trust message-embedded filename/path over file metadata.
  const safePath = resolveSafeAttachmentPath({
    filename: trustedFileRecord.filename,
    path: trustedFileRecord.path || null
  })
  if (!safePath) {
    const unsafeName = typeof attachment?.filename === 'string' ? attachment.filename : '<missing>'
    console.warn(`[Security] Skipping unsafe attachment path during delete: ${unsafeName}`)
    return
  }
  if (!fs.existsSync(safePath)) return
  try {
    fs.unlinkSync(safePath)
    console.log(`[File] Deleted attachment: ${path.basename(safePath)}`)
  } catch (err) {
    console.error(`[File] Failed to delete attachment: ${path.basename(safePath)}`, err)
  }
}

const getServerAuthContext = (channelId, userId) => {
  const serverInfo = getChannelServer(channelId)
  const servers = loadServers()
  const server = servers.find(s => s.id === serverInfo?.serverId) || null
  const isAdmin = server ? hasPermission(server, userId, 'admin') : false
  const canManageMessages = server ? hasPermission(server, userId, 'manage_messages') : false
  return { server, isAdmin, canManageMessages }
}

const canPinOrUnpinMessage = (channelId, userId, message) => {
  const { isAdmin, canManageMessages } = getServerAuthContext(channelId, userId)
  const isAuthor = message?.userId === userId
  return isAdmin || canManageMessages || isAuthor
}

const getChannelReadAccessResult = (channelId, userId) => {
  const channel = findChannelById(channelId)
  if (!channel) {
    return { allowed: false, status: 404, error: 'Channel not found' }
  }
  if (channel?.nsfw && !isUserAgeVerified(userId)) {
    return { allowed: false, status: 451, error: 'Age verification required for this channel', code: 'AGE_VERIFICATION_REQUIRED' }
  }
  if (!canViewChannel(channelId, userId)) {
    return { allowed: false, status: 403, error: 'Cannot view channel' }
  }
  return { allowed: true, channel }
}

const canSendMessageToChannel = (channelId, userId, channel = null) => {
  const resolvedChannel = channel || findChannelById(channelId)
  if (!resolvedChannel) return false

  if (resolvedChannel.type === 'dm' || channelId.startsWith('dm_')) {
    return isUserInDmChannel(resolvedChannel, channelId, userId)
  }

  const serverInfo = getChannelServer(channelId)
  if (!serverInfo?.serverId) return false

  let server = serverService.getServer(serverInfo.serverId)
  if (!server) {
    try {
      const servers = loadData(FILES.servers, {})
      server = servers[serverInfo.serverId]
    } catch (err) {
      console.warn(`[Channel] Failed to reload server ${serverInfo.serverId}:`, err.message)
      return false
    }
  }
  if (!server) return false

  return hasChannelPermission(resolvedChannel, server, userId, 'send_messages')
}

const sanitizeInboundAttachments = async (attachments, { userId, serverId = null } = {}) => {
  if (!Array.isArray(attachments)) return []

  const safeAttachments = []
  const seenAttachmentIds = new Set()

  for (const rawAttachment of attachments.slice(0, MAX_ATTACHMENT_COUNT)) {
    if (!rawAttachment || typeof rawAttachment !== 'object') continue

    const claimedId = normalizeIdentifier(rawAttachment.id, ATTACHMENT_ID_RE)
    let trustedSource = rawAttachment
    let metadataVerified = false

    if (claimedId) {
      try {
        const stored = await fileService.getFile(claimedId)
        if (stored && typeof stored === 'object') {
          const uploadedBy = typeof stored.uploadedBy === 'string' ? stored.uploadedBy.trim() : null
          const storedServerId = typeof stored.serverId === 'string' ? stored.serverId.trim() : null

          if (uploadedBy && uploadedBy !== userId) {
            console.warn(`[Security] Rejected attachment ${claimedId}: uploadedBy mismatch`)
            continue
          }
          if (serverId && storedServerId && storedServerId !== serverId) {
            console.warn(`[Security] Rejected attachment ${claimedId}: serverId mismatch`)
            continue
          }
          trustedSource = { ...stored, id: claimedId }
          metadataVerified = true
        }
      } catch (err) {
        console.warn(`[Security] Attachment metadata lookup failed for ${claimedId}:`, err.message)
      }
    }

    const safeAttachment = sanitizeAttachment(trustedSource)
    if (!safeAttachment) continue

    if (safeAttachment.id) {
      if (seenAttachmentIds.has(safeAttachment.id)) continue
      seenAttachmentIds.add(safeAttachment.id)
    }

    // Unverified client payloads should never carry server-local delete primitives.
    if (!metadataVerified) {
      delete safeAttachment.filename
      delete safeAttachment.provider
    }

    safeAttachments.push(safeAttachment)
  }

  return safeAttachments
}

const safePinnedMessageProjection = (message) => {
  if (!message) return null
  const base = hydrateMessageShape(message)
  if (!base) return null
  return {
    ...base,
    pinnedAt: message?.pinnedAt || null,
    pinnedBy: message?.pinnedBy || null
  }
}

const VALID_CHANNEL_PERMISSIONS = new Set([
  'admin',
  'manage_server',
  'manage_roles',
  'manage_channels',
  'manage_messages',
  'manage_emojis',
  'manage_events',
  'manage_webhooks',
  'kick_members',
  'ban_members',
  'mute_members',
  'deafen_members',
  'move_members',
  'priority_speaker',
  'view_channels',
  'send_messages',
  'send_embeds',
  'attach_files',
  'add_reactions',
  'mention_everyone',
  'manage_threads',
  'manage_invites',
  'create_invites',
  'connect',
  'speak',
  'video',
  'share_screen',
  'use_voice_activity'
])
const CHANNEL_PERMISSION_ALIASES = new Map([
  ['view_channel', 'view_channels']
])
const VALID_OVERWRITE_TYPES = new Set(['role', 'member', 'everyone'])
const MAX_PERMISSION_OVERWRITES = 200
const MAX_PERMISSION_ENTRIES_PER_OVERWRITE = 64
const OVERWRITE_ID_RE = /^[@A-Za-z0-9._:-]{1,128}$/
const RESERVED_OVERRIDE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const toCanonicalPermission = (permission) => {
  if (typeof permission !== 'string') return null
  const raw = permission.trim().toLowerCase()
  if (!raw) return null
  return CHANNEL_PERMISSION_ALIASES.get(raw) || raw
}

const toBoolLike = (value) => {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return null
}

const sanitizePermissionVector = (permissions, fieldName) => {
  if (permissions === undefined || permissions === null) return []
  if (!Array.isArray(permissions)) {
    throw new Error(`"${fieldName}" must be an array`)
  }
  const out = []
  const seen = new Set()
  for (const entry of permissions) {
    const canonical = toCanonicalPermission(entry)
    if (!canonical) continue
    if (!VALID_CHANNEL_PERMISSIONS.has(canonical)) {
      throw new Error(`Invalid permission value: ${entry}`)
    }
    if (!seen.has(canonical)) {
      seen.add(canonical)
      out.push(canonical)
    }
  }
  if (out.length > MAX_PERMISSION_ENTRIES_PER_OVERWRITE) {
    throw new Error('Too many permission entries in overwrite')
  }
  return out
}

const sanitizePermissionOverwrite = (rawOverwrite, explicitId = null) => {
  if (!rawOverwrite || typeof rawOverwrite !== 'object' || Array.isArray(rawOverwrite)) {
    throw new Error('Overwrite must be an object')
  }
  const id = String(explicitId ?? rawOverwrite.id ?? '').trim()
  if (!id || RESERVED_OVERRIDE_KEYS.has(id) || !OVERWRITE_ID_RE.test(id)) {
    throw new Error('Invalid overwrite target id')
  }

  const requestedType = typeof rawOverwrite.type === 'string' ? rawOverwrite.type.trim().toLowerCase() : ''
  let type = requestedType || (id === '@everyone' ? 'everyone' : 'role')
  if (!VALID_OVERWRITE_TYPES.has(type)) {
    throw new Error(`Invalid overwrite type for target ${id}`)
  }
  if (id === '@everyone') type = 'everyone'
  if (type === 'everyone' && id !== '@everyone') {
    throw new Error('Only @everyone can use overwrite type "everyone"')
  }

  let allow = sanitizePermissionVector(rawOverwrite.allow, 'allow')
  let deny = sanitizePermissionVector(rawOverwrite.deny, 'deny')

  // Support legacy frontend booleans for @everyone.
  if (id === '@everyone') {
    const view = toBoolLike(rawOverwrite.view)
    const sendMessages = toBoolLike(rawOverwrite.sendMessages)
    if (view === true && !allow.includes('view_channels')) allow = [...allow, 'view_channels']
    if (view === false && !deny.includes('view_channels')) deny = [...deny, 'view_channels']
    if (sendMessages === true && !allow.includes('send_messages')) allow = [...allow, 'send_messages']
    if (sendMessages === false && !deny.includes('send_messages')) deny = [...deny, 'send_messages']
  }

  // Deny wins if a payload sets the same permission in both arrays.
  allow = allow.filter(permission => !deny.includes(permission))

  return { id, type, allow, deny }
}

const sanitizePermissionOverwriteArray = (permissions, { strict = true } = {}) => {
  if (!Array.isArray(permissions)) return []
  if (permissions.length > MAX_PERMISSION_OVERWRITES) {
    throw new Error(`Too many permission overwrites (max ${MAX_PERMISSION_OVERWRITES})`)
  }
  const map = new Map()
  for (const item of permissions) {
    try {
      const sanitized = sanitizePermissionOverwrite(item)
      map.set(sanitized.id, sanitized)
    } catch (err) {
      if (strict) throw err
    }
  }
  return Array.from(map.values())
}

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
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    for (const attachment of message.attachments) {
      await deleteAttachmentFromDisk(attachment)
    }
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
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        await deleteAttachmentFromDisk(attachment)
      }
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

  if (!canViewChannel(channelId, req.user.id)) {
    return res.status(403).json({ error: 'Cannot view channel' })
  }

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
    const { before, after } = req.query
    const limit = clampInteger(req.query.limit, 50, { min: 1, max: 100 })
    const access = getChannelReadAccessResult(req.params.channelId, req.user.id)
    if (!access.allowed) {
      const payload = { error: access.error }
      if (access.code) payload.code = access.code
      return res.status(access.status).json(payload)
    }

    let messages = await messageService.getChannelMessages(req.params.channelId, limit, before || null)
    messages = Array.isArray(messages)
      ? messages.filter(message => message?.channelId === req.params.channelId)
      : []
  
  let filtered = messages
  
  if (before) {
    filtered = messages.filter(m => new Date(m.timestamp) < new Date(before))
    filtered = filtered.slice(-limit)
  } else if (after) {
    filtered = messages.filter(m => new Date(m.timestamp) > new Date(after))
    filtered = filtered.slice(0, limit)
  } else {
    filtered = messages.slice(-limit)
  }
  
  // Load all reactions once and attach to messages (async, queries SQLite/DB directly)
  const messageIds = filtered.map(m => m.id)
  const allReactions = reactionService.getAllReactions ? await reactionService.getAllReactions(messageIds) : {}

  const byId = new Map(messages.map(m => [m.id, m]))
  const hydrated = filtered.map(msg => {
    const base = hydrateMessageShape(msg)
    // Attach reactions from the reactions store (overrides any stored on the message)
    const msgReactions = allReactions[msg.id]
    if (msgReactions && Object.keys(msgReactions).length > 0) {
      base.reactions = msgReactions
    }
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
	  res.json(hydrated)
})

router.post('/:channelId/messages', 
  authenticateToken,
  validationRateLimit,
  sanitizeInput,
  validateRequest([
    ...validationSchemas.message,
    ...validationSchemas.channelIdParam
  ]),
  async (req, res) => {
  const { content, attachments, replyTo, metadata } = req.body
  const channelId = req.params.channelId

  const access = getChannelReadAccessResult(channelId, req.user.id)
  if (!access.allowed) {
    const payload = { error: access.error }
    if (access.code) payload.code = access.code
    return res.status(access.status).json(payload)
  }

  if (!canSendMessageToChannel(channelId, req.user.id, access.channel)) {
    return res.status(403).json({ error: 'Not authorized to send messages in this channel' })
  }

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

  const channelInfo = access.channel
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
  const safeContent = sanitizeMessageContent(content, 4000)
  const safeReplyTo = normalizeIdentifier(replyTo, MESSAGE_ID_RE)
  const safeAttachments = await sanitizeInboundAttachments(attachments, { userId: req.user.id, serverId })
  const safeMetadata = sanitizeMessageMetadata(metadata)

  if (!safeContent && safeAttachments.length === 0) {
    return res.status(400).json({ error: 'Message content or attachments required' })
  }

  const message = {
    id: uuidv4(),
    channelId,
    userId: req.user.id,
    username: messageUsername,
    avatar: req.user.avatar || getAvatarUrl(req.user.id),
    guildTag: senderProfile?.guildTag || null,
    content: safeContent,
    attachments: safeAttachments,
    replyTo: safeReplyTo,
    storage: safeMetadata ? { metadata: safeMetadata } : {},
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
  const access = getChannelReadAccessResult(req.params.channelId, req.user.id)
  if (!access.allowed) {
    const payload = { error: access.error }
    if (access.code) payload.code = access.code
    return res.status(access.status).json(payload)
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (!q) {
    return res.json([])
  }
  const limit = clampInteger(req.query.limit, 25, { min: 1, max: 100 })
  
  const allMessages = loadMessages()
  const messages = allMessages[req.params.channelId] || []
  const query = q.toLowerCase().slice(0, 200)
  
  const results = messages
    .filter(m => {
      const contentMatch = typeof m?.content === 'string' && m.content.toLowerCase().includes(query)
      const attachmentMatch = Array.isArray(m?.attachments) && m.attachments.some(a =>
        typeof a?.name === 'string' && a.name.toLowerCase().includes(query)
      )
      return contentMatch || attachmentMatch
    })
    .slice(-limit)
    .reverse()
    .map(hydrateMessageShape)
  
  console.log(`[API] Search messages in channel ${req.params.channelId} for "${q}" - found ${results.length} results`)
  res.json(results)
})

router.get('/:channelId/pins', authenticateToken, messageLimiter, (req, res) => {
  try {
    const access = getChannelReadAccessResult(req.params.channelId, req.user.id)
    if (!access.allowed) {
      const payload = { error: access.error }
      if (access.code) payload.code = access.code
      return res.status(access.status).json(payload)
    }
    // Pass channelId so the DB path returns a flat array directly
    const channelPins = loadPinnedMessages(req.params.channelId)
    const pins = (channelPins || []).map(safePinnedMessageProjection).filter(Boolean)
    res.json(pins)
  } catch (err) {
    console.error('[ChannelRoutes] Error in GET /pins:', err.message)
    res.status(500).json({ error: 'Failed to load pinned messages' })
  }
})

router.put('/:channelId/pins/:messageId', authenticateToken, messageLimiter, async (req, res) => {
  const { channelId, messageId } = req.params
  const safeMessageId = normalizeIdentifier(messageId, MESSAGE_ID_RE)
  if (!safeMessageId) {
    return res.status(400).json({ error: 'Invalid message ID' })
  }

  const access = getChannelReadAccessResult(channelId, req.user.id)
  if (!access.allowed) {
    const payload = { error: access.error }
    if (access.code) payload.code = access.code
    return res.status(access.status).json(payload)
  }

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
  if (message.channelId && message.channelId !== channelId) {
    return res.status(404).json({ error: 'Message not found' })
  }
  if (message.deleted) {
    return res.status(400).json({ error: 'Cannot pin deleted message' })
  }
  if (!canPinOrUnpinMessage(channelId, req.user.id, message)) {
    return res.status(403).json({ error: 'Not authorized to pin this message' })
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

router.delete('/:channelId/pins/:messageId', authenticateToken, messageLimiter, async (req, res) => {
  const { channelId, messageId } = req.params
  const safeMessageId = normalizeIdentifier(messageId, MESSAGE_ID_RE)
  if (!safeMessageId) {
    return res.status(400).json({ error: 'Invalid message ID' })
  }

  const access = getChannelReadAccessResult(channelId, req.user.id)
  if (!access.allowed) {
    const payload = { error: access.error }
    if (access.code) payload.code = access.code
    return res.status(access.status).json(payload)
  }

  // Load existing pins for this channel (flat array)
  const channelPins = loadPinnedMessages(channelId)
  if (!channelPins || channelPins.length === 0) {
    return res.status(404).json({ error: 'No pinned messages in this channel' })
  }

  const index = channelPins.findIndex(p => p.id === messageId)
  if (index === -1) {
    return res.status(404).json({ error: 'Pinned message not found' })
  }
  if (!canPinOrUnpinMessage(channelId, req.user.id, channelPins[index])) {
    return res.status(403).json({ error: 'Not authorized to unpin this message' })
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

  // Only members who can view the channel can view its permissions
  if (!canViewChannel(channelId, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  let safePermissions = []
  try {
    safePermissions = sanitizePermissionOverwriteArray(channel.permissions, { strict: false })
  } catch {
    safePermissions = []
  }
  res.json(safePermissions)
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
  try {
    if (Array.isArray(req.body.permissions)) {
      // Full replacement via array
      newPermissions = sanitizePermissionOverwriteArray(req.body.permissions)
    } else if (req.body.overrides && typeof req.body.overrides === 'object' && !Array.isArray(req.body.overrides)) {
      // Frontend sends { overrides: { roleId: { allow: [], deny: [] }, '@everyone': { view, sendMessages } } }
      // Convert to canonical array format and merge with existing.
      const existing = sanitizePermissionOverwriteArray(channel.permissions, { strict: false })
      const merged = new Map(existing.map(item => [item.id, item]))
      const entries = Object.entries(req.body.overrides)
      if (entries.length > MAX_PERMISSION_OVERWRITES) {
        throw new Error(`Too many permission overwrites (max ${MAX_PERMISSION_OVERWRITES})`)
      }
      for (const [id, overrideData] of entries) {
        if (RESERVED_OVERRIDE_KEYS.has(id)) {
          throw new Error('Invalid overwrite target id')
        }
        const overwrite = sanitizePermissionOverwrite(overrideData, id)
        merged.set(overwrite.id, overwrite)
      }
      if (merged.size > MAX_PERMISSION_OVERWRITES) {
        throw new Error(`Too many permission overwrites (max ${MAX_PERMISSION_OVERWRITES})`)
      }
      newPermissions = Array.from(merged.values())
    } else if (req.body.id) {
      // Single overwrite upsert
      const existing = sanitizePermissionOverwriteArray(channel.permissions, { strict: false })
      const merged = new Map(existing.map(item => [item.id, item]))
      const overwrite = sanitizePermissionOverwrite(req.body)
      merged.set(overwrite.id, overwrite)
      if (merged.size > MAX_PERMISSION_OVERWRITES) {
        throw new Error(`Too many permission overwrites (max ${MAX_PERMISSION_OVERWRITES})`)
      }
      newPermissions = Array.from(merged.values())
    } else {
      return res.status(400).json({ error: 'Provide either permissions array, overrides object, or a single overwrite {id, type, allow, deny}' })
    }
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Invalid permissions payload' })
  }

  const updated = await channelService.updateChannel(channelId, {
    permissions: newPermissions,
    updatedAt: new Date().toISOString()
  })
  if (!updated) return res.status(404).json({ error: 'Channel not found' })

  io.to(`server:${serverId}`).emit('channel:updated', updated)
  console.log(`[API] Updated permissions for channel ${channelId}`)
  res.json(sanitizePermissionOverwriteArray(updated.permissions, { strict: false }))
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

  const existing = sanitizePermissionOverwriteArray(channel.permissions, { strict: false })
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
