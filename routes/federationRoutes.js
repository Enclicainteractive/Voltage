import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { federationService } from '../services/federationService.js'
import config from '../config/config.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __fedDir = path.dirname(fileURLToPath(import.meta.url))
const FED_DATA_DIR = path.join(__fedDir, '..', '..', 'data')
const FED_SERVERS_FILE = path.join(FED_DATA_DIR, 'servers.json')

const loadServersData = () => {
  try {
    if (fs.existsSync(FED_SERVERS_FILE)) {
      return JSON.parse(fs.readFileSync(FED_SERVERS_FILE, 'utf8'))
    }
  } catch { /* ignore */ }
  return []
}

const router = express.Router()

// Get all federated peers
router.get('/peers', authenticateToken, (req, res) => {
  const peers = federationService.getPeers()
  res.json(peers.map(p => ({
    id: p.id,
    name: p.name,
    host: p.host,
    url: p.url,
    status: p.status,
    direction: p.direction,
    features: p.features,
    lastSeen: p.lastSeen,
    createdAt: p.createdAt
  })))
})

// Get specific peer info
router.get('/peers/:peerId', authenticateToken, (req, res) => {
  const peer = federationService.getPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  const { sharedSecret, ...safe } = peer
  res.json(safe)
})

// Request peering with another mainline
router.post('/peers', authenticateToken, (req, res) => {
  if (!config.config.federation?.enabled) {
    return res.status(400).json({ error: 'Federation is not enabled' })
  }

  const { name, host, url } = req.body
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' })
  }

  let parsedHost = host
  if (!parsedHost) {
    try { parsedHost = new URL(url).host } catch { return res.status(400).json({ error: 'Invalid URL' }) }
  }

  const result = federationService.addPeer({ name, host: parsedHost, url: url.replace(/\/$/, ''), direction: 'outgoing' })
  if (result.error) return res.status(409).json(result)

  console.log(`[Federation] Peering requested with ${name} (${parsedHost})`)
  res.json(result.peer)
})

// Accept incoming peering request
router.post('/peers/:peerId/accept', authenticateToken, (req, res) => {
  const peer = federationService.acceptPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  console.log(`[Federation] Accepted peer: ${peer.name}`)
  res.json(peer)
})

// Reject incoming peering request
router.post('/peers/:peerId/reject', authenticateToken, (req, res) => {
  const peer = federationService.rejectPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  res.json({ success: true })
})

// Remove a peer
router.delete('/peers/:peerId', authenticateToken, (req, res) => {
  federationService.removePeer(req.params.peerId)
  res.json({ success: true })
})

// Incoming peering handshake from another mainline
router.post('/handshake', (req, res) => {
  const { name, host, url, sharedSecret, features, autoAccept } = req.body
  if (!name || !host || !url) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  const existing = federationService.getPeerByHost(host)
  if (existing) {
    federationService.updatePeer(existing.id, { status: 'connected', lastSeen: new Date().toISOString() })
    return res.json({ accepted: true, host: config.getHost(), name: config.config.server.name })
  }

  const result = federationService.addPeer({
    name, host, url: url.replace(/\/$/, ''),
    sharedSecret: sharedSecret || undefined,
    direction: 'incoming',
    features: features || {},
    status: autoAccept ? 'connected' : 'pending'
  })

  // Auto-accept: mark as connected immediately (invite-triggered peering)
  if (autoAccept && result.peer) {
    federationService.updatePeer(result.peer.id, { status: 'connected', lastSeen: new Date().toISOString() })
  }

  console.log(`[Federation] Handshake from ${name} (${host})${autoAccept ? ' [auto-accepted via invite]' : ''}`)

  res.json({
    accepted: true,
    peerId: result.peer?.id,
    host: config.getHost(),
    name: config.config.server.name,
    sharedSecret: result.peer?.sharedSecret
  })
})

// Heartbeat / ping from peer
router.post('/ping', (req, res) => {
  const { host, token } = req.body

  if (token) {
    const verified = federationService.verifyHandshakeToken(token, host)
    if (!verified) return res.status(401).json({ error: 'Invalid token' })
    federationService.updatePeer(verified.peer.id, { status: 'connected', lastSeen: new Date().toISOString() })
  } else if (host) {
    const peer = federationService.getPeerByHost(host)
    if (peer) {
      federationService.updatePeer(peer.id, { status: 'connected', lastSeen: new Date().toISOString() })
    }
  }

  res.json({
    host: config.getHost(),
    name: config.config.server.name,
    version: config.config.server.version,
    timestamp: new Date().toISOString()
  })
})

// Share an invite code with a specific peer or all peers
router.post('/invites/share', authenticateToken, (req, res) => {
  const { code, serverId, serverName, targetPeerId, maxUses, expiresAt } = req.body
  if (!code || !serverId) {
    return res.status(400).json({ error: 'Code and serverId are required' })
  }

  const shared = federationService.shareInvite({
    code, serverId, serverName, targetPeerId, maxUses, expiresAt
  })

  res.json(shared)
})

// Get shared invites
router.get('/invites', authenticateToken, (req, res) => {
  res.json(federationService.getSharedInvites())
})

// Get shared invites from a peer (public endpoint for federated peers)
router.get('/invites/public', (req, res) => {
  const { host } = req.query
  const invites = federationService.getSharedInvites()
    .filter(i => !i.targetPeerId || (host && federationService.getPeerByHost(host)?.id === i.targetPeerId))
    .filter(i => !i.expiresAt || new Date(i.expiresAt) > new Date())
    .filter(i => !i.maxUses || i.uses < i.maxUses)
    .map(({ id, code, serverId, serverName, sourceHost, sourceMainline, expiresAt }) => ({
      id, code, serverId, serverName, sourceHost, sourceMainline, expiresAt
    }))

  res.json(invites)
})

// Use a shared invite from another mainline
router.post('/invites/:inviteId/use', authenticateToken, (req, res) => {
  const result = federationService.useSharedInvite(req.params.inviteId)
  if (!result) return res.status(404).json({ error: 'Invite not found' })
  if (result.error) return res.status(400).json(result)
  res.json(result)
})

// Remove a shared invite
router.delete('/invites/:inviteId', authenticateToken, (req, res) => {
  federationService.removeSharedInvite(req.params.inviteId)
  res.json({ success: true })
})

// Send relay message to a peer
router.post('/relay/:peerId', authenticateToken, (req, res) => {
  const peer = federationService.getPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  if (peer.status !== 'connected') return res.status(400).json({ error: 'Peer not connected' })

  const { type, payload } = req.body
  const msg = federationService.queueRelayMessage(req.params.peerId, { type, payload })
  res.json(msg)
})

// Fetch queued relay messages (called by peer)
router.post('/relay/fetch', (req, res) => {
  const { host, token } = req.body

  let peer
  if (token) {
    const verified = federationService.verifyHandshakeToken(token, host)
    if (!verified) return res.status(401).json({ error: 'Invalid token' })
    peer = verified.peer
  } else if (host) {
    peer = federationService.getPeerByHost(host)
  }

  if (!peer) return res.status(404).json({ error: 'Peer not found' })

  const messages = federationService.dequeueRelayMessages(peer.id)
  res.json(messages)
})

// Get this mainline's federation info (public)
router.get('/info', (req, res) => {
  res.json({
    host: config.getHost(),
    name: config.config.server.name,
    version: config.config.server.version,
    mode: config.config.server.mode,
    federationEnabled: config.config.federation?.enabled || false,
    features: config.config.features,
    peerCount: federationService.getPeers().filter(p => p.status === 'connected').length
  })
})

// Public server info for federation - lets remote hosts fetch basic details about a server
router.get('/server-info/:serverId', (req, res) => {
  const servers = loadServersData()
  const server = (Array.isArray(servers) ? servers : Object.values(servers))
    .find(s => s.id === req.params.serverId)
  
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  const onlineCount = server.members?.filter(m => m.status === 'online').length || 0

  res.json({
    id: server.id,
    name: server.name,
    icon: server.icon || null,
    description: server.description || '',
    memberCount: server.members?.length || 0,
    onlineCount,
    host: config.getHost(),
    hostName: config.config.server.name,
    createdAt: server.createdAt
  })
})

// Receive notification that a user from another mainline joined a server
router.post('/member-joined', (req, res) => {
  const { serverId, host, user } = req.body
  if (!serverId || !host) {
    return res.status(400).json({ error: 'serverId and host are required' })
  }

  const peer = federationService.getPeerByHost(host)
  if (peer) {
    federationService.updatePeer(peer.id, { lastSeen: new Date().toISOString() })
  }

  console.log(`[Federation] Remote user ${user?.username || 'unknown'} from ${host} joined server ${serverId}`)
  res.json({ success: true })
})

// List all servers available for federation discovery (public)
router.get('/servers', (req, res) => {
  const servers = loadServersData()
  const list = (Array.isArray(servers) ? servers : Object.values(servers))
    .filter(s => !s.federated && !s.remoteHost)
    .map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      description: s.description || '',
      memberCount: s.members?.length || 0,
      host: config.getHost()
    }))

  res.json(list)
})

export default router
