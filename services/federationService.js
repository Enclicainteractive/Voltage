import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const FEDERATION_FILE = path.join(DATA_DIR, 'federation.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const loadData = (defaultValue = {}) => {
  try {
    if (fs.existsSync(FEDERATION_FILE)) {
      return JSON.parse(fs.readFileSync(FEDERATION_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[Federation] Error loading data:', err.message)
  }
  return defaultValue
}

const saveData = (data) => {
  try {
    fs.writeFileSync(FEDERATION_FILE, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error('[Federation] Error saving data:', err.message)
    return false
  }
}

export const federationService = {
  getPeers() {
    const data = loadData()
    return data.peers || []
  },

  getPeer(peerId) {
    const peers = this.getPeers()
    return peers.find(p => p.id === peerId) || null
  },

  getPeerByHost(host) {
    const peers = this.getPeers()
    return peers.find(p => p.host === host) || null
  },

  addPeer(peerData) {
    const data = loadData()
    if (!data.peers) data.peers = []

    const existing = data.peers.find(p => p.host === peerData.host)
    if (existing) {
      return { error: 'Peer already exists', peer: existing }
    }

    const peer = {
      id: `peer_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      name: peerData.name,
      host: peerData.host,
      url: peerData.url,
      sharedSecret: peerData.sharedSecret || crypto.randomBytes(32).toString('hex'),
      status: peerData.status || 'pending',
      direction: peerData.direction || 'outgoing',
      features: peerData.features || {},
      lastSeen: null,
      createdAt: new Date().toISOString()
    }

    data.peers.push(peer)
    saveData(data)
    console.log(`[Federation] Added peer: ${peer.name} (${peer.host})`)
    return { peer }
  },

  updatePeer(peerId, updates) {
    const data = loadData()
    if (!data.peers) return null

    const index = data.peers.findIndex(p => p.id === peerId)
    if (index === -1) return null

    data.peers[index] = { ...data.peers[index], ...updates, updatedAt: new Date().toISOString() }
    saveData(data)
    return data.peers[index]
  },

  removePeer(peerId) {
    const data = loadData()
    if (!data.peers) return false
    data.peers = data.peers.filter(p => p.id !== peerId)
    saveData(data)
    return true
  },

  acceptPeer(peerId) {
    return this.updatePeer(peerId, { status: 'connected' })
  },

  rejectPeer(peerId) {
    return this.updatePeer(peerId, { status: 'rejected' })
  },

  // Shared invite codes between mainlines
  getSharedInvites() {
    const data = loadData()
    return data.sharedInvites || []
  },

  shareInvite(inviteData) {
    const data = loadData()
    if (!data.sharedInvites) data.sharedInvites = []

    const shared = {
      id: `sinv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      code: inviteData.code,
      serverId: inviteData.serverId,
      serverName: inviteData.serverName,
      sourceHost: inviteData.sourceHost || config.getHost(),
      sourceMainline: inviteData.sourceMainline || config.config.server.name,
      targetPeerId: inviteData.targetPeerId || null,
      maxUses: inviteData.maxUses || 0,
      uses: 0,
      expiresAt: inviteData.expiresAt || null,
      createdAt: new Date().toISOString()
    }

    data.sharedInvites.push(shared)
    saveData(data)
    return shared
  },

  useSharedInvite(inviteId) {
    const data = loadData()
    if (!data.sharedInvites) return null

    const invite = data.sharedInvites.find(i => i.id === inviteId || i.code === inviteId)
    if (!invite) return null

    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return { error: 'Invite expired' }
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return { error: 'Invite expired' }

    invite.uses++
    saveData(data)
    return invite
  },

  removeSharedInvite(inviteId) {
    const data = loadData()
    if (!data.sharedInvites) return false
    data.sharedInvites = data.sharedInvites.filter(i => i.id !== inviteId)
    saveData(data)
    return true
  },

  // Inter-mainline messages (relay messages between federated peers)
  getRelayQueue(peerId) {
    const data = loadData()
    return (data.relayQueue || {})[peerId] || []
  },

  queueRelayMessage(peerId, message) {
    const data = loadData()
    if (!data.relayQueue) data.relayQueue = {}
    if (!data.relayQueue[peerId]) data.relayQueue[peerId] = []

    const relayMsg = {
      id: `relay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      fromHost: config.getHost(),
      fromMainline: config.config.server.name,
      type: message.type || 'text',
      payload: message.payload,
      timestamp: new Date().toISOString()
    }

    data.relayQueue[peerId].push(relayMsg)
    saveData(data)
    return relayMsg
  },

  dequeueRelayMessages(peerId, count = 50) {
    const data = loadData()
    if (!data.relayQueue?.[peerId]) return []

    const messages = data.relayQueue[peerId].splice(0, count)
    saveData(data)
    return messages
  },

  // Federation handshake token generation
  generateHandshakeToken(peerId) {
    const peer = this.getPeer(peerId)
    if (!peer) return null

    const payload = {
      peerId,
      host: config.getHost(),
      name: config.config.server.name,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    }

    const hmac = crypto.createHmac('sha256', peer.sharedSecret)
    hmac.update(JSON.stringify(payload))
    payload.signature = hmac.digest('hex')

    return Buffer.from(JSON.stringify(payload)).toString('base64url')
  },

  verifyHandshakeToken(token, expectedHost) {
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      const peer = this.getPeerByHost(expectedHost || payload.host)
      if (!peer) return null

      const signature = payload.signature
      delete payload.signature

      const hmac = crypto.createHmac('sha256', peer.sharedSecret)
      hmac.update(JSON.stringify(payload))
      const expected = hmac.digest('hex')

      if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
        return null
      }

      // Token valid for 5 minutes
      if (Date.now() - payload.timestamp > 300000) return null

      return { peer, payload }
    } catch {
      return null
    }
  },

  // Cross-mainline user directory (users from other mainlines that have interacted)
  getRemoteUsers() {
    const data = loadData()
    return data.remoteUsers || {}
  },

  addRemoteUser(userId, userData) {
    const data = loadData()
    if (!data.remoteUsers) data.remoteUsers = {}

    data.remoteUsers[userId] = {
      ...userData,
      id: userId,
      remote: true,
      lastSeen: new Date().toISOString()
    }

    saveData(data)
    return data.remoteUsers[userId]
  },

  getRemoteUser(userId) {
    const data = loadData()
    return data.remoteUsers?.[userId] || null
  }
}

export default federationService
