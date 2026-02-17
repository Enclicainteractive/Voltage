import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { userService } from '../services/dataService.js'
import { io } from '../server.js'
import config from '../config/config.js'

const getAvatarUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json')
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json')
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json')
const PINNED_FILE = path.join(DATA_DIR, 'pinned-messages.json')

const loadData = (file, defaultValue = []) => {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (err) {
    console.error(`[Data] Error loading ${file}:`, err.message)
  }
  return defaultValue
}

const saveData = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error(`[Data] Error saving ${file}:`, err.message)
  }
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const loadChannels = () => {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[Data] Error loading channels:', err.message)
  }
  return {}
}

const saveChannels = (channels) => {
  try {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2))
  } catch (err) {
    console.error('[Data] Error saving channels:', err.message)
  }
}

const loadServers = () => {
  try {
    if (fs.existsSync(SERVERS_FILE)) {
      return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[Data] Error loading servers:', err.message)
  }
  return []
}

const getChannelServer = (channelId) => {
  const channels = loadChannels()
  for (const [serverId, list] of Object.entries(channels)) {
    const found = (list || []).find(c => c.id === channelId)
    if (found) {
      return { serverId, channel: found, channels }
    }
  }
  return null
}

const getMemberRoles = (server, userId) => {
  const member = server?.members?.find(m => m.id === userId)
  if (!member) return []
  if (Array.isArray(member.roles)) return member.roles
  return member.role ? [member.role] : []
}

const isUserAgeVerified = (userId) => {
  try {
    return userService.isAgeVerified(userId)
  } catch (err) {
    console.error('[Age Verification] Failed to check status:', err.message)
    return false
  }
}

const computePermissions = (server, userId) => {
  if (!server) return new Set()
  if (server.ownerId === userId) return new Set(['admin'])
  
  const member = server.members?.find(m => m.id === userId)
  if (!member) return new Set() // Non-members get no permissions
  
  const permSet = new Set(['view_channels', 'send_messages', 'connect', 'speak', 'use_voice_activity'])
  const roleIds = getMemberRoles(server, userId)
  roleIds.forEach(rid => {
    const role = server.roles?.find(r => r.id === rid)
    role?.permissions?.forEach(p => permSet.add(p))
  })
  if (permSet.has('admin')) return new Set(['admin'])
  return permSet
}

const hasPermission = (server, userId, permission) => {
  if (server?.ownerId === userId) return true
  const perms = computePermissions(server, userId)
  return perms.has('admin') || perms.has(permission)
}

const router = express.Router()

const loadMessages = () => {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[Data] Error loading messages:', err.message)
  }
  return {}
}

const saveMessages = (messages) => {
  try {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2))
  } catch (err) {
    console.error('[Data] Error saving messages:', err.message)
  }
}

const loadPinnedMessages = () => {
  try {
    if (fs.existsSync(PINNED_FILE)) {
      return JSON.parse(fs.readFileSync(PINNED_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[Data] Error loading pinned messages:', err.message)
  }
  return {}
}

const savePinnedMessages = (pinned) => {
  try {
    fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2))
  } catch (err) {
    console.error('[Data] Error saving pinned messages:', err.message)
  }
}

export const findChannelById = (channelId) => {
  const channels = loadChannels()
  for (const list of Object.values(channels)) {
    const found = (list || []).find(c => c.id === channelId)
    if (found) return found
  }
  return null
}

export const addMessage = (channelId, message) => {
  const allMessages = loadMessages()
  if (!allMessages[channelId]) {
    allMessages[channelId] = []
  }
  allMessages[channelId].push(message)
  saveMessages(allMessages)
  return message
}

export const getChannelMessages = (channelId, limit = 50) => {
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  return messages.slice(-limit)
}

export const editMessage = (channelId, messageId, userId, newContent) => {
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  const messageIndex = messages.findIndex(m => m.id === messageId)
  
  if (messageIndex === -1) return null
  if (messages[messageIndex].userId !== userId) return null
  
  messages[messageIndex].content = newContent
  messages[messageIndex].edited = true
  messages[messageIndex].editedAt = new Date().toISOString()
  
  saveMessages(allMessages)
  return messages[messageIndex]
}

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

export const deleteMessage = (channelId, messageId, userId) => {
  const allMessages = loadMessages()
  const messages = allMessages[channelId] || []
  const messageIndex = messages.findIndex(m => m.id === messageId)
  
  if (messageIndex === -1) return { success: false, error: 'Message not found' }
  
  const serverInfo = getChannelServer(channelId)
  const servers = loadServers()
  const server = servers.find(s => s.id === serverInfo?.serverId)
  const isAdmin = server ? hasPermission(server, userId, 'admin') : false
  
  if (messages[messageIndex].userId !== userId && !isAdmin) {
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
  
  messages.splice(messageIndex, 1)
  saveMessages(allMessages)
  return { success: true }
}

router.get('/:channelId/messages', authenticateToken, (req, res) => {
  const { limit = 50, before, after } = req.query
  const channelInfo = findChannelById(req.params.channelId)
  if (channelInfo?.nsfw && !isUserAgeVerified(req.user.id)) {
    return res.status(451).json({ error: 'Age verification required for this channel', code: 'AGE_VERIFICATION_REQUIRED' })
  }
  const allMessages = loadMessages()
  let messages = allMessages[req.params.channelId] || []
  
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
  
  console.log(`[API] Get messages for channel ${req.params.channelId} - returned ${filtered.length} messages`)
  res.json(filtered)
})

router.post('/:channelId/messages', authenticateToken, (req, res) => {
  const { content, attachments } = req.body
  const channelId = req.params.channelId

  const channelInfo = findChannelById(channelId)
  if (channelInfo?.nsfw && !isUserAgeVerified(req.user.id)) {
    return res.status(451).json({ error: 'Age verification required for this channel', code: 'AGE_VERIFICATION_REQUIRED' })
  }
  
  const message = {
    id: uuidv4(),
    channelId,
    userId: req.user.id,
    username: req.user.username || req.user.email,
    avatar: getAvatarUrl(req.user.id),
    content,
    attachments: attachments || [],
    timestamp: new Date().toISOString()
  }
  
  addMessage(channelId, message)
  
  console.log(`[API] Created message in channel ${channelId}`)
  res.status(201).json(message)
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

  const allChannels = found.channels
  const list = allChannels[found.serverId] || []
  const idx = list.findIndex(c => c.id === req.params.channelId)
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' })

  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() }
  allChannels[found.serverId] = list
  saveChannels(allChannels)
  
  if (req.body.isDefault) {
    server.defaultChannelId = req.params.channelId
    const serverIdx = servers.findIndex(s => s.id === found.serverId)
    servers[serverIdx] = server
    saveData(SERVERS_FILE, servers)
    io.to(`server:${found.serverId}`).emit('server:updated', server)
  }
  
  io.to(`server:${found.serverId}`).emit('channel:updated', list[idx])
  
  console.log(`[API] Updated channel ${req.params.channelId}`)
  res.json(list[idx])
})

router.delete('/:channelId', authenticateToken, (req, res) => {
  const found = getChannelServer(req.params.channelId)
  if (!found) return res.status(404).json({ error: 'Channel not found' })

  const servers = loadServers()
  const server = servers.find(s => s.id === found.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to delete channels' })
  }

  const allChannels = found.channels
  allChannels[found.serverId] = (allChannels[found.serverId] || []).filter(c => c.id !== req.params.channelId)
  saveChannels(allChannels)
  
  io.to(`server:${found.serverId}`).emit('channel:deleted', { channelId: req.params.channelId })
  
  console.log(`[API] Deleted channel ${req.params.channelId}`)
  res.json({ success: true })
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

router.put('/:channelId/pins/:messageId', authenticateToken, (req, res) => {
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
  savePinnedMessages(pinned)
  
  console.log(`[API] Pinned message ${messageId} in channel ${channelId}`)
  res.json({ success: true })
})

router.delete('/:channelId/pins/:messageId', authenticateToken, (req, res) => {
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
  savePinnedMessages(pinned)
  
  console.log(`[API] Unpinned message ${messageId} from channel ${channelId}`)
  res.json({ success: true })
})

export default router
