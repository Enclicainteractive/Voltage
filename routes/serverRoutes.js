import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { io } from '../server.js'
import { discoveryService } from '../services/dataService.js'
import config from '../config/config.js'

const getAvatarUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json')
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const router = express.Router()

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
  server.members = (server.members || []).map(normalizeMember)
  server.themeColor = server.themeColor || '#1fb6ff'
  server.bannerUrl = server.bannerUrl || ''
  return server
}

const getServers = () => loadData(SERVERS_FILE, []).map(normalizeServer)
const setServers = (servers) => saveData(SERVERS_FILE, servers)

const getAllChannels = () => loadData(CHANNELS_FILE, {})
const setAllChannels = (channels) => saveData(CHANNELS_FILE, channels)

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

router.get('/', authenticateToken, (req, res) => {
  const allServers = getServers()
  const userId = req.user.id
  
  const userServers = allServers.filter(server => {
    const members = server.members || []
    return members.some(m => m.id === userId)
  })
  
  console.log(`[API] Get servers - returned ${userServers.length} servers for user ${req.user.username}`)
  res.json(userServers)
})

router.get('/:serverId/members', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  res.json(server.members || [])
})

router.get('/:serverId', authenticateToken, (req, res) => {
  const servers = getServers()
  let server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    console.log(`[API] Server not found: ${req.params.serverId}`)
    return res.status(404).json({ error: 'Server not found' })
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
    setServers(servers)
  }
  
  console.log(`[API] Get server: ${server.name}`)
  res.json(server)
})

router.post('/', authenticateToken, (req, res) => {
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
  
  const servers = getServers()
  servers.push(newServer)
  setServers(servers)
  
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
  const allChannels = getAllChannels()
  allChannels[serverId] = channels
  setAllChannels(allChannels)
  
  newServer.defaultChannelId = generalChannel.id
  
  console.log(`[API] Created server: ${name} with ${channels.length} default channels`)
  res.status(201).json(newServer)
})

router.put('/:serverId', authenticateToken, (req, res) => {
  const servers = getServers()
  const index = servers.findIndex(s => s.id === req.params.serverId)
  
  if (index === -1) {
    return res.status(404).json({ error: 'Server not found' })
  }

  const server = servers[index]
  if (!hasPermission(server, req.user.id, 'manage_server')) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  servers[index] = { ...servers[index], ...req.body, updatedAt: new Date().toISOString() }
  setServers(servers)
  
  const updatedServer = servers[index]
  io.to(`server:${req.params.serverId}`).emit('server:updated', updatedServer)
  
  console.log(`[API] Updated server: ${updatedServer.name}`)
  res.json(updatedServer)
})

router.delete('/:serverId', authenticateToken, (req, res) => {
  const serverId = req.params.serverId
  
  const servers = getServers()
  const filtered = servers.filter(s => s.id !== serverId)
  setServers(filtered)
  
  const allChannels = getAllChannels()
  const serverChannels = allChannels[serverId] || []
  delete allChannels[serverId]
  setAllChannels(allChannels)
  
  const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json')
  const FILES_FILE = path.join(DATA_DIR, 'files.json')
  const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')
  
  const messages = loadData(MESSAGES_FILE, {})
  serverChannels.forEach(channel => {
    if (messages[channel.id]) {
      delete messages[channel.id]
    }
  })
  saveData(MESSAGES_FILE, messages)
  
  const files = loadData(FILES_FILE, {})
  const filesToDelete = Object.values(files).filter(f => f.serverId === serverId)
  filesToDelete.forEach(file => {
    if (file.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path)
      } catch (err) {
        console.error('[Data] Error deleting file:', err.message)
      }
    }
    delete files[file.id]
  })
  saveData(FILES_FILE, files)
  
  console.log(`[API] Deleted server: ${serverId} (${serverChannels.length} channels, ${filesToDelete.length} files deleted)`)
  res.json({ success: true })
})

router.get('/:serverId/channels', authenticateToken, (req, res) => {
  const allChannels = getAllChannels()
  const channels = allChannels[req.params.serverId] || []
  console.log(`[API] Get channels for server ${req.params.serverId} - returned ${channels.length} channels`)
  res.json(channels)
})

router.post('/:serverId/channels', authenticateToken, (req, res) => {
  const { name, type } = req.body
  const serverId = req.params.serverId

  const servers = getServers()
  const server = servers.find(s => s.id === serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!hasPermission(server, req.user.id, 'manage_channels')) {
    return res.status(403).json({ error: 'Not authorized to manage channels' })
  }
  
  const newChannel = {
    id: uuidv4(),
    serverId,
    name,
    type: type || 'text',
    createdAt: new Date().toISOString()
  }
  
  const allChannels = getAllChannels()
  const channels = allChannels[serverId] || []
  channels.push(newChannel)
  allChannels[serverId] = channels
  setAllChannels(allChannels)
  
  io.to(`server:${serverId}`).emit('channel:created', newChannel)
  
  console.log(`[API] Created channel: ${name} in server ${serverId}`)
  res.status(201).json(newChannel)
})

router.put('/:serverId/channels/order', authenticateToken, (req, res) => {
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
  setAllChannels(allChannels)
  
  io.to(`server:${serverId}`).emit('channel:order-updated', reorderedChannels)
  
  console.log(`[API] Updated channel order for server ${serverId}`)
  res.json(reorderedChannels)
})

import { inviteService } from '../services/dataService.js'

router.get('/:serverId/invites', authenticateToken, (req, res) => {
  const invites = inviteService.getServerInvites(req.params.serverId)
  res.json(invites)
})

router.post('/:serverId/invites', authenticateToken, (req, res) => {
  const { maxUses, expiresAt } = req.body
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'create_invites')) {
    return res.status(403).json({ error: 'Not authorized to create invites' })
  }

  const invite = inviteService.createInvite(req.params.serverId, req.user.id, { maxUses, expiresAt })
  console.log(`[API] Created invite for server ${req.params.serverId}: ${invite.code}`)
  res.status(201).json(invite)
})

router.delete('/:serverId/invites/:code', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!hasPermission(server, req.user.id, 'create_invites')) {
    return res.status(403).json({ error: 'Not authorized to delete invites' })
  }

  inviteService.deleteInvite(req.params.serverId, req.params.code)
  console.log(`[API] Deleted invite ${req.params.code}`)
  res.json({ success: true })
})

router.post('/invites/:code/join', authenticateToken, (req, res) => {
  const result = inviteService.useInvite(req.params.code)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  const servers = getServers()
  const server = servers.find(s => s.id === result.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  const existingMember = server.members?.find(m => m.id === req.user.id)
  if (existingMember) {
    return res.status(400).json({ error: 'Already a member' })
  }
  
  if (!server.members) server.members = []
  server.members.push({
    id: req.user.id,
    username: req.user.username,
    avatar: getAvatarUrl(req.user.id),
    roles: ['member'],
    role: 'member',
    status: 'online',
    joinedAt: new Date().toISOString()
  })
  
  setServers(servers)
  console.log(`[API] User ${req.user.username} joined server ${server.name}`)
  res.json(server)
})

router.post('/:serverId/join', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!discoveryService.isInDiscovery(server.id)) {
    return res.status(403).json({ error: 'Server not available for direct join' })
  }
  
  const existingMember = server.members?.find(m => m.id === req.user.id)
  if (existingMember) {
    return res.status(400).json({ error: 'Already a member' })
  }
  
  if (!server.members) server.members = []
  server.members.push({
    id: req.user.id,
    username: req.user.username,
    avatar: getAvatarUrl(req.user.id),
    roles: ['member'],
    role: 'member',
    status: 'online',
    joinedAt: new Date().toISOString()
  })
  
  setServers(servers)
  console.log(`[API] User ${req.user.username} joined server ${server.name} directly`)
  res.json(server)
})

router.delete('/:serverId/members/:memberId', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  // User leaving their own server - allow without permission check
  const isSelf = req.params.memberId === req.user.id
  const isOwner = server.ownerId === req.user.id
  
  if (!isSelf && !hasPermission(server, req.user.id, 'kick_members')) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  // Prevent owner from leaving without transferring
  if (isOwner && !isSelf) {
    return res.status(400).json({ error: 'Owner cannot kick themselves. Transfer ownership first.' })
  }
  
  server.members = server.members.filter(m => m.id !== req.params.memberId)
  setServers(servers)
  
  console.log(`[API] ${isSelf ? 'User left' : 'Kicked member'} ${req.params.memberId} from server ${server.name}`)
  res.json({ success: true })
})

// User leaves server themselves
router.post('/:serverId/leave', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (server.ownerId === req.user.id) {
    return res.status(400).json({ error: 'Cannot leave your own server. Transfer ownership first or delete the server.' })
  }
  
  server.members = server.members.filter(m => m.id !== req.user.id)
  setServers(servers)
  
  console.log(`[API] User ${req.user.username} left server ${server.name}`)
  res.json({ success: true })
})

router.put('/:serverId/members/:memberId', authenticateToken, (req, res) => {
  const { roles, role } = req.body
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'manage_roles')) {
    return res.status(403).json({ error: 'Not authorized to manage roles' })
  }
  
  const member = server.members?.find(m => m.id === req.params.memberId)
  if (!member) {
    return res.status(404).json({ error: 'Member not found' })
  }

  const nextRoles = Array.isArray(roles) ? roles : (role ? [role] : [])
  const validRoleIds = new Set((server.roles || []).map(r => r.id))
  const filtered = nextRoles.filter(r => validRoleIds.has(r) && r !== 'owner')
  member.roles = filtered
  member.role = member.roles[0] || null
  
  setServers(servers)
  console.log(`[API] Updated roles for ${member.username}: [${member.roles.join(', ')}]`)
  res.json({ success: true, roles: member.roles })
})

router.post('/:serverId/transfer', authenticateToken, (req, res) => {
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
  
  setServers(servers)
  console.log(`[API] Transferred server ${server.name} from ${oldOwnerId} to ${memberId}`)
  res.json({ success: true, ownerId: memberId })
})

router.post('/:serverId/bans/:memberId', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'ban_members')) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  server.members = server.members.filter(m => m.id !== req.params.memberId)
  if (!server.bans) server.bans = []
  server.bans.push({
    userId: req.params.memberId,
    bannedBy: req.user.id,
    bannedAt: new Date().toISOString()
  })
  
  setServers(servers)
  console.log(`[API] Banned member ${req.params.memberId} from server ${server.name}`)
  res.json({ success: true })
})

// Role management routes
router.get('/:serverId/roles', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  res.json(server.roles || [])
})

router.post('/:serverId/roles', authenticateToken, (req, res) => {
  const servers = getServers()
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  if (!hasPermission(server, req.user.id, 'manage_roles')) {
    return res.status(403).json({ error: 'Not authorized to create roles' })
  }
  
  const newRole = {
    id: req.body.id || uuidv4(),
    name: req.body.name,
    color: req.body.color || '#1fb6ff',
    permissions: req.body.permissions || [],
    position: req.body.position ?? (server.roles?.length || 0)
  }
  
  server.roles.push(newRole)
  setServers(servers)
  
  io.to(`server:${req.params.serverId}`).emit('role:created', { ...newRole, serverId: req.params.serverId })
  
  console.log(`[API] Created role: ${newRole.name} in server ${server.name}`)
  res.status(201).json(newRole)
})

router.put('/:serverId/roles/:roleId', authenticateToken, (req, res) => {
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
  
  server.roles[roleIndex] = {
    ...server.roles[roleIndex],
    ...req.body,
    id: req.params.roleId // Ensure ID doesn't change
  }
  
  setServers(servers)
  
  io.to(`server:${req.params.serverId}`).emit('role:updated', { ...server.roles[roleIndex], serverId: req.params.serverId })
  
  console.log(`[API] Updated role: ${server.roles[roleIndex].name}`)
  res.json(server.roles[roleIndex])
})

router.delete('/:serverId/roles/:roleId', authenticateToken, (req, res) => {
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
  
  setServers(servers)
  
  io.to(`server:${req.params.serverId}`).emit('role:deleted', { roleId: req.params.roleId, serverId: req.params.serverId })
  
  console.log(`[API] Deleted role: ${req.params.roleId}`)
  res.json({ success: true })
})

router.get('/:serverId/emojis', (req, res) => {
  const servers = loadData(SERVERS_FILE, [])
  const server = servers.find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  res.json(server.emojis || [])
})

router.post('/:serverId/emojis', authenticateToken, (req, res) => {
  const { name, url } = req.body
  
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL required' })
  }
  
  const servers = loadData(SERVERS_FILE, [])
  const serverIndex = servers.findIndex(s => s.id === req.params.serverId)
  
  if (serverIndex === -1) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  const server = servers[serverIndex]
  
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
  
  server.emojis.push(emoji)
  servers[serverIndex] = server
  saveData(SERVERS_FILE, servers)
  
  io.to(`server:${req.params.serverId}`).emit('emoji:created', emoji)
  
  console.log(`[API] Added emoji ${name} to server ${req.params.serverId}`)
  res.json(emoji)
})

router.delete('/:serverId/emojis/:emojiId', authenticateToken, (req, res) => {
  const servers = loadData(SERVERS_FILE, [])
  const serverIndex = servers.findIndex(s => s.id === req.params.serverId)
  
  if (serverIndex === -1) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  const server = servers[serverIndex]
  server.emojis = (server.emojis || []).filter(e => e.id !== req.params.emojiId)
  servers[serverIndex] = server
  saveData(SERVERS_FILE, servers)
  
  io.to(`server:${req.params.serverId}`).emit('emoji:deleted', { emojiId: req.params.emojiId, serverId: req.params.serverId })
  
  console.log(`[API] Deleted emoji ${req.params.emojiId} from server ${req.params.serverId}`)
  res.json({ success: true })
})

export default router
