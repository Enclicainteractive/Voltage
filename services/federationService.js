import crypto from 'crypto'
import axios from 'axios'
import config from '../config/config.js'
import { supportsDirectQuery, directQuery, FILES } from './dataService.js'

const FEDERATION_FILE = FILES.federation
const DEFAULT_SYNC_INTERVAL_MS = 15000

let relayHandler = null
let syncLoopTimer = null
let syncLoopInFlight = false
let federationCache = { peers: [], relayQueue: {}, processedRelayIds: {}, lastSync: null }
let cacheLoaded = false

const ensureCacheLoaded = async () => {
  if (!cacheLoaded) {
    if (supportsDirectQuery()) {
      try {
        const rows = await directQuery('SELECT data FROM federation LIMIT 1')
        if (rows && rows.length > 0 && rows[0].data) {
          federationCache = JSON.parse(rows[0].data)
        }
      } catch (err) {
        console.error('[Federation] Error loading from DB:', err.message)
      }
    }
    cacheLoaded = true
  }
}

const loadData = (defaultValue = {}) => {
  if (!cacheLoaded) {
    ensureCacheLoaded().catch(err => console.error('[Federation] Failed to load cache:', err))
    return { ...defaultValue, peers: [], relayQueue: {}, processedRelayIds: {}, lastSync: null }
  }
  return { ...federationCache }
}

const saveData = async (data) => {
  federationCache = { ...data }
  if (supportsDirectQuery()) {
    try {
      const json = JSON.stringify(data)
      await directQuery('DELETE FROM federation')
      await directQuery('INSERT INTO federation (id, data, updatedAt) VALUES (?, ?, ?)', ['federation', json, new Date().toISOString()])
      console.log('[Federation] Saved to database')
      return true
    } catch (err) {
      console.error('[Federation] Error saving to DB:', err.message)
      return false
    }
  }
  return false
}

const normalizeHost = (value) => {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase()
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()
  }
}

const normalizeUrl = (value, fallbackHost = null) => {
  if (value) {
    try {
      const parsed = new URL(String(value))
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      // fall through
    }
  }
  const host = normalizeHost(fallbackHost)
  return host ? `https://${host}` : null
}

const safeArray = (value) => (Array.isArray(value) ? value : [])

const getRelayQueueState = (data, peerId) => {
  if (!data.relayQueue) data.relayQueue = {}
  if (!data.relayQueue[peerId]) data.relayQueue[peerId] = []
  return data.relayQueue[peerId]
}

const getProcessedRelayIdsState = (data) => {
  if (!data.processedRelayIds) data.processedRelayIds = {}
  return data.processedRelayIds
}

const buildHandshakePayload = (peerId) => ({
  peerId,
  host: config.getHost(),
  name: config.config.server.name,
  timestamp: Date.now(),
  nonce: crypto.randomBytes(16).toString('hex')
})

const signPayload = (payload, secret) => {
  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(JSON.stringify(payload))
  return hmac.digest('hex')
}

const getSafeSignatureBuffer = (hex) => {
  try {
    return Buffer.from(String(hex || ''), 'hex')
  } catch {
    return Buffer.alloc(0)
  }
}

const makePeerRequestHeaders = (peer) => {
  const token = federationService.generateHandshakeToken(peer.id)
  if (!token) return {}
  return {
    'x-federation-token': token,
    'x-federation-host': config.getHost()
  }
}

export const federationService = {
  normalizeHost,
  normalizeUrl,

  async init() {
    await ensureCacheLoaded()
    console.log('[Federation] Cache initialized')
  },

  async ensureLoaded() {
    if (!cacheLoaded) {
      await ensureCacheLoaded()
    }
  },

  getPeers() {
    if (!cacheLoaded) {
      ensureCacheLoaded().catch(err => console.error('[Federation] Failed to load cache:', err))
    }
    const data = loadData()
    return safeArray(data.peers).map((peer) => ({
      ...peer,
      host: normalizeHost(peer.host) || peer.host,
      url: normalizeUrl(peer.url, peer.host) || peer.url
    }))
  },

  getConnectedPeers() {
    return this.getPeers().filter((peer) => peer.status === 'connected')
  },

  getPeer(peerId) {
    return this.getPeers().find((peer) => peer.id === peerId) || null
  },

  getPeerByHost(host) {
    const normalizedHost = normalizeHost(host)
    if (!normalizedHost) return null
    return this.getPeers().find((peer) => normalizeHost(peer.host) === normalizedHost) || null
  },

  async addPeer(peerData) {
    const data = loadPeersMutable()
    const host = normalizeHost(peerData.host || peerData.url)
    const url = normalizeUrl(peerData.url, host)
    if (!host || !url) {
      return { error: 'Peer host and URL are required' }
    }

    const existing = data.peers.find((peer) => normalizeHost(peer.host) === host)
    if (existing) {
      const merged = {
        ...existing,
        host,
        url,
        name: peerData.name || existing.name,
        direction: peerData.direction || existing.direction,
        features: peerData.features || existing.features || {},
        sharedSecret: peerData.sharedSecret || existing.sharedSecret,
        protocolVersion: peerData.protocolVersion || existing.protocolVersion || 1,
        status: peerData.status || existing.status
      }
      const index = data.peers.findIndex((peer) => peer.id === existing.id)
      data.peers[index] = merged
      await saveData(data)
      return { error: 'Peer already exists', peer: merged }
    }

    const peer = {
      id: `peer_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      name: peerData.name || host,
      host,
      url,
      sharedSecret: peerData.sharedSecret || crypto.randomBytes(32).toString('hex'),
      status: peerData.status || 'pending',
      direction: peerData.direction || 'outgoing',
      features: peerData.features || {},
      protocolVersion: peerData.protocolVersion || 1,
      lastSeen: null,
      lastSyncedAt: null,
      lastError: null,
      remotePeerId: peerData.remotePeerId || null,
      createdAt: nowIso()
    }

    data.peers.push(peer)
    await saveData(data)
    console.log(`[Federation] Added peer: ${peer.name} (${peer.host})`)
    return { peer }
  },

  async updatePeer(peerId, updates) {
    const data = loadPeersMutable()
    const index = data.peers.findIndex((peer) => peer.id === peerId)
    if (index === -1) return null

    const nextPeer = {
      ...data.peers[index],
      ...updates,
      host: normalizeHost(updates.host || data.peers[index].host) || data.peers[index].host,
      url: normalizeUrl(updates.url || data.peers[index].url, updates.host || data.peers[index].host) || data.peers[index].url,
      updatedAt: nowIso()
    }
    data.peers[index] = nextPeer
    await saveData(data)
    return nextPeer
  },

  async removePeer(peerId) {
    const data = loadPeersMutable()
    data.peers = data.peers.filter((peer) => peer.id !== peerId)
    if (data.relayQueue) delete data.relayQueue[peerId]
    await saveData(data)
    return true
  },

  acceptPeer(peerId) {
    return this.updatePeer(peerId, { status: 'connected', lastSeen: nowIso(), lastError: null })
  },

  rejectPeer(peerId) {
    return this.updatePeer(peerId, { status: 'rejected' })
  },

  getSharedInvites() {
    const data = loadData()
    return safeArray(data.sharedInvites)
  },

  async shareInvite(inviteData) {
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
      createdAt: nowIso()
    }

    data.sharedInvites.push(shared)
    await saveData(data)
    return shared
  },

  async useSharedInvite(inviteId) {
    const data = loadData()
    if (!data.sharedInvites) return null

    const invite = data.sharedInvites.find((item) => item.id === inviteId || item.code === inviteId)
    if (!invite) return null
    if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return { error: 'Invite expired' }
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return { error: 'Invite expired' }

    invite.uses += 1
    await saveData(data)
    return invite
  },

  async removeSharedInvite(inviteId) {
    const data = loadData()
    if (!data.sharedInvites) return false
    data.sharedInvites = data.sharedInvites.filter((invite) => invite.id !== inviteId)
    await saveData(data)
    return true
  },

  getRelayQueue(peerId) {
    const data = loadData()
    return safeArray(data.relayQueue?.[peerId])
  },

  async queueRelayMessage(peerId, message) {
    const peer = this.getPeer(peerId)
    if (!peer) return null

    const data = loadData()
    const queue = getRelayQueueState(data, peerId)
    const relayMsg = {
      id: message.id || `relay_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      schemaVersion: 1,
      fromHost: config.getHost(),
      fromMainline: config.config.server.name,
      type: message.type || 'text',
      payload: message.payload,
      timestamp: nowIso()
    }

    queue.push(relayMsg)
    await saveData(data)

    if (peer.status === 'connected') {
      void this.deliverQueuedMessages(peerId)
    }
    return relayMsg
  },

  async dequeueRelayMessages(peerId, count = 50) {
    const data = loadData()
    const queue = getRelayQueueState(data, peerId)
    const messages = queue.splice(0, count)
    await saveData(data)
    return messages
  },

  async removeRelayMessages(peerId, messageIds = []) {
    if (messageIds.length === 0) return true
    const data = loadData()
    const queue = getRelayQueueState(data, peerId)
    data.relayQueue[peerId] = queue.filter((message) => !messageIds.includes(message.id))
    await saveData(data)
    return true
  },

  async markRelayProcessed(peerHost, relayId) {
    const host = normalizeHost(peerHost)
    if (!host || !relayId) return false
    const data = loadData()
    const processed = getProcessedRelayIdsState(data)
    const hostState = processed[host] || {}
    hostState[relayId] = Date.now()
    processed[host] = hostState

    // Keep only the newest ~500 ids per host.
    const entries = Object.entries(hostState).sort((a, b) => b[1] - a[1]).slice(0, 500)
    processed[host] = Object.fromEntries(entries)
    await saveData(data)
    return true
  },

  hasProcessedRelay(peerHost, relayId) {
    const host = normalizeHost(peerHost)
    if (!host || !relayId) return false
    const data = loadData()
    return Boolean(data.processedRelayIds?.[host]?.[relayId])
  },

  generateHandshakeToken(peerId) {
    const peer = this.getPeer(peerId)
    if (!peer) return null
    const payload = buildHandshakePayload(peerId)
    payload.signature = signPayload(payload, peer.sharedSecret)
    return Buffer.from(JSON.stringify(payload)).toString('base64url')
  },

  verifyHandshakeToken(token, expectedHost) {
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
      const host = normalizeHost(expectedHost || payload.host)
      const peer = this.getPeerByHost(host)
      if (!peer) return null

      const signature = payload.signature
      delete payload.signature

      const expectedSignature = signPayload(payload, peer.sharedSecret)
      const actualBuf = getSafeSignatureBuffer(signature)
      const expectedBuf = getSafeSignatureBuffer(expectedSignature)
      if (actualBuf.length === 0 || actualBuf.length !== expectedBuf.length) return null
      if (!crypto.timingSafeEqual(actualBuf, expectedBuf)) return null
      if (Date.now() - Number(payload.timestamp || 0) > 300000) return null

      return { peer, payload }
    } catch {
      return null
    }
  },

  getPeerAuthHeaders(peerOrIdOrHost) {
    const peer = typeof peerOrIdOrHost === 'string'
      ? (this.getPeer(peerOrIdOrHost) || this.getPeerByHost(peerOrIdOrHost))
      : peerOrIdOrHost
    if (!peer) return {}
    return makePeerRequestHeaders(peer)
  },

  async sendHandshake(peerId, { autoAccept = false } = {}) {
    const peer = this.getPeer(peerId)
    if (!peer) return null

    const response = await axios.post(`${peer.url}/api/federation/handshake`, {
      name: config.config.server.name,
      host: config.getHost(),
      url: config.getServerUrl(),
      sharedSecret: peer.sharedSecret,
      features: config.config.features || {},
      autoAccept
    }, { timeout: 8000 })

    const responseData = response?.data || {}
    this.updatePeer(peer.id, {
      status: responseData.accepted ? 'connected' : peer.status,
      lastSeen: nowIso(),
      remotePeerId: responseData.peerId || peer.remotePeerId || null,
      features: responseData.features || peer.features,
      lastError: null
    })
    return responseData
  },

  async sendHeartbeat(peerId) {
    const peer = this.getPeer(peerId)
    if (!peer) return null
    const token = this.generateHandshakeToken(peer.id)
    if (!token) throw new Error(`Failed to generate federation token for ${peer.host}`)

    const response = await axios.post(`${peer.url}/api/federation/ping`, {
      host: config.getHost(),
      token
    }, { timeout: 8000 })

    this.updatePeer(peer.id, {
      status: 'connected',
      lastSeen: nowIso(),
      lastError: null
    })
    return response?.data || null
  },

  async deliverQueuedMessages(peerId) {
    const peer = this.getPeer(peerId)
    if (!peer) return []

    const queue = this.getRelayQueue(peerId)
    if (queue.length === 0) return []

    const deliveredIds = []
    for (const message of queue) {
      try {
        await axios.post(`${peer.url}/api/federation/relay/push`, {
          id: message.id,
          schemaVersion: message.schemaVersion || 1,
          type: message.type,
          payload: message.payload,
          timestamp: message.timestamp,
          fromHost: message.fromHost,
          fromMainline: message.fromMainline
        }, {
          timeout: 10000,
          headers: this.getPeerAuthHeaders(peer)
        })
        deliveredIds.push(message.id)
      } catch (err) {
        this.updatePeer(peer.id, {
          status: peer.status === 'rejected' ? peer.status : 'error',
          lastError: err.message
        })
        break
      }
    }

    if (deliveredIds.length > 0) {
      this.removeRelayMessages(peer.id, deliveredIds)
      this.updatePeer(peer.id, {
        status: 'connected',
        lastSeen: nowIso(),
        lastSyncedAt: nowIso(),
        lastError: null
      })
    }
    return deliveredIds
  },

  async fetchRelayMessages(peerId) {
    const peer = this.getPeer(peerId)
    if (!peer) return []

    const token = this.generateHandshakeToken(peer.id)
    if (!token) throw new Error(`Failed to generate federation token for ${peer.host}`)

    const response = await axios.post(`${peer.url}/api/federation/relay/fetch`, {
      host: config.getHost(),
      token
    }, { timeout: 10000 })

    const messages = safeArray(response?.data)
    this.updatePeer(peer.id, {
      status: 'connected',
      lastSeen: nowIso(),
      lastSyncedAt: nowIso(),
      lastError: null
    })
    return messages
  },

  setRelayHandler(handler) {
    relayHandler = typeof handler === 'function' ? handler : null
  },

  async syncPeer(peerId) {
    const peer = this.getPeer(peerId)
    if (!peer || peer.status === 'rejected') return

    try {
      await this.sendHeartbeat(peer.id)
      await this.deliverQueuedMessages(peer.id)
      const incoming = await this.fetchRelayMessages(peer.id)
      if (relayHandler && incoming.length > 0) {
        for (const message of incoming) {
          try {
            await relayHandler(message, peer)
          } catch (err) {
            console.error('[Federation] Relay handler error:', err.message)
          }
        }
      }
      this.updatePeer(peer.id, {
        status: 'connected',
        lastSeen: nowIso(),
        lastSyncedAt: nowIso(),
        lastError: null
      })
    } catch (err) {
      this.updatePeer(peer.id, {
        status: peer.status === 'pending' ? 'pending' : 'error',
        lastError: err.message
      })
    }
  },

  startFederationSyncLoop(intervalMs = DEFAULT_SYNC_INTERVAL_MS) {
    if (syncLoopTimer) return syncLoopTimer

    const run = async () => {
      if (syncLoopInFlight) return
      syncLoopInFlight = true
      try {
        const peers = this.getPeers().filter((peer) => peer.status === 'connected' || peer.status === 'error')
        for (const peer of peers) {
          // eslint-disable-next-line no-await-in-loop
          await this.syncPeer(peer.id)
        }
      } finally {
        syncLoopInFlight = false
      }
    }

    syncLoopTimer = setInterval(() => {
      void run()
    }, Math.max(5000, Number(intervalMs) || DEFAULT_SYNC_INTERVAL_MS))

    void run()
    return syncLoopTimer
  },

  stopFederationSyncLoop() {
    if (syncLoopTimer) clearInterval(syncLoopTimer)
    syncLoopTimer = null
  },

  getRemoteUsers() {
    const data = loadData()
    return data.remoteUsers || {}
  },

  async addRemoteUser(userId, userData) {
    const data = loadData()
    if (!data.remoteUsers) data.remoteUsers = {}
    data.remoteUsers[userId] = {
      ...data.remoteUsers[userId],
      ...userData,
      id: userId,
      remote: true,
      lastSeen: nowIso()
    }
    await saveData(data)
    return data.remoteUsers[userId]
  },

  getRemoteUser(userId) {
    const data = loadData()
    return data.remoteUsers?.[userId] || null
  }
}

export default federationService
