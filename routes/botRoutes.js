import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { botService } from '../services/botService.js'
import { io } from '../server.js'
import { dataService } from '../services/dataService.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json')

const getServers = () => {
  try {
    if (fs.existsSync(SERVERS_FILE)) {
      return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[Data] Error loading servers:', err.message)
  }
  return []
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

const router = express.Router()

// Middleware to authenticate bot token
const authenticateBot = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bot ')) {
    return res.status(401).json({ error: 'Bot token required. Use Authorization: Bot <token>' })
  }

  const token = authHeader.slice(4)
  const bot = botService.getBotByToken(token)
  if (!bot) return res.status(401).json({ error: 'Invalid bot token' })

  req.bot = bot
  next()
}

// === User-facing bot management ===

// List my bots
router.get('/my', authenticateToken, (req, res) => {
  const bots = botService.getBotsByOwner(req.user.id)
  res.json(bots)
})

// Create a bot
router.post('/', authenticateToken, (req, res) => {
  const { name, description, avatar, prefix, permissions, intents, webhookUrl } = req.body
  if (!name || name.length < 2 || name.length > 32) {
    return res.status(400).json({ error: 'Name must be 2-32 characters' })
  }

  const bot = botService.createBot(req.user.id, {
    name, description, avatar, prefix, permissions, intents, webhookUrl, public: req.body.public
  })

  res.json(bot)
})

// Get bot details
router.get('/:botId', authenticateToken, (req, res) => {
  const bot = botService.getBot(req.params.botId)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
  res.json(bot)
})

// Update bot
router.put('/:botId', authenticateToken, (req, res) => {
  const result = botService.updateBot(req.params.botId, req.user.id, req.body)
  if (!result) return res.status(404).json({ error: 'Bot not found' })
  if (result.error) return res.status(403).json(result)
  res.json(result)
})

// Delete bot
router.delete('/:botId', authenticateToken, (req, res) => {
  const success = botService.deleteBot(req.params.botId, req.user.id)
  if (!success) return res.status(404).json({ error: 'Bot not found or not authorized' })
  res.json({ success: true })
})

// Regenerate bot token
router.post('/:botId/regenerate-token', authenticateToken, (req, res) => {
  const token = botService.regenerateToken(req.params.botId, req.user.id)
  if (!token) return res.status(404).json({ error: 'Bot not found or not authorized' })
  res.json({ token, message: 'Store this token securely - it will not be shown again' })
})

// Add bot to server
router.post('/:botId/servers/:serverId', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!canManageServer(server, req.user.id)) return res.status(403).json({ error: 'Not authorized to manage bots' })

  botService.addBotToServer(req.params.botId, req.params.serverId)
  
  io.to(`server:${req.params.serverId}`).emit('bot:added', {
    serverId: req.params.serverId,
    bot: botService.getBot(req.params.botId)
  })

  res.json({ success: true })
})

// Remove bot from server
router.delete('/:botId/servers/:serverId', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!canManageServer(server, req.user.id)) return res.status(403).json({ error: 'Not authorized to manage bots' })

  botService.removeBotFromServer(req.params.botId, req.params.serverId)
  
  io.to(`server:${req.params.serverId}`).emit('bot:removed', {
    serverId: req.params.serverId,
    botId: req.params.botId
  })

  res.json({ success: true })
})

// Get bots in a server
router.get('/server/:serverId', authenticateToken, (req, res) => {
  const bots = botService.getServerBots(req.params.serverId)
  res.json(bots)
})

// Browse public bots
router.get('/public/browse', authenticateToken, (req, res) => {
  res.json(botService.getAllPublicBots())
})

// Get bot profile (public-safe, for display in UI)
router.get('/:botId/profile', authenticateToken, (req, res) => {
  const bot = botService.getBot(req.params.botId)
  if (!bot) return res.status(404).json({ error: 'Bot not found' })
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
    commands: botService.getBotCommands(bot.id)
  })
})

// Get bot commands
router.get('/:botId/commands', authenticateToken, (req, res) => {
  res.json(botService.getBotCommands(req.params.botId))
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
router.post('/api/channels/:channelId/messages', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }

  const { content, embeds, attachments } = req.body
  if (!content && !embeds?.length) {
    return res.status(400).json({ error: 'Content or embeds required' })
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
    bot: true,
    timestamp: new Date().toISOString()
  }

  io.to(`channel:${req.params.channelId}`).emit('message:new', message)
  res.json(message)
})

// Bot: register slash commands
router.put('/api/commands', authenticateBot, (req, res) => {
  const { commands } = req.body
  if (!Array.isArray(commands)) {
    return res.status(400).json({ error: 'Commands must be an array' })
  }

  botService.registerCommands(req.bot.id, commands)
  res.json({ success: true, count: commands.length })
})

// Bot: update status
router.put('/api/status', authenticateBot, (req, res) => {
  const { status } = req.body
  botService.setBotStatus(req.bot.id, status || 'online')
  res.json({ success: true })
})

// Bot: get server members
router.get('/api/servers/:serverId/members', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:read')) {
    return res.status(403).json({ error: 'Missing members:read permission' })
  }

  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  res.json(server.members || [])
})

// Bot: add reaction
router.post('/api/channels/:channelId/messages/:messageId/reactions', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'reactions:add')) {
    return res.status(403).json({ error: 'Missing reactions:add permission' })
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

router.get('/api/servers/:serverId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'channels:read')) {
    return res.status(403).json({ error: 'Missing channels:read permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  // Strip sensitive internal fields before returning
  const { bans, ...safe } = server
  res.json(safe)
})

// =========================================================================
// Bot: channels
// =========================================================================

router.get('/api/servers/:serverId/channels', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'channels:read')) {
    return res.status(403).json({ error: 'Missing channels:read permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  res.json(server.channels || [])
})

router.get('/api/channels/:channelId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'channels:read')) {
    return res.status(403).json({ error: 'Missing channels:read permission' })
  }
  const channel = dataService.getChannel(req.params.channelId)
  if (!channel) return res.status(404).json({ error: 'Channel not found' })
  if (!req.bot.servers.includes(channel.serverId)) {
    return res.status(403).json({ error: 'Bot not in that server' })
  }
  res.json(channel)
})

// Bot: typing indicator (fire-and-forget; clients display it briefly)
router.post('/api/channels/:channelId/typing', authenticateBot, (req, res) => {
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

router.put('/api/channels/:channelId/messages/:messageId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }
  const { content, embeds } = req.body
  const updated = dataService.editMessage(req.params.messageId, content)
  if (!updated) {
    // Message not in persistent store — emit the edit event anyway so live
    // clients update their UI (covers in-memory messages from this session)
    io.to(`channel:${req.params.channelId}`).emit('message:edited', {
      messageId: req.params.messageId,
      channelId: req.params.channelId,
      content: content || '',
      embeds:   embeds || [],
      edited: true
    })
    return res.json({ success: true })
  }
  io.to(`channel:${req.params.channelId}`).emit('message:edited', updated)
  res.json(updated)
})

router.delete('/api/channels/:channelId/messages/:messageId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'messages:delete')) {
    return res.status(403).json({ error: 'Missing messages:delete permission' })
  }
  dataService.deleteMessage(req.params.messageId)
  io.to(`channel:${req.params.channelId}`).emit('message:deleted', {
    messageId: req.params.messageId,
    channelId: req.params.channelId
  })
  res.json({ success: true })
})

router.post('/api/channels/:channelId/messages/:messageId/pin', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
  }
  io.to(`channel:${req.params.channelId}`).emit('message:pinned', {
    messageId: req.params.messageId,
    channelId: req.params.channelId,
    pinnedBy: req.bot.id
  })
  res.json({ success: true })
})

router.delete('/api/channels/:channelId/messages/:messageId/pin', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'messages:send')) {
    return res.status(403).json({ error: 'Missing messages:send permission' })
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

router.delete('/api/channels/:channelId/messages/:messageId/reactions', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'reactions:add')) {
    return res.status(403).json({ error: 'Missing reactions:add permission' })
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

router.get('/api/servers/:serverId/members/:userId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:read')) {
    return res.status(403).json({ error: 'Missing members:read permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  const member = (server.members || []).find(m => m.id === req.params.userId)
  if (!member) return res.status(404).json({ error: 'Member not found' })
  res.json(member)
})

router.delete('/api/servers/:serverId/members/:userId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:manage')) {
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
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2))

  io.to(`server:${req.params.serverId}`).emit('member:left', {
    userId: req.params.userId,
    serverId: req.params.serverId,
    reason: req.body?.reason || 'Kicked by bot'
  })
  res.json({ success: true })
})

router.post('/api/servers/:serverId/bans/:userId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:manage')) {
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
  server.members = (server.members || []).filter(m => m.id !== req.params.userId)

  const alreadyBanned = server.bans.find(b => b.userId === req.params.userId)
  if (!alreadyBanned) {
    server.bans.push({
      userId: req.params.userId,
      reason: req.body?.reason || 'Banned by bot',
      bannedBy: req.bot.id,
      bannedAt: new Date().toISOString()
    })
  }
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2))

  io.to(`server:${req.params.serverId}`).emit('member:left', {
    userId: req.params.userId,
    serverId: req.params.serverId,
    reason: req.body?.reason || 'Banned by bot'
  })
  res.json({ success: true })
})

router.delete('/api/servers/:serverId/bans/:userId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:manage')) {
    return res.status(403).json({ error: 'Missing members:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  servers[idx].bans = (servers[idx].bans || []).filter(b => b.userId !== req.params.userId)
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2))
  res.json({ success: true })
})

router.get('/api/servers/:serverId/bans', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:manage')) {
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

router.get('/api/servers/:serverId/roles', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'channels:read')) {
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

router.post('/api/servers/:serverId/members/:userId/roles/:roleId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:manage')) {
    return res.status(403).json({ error: 'Missing members:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  const member = (servers[idx].members || []).find(m => m.id === req.params.userId)
  if (!member) return res.status(404).json({ error: 'Member not found' })

  if (!Array.isArray(member.roles)) member.roles = []
  if (!member.roles.includes(req.params.roleId)) {
    member.roles.push(req.params.roleId)
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2))
  }
  io.to(`server:${req.params.serverId}`).emit('member:updated', { member })
  res.json({ success: true })
})

router.delete('/api/servers/:serverId/members/:userId/roles/:roleId', authenticateBot, (req, res) => {
  if (!botService.hasPermission(req.bot.id, 'members:manage')) {
    return res.status(403).json({ error: 'Missing members:manage permission' })
  }
  if (!req.bot.servers.includes(req.params.serverId)) {
    return res.status(403).json({ error: 'Bot not in this server' })
  }
  const servers = getServers()
  const idx = servers.findIndex(s => s.id === req.params.serverId)
  if (idx === -1) return res.status(404).json({ error: 'Server not found' })

  const member = (servers[idx].members || []).find(m => m.id === req.params.userId)
  if (!member) return res.status(404).json({ error: 'Member not found' })

  member.roles = (member.roles || []).filter(r => r !== req.params.roleId)
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2))
  io.to(`server:${req.params.serverId}`).emit('member:updated', { member })
  res.json({ success: true })
})

export default router
