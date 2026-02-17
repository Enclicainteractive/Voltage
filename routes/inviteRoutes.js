import express from 'express'
import { authenticateToken, optionalAuth } from '../middleware/authMiddleware.js'
import { inviteService } from '../services/dataService.js'
import { InviteEncoder, parseCrossHostInvite, createCrossHostInvite } from '../utils/inviteEncoder.js'
import axios from 'axios'
import config from '../config/config.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json')

const getAvatarUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
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

const getServers = () => loadData(SERVERS_FILE, [])
const setServers = (servers) => saveData(SERVERS_FILE, servers)

// Get invite info (public - for invite page)
router.get('/:code', optionalAuth, (req, res) => {
  const invite = inviteService.getInvite(req.params.code)
  
  if (!invite) {
    return res.status(404).json({ error: 'Invalid or expired invite' })
  }
  
  const servers = getServers()
  const server = servers.find(s => s.id === invite.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  // Get online count (simplified - in production would check socket connections)
  const onlineCount = server.members?.filter(m => m.status === 'online').length || 1
  
  // Get inviter info
  const inviter = server.members?.find(m => m.id === invite.createdBy)
  
  res.json({
    code: invite.code,
    server: {
      id: server.id,
      name: server.name,
      icon: server.icon,
      memberCount: server.members?.length || 1,
      onlineCount
    },
    inviter: inviter ? {
      id: inviter.id,
      username: inviter.username,
      avatar: getAvatarUrl(inviter.id)
    } : null,
    expiresAt: invite.expiresAt,
    uses: invite.uses
  })
})

// Join server via invite
router.post('/:code/join', authenticateToken, (req, res) => {
  const result = inviteService.useInvite(req.params.code)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  const servers = getServers()
  const server = servers.find(s => s.id === result.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  
  // Check if already a member
  const existingMember = server.members?.find(m => m.id === req.user.id)
  if (existingMember) {
    return res.json(server) // Already a member, just return server
  }
  
  // Add user to server
  if (!server.members) server.members = []
  server.members.push({
    id: req.user.id,
    username: req.user.username || req.user.email,
    avatar: getAvatarUrl(req.user.id),
    roles: ['member'],
    role: 'member',
    status: 'online',
    joinedAt: new Date().toISOString()
  })
  
  setServers(servers)
  console.log(`[API] User ${req.user.username} joined server ${server.name} via invite ${req.params.code}`)
  res.json(server)
})

// Cross-host invite endpoints
router.get('/cross-host/:code', optionalAuth, async (req, res) => {
  try {
    const decoded = parseCrossHostInvite(req.params.code)
    
    if (!decoded) {
      return res.status(400).json({ error: 'Invalid invite code' })
    }

    const serverHost = decoded.host
    const currentHost = config.getHost()
    
    if (serverHost === currentHost) {
      const invite = inviteService.getInvite(decoded.key || decoded.serverId)
      if (!invite) {
        return res.status(404).json({ error: 'Invite not found' })
      }
      return res.json({
        type: 'local',
        serverId: invite.serverId
      })
    }

    const servers = getServers()
    const server = servers.find(s => s.id === decoded.serverId)
    
    if (!server) {
      return res.status(404).json({ error: 'Server not found' })
    }

    const onlineCount = server.members?.filter(m => m.status === 'online').length || 1
    
    res.json({
      type: 'cross-host',
      host: serverHost,
      server: {
        id: server.id,
        name: server.name,
        icon: server.icon,
        memberCount: server.members?.length || 1,
        onlineCount
      }
    })
  } catch (error) {
    console.error('[API] Cross-host invite error:', error)
    res.status(500).json({ error: 'Failed to fetch invite' })
  }
})

router.post('/cross-host/:code/join', authenticateToken, async (req, res) => {
  try {
    const decoded = parseCrossHostInvite(req.params.code)
    
    if (!decoded) {
      return res.status(400).json({ error: 'Invalid invite code' })
    }

    const serverHost = decoded.host
    const currentHost = config.getHost()
    
    if (serverHost === currentHost) {
      const result = inviteService.useInvite(decoded.key || decoded.serverId)
      if (result.error) {
        return res.status(400).json({ error: result.error })
      }
      const servers = getServers()
      const server = servers.find(s => s.id === result.serverId)
      return res.json(server)
    }

    const servers = getServers()
    const server = servers.find(s => s.id === decoded.serverId)
    
    if (!server) {
      return res.status(404).json({ error: 'Server not found' })
    }

    const existingMember = server.members?.find(m => m.id === req.user.id)
    if (existingMember) {
      return res.json(server)
    }

    if (!server.members) server.members = []
    server.members.push({
      id: req.user.id,
      username: req.user.username,
      avatar: getAvatarUrl(req.user.id),
      roles: ['member'],
      role: 'member',
      status: 'online',
      joinedAt: new Date().toISOString(),
      remoteHost: serverHost
    })
    
    setServers(servers)
    
    console.log(`[API] User ${req.user.username} joined cross-host server ${server.name} (${serverHost})`)
    
    res.json(server)
  } catch (error) {
    console.error('[API] Cross-host join error:', error)
    res.status(500).json({ error: 'Failed to join server' })
  }
})

router.get('/cross-host/:code/generate-link', authenticateToken, (req, res) => {
  const decoded = parseCrossHostInvite(req.params.code)
  
  if (!decoded) {
    return res.status(400).json({ error: 'Invalid invite code' })
  }

  const currentHost = config.getHost()
  const linkData = createCrossHostInvite(decoded.serverId, decoded.channelId, currentHost, req.params.code)
  
  res.json({
    code: linkData,
    url: `https://volt.gg/inv/${linkData}`
  })
})

export default router
