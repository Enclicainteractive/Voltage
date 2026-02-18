import express from 'express'
import { authenticateToken, optionalAuth } from '../middleware/authMiddleware.js'
import { inviteService } from '../services/dataService.js'
import { InviteEncoder, parseCrossHostInvite, createCrossHostInvite } from '../utils/inviteEncoder.js'
import { federationService } from '../services/federationService.js'
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
    
    // Local invite encoded as cross-host
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

    // Remote host - fetch real details from the remote server
    const remoteUrl = decoded.host.startsWith('http') ? decoded.host : `https://${decoded.host}`
    let baseUrl
    try { baseUrl = new URL(remoteUrl).origin } catch { baseUrl = `https://${serverHost}` }

    // Auto-peer with remote host
    const peerResult = await ensureFederationPeer(baseUrl)

    // Fetch invite info from the remote host
    let remoteInvite = null
    if (decoded.key) {
      try {
        const inviteRes = await axios.get(`${baseUrl}/api/invites/${decoded.key}`, { timeout: 8000 })
        remoteInvite = inviteRes.data
      } catch { /* remote invite lookup failed, try server info */ }
    }

    // If no invite code, try to get server info directly
    if (!remoteInvite && decoded.serverId) {
      try {
        const serverRes = await axios.get(`${baseUrl}/api/federation/server-info/${decoded.serverId}`, { timeout: 8000 })
        remoteInvite = { server: serverRes.data }
      } catch { /* fallback to local data */ }
    }

    // Fallback: check local data for a federated copy
    if (!remoteInvite) {
      const servers = getServers()
      const localCopy = servers.find(s => s.id === decoded.serverId)
      if (localCopy) {
        remoteInvite = {
          server: {
            id: localCopy.id,
            name: localCopy.name,
            icon: localCopy.icon,
            memberCount: localCopy.members?.length || 0,
            onlineCount: localCopy.members?.filter(m => m.status === 'online').length || 0
          }
        }
      }
    }

    if (!remoteInvite) {
      return res.status(404).json({ error: 'Could not fetch server info from remote host' })
    }

    // Resolve icon URL
    const serverData = remoteInvite.server || remoteInvite
    if (serverData.icon && !serverData.icon.startsWith('http')) {
      serverData.icon = `${baseUrl}${serverData.icon}`
    }

    res.json({
      type: 'cross-host',
      host: serverHost,
      hostUrl: baseUrl,
      federated: !peerResult.local,
      newPeer: !!peerResult.newPeer,
      server: serverData,
      inviter: remoteInvite.inviter || null,
      code: decoded.key || null
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

    // Remote host - auto-peer and fetch details
    const remoteUrl = serverHost.startsWith('http') ? serverHost : `https://${serverHost}`
    let baseUrl
    try { baseUrl = new URL(remoteUrl).origin } catch { baseUrl = `https://${serverHost}` }

    await ensureFederationPeer(baseUrl)

    // Try to use the invite on the remote host
    let remoteServer = null
    if (decoded.key) {
      try {
        const inviteRes = await axios.get(`${baseUrl}/api/invites/${decoded.key}`, { timeout: 8000 })
        remoteServer = inviteRes.data?.server || inviteRes.data
      } catch { /* fallback */ }
    }

    // Fallback to server info endpoint
    if (!remoteServer && decoded.serverId) {
      try {
        const serverRes = await axios.get(`${baseUrl}/api/federation/server-info/${decoded.serverId}`, { timeout: 8000 })
        remoteServer = serverRes.data
      } catch { /* fallback to local */ }
    }

    if (!remoteServer) {
      const servers = getServers()
      remoteServer = servers.find(s => s.id === decoded.serverId)
    }

    if (!remoteServer?.id && !decoded.serverId) {
      return res.status(404).json({ error: 'Server not found' })
    }

    const serverId = remoteServer?.id || decoded.serverId
    const servers = getServers()
    let localServer = servers.find(s => s.id === serverId && s.remoteHost === serverHost)

    if (!localServer) {
      const icon = remoteServer?.icon
        ? (remoteServer.icon.startsWith('http') ? remoteServer.icon : `${baseUrl}${remoteServer.icon}`)
        : null
      localServer = {
        id: serverId,
        name: remoteServer?.name || 'Remote Server',
        icon,
        remoteHost: serverHost,
        remoteUrl: baseUrl,
        federated: true,
        memberCount: remoteServer?.memberCount || 0,
        members: [{
          id: req.user.id,
          username: req.user.username,
          avatar: getAvatarUrl(req.user.id),
          roles: ['member'],
          role: 'member',
          status: 'online',
          joinedAt: new Date().toISOString()
        }],
        roles: [],
        createdAt: new Date().toISOString()
      }
      servers.push(localServer)
    } else {
      const existingMember = localServer.members?.find(m => m.id === req.user.id)
      if (!existingMember) {
        if (!localServer.members) localServer.members = []
        localServer.members.push({
          id: req.user.id,
          username: req.user.username,
          avatar: getAvatarUrl(req.user.id),
          roles: ['member'],
          role: 'member',
          status: 'online',
          joinedAt: new Date().toISOString()
        })
      }
    }

    // Notify the remote host about the join
    try {
      await axios.post(`${baseUrl}/api/federation/member-joined`, {
        serverId,
        host: currentHost,
        user: { id: req.user.id, username: req.user.username }
      }, { timeout: 5000 })
    } catch { /* non-critical */ }
    
    setServers(servers)
    console.log(`[API] User ${req.user.username} joined cross-host server ${localServer.name} (${serverHost})`)
    res.json(localServer)
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

// Auto-peer with a remote host if not already peered
const ensureFederationPeer = async (remoteUrl) => {
  try {
    const parsedUrl = new URL(remoteUrl)
    const remoteHost = parsedUrl.host
    const currentHost = config.getHost()
    if (remoteHost === currentHost) return { local: true }

    const existing = federationService.getPeerByHost(remoteHost)
    if (existing) {
      if (existing.status !== 'connected') {
        federationService.updatePeer(existing.id, { status: 'connected', lastSeen: new Date().toISOString() })
      }
      return { peer: existing, alreadyPeered: true }
    }

    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`

    let remoteName = remoteHost
    try {
      const infoRes = await axios.get(`${baseUrl}/api/federation/info`, { timeout: 5000 })
      remoteName = infoRes.data?.name || remoteHost
    } catch { /* use host as name */ }

    const result = federationService.addPeer({
      name: remoteName,
      host: remoteHost,
      url: baseUrl,
      direction: 'outgoing'
    })

    if (result.error && result.peer) {
      return { peer: result.peer, alreadyPeered: true }
    }

    try {
      await axios.post(`${baseUrl}/api/federation/handshake`, {
        name: config.config.server.name,
        host: currentHost,
        url: config.getServerUrl(),
        sharedSecret: result.peer?.sharedSecret,
        features: config.config.features || {},
        autoAccept: true
      }, { timeout: 5000 })
      federationService.updatePeer(result.peer.id, { status: 'connected', lastSeen: new Date().toISOString() })
    } catch (err) {
      console.log(`[Federation] Auto-handshake with ${remoteHost} deferred: ${err.message}`)
    }

    console.log(`[Federation] Auto-peered with ${remoteName} (${remoteHost}) via invite`)
    return { peer: result.peer, newPeer: true }
  } catch (err) {
    console.error('[Federation] Auto-peer error:', err.message)
    return { error: err.message }
  }
}

// Resolve an external invite: fetch server info from remote host, auto-peer
router.get('/resolve-external', optionalAuth, async (req, res) => {
  const { host, code } = req.query
  if (!host || !code) {
    return res.status(400).json({ error: 'host and code are required' })
  }

  try {
    const parsedHost = host.startsWith('http') ? host : `https://${host}`
    const baseUrl = new URL(parsedHost).origin

    const peerResult = await ensureFederationPeer(baseUrl)

    let inviteInfo
    try {
      const inviteRes = await axios.get(`${baseUrl}/api/invites/${code}`, { timeout: 8000 })
      inviteInfo = inviteRes.data
    } catch (err) {
      return res.status(404).json({ error: 'Invite not found on remote host' })
    }

    res.json({
      type: 'external',
      host: new URL(baseUrl).host,
      hostUrl: baseUrl,
      federated: !peerResult.local,
      newPeer: !!peerResult.newPeer,
      server: inviteInfo.server || inviteInfo,
      inviter: inviteInfo.inviter || null,
      code
    })
  } catch (err) {
    console.error('[API] Resolve external invite error:', err.message)
    res.status(500).json({ error: 'Failed to resolve external invite' })
  }
})

// Join via external invite: auto-peer + proxy the join to the remote host
router.post('/resolve-external/join', authenticateToken, async (req, res) => {
  const { host, code } = req.body
  if (!host || !code) {
    return res.status(400).json({ error: 'host and code are required' })
  }

  try {
    const parsedHost = host.startsWith('http') ? host : `https://${host}`
    const baseUrl = new URL(parsedHost).origin

    await ensureFederationPeer(baseUrl)

    const servers = getServers()
    const inviteRes = await axios.get(`${baseUrl}/api/invites/${code}`, { timeout: 8000 })
    const remoteServer = inviteRes.data?.server || inviteRes.data
    const remoteHost = new URL(baseUrl).host

    if (!remoteServer?.id) {
      return res.status(404).json({ error: 'Server not found on remote host' })
    }

    let localServer = servers.find(s => s.id === remoteServer.id && s.remoteHost === remoteHost)
    if (!localServer) {
      localServer = {
        id: remoteServer.id,
        name: remoteServer.name,
        icon: remoteServer.icon ? (remoteServer.icon.startsWith('http') ? remoteServer.icon : `${baseUrl}${remoteServer.icon}`) : null,
        remoteHost,
        remoteUrl: baseUrl,
        federated: true,
        memberCount: remoteServer.memberCount || 0,
        members: [{
          id: req.user.id,
          username: req.user.username,
          avatar: req.user.avatar,
          roles: ['member'],
          role: 'member',
          status: 'online',
          joinedAt: new Date().toISOString()
        }],
        roles: [],
        createdAt: new Date().toISOString()
      }
      servers.push(localServer)
    } else {
      const existingMember = localServer.members?.find(m => m.id === req.user.id)
      if (!existingMember) {
        if (!localServer.members) localServer.members = []
        localServer.members.push({
          id: req.user.id,
          username: req.user.username,
          avatar: req.user.avatar,
          roles: ['member'],
          role: 'member',
          status: 'online',
          joinedAt: new Date().toISOString()
        })
      }
    }

    setServers(servers)
    console.log(`[API] User ${req.user.username} joined federated server ${localServer.name} from ${remoteHost}`)
    res.json(localServer)
  } catch (err) {
    console.error('[API] External join error:', err.message)
    res.status(500).json({ error: 'Failed to join external server' })
  }
})

export default router
