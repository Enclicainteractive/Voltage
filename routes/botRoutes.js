import express from 'express'
import zlib from 'zlib'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { botService } from '../services/botService.js'
import { io } from '../server.js'
import { adminService, channelService, messageService, serverService, userService } from '../services/dataService.js'
import { addMessage, loadMessages, pendingMessageWrites, scheduleMessageFlush } from './channelRoutes.js'
import { getBotSockets } from '../services/socketService.js'

const isServerMember = (server, userId) => (
  server?.ownerId === userId ||
  (Array.isArray(server?.members) && server.members.some(m => m.id === userId))
)

const toOwnerBot = (bot, { includeToken = false } = {}) => {
  if (!bot || typeof bot !== 'object') return bot
  const { token, tokenHash, webhookSecret, ...safe } = bot
  if (includeToken && token) return { ...safe, token }
  return safe
}

/**
 * Strip sensitive fields (owner identity + install footprint + internal config)
 * from a bot record before returning it in public/listing responses.
 */
const toPublicBot = (bot) => {
  const ownerSafe = toOwnerBot(bot)
  if (!ownerSafe || typeof ownerSafe !== 'object') return ownerSafe
  const {
    ownerId,
    installedServers,
    servers,
    permissions,
    intents,
    commands,
    webhookUrl,
    updatedAt,
    lastActive,
    ...rest
  } = ownerSafe
  return rest
}

/**
 * Returns true when the requester should be allowed to see the full bot
 * record (owner identity + installed-server list).
 */
const canSeeFullBot = (bot, userId) => {
  if (!bot || !userId) return false
  if (bot.ownerId === userId) return true
  try {
    if (adminService?.isAdmin && adminService.isAdmin(userId)) return true
  } catch {
    // adminService unavailable — treat as non-admin
  }
  return false
}

const canViewBot = (bot, userId) => {
  if (!bot || !userId) return false
  if (canSeeFullBot(bot, userId)) return true
  if (bot.public) return true
  const installedServerIds = Array.isArray(bot.servers)
    ? bot.servers
    : (Array.isArray(bot.installedServers) ? bot.installedServers : [])
  if (installedServerIds.length === 0) return false
  const servers = getServers()
  return installedServerIds.some((serverId) => {
    const server = servers.find(s => s.id === serverId)
    return isServerMember(server, userId)
  })
}

const botSharesServerWithUser = (bot, userId) => {
  if (!bot || !userId) return false
  const installedServerIds = new Set(Array.isArray(bot.servers) ? bot.servers : [])
  if (installedServerIds.size === 0) return false
  const servers = getServers()
  return servers.some((server) => (
    installedServerIds.has(server.id) &&
    (server.ownerId === userId || (Array.isArray(server.members) && server.members.some(m => m.id === userId)))
  ))
}

/**
 * Get all servers as an array. Uses dataService instead of direct fs access.
 */
const getServers = () => {
  try {
    const servers = serverService.getAllServers()
    if (Array.isArray(servers)) return servers
    if (servers && typeof servers === 'object') return Object.values(servers)
  } catch (err) {
    console.error('[Data] Error loading servers:', err.message)
  }
  return []
}

/**
 * Save the servers array back to storage via serverService.
 * Updates each server individually.
 */
const saveServers = async (serversArray) => {
  for (const server of serversArray) {
    if (server && server.id) {
      await serverService.updateServer(server.id, server)
    }
  }
}

const canManageServer = (server, userId) => {
  if (server.ownerId === userId) return true
  const member = server.members?.find(m => m.id === userId)
  if (!member) return false
  const roleIds = Array.isArray(member.roles) ? member.roles : (member.role ? [member.role] : [])
  for (const roleId of roleIds) {
    const role = server.roles?.find(r => r.id === roleId)
    if (role?.permissions?.includes('admin') || role?.permissions?.includes('manage_server')) return true
  }
  return false
}

const toSafeMember = (member) => ({
  id: member?.id || null,
  username: member?.username || null,
  avatar: member?.avatar || null,
  roles: Array.isArray(member?.roles) ? member.roles : [],
  role: member?.role || (Array.isArray(member?.roles) ? member.roles[0] || null : null),
  status: member?.status || 'offline',
  isBot: Boolean(member?.isBot)
})

const resolveBotChannelAccess = (bot, channelId) => {
  const channel = channelService.getChannel(channelId)
  if (!channel) return { status: 404, error: 'Channel not found' }

  const serverId = channel.serverId
  if (!serverId || typeof serverId !== 'string') {
    return { status: 403, error: 'Channel is not associated with a server' }
  }
  if (!Array.isArray(bot?.servers) || !bot.servers.includes(serverId)) {
    return { status: 403, error: 'Bot not in this server' }
  }
  return { channel, serverId }
}

const getMessageChannelId = (message) => (
  typeof message?.channelId === 'string' ? message.channelId : null
)

const ensureMessageInChannel = async (messageId, channelId) => {
  const message = await messageService.getMessage(messageId)
  if (!message) return { status: 404, error: 'Message not found' }
  if (getMessageChannelId(message) !== channelId) {
    return { status: 403, error: 'Message does not belong to this channel' }
  }
  return { message }
}

const router = express.Router()

// Middleware to authenticate bot token
const authenticateBot = async (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bot ')) {
    return res.status(401).json({ error: 'Bot token required. Use Authorization: Bot <token>' })
  }

  const token = authHeader.slice(4)
  const bot = await botService.getBotByToken(token)
  if (!bot) return res.status(401).json({ error: 'Invalid bot token' })

  req.bot = bot
  next()
}

// === User-facing bot management ===

// List my bots
router.get('/my', authenticateToken, async (req, res) => {
  const bots = await botService.getBotsByOwner(req.user.id)
  res.json((Array.isArray(bots) ? bots : []).map((bot) => toOwnerBot(bot)))
})

// Create a bot
router.post('/', authenticateToken, async (req, res) => {
  const { name, description, avatar, prefix, permissions, intents, webhookUrl } = req.body
  if (!name || name.length < 2 || name.length > 32) {
    return res.status(400).json({ error: 'Name must be 2-32 characters' })
  }

  const bot = await botService.createBot(req.user.id, {
    name, description, avatar, prefix, permissions, intents, webhookUrl, public: req.body.public
  })

  res.json(toOwnerBot(bot, { includeToken: true }))
})

// Get bot details
router.get('/:botId', authenticateToken, async (req, res) => {
  const bot = await botService.getBot(req.params.botId)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
  if (!canViewBot(bot, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to view this bot' })
  }
  // Only the bot's owner or platform admins see ownerId / installedServers /
  // servers list. Everyone else gets the public projection.
  if (canSeeFullBot(bot, req.user.id)) return res.json(toOwnerBot(bot))
  res.json(toPublicBot(bot))
})

// Update bot
router.put('/:botId', authenticateToken, async (req, res) => {
  const result = await botService.updateBot(req.params.botId, req.user.id, req.body)
  if (!result) return res.status(404).json({ error: 'Bot not found' })
  if (result.error) return res.status(403).json(result)
  res.json(toOwnerBot(result))
})

// Delete bot
router.delete('/:botId', authenticateToken, async (req, res) => {
  const success = await botService.deleteBot(req.params.botId, req.user.id)
  if (!success) return res.status(404).json({ error: 'Bot not found or not authorized' })
  res.json({ success: true })
})

// Regenerate bot token
router.post('/:botId/regenerate-token', authenticateToken, async (req, res) => {
  const token = await botService.regenerateToken(req.params.botId, req.user.id)
  if (!token) return res.status(404).json({ error: 'Bot not found or not authorized' })
  res.json({ token, message: 'Store this token securely - it will not be shown again' })
})

// Add bot to server
router.post('/:botId/servers/:serverId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!canManageServer(server, req.user.id)) return res.status(403).json({ error: 'Not authorized to manage bots' })

  const bot = await botService.getBot(req.params.botId)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
  if (!bot.public && !canSeeFullBot(bot, req.user.id)) {
    return res.status(403).json({ error: 'Bot is private and cannot be installed by this user' })
  }

  await botService.addBotToServer(req.params.botId, req.params.serverId)
  
  if (!server.members) server.members = []
  const existingMember = server.members.find(m => m.id === bot.id)
  if (!existingMember) {
    server.members.push({
      id: bot.id,
      username: bot.name,
      avatar: bot.avatar || null,
      roles: bot.roles || [],
      role: bot.roles?.[0] || null,
      status: 'online',
      isBot: true
    })
    await saveServers(servers)
  }
  
  io.to(`server:${req.params.serverId}`).emit('bot:added', {
    serverId: req.params.serverId,
    bot: bot
  })

  res.json({ success: true })
})

// Remove bot from server
router.delete('/:botId/servers/:serverId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!canManageServer(server, req.user.id)) return res.status(403).json({ error: 'Not authorized to manage bots' })

  await botService.removeBotFromServer(req.params.botId, req.params.serverId)
  
  if (server.members) {
    server.members = server.members.filter(m => m.id !== req.params.botId)
    await saveServers(servers)
  }
  
  io.to(`server:${req.params.serverId}`).emit('bot:removed', {
    serverId: req.params.serverId,
    botId: req.params.botId
  })

  // Notify the bot directly via their unique room
  io.to(`bot:${req.params.botId}`).emit('bot:remove-from-server', { serverId: req.params.serverId })

  res.json({ success: true })
})

// Get bots in a server
router.get('/server/:serverId', authenticateToken, async (req, res) => {
  // Membership gate — only members of this server should be able to enumerate
  // its installed bots. Mirrors isServerMember() pattern from serverRoutes.js
  // (intentionally inlined to avoid cross-route coupling).
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  const isMember = server.ownerId === req.user.id ||
    (Array.isArray(server.members) && server.members.some(m => m.id === req.user.id))
  if (!isMember) return res.status(403).json({ error: 'Not a member of this server' })

  const bots = await botService.getServerBots(req.params.serverId)
  // Strip ownerId / installedServers / servers from each bot unless the
  // requester is that bot's owner or a platform admin.
  const sanitized = (Array.isArray(bots) ? bots : []).map((bot) =>
    canSeeFullBot(bot, req.user.id) ? toOwnerBot(bot) : toPublicBot(bot)
  )
  res.json(sanitized)
})

// Browse public bots
router.get('/public/browse', authenticateToken, async (req, res) => {
  // Public directory: NEVER leak ownerId or which servers a bot is installed
  // in. Even a logged-in user iterating this list should not be able to
  // enumerate server UUIDs through the bot footprint.
  const bots = await botService.getAllPublicBots()
  const sanitized = (Array.isArray(bots) ? bots : []).map(toPublicBot)
  res.json(sanitized)
})

// Get bot profile (public-safe, for display in UI)
router.get('/:botId/profile', authenticateToken, async (req, res) => {
  const bot = await botService.getBot(req.params.botId)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
  if (!canViewBot(bot, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to view this bot profile' })
  }
  res.json({
    id: bot.id,
    username: bot.name,
    displayName: bot.name,
    avatar: bot.avatar || null,
    description: bot.description || '',
    status: bot.status || 'offline',
    isBot: true,
    createdAt: bot.createdAt,
    public: bot.public,
    prefix: bot.prefix,
    commands: await botService.getBotCommands(bot.id)
  })
})

// Get bot commands
router.get('/:botId/commands', authenticateToken, async (req, res) => {
  const bot = await botService.getBot(req.params.botId)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
  if (!canViewBot(bot, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to view this bot commands list' })
  }
  res.json(await botService.getBotCommands(req.params.botId))
})

// === Bot API (used by bots themselves via Bot token) ===

// Bot: get self info
router.get('/api/me', authenticateBot, (req, res) => {
  res.json({
    id: req.bot.id,
    name: req.bot.name,
    servers: req.bot.servers,
    permissions: req.bot.permissions,
    intents: req.bot.intents
  })
})

// Bot: send message to a channel
router.post('/api/channels/:channelId/messages', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }

  const { content, embeds, attachments, ui } = req.body
  if (!content && !embeds?.length && !ui) {
    return res.status(400).json({ error: 'Content, embeds, or ui required' })
  }

  const message = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    channelId: req.params.channelId,
    userId: req.bot.id,
    username: req.bot.name,
    avatar: req.bot.avatar,
    content: content || '',
    embeds: embeds || [],
    attachments: attachments || [],
    ui: ui || null,
    bot: true,
    timestamp: new Date().toISOString()
  }

  try {
    await addMessage(req.params.channelId, message, { awaitPersist: false })
    io.to(`channel:${req.params.channelId}`).emit('message:new', message)
    res.json(message)
  } catch (err) {
    console.error('[BotRoutes] Failed to persist bot message:', err.message)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// Bot: get messages from a channel
router.get('/api/channels/:channelId/messages', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:read')) {
    return res.status(403).json({ error: 'Missing messages:read permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }

  const limit = parseInt(req.query.limit, 10) || 50
  const messages = await messageService.getChannelMessages(req.params.channelId, limit)
  res.json(messages)
})

// Bot: register slash commands
router.put('/api/commands', authenticateBot, async (req, res) => {
  const { commands } = req.body
  if (!Array.isArray(commands)) {
    return res.status(400).json({ error: 'Commands must be an array' })
  }

  await botService.registerCommands(req.bot.id, commands)
  res.json({ success: true, count: commands.length })
})

// Bot: update status + optional customStatus
router.put('/api/status', authenticateBot, async (req, res) => {
  const { status, customStatus } = req.body
  const newStatus = status || 'online'
  await botService.setBotStatus(req.bot.id, newStatus, customStatus)

  // Broadcast to every connected client so the members bar updates in real-time
  io.emit('user:status', {
    userId:       req.bot.id,
    status:       newStatus,
    customStatus: customStatus ?? null,
    isBot:        true
  })

  res.json({ success: true })
})

// Bot: get server members
router.get('/api/servers/:serverId/members', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'members:read')) {
    return res.status(403).json({ error: 'Missing members:read permission' })
  }

  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  res.json((server.members || []).map(toSafeMember))
})

// Bot: add reaction
router.post('/api/channels/:channelId/messages/:messageId/reactions', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'reactions:add')) {
    return res.status(403).json({ error: 'Missing reactions:add permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }

  const messageAccess = await ensureMessageInChannel(req.params.messageId, req.params.channelId)
  if (messageAccess.error) {
    return res.status(messageAccess.status).json({ error: messageAccess.error })
  }

  const { emoji } = req.body
  io.to(`channel:${req.params.channelId}`).emit('reaction:updated', {
    messageId: req.params.messageId,
    action: 'add',
    userId: req.bot.id,
    emoji
  })
  res.json({ success: true })
})

// Bot: gateway info (for WebSocket connection)
router.get('/api/gateway', authenticateBot, (req, res) => {
  // req.protocol reflects the internal protocol (http) when behind a reverse
  // proxy. Honour X-Forwarded-Proto so bots behind HTTPS proxies receive the
  // correct wss-compatible https:// URL and don't hit a 301 redirect.
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  res.json({
    url: `${proto}://${req.get('host')}`,
    encoding: 'json',
    version: 1
  })
})

// =========================================================================
// Bot: server info
// =========================================================================

router.get('/api/servers/:serverId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:read')) {
    return res.status(403).json({ error: 'Missing channels:read permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  // Strip sensitive internal fields before returning
  const { bans: _bans, ...safe } = server
  res.json(safe)
})

// =========================================================================
// Bot: channels
// =========================================================================

router.get('/api/servers/:serverId/channels', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:read')) {
    return res.status(403).json({ error: 'Missing channels:read permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  // Channels may be stored in the server object OR via channelService (DB).
  // Check both sources and return whichever has data.
  let channels = server.channels
  if (!channels || (Array.isArray(channels) && channels.length === 0)) {
    // Fall back to channelService which reads from the database
    const serviceChannels = channelService.getServerChannels(req.params.serverId)
    if (serviceChannels && serviceChannels.length > 0) {
      channels = serviceChannels
    }
  }
  res.json(channels || [])
})

router.get('/api/channels/:channelId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:read')) {
    return res.status(403).json({ error: 'Missing channels:read permission' })
  }
  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }
  res.json(channelAccess.channel)
})

// Bot: typing indicator (fire-and-forget; clients display it briefly)
router.post('/api/channels/:channelId/typing', authenticateBot, (req, res) => {
  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }

  io.to(`channel:${req.params.channelId}`).emit('user:typing', {
    userId:   req.bot.id,
    username: req.bot.name,
    channelId: req.params.channelId,
    bot: true
  })
  res.json({ success: true })
})

// =========================================================================
// Bot: message operations (edit, delete, pin)
// =========================================================================

router.put('/api/channels/:channelId/messages/:messageId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }
  const { serverId } = channelAccess

  const messageAccess = await ensureMessageInChannel(req.params.messageId, req.params.channelId)
  if (messageAccess.error) {
    return res.status(messageAccess.status).json({ error: messageAccess.error })
  }
  if (messageAccess.message.userId !== req.bot.id) {
    return res.status(403).json({ error: 'Bots can only edit their own messages' })
  }

  const { content, embeds, ui } = req.body
  
  const allMessages = loadMessages()
  const messages = allMessages[req.params.channelId] || []
  const existingMsg = messages.find(m => m.id === req.params.messageId)
  
  const updated = await messageService.editMessage(req.params.messageId, content, {
    ui: ui !== undefined ? ui : (existingMsg?.ui || null),
    embeds: embeds !== undefined ? embeds : (existingMsg?.embeds || [])
  })
  
  const editPayload = updated || {
    messageId: req.params.messageId,
    channelId: req.params.channelId,
    content: content || '',
    embeds: embeds || [],
    ui: ui !== undefined ? ui : (existingMsg?.ui || null),
    edited: true
  }
  
  io.to(`channel:${req.params.channelId}`).emit('message:edited', editPayload)
  
  // Emit canvas-specific events for realtime canvas updates
  if (ui?.canvas) {
    const canvasData = ui.canvas
    
    // Check if this is a canvas clear operation
    if (canvasData.clear) {
      io.to(`channel:${req.params.channelId}`).emit('ui:canvasClear', {
        messageId: req.params.messageId,
        channelId: req.params.channelId,
        canvas: canvasData
      })
    }
    // Check if this is a bulk pixel update operation (more efficient for real-time frames)
    else if (canvasData.update && canvasData.bulkPixels) {
      io.to(`channel:${req.params.channelId}`).emit('ui:canvasBulkPixelUpdate', {
        messageId: req.params.messageId,
        channelId: req.params.channelId,
        bulkPixels: canvasData.bulkPixels
      })
    }
    // Check if this is a pixel update operation
    else if (canvasData.update && canvasData.pixels) {
      io.to(`channel:${req.params.channelId}`).emit('ui:canvasPixelUpdate', {
        messageId: req.params.messageId,
        channelId: req.params.channelId,
        pixels: canvasData.pixels
      })
    }
    // Full canvas update
    else if (canvasData.pixels || canvasData.width || canvasData.height) {
      io.to(`channel:${req.params.channelId}`).emit('ui:canvasUpdate', {
        messageId: req.params.messageId,
        channelId: req.params.channelId,
        canvas: canvasData
      })
    }
  }
  
  if (serverId) {
    const botSockets = getBotSockets()
    for (const [botId, botSocketId] of botSockets.entries()) {
      if (botId === req.bot.id) continue
      const botSocket = io.sockets.sockets.get(botSocketId)
      if (!botSocket) continue
      const bot = await botService.getBot(botId)
      if (bot?.servers.includes(serverId)) {
        botSocket.emit('message:edited', { ...editPayload, serverId })
      }
    }
  }
  
  res.json(editPayload)
})

router.delete('/api/channels/:channelId/messages/:messageId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:delete')) {
    return res.status(403).json({ error: 'Missing messages:delete permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }

  const messageAccess = await ensureMessageInChannel(req.params.messageId, req.params.channelId)
  if (messageAccess.error) {
    return res.status(messageAccess.status).json({ error: messageAccess.error })
  }

  await messageService.deleteMessage(req.params.messageId)
  io.to(`channel:${req.params.channelId}`).emit('message:deleted', {
    messageId: req.params.messageId,
    channelId: req.params.channelId
  })
  res.json({ success: true })
})

router.post('/api/channels/:channelId/messages/:messageId/pin', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }
  const messageAccess = await ensureMessageInChannel(req.params.messageId, req.params.channelId)
  if (messageAccess.error) {
    return res.status(messageAccess.status).json({ error: messageAccess.error })
  }

  io.to(`channel:${req.params.channelId}`).emit('message:pinned', {
    messageId: req.params.messageId,
    channelId: req.params.channelId,
    pinnedBy: req.bot.id
  })
  res.json({ success: true })
})

router.delete('/api/channels/:channelId/messages/:messageId/pin', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }
  const messageAccess = await ensureMessageInChannel(req.params.messageId, req.params.channelId)
  if (messageAccess.error) {
    return res.status(messageAccess.status).json({ error: messageAccess.error })
  }

  io.to(`channel:${req.params.channelId}`).emit('message:unpinned', {
    messageId: req.params.messageId,
    channelId: req.params.channelId
  })
  res.json({ success: true })
})

// =========================================================================
// Bot: reactions (remove)
// =========================================================================

router.delete('/api/channels/:channelId/messages/:messageId/reactions', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'reactions:add')) {
    return res.status(403).json({ error: 'Missing reactions:add permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }
  const messageAccess = await ensureMessageInChannel(req.params.messageId, req.params.channelId)
  if (messageAccess.error) {
    return res.status(messageAccess.status).json({ error: messageAccess.error })
  }

  const { emoji } = req.body
  io.to(`channel:${req.params.channelId}`).emit('reaction:updated', {
    messageId: req.params.messageId,
    action: 'remove',
    userId: req.bot.id,
    emoji
  })
  res.json({ success: true })
})

// =========================================================================
// Bot: moderation — kick, ban, unban, bans list
// =========================================================================

router.get('/api/servers/:serverId/members/:userId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'members:read')) {
    return res.status(403).json({ error: 'Missing members:read permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  const member = Array.isArray(server.members) ? server.members.find(m => m.id === req.params.userId) : undefined
  if (!member) return res.status(404).json({ error: 'Member not found' })
  res.json(toSafeMember(member))
})

router.delete('/api/servers/:serverId/members/:userId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'members:manage')) {
    return res.status(403).json({ error: 'Missing members:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  const server = servers[idx]
  const memberIdx = (server.members || []).findIndex(m => m.id === req.params.userId)
  if (memberIdx === -1) return res.status(404).json({ error: 'Member not found' })

  server.members.splice(memberIdx, 1)
  try {
    await saveServers(servers)
  } catch (err) {
    console.error('[Bot] Error saving server:', err)
    return res.status(500).json({ error: 'Failed to save server data' })
  }

  io.to(`server:${req.params.serverId}`).emit('member:left', {
    userId: req.params.userId,
    serverId: req.params.serverId,
    reason: req.body?.reason || 'Kicked by bot'
  })
  res.json({ success: true })
})

router.post('/api/servers/:serverId/bans/:userId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'members:manage')) {
    return res.status(403).json({ error: 'Missing members:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  const server = servers[idx]
  if (!server.bans) server.bans = []

  // Remove from members if present
  server.members = Array.isArray(server.members) ? server.members.filter(m => m.id !== req.params.userId) : []

  const alreadyBanned = server.bans.find(b => b.userId === req.params.userId)
  if (!alreadyBanned) {
    server.bans.push({
      userId: req.params.userId,
      reason: req.body?.reason || 'Banned by bot',
      bannedBy: req.bot.id,
      bannedAt: new Date().toISOString()
    })
  }
  try {
    await saveServers(servers)
  } catch (err) {
    console.error('[Bot] Error saving server:', err)
    return res.status(500).json({ error: 'Failed to save server data' })
  }

  io.to(`server:${req.params.serverId}`).emit('member:left', {
    userId: req.params.userId,
    serverId: req.params.serverId,
    reason: req.body?.reason || 'Banned by bot'
  })
  res.json({ success: true })
})

router.delete('/api/servers/:serverId/bans/:userId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'members:manage')) {
    return res.status(403).json({ error: 'Missing members:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  servers[idx].bans = (servers[idx].bans || []).filter(b => b.userId !== req.params.userId)
  try {
    await saveServers(servers)
  } catch (err) {
    console.error('[Bot] Error saving server:', err)
    return res.status(500).json({ error: 'Failed to save server data' })
  }
  res.json({ success: true })
})

router.get('/api/servers/:serverId/bans', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'members:manage')) {
    return res.status(403).json({ error: 'Missing members:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  res.json(server.bans || [])
})

// =========================================================================
// Bot: roles
// =========================================================================

router.get('/api/servers/:serverId/roles', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:read')) {
    return res.status(403).json({ error: 'Missing channels:read permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  res.json(server.roles || [])
})

router.post('/api/servers/:serverId/members/:userId/roles/:roleId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'roles:manage')) {
    return res.status(403).json({ error: 'Missing roles:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  const role = (servers[idx].roles || []).find(r => r.id === req.params.roleId)
  if (!role) return res.status(404).json({ error: 'Role not found' })
  const member = (servers[idx].members || []).find(m => m.id === req.params.userId)
  if (!member) return res.status(404).json({ error: 'Member not found' })

  if (!Array.isArray(member.roles)) member.roles = []
  if (!member.roles.includes(req.params.roleId)) {
    member.roles.push(req.params.roleId)
    try {
      await saveServers(servers)
    } catch (err) {
      console.error('[Bot] Error saving server:', err)
      return res.status(500).json({ error: 'Failed to save server data' })
    }
  }
  io.to(`server:${req.params.serverId}`).emit('member:updated', { member })
  res.json({ success: true })
})

router.delete('/api/servers/:serverId/members/:userId/roles/:roleId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'roles:manage')) {
    return res.status(403).json({ error: 'Missing roles:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  const role = (servers[idx].roles || []).find(r => r.id === req.params.roleId)
  if (!role) return res.status(404).json({ error: 'Role not found' })
  const member = (servers[idx].members || []).find(m => m.id === req.params.userId)
  if (!member) return res.status(404).json({ error: 'Member not found' })

  member.roles = Array.isArray(member.roles) ? member.roles.filter(r => r !== req.params.roleId) : []
  try {
    await saveServers(servers)
  } catch (err) {
    console.error('[Bot] Error saving server:', err)
    return res.status(500).json({ error: 'Failed to save server data' })
  }
  io.to(`server:${req.params.serverId}`).emit('member:updated', { member })
  res.json({ success: true })
})

router.post('/migrate-to-members', authenticateToken, async (req, res) => {
  if (!adminService.isAdmin(req.user.id)) {
    return res.status(403).json({ error: 'Admin privileges required' })
  }
  const servers = getServers()
  const result = await botService.syncBotsWithServerMembers(servers, saveServers)
  res.json({ success: true, ...result })
})

// Bot: bulk delete messages
router.post('/api/channels/:channelId/messages/bulk-delete', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:delete')) {
    return res.status(403).json({ error: 'Missing messages:delete permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }

  const { messageIds } = req.body
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds array required' })
  }

  const allMessages = loadMessages()
  const messages = allMessages[req.params.channelId] || []
  const deletedIds = []

  for (const msgId of messageIds) {
    const idx = messages.findIndex(m => m.id === msgId)
    if (idx !== -1) {
      messages.splice(idx, 1)
      deletedIds.push(msgId)
    }
  }

  allMessages[req.params.channelId] = messages
  pendingMessageWrites += 1
  await scheduleMessageFlush({ immediate: true })

  io.to(`channel:${req.params.channelId}`).emit('messages:bulk-deleted', {
    channelId: req.params.channelId,
    messageIds: deletedIds
  })

  res.json({ success: true, deleted: deletedIds.length })
})

// Bot: send DM to user
router.post('/api/dm/:userId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }
  if (!botSharesServerWithUser(req.bot, req.params.userId)) {
    return res.status(403).json({ error: 'Bot does not share a server with this user' })
  }
  const targetUser = userService.getUser(req.params.userId)
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' })
  }

  const { content, embeds, attachments, ui } = req.body
  if (!content && !embeds?.length && !ui) {
    return res.status(400).json({ error: 'Content, embeds, or ui required' })
  }

  const message = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    channelId: `dm_${req.params.userId}`,
    userId: req.bot.id,
    username: req.bot.name,
    avatar: req.bot.avatar,
    content: content || '',
    embeds: embeds || [],
    attachments: attachments || [],
    ui: ui || null,
    bot: true,
    timestamp: new Date().toISOString()
  }

  io.to(`user:${req.params.userId}`).emit('dm:new', message)
  io.to(`bot:${req.bot.id}`).emit('dm:new', message)
  res.json(message)
})

// Bot: create channel
router.post('/api/servers/:serverId/channels', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:manage')) {
    return res.status(403).json({ error: 'Missing channels:manage permission' })
  }

  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  const { name, type } = req.body
  if (!name) return res.status(400).json({ error: 'Channel name required' })

  const newChannel = {
    id: `ch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    serverId: req.params.serverId,
    name: name,
    type: type || 'text',
    createdAt: new Date().toISOString()
  }

  if (!server.channels) server.channels = []
  server.channels.push(newChannel)
  await saveServers(servers)

  io.to(`server:${req.params.serverId}`).emit('channel:created', newChannel)
  res.json(newChannel)
})

// Bot: delete channel
router.delete('/api/channels/:channelId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:manage')) {
    return res.status(403).json({ error: 'Missing channels:manage permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }
  const { serverId } = channelAccess

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  const channelIdx = (server.channels || []).findIndex(c => c.id === req.params.channelId)
  if (channelIdx === -1) return res.status(404).json({ error: 'Channel not found' })

  const deletedChannel = server.channels.splice(channelIdx, 1)[0]
  await saveServers(servers)

  io.to(`server:${serverId}`).emit('channel:deleted', { channelId: req.params.channelId })
  res.json({ success: true, channel: deletedChannel })
})

// Bot: create category
router.post('/api/servers/:serverId/categories', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:manage')) {
    return res.status(403).json({ error: 'Missing channels:manage permission' })
  }

  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'Category name required' })

  const newCategory = {
    id: `cat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: name,
    createdAt: new Date().toISOString()
  }

  if (!server.categories) server.categories = []
  server.categories.push(newCategory)
  await saveServers(servers)

  io.to(`server:${req.params.serverId}`).emit('category:created', newCategory)
  res.json(newCategory)
})

// Bot: delete category
router.delete('/api/categories/:categoryId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:manage')) {
    return res.status(403).json({ error: 'Missing channels:manage permission' })
  }

  const servers = getServers()
  let server = null
  let categoryIdx = -1
  let serverId = null

  for (const s of servers) {
    const idx = (s.categories || []).findIndex(c => c.id === req.params.categoryId)
    if (idx !== -1) {
      server = s
      categoryIdx = idx
      serverId = s.id
      break
    }
  }

  if (!server) return res.status(404).json({ error: 'Category not found' })
  if (!req.bot.servers.includes(serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const deletedCategory = server.categories.splice(categoryIdx, 1)[0]
  await saveServers(servers)

  io.to(`server:${serverId}`).emit('category:deleted', { categoryId: req.params.categoryId })
  res.json({ success: true, category: deletedCategory })
})

// Bot: edit channel
router.patch('/api/channels/:channelId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'channels:manage')) {
    return res.status(403).json({ error: 'Missing channels:manage permission' })
  }

  const channelAccess = resolveBotChannelAccess(req.bot, req.params.channelId)
  if (channelAccess.error) {
    return res.status(channelAccess.status).json({ error: channelAccess.error })
  }
  const { serverId } = channelAccess

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  const channelIdx = (server.channels || []).findIndex(c => c.id === req.params.channelId)
  if (channelIdx === -1) return res.status(404).json({ error: 'Channel not found' })

  const { name, topic, nsfw, slowMode } = req.body
  if (name) server.channels[channelIdx].name = name
  if (topic !== undefined) server.channels[channelIdx].topic = topic
  if (nsfw !== undefined) server.channels[channelIdx].nsfw = nsfw
  if (slowMode !== undefined) server.channels[channelIdx].slowMode = slowMode

  await saveServers(servers)

  io.to(`server:${serverId}`).emit('channel:updated', server.channels[channelIdx])
  res.json(server.channels[channelIdx])
})

// Bot: create role
router.post('/api/servers/:serverId/roles', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'roles:manage')) {
    return res.status(403).json({ error: 'Missing roles:manage permission' })
  }

  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  const { name, color, permissions } = req.body
  if (!name) return res.status(400).json({ error: 'Role name required' })

  const newRole = {
    id: `role_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: name,
    color: color || '#99aab5',
    position: (server.roles?.length || 0),
    permissions: permissions || []
  }

  if (!server.roles) server.roles = []
  server.roles.push(newRole)
  await saveServers(servers)

  io.to(`server:${req.params.serverId}`).emit('role:created', newRole)
  res.json(newRole)
})

// Bot: delete role
router.delete('/api/servers/:serverId/roles/:roleId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'roles:manage')) {
    return res.status(403).json({ error: 'Missing roles:manage permission' })
  }

  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  const roleIdx = (server.roles || []).findIndex(r => r.id === req.params.roleId)
  if (roleIdx === -1) return res.status(404).json({ error: 'Role not found' })

  const deletedRole = server.roles.splice(roleIdx, 1)[0]
  await saveServers(servers)

  io.to(`server:${req.params.serverId}`).emit('role:deleted', { roleId: req.params.roleId })
  res.json({ success: true, role: deletedRole })
})

// Bot: edit role
router.patch('/api/servers/:serverId/roles/:roleId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'roles:manage')) {
    return res.status(403).json({ error: 'Missing roles:manage permission' })
  }

  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  const roleIdx = (server.roles || []).findIndex(r => r.id === req.params.roleId)
  if (roleIdx === -1) return res.status(404).json({ error: 'Role not found' })

  const { name, color, permissions, position } = req.body
  if (name) server.roles[roleIdx].name = name
  if (color) server.roles[roleIdx].color = color
  if (permissions) server.roles[roleIdx].permissions = permissions
  if (position !== undefined) server.roles[roleIdx].position = position

  await saveServers(servers)

  io.to(`server:${req.params.serverId}`).emit('role:updated', server.roles[roleIdx])
  res.json(server.roles[roleIdx])
})

// Bot: get user by ID
router.get('/api/users/:userId', authenticateBot, async (req, res) => {
  if (!await botService.hasPermission(req.bot.id, 'members:read')) {
    return res.status(403).json({ error: 'Missing members:read permission' })
  }
  if (!botSharesServerWithUser(req.bot, req.params.userId)) {
    return res.status(403).json({ error: 'Bot does not share a server with this user' })
  }
  const targetUser = userService.getUser(req.params.userId)
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' })
  }

  res.json({
    id: targetUser.id,
    username: targetUser.username,
    avatar: targetUser.avatar,
    status: targetUser.status || 'offline',
    customStatus: targetUser.customStatus || null,
    createdAt: targetUser.createdAt
  })
})

export default router
