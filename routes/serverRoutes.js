import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { io } from '../server.js'
import { cleanupVoiceUser, getVoiceChannelUsers } from '../services/socketService.js'
import { FILES, discoveryService, userService, serverService, channelService, messageService, fileService, saveData } from '../services/dataService.js'
import config from '../config/config.js'
import { botService } from '../services/botService.js'
import { isTagBlacklisted } from '../utils/guildTagBlacklist.js'

const getServerHost = () => {
  try {
    return config.getServerHost()
  } catch {
    return 'localhost'
  }
}

const isExternalImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value))

const getAvatarUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const resolveUserAvatar = (userId, profile = null) => {
  const explicit = profile?.imageUrl || profile?.imageurl || profile?.avatarUrl || profile?.avatarURL || profile?.avatar || null
  if (isExternalImage(explicit)) return explicit
  return getAvatarUrl(userId)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const router = express.Router()

const PERMISSIONS = [
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
]

const BASE_PERMISSIONS = new Set(['view_channels', 'send_messages', 'connect', 'speak', 'use_voice_activity'])

const normalizeMember = (member) => {
  const normalized = { ...member }
  if (!normalized.roles) {
    normalized.roles = normalized.role ? [normalized.role] : []
  }
  if (!Array.isArray(normalized.roles)) {
    normalized.roles = []
  }
  normalized.role = normalized.roles[0] || normalized.role || null
  return normalized
}

const normalizeServer = (server) => {
  if (!server) return server
  server.roles = Array.isArray(server.roles) ? server.roles : []
  server.members = Array.isArray(server.members) ? server.members.map(normalizeMember) : []
  server.themeColor = server.themeColor || '#1fb6ff'
  server.bannerUrl = server.bannerUrl || ''
  return server
}

const toServerArray = (data) => {
  if (Array.isArray(data)) return data.map(normalizeServer)
  if (data && typeof data === 'object') return Object.values(data).map(normalizeServer)
  return []
}

const toServerRecord = (servers) => {
  const record = {}
  for (const server of servers || []) {
    if (server?.id) record[server.id] = server
  }
  return record
}

const toGroupedItems = (value) => {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  if (value.serverId) return [value]
  return Object.values(value).filter(item => item && typeof item === 'object')
}

const toGroupedByServer = (data, entityKey = 'id') => {
  if (!data || typeof data !== 'object') return {}

  const grouped = {}
  for (const value of Object.values(data)) {
    for (const item of toGroupedItems(value)) {
      if (!item?.serverId) continue
      if (!grouped[item.serverId]) grouped[item.serverId] = []
      grouped[item.serverId].push(item)
    }
  }

  if (Object.keys(grouped).length > 0) return grouped

  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item?.serverId) continue
      if (!grouped[item.serverId]) grouped[item.serverId] = []
      grouped[item.serverId].push(item)
    }
    return grouped
  }

  if (entityKey && data && typeof data === 'object') {
    const firstValue = Object.values(data)[0]
    if (Array.isArray(firstValue)) return data
  }

  return {}
}

const toFlatRecord = (grouped, idField = 'id') => {
  const flat = {}
  for (const items of Object.values(grouped || {})) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const id = item?.[idField]
      if (id) flat[id] = item
    }
  }
  return flat
}

// PERFORMANCE FIX: Use saveData to save entire dataset at once instead of iterating and saving each item
// This eliminates cascading saves - before: 55 server saves + 400 channel saves per request
const getServers = () => {
  const data = serverService.getAllServers()
  return Array.isArray(data) ? data : Object.values(data || {})
}
const getServersFresh = async () => {
  const data = typeof serverService.getAllServersFresh === 'function'
    ? await serverService.getAllServersFresh()
    : serverService.getAllServers()
  return Array.isArray(data) ? data : Object.values(data || {})
}
const setServers = async (servers) => {
  // Convert array to record format and save ALL servers in ONE operation
  const serverRecord = toServerRecord(servers)
  await saveData(FILES.servers, serverRecord)
}

const getAllChannels = () => channelService.getAllChannelsGrouped()
const getAllChannelsFresh = async () => {
  if (typeof channelService.getAllChannelsGroupedFresh === 'function') {
    return await channelService.getAllChannelsGroupedFresh()
  }
  return getAllChannels()
}
const setAllChannels = async (channels) => {
  // Flatten grouped channels and save ALL in ONE operation
  const flatChannels = toFlatRecord(channels)
  await saveData(FILES.channels, flatChannels)
}

const getAllCategories = () => serverService.getAllCategoriesGrouped()
const setAllCategories = async (categories) => {
  // Flatten and save ALL categories in ONE operation
  const flatCategories = {}
  for (const serverCategories of Object.values(categories || {})) {
    for (const category of serverCategories) {
      if (category?.id) {
        flatCategories[category.id] = category
      }
    }
  }
  await saveData(FILES.categories, flatCategories)
}

const getMemberRoles = (server, userId) => {
  const member = server?.members?.find(m => m.id === userId)
  return member?.roles || []
}

const getAllPermissions = () => new Set(PERMISSIONS)

const computePermissions = (server, userId) => {
  if (!server) return new Set()
  if (server.ownerId === userId) return getAllPermissions()

  const member = server.members?.find(m => m.id === userId)
  if (!member) return new Set() // Non-members get no permissions

  const permissions = new Set(BASE_PERMISSIONS)
  const roles = getMemberRoles(server, userId)
  roles.forEach(roleId => {
    const role = server.roles?.find(r => r.id === roleId)
    if (role?.permissions?.includes('all')) {
      getAllPermissions().forEach(p => permissions.add(p))
    }
    role?.permissions?.forEach(p => permissions.add(p))
  })

  if (permissions.has('admin')) return getAllPermissions()
  return permissions
}

const hasPermission = (server, userId, permission) => {
  if (server?.ownerId === userId) return true
  const perms = computePermissions(server, userId)
  return perms.has(permission) || perms.has('admin')
}

const isServerMember = (server, userId) => {
  if (!server) return false
  if (server.ownerId === userId) return true
  return Array.isArray(server.members) && server.members.some(m => m.id === userId)
}

const SERVER_MUTABLE_FIELDS = new Set([
  'name',
  'icon',
  'description',
  'themeColor',
  'bannerUrl',
  'defaultChannelId',
  'discovery',
  'public'
])

const pickAllowedServerUpdates = (payload = {}) => {
  const updates = {}
  for (const field of SERVER_MUTABLE_FIELDS) {
    if (payload[field] !== undefined) {
      updates[field] = payload[field]
    }
  }
  return updates
}

const VALID_PERMISSION_SET = new Set(PERMISSIONS)
const RESERVED_ROLE_IDS = new Set(['owner', 'member'])
const ROLE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const INVITE_CODE_RE = /^[A-Z0-9]{4,64}$/
const MAX_INVITE_USES = 100000
const MAX_TIMEOUT_SECONDS = 60 * 60 * 24 * 28 // 28 days

const ROLE_MUTABLE_FIELDS = new Set(['name', 'color', 'permissions', 'position'])
const CATEGORY_MUTABLE_FIELDS = new Set(['name', 'position'])

const normalizeInviteCode = (value) => {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  if (!INVITE_CODE_RE.test(code)) return null
  return code
}

const isUserBanned = (server, userId) => {
  if (!server || !userId || !Array.isArray(server.bans)) return false
  return server.bans.some(entry => entry?.userId === userId)
}

const getRolePosition = (role) => {
  const parsed = Number(role?.position)
  return Number.isFinite(parsed) ? parsed : 0
}

const getMemberRoleIds = (member) => {
  if (!member) return []
  if (Array.isArray(member.roles)) return member.roles.filter(roleId => typeof roleId === 'string' && roleId)
  if (typeof member.role === 'string' && member.role.trim()) return [member.role]
  return []
}

const getMemberHighestRolePosition = (server, userId) => {
  if (!server || !userId) return -1
  if (server.ownerId === userId) return Number.MAX_SAFE_INTEGER

  const member = Array.isArray(server.members) ? server.members.find(m => m?.id === userId) : null
  if (!member) return -1

  const memberRoleIds = getMemberRoleIds(member)
  let highestPosition = -1
  for (const roleId of memberRoleIds) {
    const role = server.roles?.find(item => item?.id === roleId)
    if (!role) continue
    highestPosition = Math.max(highestPosition, getRolePosition(role))
  }
  return highestPosition
}

const canManageTargetMember = (server, actorId, targetId) => {
  if (!server || !actorId || !targetId) return false
  if (actorId === targetId) return false
  if (server.ownerId === actorId) return true
  if (server.ownerId === targetId) return false

  const actorPosition = getMemberHighestRolePosition(server, actorId)
  const targetPosition = getMemberHighestRolePosition(server, targetId)
  if (actorPosition < 0) return false
  return actorPosition > targetPosition
}

const canManageRoleId = (server, actorId, roleId) => {
  if (!server || !actorId || !roleId) return false
  if (server.ownerId === actorId) return true
  if (roleId === 'owner') return false

  const actorPosition = getMemberHighestRolePosition(server, actorId)
  if (actorPosition < 0) return false

  const targetRole = server.roles?.find(item => item?.id === roleId)
  if (!targetRole) return false

  return actorPosition > getRolePosition(targetRole)
}

const canGrantPermissions = (server, actorId, permissions = []) => {
  if (!server || !actorId) return false
  if (server.ownerId === actorId) return true

  const actorPermissions = computePermissions(server, actorId)
  for (const permission of permissions) {
    if (!actorPermissions.has(permission)) {
      return false
    }
  }
  return true
}

const parseInviteOptions = (payload = {}) => {
  const options = {}

  if (payload.maxUses !== undefined && payload.maxUses !== null && payload.maxUses !== '') {
    const parsed = Number.parseInt(payload.maxUses, 10)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_INVITE_USES) {
      throw new Error(`maxUses must be an integer between 0 and ${MAX_INVITE_USES}`)
    }
    options.maxUses = parsed
  }

  if (payload.expiresAt !== undefined) {
    if (payload.expiresAt === null || payload.expiresAt === '') {
      options.expiresAt = null
    } else {
      const expiresAt = new Date(payload.expiresAt)
      if (Number.isNaN(expiresAt.getTime())) {
        throw new Error('expiresAt must be a valid date')
      }
      options.expiresAt = expiresAt.toISOString()
    }
  }

  return options
}

const sanitizePermissionList = (permissions) => {
  if (!Array.isArray(permissions)) {
    throw new Error('permissions must be an array')
  }
  const sanitized = []
  const seen = new Set()
  for (const permission of permissions) {
    if (typeof permission !== 'string') continue
    const normalized = permission.trim().toLowerCase()
    if (!normalized || !VALID_PERMISSION_SET.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    sanitized.push(normalized)
  }
  return sanitized
}

const pickAllowedRoleUpdates = (payload = {}, { allowCustomId = false } = {}) => {
  const updates = {}
  for (const field of ROLE_MUTABLE_FIELDS) {
    if (payload[field] !== undefined) {
      updates[field] = payload[field]
    }
  }

  if (allowCustomId && payload.id !== undefined) {
    updates.id = payload.id
  }

  if (updates.permissions !== undefined) {
    updates.permissions = sanitizePermissionList(updates.permissions)
  }
  if (updates.position !== undefined) {
    const parsed = Number(updates.position)
    if (!Number.isFinite(parsed)) throw new Error('position must be a number')
    updates.position = parsed
  }
  if (updates.name !== undefined && typeof updates.name !== 'string') {
    throw new Error('name must be a string')
  }
  if (updates.color !== undefined && typeof updates.color !== 'string') {
    throw new Error('color must be a string')
  }
  if (updates.id !== undefined) {
    if (typeof updates.id !== 'string' || !ROLE_ID_RE.test(updates.id) || RESERVED_ROLE_IDS.has(updates.id)) {
      throw new Error('Invalid role id')
    }
  }

  return updates
}

const pickAllowedCategoryUpdates = (payload = {}) => {
  const updates = {}
  for (const field of CATEGORY_MUTABLE_FIELDS) {
    if (payload[field] !== undefined) {
      updates[field] = payload[field]
    }
  }
  if (updates.name !== undefined && typeof updates.name !== 'string') {
    throw new Error('name must be a string')
  }
  if (updates.position !== undefined) {
    const parsed = Number(updates.position)
    if (!Number.isFinite(parsed)) throw new Error('position must be a number')
    updates.position = parsed
  }
  return updates
}

const emitServerJoined = (userId, server, member, source = 'join') => {
  if (!userId || !server?.id) return
  const joinedPayload = {
    ...server,
    __addToList: true,
    joinedVia: source
  }
  io.to(`user:${userId}`).emit('server:updated', joinedPayload)
  io.to(`user:${userId}`).emit('server:joined', {
    serverId: server.id,
    source,
    server: joinedPayload
  })
  if (member?.id) {
    io.to(`server:${server.id}`).emit('member:joined', {
      serverId: server.id,
      member
    })
  }
  io.to(`server:${server.id}`).emit('server:updated', server)
}

const emitServerLeft = (userId, serverId, reason = 'left') => {
  if (!userId || !serverId) return
  io.to(`user:${userId}`).emit('server:left', { serverId, reason })
}

router.get('/', authenticateToken, async (req, res) => {
  const allServers = await getServersFresh()
  const userId = req.user.id
  
  const userServers = allServers.filter(server => {
    if (server?.ownerId === userId) return true
    const members = server.members || []
    return members.some(m => m.id === userId)
  })
  
  console.log(`[API] Get servers - returned ${userServers.length} servers for user ${req.user.username}`)
  res.json(userServers)
})

router.get('/:serverId/members', authenticateToken, async (req, res) => {
  const servers = await getServersFresh()
  const server = servers.find(s => s.id === req.params.serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  // Enrich member objects with host/avatarHost/guildTag/nick from user profile
  const localHost = config.getHost()
  const localImageServerUrl = config.getImageServerUrl()
  const enrichedMembers = Array.isArray(server.members) ? server.members.map(member => {
    const profile = userService.getUser(member.id)
    const host = member.host || profile?.host || localHost
    // avatarHost is the image server URL for where this user's images are stored
    const avatarHost = member.avatarHost || profile?.avatarHost || localImageServerUrl
    // Include guild tag (global) and server nick (per-server)
    const guildTag = profile?.guildTag || null
    const nick = profile?.serverNicks?.[req.params.serverId] || null
    return { ...member, host, avatarHost, guildTag, nick }
  }) : []

  // Merge bots - use roles from member entry if available, otherwise from botService
  const existingBotIds = new Set(enrichedMembers.filter(m => m.isBot).map(m => m.id))
  const bots = await botService.getServerBots(req.params.serverId)
  const botMembers = bots
    .filter(bot => !existingBotIds.has(bot.id))
    .map(bot => ({
      id:           bot.id,
      username:     bot.name,
      avatar:       bot.avatar || null,
      status:       bot.status || 'offline',
      customStatus: bot.customStatus || null,
      roles:        bot.roles || [],
      role:         bot.roles?.[0] || null,
      isBot:        true
    }))

  res.json([...enrichedMembers, ...botMembers])
})

router.get('/:serverId/online-members', authenticateToken, async (req, res) => {
  const servers = await getServersFresh()
  const server = servers.find(s => s.id === req.params.serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  const serverMemberIds = new Set(Array.isArray(server.members) ? server.members.map(m => m.id) : [])
  
  const onlineMembers = []
  for (const [socketId, socket] of io.sockets.sockets) {
    if (socket.user && serverMemberIds.has(socket.user.id)) {
      onlineMembers.push({
        userId: socket.user.id,
        status: socket.user.status || 'online',
        customStatus: socket.user.customStatus || null
      })
    }
  }

  res.json(onlineMembers)
})

router.get('/:serverId', authenticateToken, async (req, res) => {
  const servers = await getServersFresh()
  let server = servers.find(s => s.id === req.params.serverId)

  if (!server) {
    console.log(`[API] Server not found: ${req.params.serverId}`)
    return res.status(404).json({ error: 'Server not found' })
  }

  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  if (!server.roles || server.roles.length === 0) {
    const memberRoleId = uuidv4()
    const adminRoleId = uuidv4()
    server.roles = [
      { id: 'member', name: '@member', color: '#99aab5', position: 0, permissions: ['view_channels', 'send_messages', 'connect', 'speak', 'use_voice_activity'] },
      { id: 'owner', name: '@owner', color: '#faa81a', position: 100, permissions: ['admin'] },
      { id: memberRoleId, name: 'Member', color: '#1fb6ff', position: 1, permissions: ['view_channels', 'send_messages', 'connect', 'speak', 'use_voice_activity'] },
      { id: adminRoleId, name: 'Admin', color: '#ed4245', position: 2, permissions: ['admin', 'manage_server', 'manage_roles', 'manage_channels', 'kick_members', 'ban_members'] }
    ]
    const memberIndex = server.members?.findIndex(m => m.id === req.user.id)
    if (memberIndex !== undefined && memberIndex >= 0) {
      server.members[memberIndex].roles = ['owner', adminRoleId]
      server.members[memberIndex].role = 'owner'
    }
    await setServers(servers)
  }
  
  // Merge bots as members with isBot flag
  // Bots that are already in members array have their roles preserved
  // Bots not yet in members are added dynamically from botService
  const existingBotMembers = (server.members || []).filter(m => m.isBot)
  const existingBotIds = new Set(existingBotMembers.map(m => m.id))
  
  const bots = await botService.getServerBots(server.id)
  const dynamicBotMembers = bots
    .filter(bot => !existingBotIds.has(bot.id))
    .map(bot => ({
      id:           bot.id,
      username:     bot.name,
      avatar:       bot.avatar || null,
      status:       bot.status || 'offline',
      customStatus: bot.customStatus || null,
      roles:        bot.roles || [],
      role:         bot.roles?.[0] || null,
      isBot:        true
    }))
  
  const serverWithBots = {
    ...server,
    members: [
      ...(server.members || []),
      ...dynamicBotMembers
    ]
  }

  console.log(`[API] Get server: ${server.name}`)
  res.json(serverWithBots)
})

router.post('/', authenticateToken, async (req, res) => {
  const { name, icon } = req.body
  
  const serverId = uuidv4()
  const memberRoleId = uuidv4()
  const adminRoleId = uuidv4()
  const newServer = {
    id: serverId,
    name,
    icon,
    ownerId: req.user.id,
    themeColor: '#1fb6ff',
    bannerUrl: '',
    roles: [
      { id: 'member', name: '@member', color: '#99aab5', position: 0, permissions: ['view_channels', 'send_messages', 'connect', 'speak', 'use_voice_activity'] },
      { id: 'owner', name: '@owner', color: '#faa81a', position: 100, permissions: ['admin'] },
      { id: memberRoleId, name: 'Member', color: '#1fb6ff', position: 1, permissions: ['view_channels', 'send_messages', 'connect', 'speak', 'use_voice_activity'] },
      { id: adminRoleId, name: 'Admin', color: '#ed4245', position: 2, permissions: ['admin', 'manage_server', 'manage_roles', 'manage_channels', 'kick_members', 'ban_members'] }
    ],
    members: [{ 
      id: req.user.id, 
      username: req.user.username || req.user.email, 
      roles: ['owner', adminRoleId],
      role: 'owner',
      status: 'online'
    }],
    createdAt: new Date().toISOString()
  }
  
  const servers = await getServersFresh()
  servers.push(newServer)
  await setServers(servers)
  
  const generalChannel = {
    id: uuidv4(),
    serverId: serverId,
    name: 'general',
    type: 'text',
    isDefault: true,
    createdAt: new Date().toISOString()
  }
  
  const voiceChannel = {
    id: uuidv4(),
    serverId: serverId,
    name: 'General Voice',
    type: 'voice',
    createdAt: new Date().toISOString()
  }
  
  const channels = [generalChannel, voiceChannel]
  const allChannels = await getAllChannelsFresh()
  allChannels[serverId] = channels
  await setAllChannels(allChannels)
  
  newServer.defaultChannelId = generalChannel.id
  const createdServerIndex = servers.findIndex(entry => entry.id === serverId)
  if (createdServerIndex >= 0) {
    servers[createdServerIndex] = {
      ...servers[createdServerIndex],
      defaultChannelId: generalChannel.id
    }
    await setServers(servers)
  }
  emitServerJoined(req.user.id, newServer, newServer.members?.[0] || null, 'create')
  
  console.log(`[API] Created server: ${name} with ${channels.length} default channels`)
  res.status(201).json(newServer)
})

router.put('/:serverId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const index = servers.findIndex(s => s.id === req.params.serverId)
  
  if (index === -1) {
    return res.status(404).json({ error: 'Server not found' })
  }

  const server = servers[index]
  if (!hasPermission(server, req.user.id, 'manage_server')) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  const safeUpdates = pickAllowedServerUpdates(req.body)
  if (Object.keys(safeUpdates).length === 0) {
    return res.status(400).json({ error: 'No mutable server fields provided' })
  }

  servers[index] = { ...servers[index], ...safeUpdates, updatedAt: new Date().toISOString() }
  await setServers(servers)
  
  const updatedServer = servers[index]
  io.to(`server:${req.params.serverId}`).emit('server:updated', updatedServer)
  
  console.log(`[API] Updated server: ${updatedServer.name}`)
  res.json(updatedServer)
})

router.delete('/:serverId', authenticateToken, async (req, res) => {
  const serverId = req.params.serverId
  
  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (server.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Only the owner can delete this server' })
  }

  const filtered = servers.filter(s => s.id !== serverId)
  await setServers(filtered)
  
  const allChannels = getAllChannels()
  const serverChannels = allChannels[serverId] || []
  delete allChannels[serverId]
  await setAllChannels(allChannels)
  
  const serverChannelIds = new Set(serverChannels.map(c => c.id))
  await messageService.deleteMessagesByChannelIds([...serverChannelIds])
  
  const files = await fileService.getAllFiles()
  const filesRecord = Array.isArray(files)
    ? Object.fromEntries(files.filter(f => f?.id).map(f => [f.id, f]))
    : (files || {})
  const filesToDelete = Object.values(filesRecord).filter(f => f.serverId === serverId)
  filesToDelete.forEach(file => {
    if (file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path)
      } catch (err) {
        console.error('[Data] Error deleting file:', err.message)
      }
    }
  })
  for (const file of filesToDelete) {
    await fileService.deleteFile(file.id)
  }
  
  console.log(`[API] Deleted server: ${serverId} (${serverChannels.length} channels, ${filesToDelete.length} files deleted)`)
  res.json({ success: true })
})

router.get('/:serverId/channels', authenticateToken, async (req, res) => {
  const servers = await getServersFresh()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  const allChannels = await getAllChannelsFresh()
  const channels = allChannels[req.params.serverId] || []
  console.log(`[API] Get channels for server ${req.params.serverId} - returned ${channels.length} channels`)
  res.json(channels)
})

router.post('/:serverId/channels', authenticateToken, async (req, res) => {
  const { name, type, categoryId } = req.body
  const serverId = req.params.serverId

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to manage channels' })
  }
  
  // Validate categoryId if provided
  if (categoryId) {
    const allCategories = getAllCategories()
    const categories = allCategories[serverId] || []
    if (!categories.find(c => c.id === categoryId)) {
      return res.status(400).json({ error: 'Invalid category' })
    }
  }
  
  const newChannel = {
    id: uuidv4(),
    serverId,
    name,
    type: type || 'text',
    categoryId: categoryId || null,
    createdAt: new Date().toISOString()
  }
  
  const allChannels = getAllChannels()
  const channels = allChannels[serverId] || []
  channels.push(newChannel)
  allChannels[serverId] = channels
  await setAllChannels(allChannels)
  
  io.to(`server:${serverId}`).emit('channel:created', newChannel)
  
  console.log(`[API] Created channel: ${name} in server ${serverId}`)
  res.status(201).json(newChannel)
})

router.put('/:serverId/channels/order', authenticateToken, async (req, res) => {
  const { channelIds } = req.body
  const serverId = req.params.serverId
  
  if (!channelIds || !Array.isArray(channelIds)) {
    return res.status(400).json({ error: 'channelIds array required' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to manage channels' })
  }

  const allChannels = getAllChannels()
  const channels = allChannels[serverId] || []
  
  const reorderedChannels = channelIds.map((id, index) => {
    const channel = channels.find(c => c.id === id)
    if (channel) {
      return { ...channel, position: index }
    }
    return null
  }).filter(Boolean)
  
  allChannels[serverId] = reorderedChannels
  await setAllChannels(allChannels)
  
  io.to(`server:${serverId}`).emit('channel:order-updated', reorderedChannels)
  
  console.log(`[API] Updated channel order for server ${serverId}`)
  res.json(reorderedChannels)
})

import { inviteService } from '../services/dataService.js'

router.get('/:serverId/invites', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }
  if (!hasPermission(server, req.user.id, 'create_invites')) {
    return res.status(403).json({ error: 'Not authorized to view invites' })
  }

  const invites = inviteService.getServerInvites(req.params.serverId)
  res.json(invites)
})

router.post('/:serverId/invites', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'create_invites')) {
    return res.status(403).json({ error: 'Not authorized to create invites' })
  }

  let inviteOptions = {}
  try {
    inviteOptions = parseInviteOptions(req.body || {})
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  const invite = await inviteService.createInvite(req.params.serverId, req.user.id, inviteOptions)
  console.log(`[API] Created invite for server ${req.params.serverId}: ${invite.code}`)
  res.status(201).json(invite)
})

router.delete('/:serverId/invites/:code', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'create_invites')) {
    return res.status(403).json({ error: 'Not authorized to delete invites' })
  }

  const inviteCode = normalizeInviteCode(req.params.code)
  if (!inviteCode) {
    return res.status(400).json({ error: 'Invalid invite code' })
  }

  const invite = inviteService.getInvite(inviteCode)
  if (!invite || invite.serverId !== req.params.serverId) {
    return res.status(404).json({ error: 'Invite not found' })
  }

  await inviteService.deleteInvite(inviteCode)
  console.log(`[API] Deleted invite ${inviteCode}`)
  res.json({ success: true })
})

router.post('/invites/:code/join', authenticateToken, async (req, res) => {
  const inviteCode = normalizeInviteCode(req.params.code)
  if (!inviteCode) {
    return res.status(400).json({ error: 'Invalid invite code' })
  }

  const invite = inviteService.getInvite(inviteCode)
  if (!invite) {
    return res.status(400).json({ error: 'Invite not found' })
  }
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return res.status(400).json({ error: 'Invite expired' })
  }
  if (invite.maxUses && invite.uses >= invite.maxUses) {
    return res.status(400).json({ error: 'Invite expired' })
  }
  
  const servers = await getServersFresh()
  const server = servers.find(s => s.id === invite.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (isUserBanned(server, req.user.id)) {
    return res.status(403).json({ error: 'You are banned from this server' })
  }
  
  const existingMember = server.members?.find(m => m.id === req.user.id)
  if (existingMember) {
    return res.json(server)
  }

  const result = await inviteService.useInvite(inviteCode)
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  if (result.serverId !== server.id) {
    return res.status(403).json({ error: 'Invite/server mismatch' })
  }
  
  if (!server.members) server.members = []
  const joinedMember = {
    id: req.user.id,
    username: req.user.username,
    imageUrl: req.user?.imageUrl || req.user?.imageurl || req.user?.avatarUrl || req.user?.avatarURL || (isExternalImage(req.user?.avatar) ? req.user.avatar : null),
    avatar: resolveUserAvatar(req.user.id, req.user),
    host: req.user.host || config.getHost(),
    avatarHost: config.getImageServerUrl(),
    roles: ['member'],
    role: 'member',
    status: 'online',
    joinedAt: new Date().toISOString()
  }
  server.members.push(joinedMember)
  
  await setServers(servers)
  emitServerJoined(req.user.id, server, joinedMember, 'invite')
  console.log(`[API] User ${req.user.username} joined server ${server.name}`)
  res.json(server)
})

router.post('/:serverId/join', authenticateToken, async (req, res) => {
  const servers = await getServersFresh()
  const server = servers.find(s => s.id === req.params.serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (isUserBanned(server, req.user.id)) {
    return res.status(403).json({ error: 'You are banned from this server' })
  }

  // SECURITY (VULN-1: invite bypass): a direct POST to /:serverId/join must
  // never be enough on its own to add the caller to `server.members`. We
  // require ONE of the following conditions to be true before granting
  // membership:
  //   1. The caller is already a member (idempotent re-join — return current
  //      server state without mutating anything).
  //   2. The caller supplied a valid `inviteCode` body param that resolves
  //      to a non-expired, non-exhausted invite for THIS server.
  //   3. The server has been explicitly published to discovery (i.e. it is
  //      a public/discovery-listed server). Anything else → 403.
  //
  // Without this check, any authenticated user could enumerate server UUIDs
  // and silently add themselves to private servers.

  // (1) Idempotent re-join for existing members.
  const existingMember = server.members?.find(m => m.id === req.user.id)
  if (existingMember) {
    return res.json(server)
  }

  // (2) Invite-based join: caller must explicitly present a valid invite
  //     for this exact server.
  const inviteCode = normalizeInviteCode(req.body?.inviteCode) || normalizeInviteCode(req.body?.code)

  let inviteAuthorized = false
  let consumedInviteCode = null
  if (inviteCode) {
    const invite = inviteService.getInvite(inviteCode)
    if (invite && invite.serverId === server.id) {
      // Validate expiry / max uses BEFORE consuming.
      const expired = invite.expiresAt && new Date(invite.expiresAt) < new Date()
      const exhausted = invite.maxUses && invite.uses >= invite.maxUses
      if (!expired && !exhausted) {
        inviteAuthorized = true
        consumedInviteCode = inviteCode
      }
    }
  }

  // (3) Discovery / public-server fallback.
  const isPublic = inviteAuthorized
    || discoveryService.isInDiscovery(server.id)
    || server.discovery === true
    || server.public === true

  if (!inviteAuthorized && !isPublic) {
    return res.status(403).json({ error: 'Invite required' })
  }

  // Consume the invite (increment uses) only after we know we will actually
  // add the user, so a failed mutation doesn't burn an invite slot.
  if (consumedInviteCode) {
    const consumeResult = await inviteService.useInvite(consumedInviteCode)
    if (consumeResult?.error) {
      return res.status(400).json({ error: consumeResult.error })
    }
    if (consumeResult?.serverId && consumeResult.serverId !== server.id) {
      // Defense-in-depth: useInvite returned a different server than the
      // caller targeted. Refuse rather than cross-add.
      return res.status(403).json({ error: 'Invite required' })
    }
  }

  if (!server.members) server.members = []
  const joinedMember = {
    id: req.user.id,
    username: req.user.username,
    imageUrl: req.user?.imageUrl || req.user?.imageurl || req.user?.avatarUrl || req.user?.avatarURL || (isExternalImage(req.user?.avatar) ? req.user.avatar : null),
    avatar: resolveUserAvatar(req.user.id, req.user),
    host: req.user.host || config.getHost(),
    avatarHost: config.getImageServerUrl(),
    roles: ['member'],
    role: 'member',
    status: 'online',
    joinedAt: new Date().toISOString()
  }
  server.members.push(joinedMember)

  await setServers(servers)
  emitServerJoined(req.user.id, server, joinedMember, consumedInviteCode ? 'invite' : 'direct')
  console.log(`[API] User ${req.user.username} joined server ${server.name} ${consumedInviteCode ? `via invite ${consumedInviteCode}` : 'directly'}`)
  res.json(server)
})

router.delete('/:serverId/members/:memberId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  const isSelf = req.params.memberId === req.user.id
  const isOwner = server.ownerId === req.user.id
  const targetMember = server.members?.find(m => m.id === req.params.memberId)

  if (!targetMember) {
    return res.status(404).json({ error: 'Member not found' })
  }

  if (isSelf && isOwner) {
    return res.status(400).json({ error: 'Owner cannot leave. Transfer ownership first.' })
  }
  
  if (!isSelf && !hasPermission(server, req.user.id, 'kick_members')) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  if (!isSelf && !canManageTargetMember(server, req.user.id, req.params.memberId)) {
    return res.status(403).json({ error: 'Cannot moderate a member with an equal or higher role' })
  }

  if (req.params.memberId === server.ownerId && req.user.id !== server.ownerId) {
    return res.status(403).json({ error: 'Cannot remove the server owner' })
  }
  
  if (!server.members) server.members = []
  server.members = server.members.filter(m => m.id !== req.params.memberId)
  await setServers(servers)

  const kickedMemberId = req.params.memberId
  const serverId = req.params.serverId

  if (isSelf) {
    emitServerLeft(kickedMemberId, serverId, 'self-remove')
    io.to(`server:${serverId}`).emit('member:removed', {
      serverId,
      memberId: kickedMemberId,
      userId: kickedMemberId
    })
  }

  if (!isSelf) {
    // Notify the kicked user directly so their client removes the server immediately
    io.to(`user:${kickedMemberId}`).emit('member:kicked', {
      serverId,
      memberId: kickedMemberId,
      userId: kickedMemberId,
    })
    // Notify all other server members that someone was kicked
    io.to(`server:${serverId}`).emit('member:removed', {
      serverId,
      memberId: kickedMemberId,
      userId: kickedMemberId,
    })
  }

  console.log(`[API] ${isSelf ? 'User left' : 'Kicked member'} ${kickedMemberId} from server ${server.name}`)
  res.json({ success: true })
})

// User leaves server themselves
router.post('/:serverId/leave', authenticateToken, async (req, res) => {
  const servers = await getServersFresh()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (server.ownerId === req.user.id) {
    return res.status(400).json({ error: 'Cannot leave your own server. Transfer ownership first or delete the server.' })
  }

  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }
  
  if (!server.members) server.members = []
  server.members = server.members.filter(m => m.id !== req.user.id)
  await setServers(servers)
  emitServerLeft(req.user.id, req.params.serverId, 'left')
  io.to(`server:${req.params.serverId}`).emit('member:removed', {
    serverId: req.params.serverId,
    memberId: req.user.id,
    userId: req.user.id
  })
  
  console.log(`[API] User ${req.user.username} left server ${server.name}`)
  res.json({ success: true })
})

router.put('/:serverId/members/:memberId', authenticateToken, async (req, res) => {
  const { roles, role } = req.body
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'manage_roles')) {
    return res.status(403).json({ error: 'Not authorized to manage roles' })
  }

  if (req.params.memberId === server.ownerId) {
    return res.status(400).json({ error: 'Cannot edit owner roles' })
  }
  
  const member = server.members?.find(m => m.id === req.params.memberId)
  if (!member) {
    return res.status(404).json({ error: 'Member not found' })
  }

  if (!canManageTargetMember(server, req.user.id, req.params.memberId)) {
    return res.status(403).json({ error: 'Cannot edit roles for a member with an equal or higher role' })
  }

  const nextRoles = Array.isArray(roles) ? roles : (role ? [role] : [])
  if (!Array.isArray(nextRoles) || nextRoles.some(entry => typeof entry !== 'string')) {
    return res.status(400).json({ error: 'roles must be an array of role IDs' })
  }
  const validRoleIds = new Set(Array.isArray(server.roles) ? server.roles.map(r => r.id) : [])
  const filtered = nextRoles.filter(r => validRoleIds.has(r) && r !== 'owner')

  for (const roleId of filtered) {
    if (!canManageRoleId(server, req.user.id, roleId)) {
      return res.status(403).json({ error: `Cannot assign role ${roleId}` })
    }
  }

  member.roles = filtered
  member.role = member.roles[0] || null
  
  await setServers(servers)
  console.log(`[API] Updated roles for ${member.username}: [${(member.roles || []).join(', ')}]`)
  res.json({ success: true, roles: member.roles })
})

router.post('/:serverId/transfer', authenticateToken, async (req, res) => {
  const { memberId } = req.body
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (server.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Only the owner can transfer the server' })
  }
  
  const newOwner = server.members?.find(m => m.id === memberId)
  if (!newOwner) {
    return res.status(404).json({ error: 'Member not found' })
  }
  
  const oldOwnerId = server.ownerId
  server.ownerId = memberId
  
  if (!newOwner.roles) newOwner.roles = []
  if (!newOwner.roles.includes('owner')) {
    newOwner.roles = ['owner', ...newOwner.roles.filter(r => r !== 'owner')]
    newOwner.role = 'owner'
  }
  
  const oldOwner = server.members?.find(m => m.id === oldOwnerId)
  if (oldOwner) {
    oldOwner.roles = oldOwner.roles?.filter(r => r !== 'owner') || []
    oldOwner.role = oldOwner.roles[0] || null
  }
  
  await setServers(servers)
  console.log(`[API] Transferred server ${server.name} from ${oldOwnerId} to ${memberId}`)
  res.json({ success: true, ownerId: memberId })
})

router.post('/:serverId/bans/:memberId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'ban_members')) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const bannedMemberId = req.params.memberId
  const banServerId = req.params.serverId

  const targetMember = Array.isArray(server.members) ? server.members.find(m => m?.id === bannedMemberId) : null
  if (!targetMember) {
    return res.status(404).json({ error: 'Member not found' })
  }
  if (bannedMemberId === server.ownerId) {
    return res.status(403).json({ error: 'Cannot ban the server owner' })
  }
  if (!canManageTargetMember(server, req.user.id, bannedMemberId)) {
    return res.status(403).json({ error: 'Cannot ban a member with an equal or higher role' })
  }
  if (isUserBanned(server, bannedMemberId)) {
    return res.status(409).json({ error: 'Member already banned' })
  }

  if (!server.members) server.members = []
  server.members = server.members.filter(m => m.id !== bannedMemberId)
  if (!server.bans) server.bans = []
  server.bans.push({
    userId: bannedMemberId,
    bannedBy: req.user.id,
    bannedAt: new Date().toISOString()
  })
  
  await setServers(servers)

  // Notify the banned user directly so their client removes the server immediately
  io.to(`user:${bannedMemberId}`).emit('member:banned', {
    serverId: banServerId,
    memberId: bannedMemberId,
    userId: bannedMemberId,
  })
  // Notify all other server members
  io.to(`server:${banServerId}`).emit('member:removed', {
    serverId: banServerId,
    memberId: bannedMemberId,
    userId: bannedMemberId,
  })

  console.log(`[API] Banned member ${bannedMemberId} from server ${server.name}`)
  res.json({ success: true })
})

// Role management routes
router.get('/:serverId/roles', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  res.json(server.roles || [])
})

// GET /api/servers/:serverId/my-role - returns the current user's highest role in the server
router.get('/:serverId/my-role', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  const member = Array.isArray(server.members)
    ? server.members.find(m => m?.id === req.user.id)
    : null

  if (!member) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  // Check if user is owner
  const isOwner = server.ownerId === req.user.id

  // Get member's assigned roles
  const memberRoleIds = Array.isArray(member.roles) ? member.roles : []
  const serverRoles = Array.isArray(server.roles) ? server.roles : []

  // Find the highest role by position
  const memberRoles = serverRoles
    .filter(r => memberRoleIds.includes(r.id))
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))

  const highestRole = memberRoles[0] || null

  res.json({
    role: highestRole,
    roles: memberRoles,
    isOwner,
    permissions: isOwner
      ? ['administrator']
      : (highestRole?.permissions || [])
  })
})

router.post('/:serverId/roles', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'manage_roles')) {
    return res.status(403).json({ error: 'Not authorized to create roles' })
  }

  let roleInput = {}
  try {
    roleInput = pickAllowedRoleUpdates(req.body || {}, { allowCustomId: true })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  const roleName = typeof roleInput.name === 'string' ? roleInput.name.trim() : ''
  if (!roleName) {
    return res.status(400).json({ error: 'Role name is required' })
  }

  const roleId = roleInput.id || uuidv4()
  if (Array.isArray(server.roles) && server.roles.some(role => role.id === roleId)) {
    return res.status(409).json({ error: 'Role ID already exists' })
  }

  const rolePosition = roleInput.position ?? (server.roles?.length || 0)
  if (server.ownerId !== req.user.id) {
    const actorPosition = getMemberHighestRolePosition(server, req.user.id)
    if (rolePosition >= actorPosition) {
      return res.status(403).json({ error: 'Cannot create roles at or above your highest role' })
    }
  }

  const rolePermissions = Array.isArray(roleInput.permissions) ? roleInput.permissions : []
  if (!canGrantPermissions(server, req.user.id, rolePermissions)) {
    return res.status(403).json({ error: 'Cannot grant permissions you do not have' })
  }
  
  const newRole = {
    id: roleId,
    name: roleName,
    color: roleInput.color || '#1fb6ff',
    permissions: rolePermissions,
    position: rolePosition
  }
  
  if (!server.roles) server.roles = []
  server.roles.push(newRole)
  await setServers(servers)
  
  io.to(`server:${req.params.serverId}`).emit('role:created', { ...newRole, serverId: req.params.serverId })
  
  console.log(`[API] Created role: ${newRole.name} in server ${server.name}`)
  res.status(201).json(newRole)
})

router.put('/:serverId/roles/:roleId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'manage_roles')) {
    return res.status(403).json({ error: 'Not authorized to edit roles' })
  }
  
  if (!server.roles) {
    server.roles = []
  }
  
  const roleIndex = server.roles.findIndex(r => r.id === req.params.roleId)
  if (roleIndex === -1) {
    return res.status(404).json({ error: 'Role not found' })
  }

  if (!canManageRoleId(server, req.user.id, req.params.roleId)) {
    return res.status(403).json({ error: 'Cannot edit this role' })
  }

  let safeRoleUpdates = {}
  try {
    safeRoleUpdates = pickAllowedRoleUpdates(req.body || {})
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  if (Object.keys(safeRoleUpdates).length === 0) {
    return res.status(400).json({ error: 'No mutable role fields provided' })
  }

  if (safeRoleUpdates.permissions && !canGrantPermissions(server, req.user.id, safeRoleUpdates.permissions)) {
    return res.status(403).json({ error: 'Cannot grant permissions you do not have' })
  }
  if (safeRoleUpdates.position !== undefined && server.ownerId !== req.user.id) {
    const actorPosition = getMemberHighestRolePosition(server, req.user.id)
    if (safeRoleUpdates.position >= actorPosition) {
      return res.status(403).json({ error: 'Cannot move roles at or above your highest role' })
    }
  }
  if (safeRoleUpdates.name !== undefined) {
    safeRoleUpdates.name = safeRoleUpdates.name.trim()
    if (!safeRoleUpdates.name) {
      return res.status(400).json({ error: 'Role name cannot be empty' })
    }
  }
  
  server.roles[roleIndex] = {
    ...server.roles[roleIndex],
    ...safeRoleUpdates,
    id: req.params.roleId // Ensure ID doesn't change
  }
  
  await setServers(servers)
  
  io.to(`server:${req.params.serverId}`).emit('role:updated', { ...server.roles[roleIndex], serverId: req.params.serverId })
  
  console.log(`[API] Updated role: ${server.roles[roleIndex].name}`)
  res.json(server.roles[roleIndex])
})

router.delete('/:serverId/roles/:roleId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'manage_roles')) {
    return res.status(403).json({ error: 'Not authorized to delete roles' })
  }
  
  if (!server.roles) {
    server.roles = []
  }

  const roleToDelete = server.roles.find(role => role.id === req.params.roleId)
  if (!roleToDelete) {
    return res.status(404).json({ error: 'Role not found' })
  }
  if (req.params.roleId === 'owner') {
    return res.status(400).json({ error: 'Cannot delete owner role' })
  }
  if (!canManageRoleId(server, req.user.id, req.params.roleId)) {
    return res.status(403).json({ error: 'Cannot delete this role' })
  }
  
  server.roles = server.roles.filter(r => r.id !== req.params.roleId)
  
  // Remove role from all members who had it
  server.members?.forEach(m => {
    if (Array.isArray(m.roles)) {
      m.roles = m.roles.filter(r => r !== req.params.roleId)
      m.role = m.roles[0] || null
    } else if (m.role === req.params.roleId) {
      m.role = null
    }
  })
  
  await setServers(servers)
  
  io.to(`server:${req.params.serverId}`).emit('role:deleted', { roleId: req.params.roleId, serverId: req.params.serverId })
  
  console.log(`[API] Deleted role: ${req.params.roleId}`)
  res.json({ success: true })
})

router.get('/:serverId/emojis', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)

  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  // Add host info to each emoji for global format
  const emojisWithHost = Array.isArray(server.emojis) ? server.emojis.map(emoji => ({
    ...emoji,
    host: getServerHost(),
    serverId: server.id,
    serverName: server.name
  })) : []

  res.json(emojisWithHost)
})

router.post('/:serverId/emojis', authenticateToken, async (req, res) => {
  const { name, url } = req.body
  
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL required' })
  }
  
  const servers = getServers()
  const serverIndex = servers.findIndex(s => s.id === req.params.serverId)
  
  if (serverIndex === -1) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  const server = servers[serverIndex]
  if (!hasPermission(server, req.user.id, 'manage_emojis')) {
    return res.status(403).json({ error: 'Not authorized to manage emojis' })
  }
  
  if (!server.emojis) {
    server.emojis = []
  }
  
  const emoji = {
    id: uuidv4(),
    name,
    url,
    addedBy: req.user.id,
    addedAt: new Date().toISOString()
  }
  
  if (!server.emojis) server.emojis = []
  server.emojis.push(emoji)
  servers[serverIndex] = server
  await setServers(servers)
  
  const emojiData = { 
    ...emoji, 
    serverId: req.params.serverId, 
    serverName: server.name,
    host: getServerHost()
  }
  
  // Emit to server room
  io.to(`server:${req.params.serverId}`).emit('emoji:created', emojiData)
  // Also emit globally so all connected clients can update their global emoji cache
  io.emit('emoji:created', emojiData)
  
  console.log(`[API] Added emoji ${name} to server ${req.params.serverId}`)
  res.json(emoji)
})

router.delete('/:serverId/emojis/:emojiId', authenticateToken, async (req, res) => {
  const servers = getServers()
  const serverIndex = servers.findIndex(s => s.id === req.params.serverId)
  
  if (serverIndex === -1) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  const server = servers[serverIndex]
  if (!hasPermission(server, req.user.id, 'manage_emojis')) {
    return res.status(403).json({ error: 'Not authorized to manage emojis' })
  }
  const emojiExists = Array.isArray(server.emojis) && server.emojis.some(e => e.id === req.params.emojiId)
  if (!emojiExists) {
    return res.status(404).json({ error: 'Emoji not found' })
  }
  server.emojis = Array.isArray(server.emojis) ? server.emojis.filter(e => e.id !== req.params.emojiId) : []
  servers[serverIndex] = server
  await setServers(servers)
  
  // Emit to server room
  io.to(`server:${req.params.serverId}`).emit('emoji:deleted', { emojiId: req.params.emojiId, serverId: req.params.serverId })
  // Also emit globally so all connected clients can update their global emoji cache
  io.emit('emoji:deleted', { emojiId: req.params.emojiId, serverId: req.params.serverId })
  
  console.log(`[API] Deleted emoji ${req.params.emojiId} from server ${req.params.serverId}`)
  res.json({ success: true })
})

// Global emojis - get all emojis from all servers the user is in
router.get('/emojis/global', authenticateToken, (req, res) => {
  const userId = req.user.id
  const allServers = getServers()
  
  // Get servers user is a member of
  const userServers = allServers.filter(s => {
    if (s.ownerId === userId) return true
    if (!Array.isArray(s.members)) return false
    return s.members.some(member => {
      if (typeof member === 'string') return member === userId
      return member?.id === userId
    })
  })
  
  // Collect all emojis with server info
  const allEmojis = []
  userServers.forEach(server => {
    if (server.emojis && server.emojis.length > 0) {
      server.emojis.forEach(emoji => {
        allEmojis.push({
          ...emoji,
          serverId: server.id,
          serverName: server.name,
          host: getServerHost()
        })
      })
    }
  })
  
  console.log(`[API] Global emojis for user ${userId}: ${allEmojis.length} emojis from ${userServers.length} servers`)
  res.json(allEmojis)
})

// Category routes
router.get('/:serverId/categories', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!isServerMember(server, req.user.id)) {
    return res.status(403).json({ error: 'Not a member of this server' })
  }

  const allCategories = getAllCategories()
  const categories = allCategories[req.params.serverId] || []
  console.log(`[API] Get categories for server ${req.params.serverId} - returned ${categories.length} categories`)
  res.json(categories)
})

router.post('/:serverId/categories', authenticateToken, async (req, res) => {
  const { name, position } = req.body
  const serverId = req.params.serverId

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to manage categories' })
  }
  
  const newCategory = {
    id: uuidv4(),
    serverId,
    name,
    position: position ?? 0,
    createdAt: new Date().toISOString()
  }
  
  const allCategories = getAllCategories()
  if (!allCategories[serverId]) {
    allCategories[serverId] = []
  }
  allCategories[serverId].push(newCategory)
  await setAllCategories(allCategories)
  
  io.to(`server:${serverId}`).emit('category:created', newCategory)
  
  console.log(`[API] Created category: ${name} in server ${serverId}`)
  res.status(201).json(newCategory)
})

router.put('/:serverId/categories/order', authenticateToken, async (req, res) => {
  const { categoryIds } = req.body
  const serverId = req.params.serverId
  
  if (!categoryIds || !Array.isArray(categoryIds)) {
    return res.status(400).json({ error: 'categoryIds array required' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to manage categories' })
  }

  const allCategories = getAllCategories()
  const categories = allCategories[serverId] || []
  
  const reorderedCategories = categoryIds.map((id, index) => {
    const category = categories.find(c => c.id === id)
    if (category) {
      return { ...category, position: index }
    }
    return null
  }).filter(Boolean)
  
  allCategories[serverId] = reorderedCategories
  await setAllCategories(allCategories)
  
  io.to(`server:${serverId}`).emit('category:order-updated', reorderedCategories)
  
  console.log(`[API] Updated category order for server ${serverId}`)
  res.json(reorderedCategories)
})

// Individual category routes (for update/delete)
router.put('/categories/:categoryId', authenticateToken, async (req, res) => {
  const allCategories = getAllCategories()
  let foundCategory = null
  let serverId = null
  
  // Find category across all servers
  for (const [sid, categories] of Object.entries(allCategories)) {
    if (!Array.isArray(categories)) continue
    const idx = categories.findIndex(c => c.id === req.params.categoryId)
    if (idx !== -1) {
      foundCategory = categories[idx]
      serverId = sid
      break
    }
  }
  
  if (!foundCategory) {
    return res.status(404).json({ error: 'Category not found' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to edit categories' })
  }

  let safeUpdates = {}
  try {
    safeUpdates = pickAllowedCategoryUpdates(req.body || {})
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
  if (Object.keys(safeUpdates).length === 0) {
    return res.status(400).json({ error: 'No mutable category fields provided' })
  }

  const serverCategories = toGroupedItems(allCategories[serverId])
  const categoryIndex = serverCategories.findIndex(c => c.id === req.params.categoryId)
  if (categoryIndex === -1) {
    return res.status(404).json({ error: 'Category not found' })
  }

  serverCategories[categoryIndex] = {
    ...serverCategories[categoryIndex],
    ...safeUpdates,
    id: req.params.categoryId,
    serverId,
    updatedAt: new Date().toISOString()
  }
  allCategories[serverId] = serverCategories
  await setAllCategories(allCategories)

  io.to(`server:${serverId}`).emit('category:updated', serverCategories[categoryIndex])
  console.log(`[API] Updated category ${req.params.categoryId}`)
  return res.json(serverCategories[categoryIndex])
})

router.delete('/categories/:categoryId', authenticateToken, async (req, res) => {
  if (req.params.categoryId === 'uncategorized') {
    return res.status(400).json({ error: 'Cannot delete uncategorized pseudo-category' })
  }
  
  const allCategories = getAllCategories()
  let serverId = null
  
  // Find category across all servers
  for (const [sid, categories] of Object.entries(allCategories)) {
    if (!Array.isArray(categories)) continue
    const idx = categories.findIndex(c => c.id === req.params.categoryId)
    if (idx !== -1) {
      serverId = sid
      break
    }
  }
  
  if (!serverId) {
    return res.status(404).json({ error: 'Category not found' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to delete categories' })
  }

  // Remove category
  allCategories[serverId] = toGroupedItems(allCategories[serverId]).filter(c => c.id !== req.params.categoryId)
  await setAllCategories(allCategories)
  
  // Move all channels in this category to uncategorized (null)
  const allChannels = getAllChannels()
  if (allChannels[serverId]) {
    allChannels[serverId] = allChannels[serverId].map(c => {
      if (c.categoryId === req.params.categoryId) {
        return { ...c, categoryId: null }
      }
      return c
    })
    await setAllChannels(allChannels)
  }
  
  io.to(`server:${serverId}`).emit('category:deleted', { categoryId: req.params.categoryId, serverId })
  
  console.log(`[API] Deleted category ${req.params.categoryId}`)
  res.json({ success: true })
})

// Get server guild tag settings
router.get('/:serverId/guild-tag', authenticateToken, async (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!isServerMember(server, req.user.id)) return res.status(403).json({ error: 'Not authorized' })
  res.json({
    guildTag: server.guildTag || null,
    guildTagPrivate: server.guildTagPrivate === true
  })
})

// Set server guild tag (owner/admin only)
router.put('/:serverId/guild-tag', authenticateToken, async (req, res) => {
  const servers = getServers()
  const index = servers.findIndex(s => s.id === req.params.serverId)
  if (index === -1) return res.status(404).json({ error: 'Server not found' })
  const server = servers[index]
  if (!hasPermission(server, req.user.id, 'manage_server')) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  const { guildTag, guildTagPrivate } = req.body
  if (guildTag !== undefined) {
    if (guildTag === null || guildTag === '') {
      servers[index].guildTag = null
    } else {
      const tag = String(guildTag).trim()
      if (tag.length < 1 || tag.length > 4) {
        return res.status(400).json({ error: 'Guild tag must be 1-4 characters' })
      }
      // No emojis allowed
      if (/\p{Emoji}/u.test(tag)) {
        return res.status(400).json({ error: 'Emojis are not allowed in guild tags' })
      }

      const lowerTag = tag.toLowerCase()
      if (isTagBlacklisted(tag)){
        return res.status(400).json({ error: 'This guild tag is not allowed' })
      }

      servers[index].guildTag = tag
    }
  }
  if (guildTagPrivate !== undefined) {
    servers[index].guildTagPrivate = Boolean(guildTagPrivate)
  }
  servers[index].updatedAt = new Date().toISOString()
  await setServers(servers)
  io.to(`server:${req.params.serverId}`).emit('server:updated', servers[index])
  console.log(`[API] Updated guild tag for server ${req.params.serverId}: ${servers[index].guildTag}`)
  res.json({ guildTag: servers[index].guildTag || null, guildTagPrivate: servers[index].guildTagPrivate === true })
})

// ─── TIMEOUT ────────────────────────────────────────────────────────────────
// POST /:serverId/members/:memberId/timeout
// Body: { duration: <seconds>, reason: <string> }
// duration = 0 → remove timeout
router.post('/:serverId/members/:memberId/timeout', authenticateToken, async (req, res) => {
  const { serverId, memberId } = req.params
  const servers = getServers()
  const index = servers.findIndex(s => s.id === serverId)
  if (index === -1) return res.status(404).json({ error: 'Server not found' })
  const server = servers[index]

  if (!hasPermission(server, req.user.id, 'kick_members') && !hasPermission(server, req.user.id, 'ban_members')) {
    return res.status(403).json({ error: 'Not authorized to timeout members' })
  }

  // Cannot timeout the server owner
  if (memberId === server.ownerId) {
    return res.status(400).json({ error: 'Cannot timeout the server owner' })
  }

  // Cannot timeout yourself
  if (memberId === req.user.id) {
    return res.status(400).json({ error: 'Cannot timeout yourself' })
  }

  const hasDuration = req.body?.duration !== undefined && req.body?.duration !== null && req.body?.duration !== ''
  const duration = hasDuration ? Number.parseInt(req.body.duration, 10) : 0
  if (!Number.isInteger(duration)) {
    return res.status(400).json({ error: 'duration must be an integer number of seconds' })
  }
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim().slice(0, 500)
    : null

  const member = server.members?.find(m => m && m.id === memberId)
  if (!member) return res.status(404).json({ error: 'Member not found' })
  if (!canManageTargetMember(server, req.user.id, memberId)) {
    return res.status(403).json({ error: 'Cannot timeout a member with an equal or higher role' })
  }

  if (duration < 0 || duration > MAX_TIMEOUT_SECONDS) {
    return res.status(400).json({ error: `duration must be between 0 and ${MAX_TIMEOUT_SECONDS} seconds` })
  }

  if (duration === 0) {
    // Remove timeout
    member.timeoutUntil = null
    member.timeoutReason = null
  } else {
    const timeoutUntil = new Date(Date.now() + duration * 1000).toISOString()
    member.timeoutUntil = timeoutUntil
    member.timeoutReason = reason
  }

  await setServers(servers)

  // Notify the timed-out user
  io.to(`user:${memberId}`).emit('member:timeout', {
    serverId,
    memberId,
    timeoutUntil: member.timeoutUntil,
    reason: member.timeoutReason,
    moderatorId: req.user.id
  })

  // Notify all server members so they can update the member list
  io.to(`server:${serverId}`).emit('member:updated', {
    serverId,
    member: { id: memberId, timeoutUntil: member.timeoutUntil, timeoutReason: member.timeoutReason }
  })

  console.log(`[API] ${duration <= 0 ? 'Removed timeout for' : 'Timed out'} member ${memberId} in server ${server.name}${duration > 0 ? ` for ${duration}s` : ''}`)
  res.json({ success: true, memberId, timeoutUntil: member.timeoutUntil })
})

// ─── VOICE DISCONNECT ────────────────────────────────────────────────────────
// POST /:serverId/members/:memberId/voice-disconnect
// Forcibly disconnects a user from any voice channel in this server
router.post('/:serverId/members/:memberId/voice-disconnect', authenticateToken, async (req, res) => {
  const { serverId, memberId } = req.params
  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })

  if (!hasPermission(server, req.user.id, 'kick_members') && !hasPermission(server, req.user.id, 'ban_members')) {
    return res.status(403).json({ error: 'Not authorized to disconnect members from voice' })
  }

  if (memberId === server.ownerId && req.user.id !== server.ownerId) {
    return res.status(400).json({ error: 'Cannot disconnect the server owner from voice' })
  }

  const member = Array.isArray(server.members) ? server.members.find(m => m?.id === memberId) : null
  if (!member) {
    return res.status(404).json({ error: 'Member not found' })
  }
  if (!canManageTargetMember(server, req.user.id, memberId)) {
    return res.status(403).json({ error: 'Cannot disconnect a member with an equal or higher role' })
  }

  // Emit to the target user's socket to force them to leave voice
  io.to(`user:${memberId}`).emit('voice:force-disconnect', {
    serverId,
    moderatorId: req.user.id,
    reason: typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 500) : null
  })

  // Also clean up server-side voice state immediately so all other participants
  // see the user leave right away (even if the client is slow to respond)
  const allChannels = getAllChannels()
  const serverChannels = allChannels[serverId] || []
  const voiceChannelIds = serverChannels.filter(c => c.type === 'voice').map(c => c.id)
  let disconnectedFrom = null
  for (const channelId of voiceChannelIds) {
    const participants = getVoiceChannelUsers(channelId)
    if (participants.some(p => p.id === memberId)) {
      cleanupVoiceUser(io, channelId, memberId, 'force-disconnect')
      disconnectedFrom = channelId
      break
    }
  }

  console.log(`[API] Force-disconnected member ${memberId} from voice in server ${server.name}${disconnectedFrom ? ` (channel ${disconnectedFrom})` : ' (not in voice)'}`)
  res.json({ success: true, memberId, channelId: disconnectedFrom })
})

export default router
