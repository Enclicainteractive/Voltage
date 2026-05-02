import express from 'express'
import net from 'net'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { federationService } from '../services/federationService.js'
import {
  adminService,
  channelService,
  dmMessageService,
  dmService,
  friendRequestService,
  friendService,
  serverService,
  userService
} from '../services/dataService.js'
import config from '../config/config.js'

let _io = null

const loadServersData = () => {
  const data = serverService.getAllServers()
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') return Object.values(data)
  return []
}

const saveServersData = async (servers) => {
  for (const server of servers || []) {
    if (server?.id) {
      await serverService.updateServer(server.id, server)
    }
  }
}

const safeArray = (value) => (Array.isArray(value) ? value : [])
const getRemoteStorageId = (userId, host) => `${String(userId || '')}@${String(host || '').toLowerCase()}`
const getRemoteAddress = (username, host) => {
  const safeUsername = String(username || '').trim()
  const safeHost = String(host || '').trim().toLowerCase()
  return safeUsername && safeHost ? `${safeUsername}:${safeHost}` : safeUsername || safeHost || ''
}

const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_.:@-]+$/
const SAFE_EVENT_TYPE_PATTERN = /^[a-zA-Z0-9:_-]+$/
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:'])
const MAX_ID_LENGTH = 160
const MAX_HOST_LENGTH = 255
const MAX_URL_LENGTH = 2048
const MAX_NAME_LENGTH = 140
const MAX_SHARED_SECRET_LENGTH = 512
const PRIVATE_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal']

const normalizeText = (value) => typeof value === 'string' ? value.trim() : ''
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

const isPrivateIpv4Address = (address) => {
  const parts = String(address || '').split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false

  const [first, second] = parts
  if (first === 10 || first === 127 || first === 0) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 198 && (second === 18 || second === 19)) return true
  if (first >= 224) return true
  return false
}

const isPrivateIpv6Address = (address) => {
  const normalized = String(address || '').toLowerCase()
  if (!normalized) return false
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true
  if (normalized.startsWith('::ffff:')) {
    const mappedIpv4 = normalized.slice(7)
    if (net.isIP(mappedIpv4) === 4) return isPrivateIpv4Address(mappedIpv4)
  }
  return false
}

const normalizeHostname = (value) => {
  const raw = normalizeText(value)
  if (!raw) return null
  const candidate = raw.includes('://') ? raw : `https://${raw}`
  try {
    const parsed = new URL(candidate)
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
    return hostname || null
  } catch {
    return null
  }
}

const isLocalOrPrivateHost = (host) => {
  const hostname = normalizeHostname(host)
  if (!hostname) return true
  if (hostname === 'localhost' || PRIVATE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true
  }

  const ipType = net.isIP(hostname)
  if (ipType === 4) return isPrivateIpv4Address(hostname)
  if (ipType === 6) return isPrivateIpv6Address(hostname)
  return false
}

const normalizeBoundedText = (value, maxLength = 200) => {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  return normalized.slice(0, maxLength)
}

const getUserId = (req) => req.user?.id || req.user?.userId || null

const isConfiguredAdmin = (userId) => {
  if (!userId) return false
  const adminUsers = config.config.security?.adminUsers || []
  const persistedUser = userService.getUser(userId)
  const persistedUsername = persistedUser?.username || null
  return adminUsers.includes(userId) || (persistedUsername && adminUsers.includes(persistedUsername))
}

const isFederationModeratorRequest = (req) => {
  const userId = getUserId(req)
  return !!(isConfiguredAdmin(userId) || (userId && adminService.isModerator(userId)))
}

const requireFederationModerator = (req, res, next) => {
  if (!isFederationModeratorRequest(req)) {
    return res.status(403).json({ error: 'Moderator access required' })
  }
  next()
}

const isSafeId = (value) => {
  const normalized = normalizeText(value)
  if (!normalized || normalized.length > MAX_ID_LENGTH) return false
  if (RESERVED_OBJECT_KEYS.has(normalized)) return false
  return SAFE_ID_PATTERN.test(normalized)
}

const readSafeRouteId = (req, res, paramName, label) => {
  const value = normalizeText(req.params?.[paramName])
  if (!isSafeId(value)) {
    res.status(400).json({ error: `Invalid ${label}` })
    return null
  }
  return value
}

const normalizeAndValidateHost = (value) => {
  const raw = normalizeText(value)
  if (!raw || raw.length > MAX_HOST_LENGTH) return null

  const candidate = raw.includes('://') ? raw : `https://${raw}`
  try {
    const parsed = new URL(candidate)
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) return null
    if (!parsed.host || parsed.username || parsed.password) return null
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return null
    const normalized = parsed.host.toLowerCase()
    if (!normalized || normalized.length > MAX_HOST_LENGTH) return null
    return normalized
  } catch {
    return null
  }
}

const normalizeAndValidateUrl = (value, expectedHost = null, { requireHttps = false } = {}) => {
  const raw = normalizeText(value)
  if (!raw || raw.length > MAX_URL_LENGTH) return null

  try {
    const parsed = new URL(raw)
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) return null
    if (requireHttps && parsed.protocol !== 'https:') return null
    if (!parsed.host || parsed.username || parsed.password) return null
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return null

    const host = parsed.host.toLowerCase()
    if (expectedHost && host !== expectedHost) return null
    return `${parsed.protocol}//${host}`
  } catch {
    return null
  }
}

const getFederationAllowlistHosts = () => {
  return safeArray(config.config.federation?.allowedServers)
    .map((entry) => normalizeAndValidateHost(entry) || federationService.normalizeHost(entry))
    .filter(Boolean)
}

const isHostAllowedByFederationConfig = (host) => {
  const normalizedHost = normalizeAndValidateHost(host) || federationService.normalizeHost(host)
  if (!normalizedHost) return false

  const allowlist = getFederationAllowlistHosts()
  if (isLocalOrPrivateHost(normalizedHost)) {
    // Local/private targets are blocked by default to prevent SSRF; allow only
    // when explicitly pinned in federation.allowedServers.
    return allowlist.includes(normalizedHost)
  }
  if (allowlist.length === 0) return true
  if (allowlist.includes('*')) return true

  return allowlist.some((entry) => {
    if (entry === normalizedHost) return true
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1)
      return normalizedHost.endsWith(suffix)
    }
    return false
  })
}

const parseBoundedInteger = (value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return null
  if (parsed < min || parsed > max) return null
  return parsed
}

const isFederationEnabled = () => config.config.federation?.enabled === true

const sanitizeMemberForFederation = (member) => ({
  id: member?.id,
  username: member?.username || null,
  displayName: member?.displayName || null,
  avatar: member?.avatar || member?.imageUrl || member?.avatarUrl || null,
  host: member?.host || config.getHost(),
  roles: safeArray(member?.roles),
  role: member?.role || null,
  status: member?.status || 'offline',
  joinedAt: member?.joinedAt || null
})

const sanitizeChannelForFederation = (channel) => ({
  id: channel?.id,
  serverId: channel?.serverId,
  name: channel?.name,
  type: channel?.type,
  topic: channel?.topic || '',
  categoryId: channel?.categoryId || null,
  position: channel?.position ?? null,
  nsfw: !!channel?.nsfw,
  rateLimitPerUser: channel?.rateLimitPerUser ?? null
})

const sanitizeServerSnapshot = (server) => {
  const channels = channelService.getServerChannels(server.id).map(sanitizeChannelForFederation)
  const members = safeArray(server.members).map(sanitizeMemberForFederation)
  return {
    id: server.id,
    name: server.name,
    icon: server.icon || null,
    description: server.description || '',
    banner: server.banner || null,
    ownerId: server.ownerId || null,
    roles: safeArray(server.roles),
    categories: safeArray(server.categories),
    memberCount: members.length,
    onlineCount: members.filter((member) => member.status === 'online').length,
    members,
    channels,
    host: config.getHost(),
    hostName: config.config.server.name,
    apiUrl: config.getServerUrl(),
    imageServerUrl: config.getImageServerUrl(),
    createdAt: server.createdAt || null,
    updatedAt: server.updatedAt || null
  }
}

export const buildFederationDiscoveryDocument = () => {
  const oauthSettings = config.config.auth?.oauth || {}
  const oauthProvider = oauthSettings?.provider || null
  const oauthEnabled = config.isOAuthEnabled()
  const localAuthEnabled = config.isLocalAuthEnabled()
  const allowRegistration = config.isRegistrationAllowed()
  const serverUrl = config.getServerUrl()
  const host = config.getHost()
  const federationEnabled = isFederationEnabled()

  return {
    software: 'voltchat',
    protocol: 'voltchat-federation',
    protocolVersion: 1,
    instanceType: 'voltchat-mainnet',
    host,
    name: config.config.server.name,
    description: config.config.server.description || '',
    website: serverUrl,
    endpoints: {
      api: serverUrl,
      images: config.getImageServerUrl(),
      federation: `${serverUrl}/api/federation`,
      discovery: `${serverUrl}/.well-known/voltchat`
    },
    capabilities: {
      federation: federationEnabled,
      remoteInvites: true,
      relayPush: true,
      relayFetch: true,
      serverSnapshots: true
    },
    auth: {
      local: {
        enabled: localAuthEnabled,
        canRegister: localAuthEnabled && allowRegistration
      },
      oauth: {
        enabled: oauthEnabled,
        provider: oauthProvider
      }
    },
    federationEnabled,
    discoveryVersion: 1,
    verification: {
      valid: Boolean(serverUrl && host),
      checkedAt: new Date().toISOString()
    },
    apiUrl: serverUrl,
    imageServerUrl: config.getImageServerUrl(),
    cdnEnabled: config.isCdnEnabled(),
    cdnUrl: config.isCdnEnabled() ? config.getCdnConfig()?.url || null : null
  }
}

const upsertRemoteServerSnapshot = (snapshot, fromHost) => {
  if (!snapshot?.id) return null

  const servers = loadServersData()
  const normalizedHost = federationService.normalizeHost(fromHost)
  const existingIndex = servers.findIndex((server) => server.id === snapshot.id && federationService.normalizeHost(server.remoteHost) === normalizedHost)
  const existing = existingIndex >= 0 ? servers[existingIndex] : null

  const remoteServer = {
    ...existing,
    id: snapshot.id,
    name: snapshot.name || existing?.name || 'Remote Server',
    icon: snapshot.icon || existing?.icon || null,
    description: snapshot.description || existing?.description || '',
    banner: snapshot.banner || existing?.banner || null,
    ownerId: snapshot.ownerId || existing?.ownerId || null,
    roles: safeArray(snapshot.roles),
    categories: safeArray(snapshot.categories),
    memberCount: Number(snapshot.memberCount || safeArray(snapshot.members).length || 0),
    members: safeArray(snapshot.members),
    remoteHost: normalizedHost,
    remoteUrl: snapshot.apiUrl || existing?.remoteUrl || `https://${normalizedHost}`,
    imageServerUrl: snapshot.imageServerUrl || existing?.imageServerUrl || null,
    federated: true,
    createdAt: snapshot.createdAt || existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  if (existingIndex >= 0) servers[existingIndex] = remoteServer
  else servers.push(remoteServer)
  saveServersData(servers)

  const channels = safeArray(snapshot.channels)
  for (const channel of channels) {
    if (!channel?.id) continue
    const existingChannel = channelService.getChannel(channel.id)
    if (existingChannel) {
      channelService.updateChannel(channel.id, {
        ...sanitizeChannelForFederation(channel),
        remoteHost: normalizedHost,
        federated: true
      })
    } else {
      channelService.createChannel({
        ...sanitizeChannelForFederation(channel),
        remoteHost: normalizedHost,
        federated: true
      })
    }
  }

  return remoteServer
}

const upsertRemoteUser = async (payload, fromHost) => {
  if (!payload?.id) return null
  const normalizedHost = federationService.normalizeHost(payload.host || fromHost)
  const remoteUserId = getRemoteStorageId(payload.id, normalizedHost)
  const normalizedUser = {
    id: remoteUserId,
    remoteUserId: payload.id,
    username: payload.username || null,
    displayName: payload.displayName || payload.username || null,
    customUsername: payload.customUsername || null,
    avatar: payload.avatar || null,
    imageUrl: payload.imageUrl || payload.avatar || null,
    avatarHost: payload.avatarHost || payload.imageServerUrl || null,
    host: normalizedHost,
    status: payload.status || 'offline',
    customStatus: payload.customStatus || null,
    roles: safeArray(payload.roles),
    remote: true,
    federatedHost: normalizedHost,
    address: getRemoteAddress(payload.customUsername || payload.username, normalizedHost)
  }
  federationService.addRemoteUser(remoteUserId, normalizedUser)
  await userService.saveUser(remoteUserId, normalizedUser)
  return normalizedUser
}

const upsertRemoteMember = (payload, fromHost) => {
  if (!payload?.serverId || !payload?.member?.id) return null
  const servers = loadServersData()
  const normalizedHost = federationService.normalizeHost(fromHost)
  const index = servers.findIndex((server) => server.id === payload.serverId && federationService.normalizeHost(server.remoteHost) === normalizedHost)
  if (index === -1) return null

  const server = servers[index]
  const members = safeArray(server.members)
  const member = sanitizeMemberForFederation({
    ...payload.member,
    host: payload.member.host || normalizedHost
  })
  const memberIndex = members.findIndex((entry) => entry.id === member.id)
  if (memberIndex >= 0) members[memberIndex] = { ...members[memberIndex], ...member }
  else members.push(member)
  server.members = members
  server.memberCount = members.length
  server.updatedAt = new Date().toISOString()
  servers[index] = server
  saveServersData(servers)
  return member
}

const removeRemoteMember = (payload, fromHost) => {
  if (!payload?.serverId || !payload?.userId) return false
  const servers = loadServersData()
  const normalizedHost = federationService.normalizeHost(fromHost)
  const index = servers.findIndex((server) => server.id === payload.serverId && federationService.normalizeHost(server.remoteHost) === normalizedHost)
  if (index === -1) return false

  const server = servers[index]
  server.members = safeArray(server.members).filter((member) => member.id !== payload.userId)
  server.memberCount = server.members.length
  server.updatedAt = new Date().toISOString()
  servers[index] = server
  saveServersData(servers)
  return true
}

const verifyFederationRequest = (req) => {
  const token = req.headers['x-federation-token'] || req.body?.token
  const host = req.headers['x-federation-host'] || req.body?.host || req.body?.fromHost
  if (!token || !host) return null
  if (typeof token !== 'string' || token.length > 8192) return null
  const normalizedHost = normalizeAndValidateHost(host) || federationService.normalizeHost(host)
  if (!normalizedHost) return null

  const verified = federationService.verifyHandshakeToken(token, normalizedHost)
  if (!verified?.peer) return null
  if (!isHostAllowedByFederationConfig(verified.peer.host)) return null

  if (verified.peer.status !== 'connected' && verified.peer.status !== 'error') {
    return null
  }

  return verified
}

const requireFederationPeerAuth = (req, res, next) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  req.federationPeer = verified.peer
  return next()
}

const buildInboundFederatedDm = (payload, fromHost, conversationId) => {
  const senderHost = federationService.normalizeHost(payload.from?.host || fromHost)
  const senderUserId = getRemoteStorageId(payload.from?.id, senderHost)
  return {
    id: payload.message?.id || `fed_dm_${Date.now()}`,
    conversationId,
    userId: senderUserId,
    username: payload.from?.username || payload.message?.username || 'Unknown',
    avatar: payload.from?.avatar || payload.message?.avatar || null,
    content: payload.message?.content || '',
    timestamp: payload.message?.timestamp || new Date().toISOString(),
    attachments: safeArray(payload.message?.attachments),
    replyTo: payload.message?.replyTo || null,
    storage: payload.message?.storage || {
      cdn: 'local',
      storageNode: senderHost,
      serverUrl: payload.from?.serverUrl || null
    },
    encrypted: !!payload.message?.encrypted,
    iv: payload.message?.iv || null,
    epoch: payload.message?.epoch || null,
    federated: true,
    host: senderHost
  }
}

const processRelayEvent = async (message, peer = null) => {
  if (!message?.id || !message?.type) return
  const fromHost = federationService.normalizeHost(message.fromHost || peer?.host)
  if (!fromHost) return
  if (federationService.hasProcessedRelay(fromHost, message.id)) return

  const payload = message.payload || {}
  switch (message.type) {
    case 'mention:relay': {
      const users = Object.values(userService.getAllUsers() || {})
      const localUser = users.find((user) => user.username?.toLowerCase() === String(payload.targetUsername || '').toLowerCase())
      if (localUser && _io) {
        _io.to(`user:${localUser.id}`).emit('notification:mention', {
          type: 'federated',
          channelId: payload.channelId,
          messageId: payload.messageId,
          senderId: payload.senderId,
          senderAddress: getRemoteAddress(payload.senderName || payload.targetUsername, payload.senderHost || fromHost),
          senderName: payload.senderName,
          senderHost: payload.senderHost || fromHost,
          content: payload.content,
          timestamp: payload.timestamp,
          federated: true
        })
      }
      break
    }
    case 'user:upsert':
      upsertRemoteUser(payload, fromHost)
      break
    case 'user:presence': {
      const remoteUser = upsertRemoteUser(payload.user || payload, fromHost)
      if (remoteUser && _io) {
        _io.emit('user:status', {
          userId: remoteUser.id,
          host: remoteUser.host,
          status: remoteUser.status || 'offline',
          customStatus: remoteUser.customStatus || null,
          federated: true
        })
      }
      break
    }
    case 'server:upsert':
      upsertRemoteServerSnapshot(payload.server || payload, fromHost)
      break
    case 'server:member:upsert':
      upsertRemoteMember(payload, fromHost)
      break
    case 'server:member:remove':
      removeRemoteMember(payload, fromHost)
      break
    case 'friend:request': {
      const localRecipientId = payload.toUserId
      const remoteUser = upsertRemoteUser(payload.from, fromHost)
      if (localRecipientId && remoteUser) {
        const request = await friendRequestService.sendRequest(
          remoteUser.id,
          localRecipientId,
          remoteUser.customUsername || remoteUser.username,
          payload.toUsername || null
        )
        if (!request?.error && _io) {
          _io.to(`user:${localRecipientId}`).emit('friend:request:received', {
            from: {
              id: remoteUser.id,
              username: remoteUser.customUsername || remoteUser.username,
              avatar: remoteUser.avatar,
              host: remoteUser.host,
              address: remoteUser.address,
              federated: true
            }
          })
        }
      }
      break
    }
    case 'friend:accept': {
      const localUserId = payload.toUserId
      const remoteUser = upsertRemoteUser(payload.from, fromHost)
      if (localUserId && remoteUser) {
        await friendService.addFriend(localUserId, remoteUser.id)
        if (_io) {
          _io.to(`user:${localUserId}`).emit('friend:request:accepted', {
            userId: remoteUser.id,
            username: remoteUser.customUsername || remoteUser.username,
            host: remoteUser.host,
            address: remoteUser.address,
            federated: true
          })
        }
      }
      break
    }
    case 'dm:message': {
      const localRecipientId = payload.toUserId
      const remoteUser = upsertRemoteUser(payload.from, fromHost)
      if (localRecipientId && remoteUser) {
        const conversation = await dmService.getOrCreateConversation(localRecipientId, remoteUser.id)
        const inboundMessage = buildInboundFederatedDm(payload, fromHost, conversation.id)
        await dmMessageService.addMessage(conversation.id, inboundMessage)
        await dmService.updateLastMessage(conversation.id, localRecipientId, remoteUser.id)
        if (_io) {
          _io.to(`dm:${conversation.id}`).emit('dm:new', inboundMessage)
          _io.to(`user:${localRecipientId}`).emit('dm:notification', {
            conversationId: conversation.id,
            message: inboundMessage,
            from: {
              id: remoteUser.id,
              username: remoteUser.customUsername || remoteUser.username,
              avatar: remoteUser.avatar,
              host: remoteUser.host,
              address: remoteUser.address,
              federated: true
            }
          })
        }
      }
      break
    }
    default:
      console.log(`[Federation] Ignoring unsupported relay event: ${message.type}`)
      break
  }

  federationService.markRelayProcessed(fromHost, message.id)
}

export const setupFederationRoutes = (io) => {
  _io = io
  federationService.setRelayHandler(processRelayEvent)
  federationService.startFederationSyncLoop()
}

const router = express.Router()

router.get('/peers', authenticateToken, requireFederationModerator, (req, res) => {
  const peers = federationService.getPeers()
  res.json(peers.map(({ sharedSecret, ...peer }) => peer))
})

router.get('/peers/:peerId', authenticateToken, requireFederationModerator, (req, res) => {
  const peerId = readSafeRouteId(req, res, 'peerId', 'peer id')
  if (!peerId) return

  const peer = federationService.getPeer(peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  const { sharedSecret, ...safePeer } = peer
  res.json(safePeer)
})

router.post('/peers', authenticateToken, requireFederationModerator, async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const name = normalizeBoundedText(req.body?.name, MAX_NAME_LENGTH)
  const host = normalizeText(req.body?.host)
  const url = normalizeText(req.body?.url)

  if (!name || !(host || url)) {
    return res.status(400).json({ error: 'Name and host/url are required' })
  }

  const normalizedHost = normalizeAndValidateHost(host || url)
  if (!normalizedHost) {
    return res.status(400).json({ error: 'Invalid host' })
  }
  if (!isHostAllowedByFederationConfig(normalizedHost)) {
    return res.status(403).json({ error: 'Peer host is not allowed by federation policy' })
  }

  const fallbackUrl = `https://${normalizedHost}`
  const normalizedUrl = normalizeAndValidateUrl(url || fallbackUrl, normalizedHost, { requireHttps: true })
  if (!normalizedUrl) {
    return res.status(400).json({ error: 'Invalid URL (HTTPS required)' })
  }

  const result = await federationService.addPeer({
    name,
    host: normalizedHost,
    url: normalizedUrl,
    direction: 'outgoing'
  })
  if (result.error && result.peer) return res.status(409).json(result)
  if (!result.peer) return res.status(400).json(result)

  try {
    await federationService.sendHandshake(result.peer.id, { autoAccept: false })
  } catch (err) {
    await federationService.updatePeer(result.peer.id, { status: 'pending', lastError: err.message })
  }

  const { sharedSecret, ...safePeer } = federationService.getPeer(result.peer.id)
  res.json(safePeer)
})

router.post('/peers/:peerId/accept', authenticateToken, requireFederationModerator, async (req, res) => {
  const peerId = readSafeRouteId(req, res, 'peerId', 'peer id')
  if (!peerId) return

  const peer = await federationService.acceptPeer(peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })

  try {
    await federationService.sendHeartbeat(peer.id)
    await federationService.deliverQueuedMessages(peer.id)
  } catch (err) {
    await federationService.updatePeer(peer.id, { status: 'error', lastError: err.message })
  }

  const { sharedSecret, ...safePeer } = federationService.getPeer(peer.id)
  res.json(safePeer)
})

router.post('/peers/:peerId/reject', authenticateToken, requireFederationModerator, async (req, res) => {
  const peerId = readSafeRouteId(req, res, 'peerId', 'peer id')
  if (!peerId) return

  const peer = await federationService.rejectPeer(peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  res.json({ success: true })
})

router.delete('/peers/:peerId', authenticateToken, requireFederationModerator, async (req, res) => {
  const peerId = readSafeRouteId(req, res, 'peerId', 'peer id')
  if (!peerId) return

  await federationService.removePeer(peerId)
  res.json({ success: true })
})

router.post('/handshake', async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const name = normalizeBoundedText(req.body?.name, MAX_NAME_LENGTH)
  const host = normalizeText(req.body?.host)
  const url = normalizeText(req.body?.url)
  const sharedSecret = normalizeBoundedText(req.body?.sharedSecret, MAX_SHARED_SECRET_LENGTH)
  const hasFeaturePayload = isPlainObject(req.body?.features)
  const features = hasFeaturePayload ? req.body.features : null

  if (!name || !host || !url || !sharedSecret) {
    return res.status(400).json({ error: 'Missing required fields' })
  }
  if (sharedSecret.length < 16) {
    return res.status(400).json({ error: 'Invalid sharedSecret' })
  }

  const normalizedHost = normalizeAndValidateHost(host)
  if (!normalizedHost) {
    return res.status(400).json({ error: 'Invalid host' })
  }
  if (!isHostAllowedByFederationConfig(normalizedHost)) {
    return res.status(403).json({ error: 'Peer host is not allowed by federation policy' })
  }

  const normalizedUrl = normalizeAndValidateUrl(url, normalizedHost, { requireHttps: true })
  if (!normalizedUrl) {
    return res.status(400).json({ error: 'Invalid URL (HTTPS required)' })
  }

  const existing = federationService.getPeerByHost(normalizedHost)
  if (existing) {
    if (existing.sharedSecret && existing.sharedSecret !== sharedSecret) {
      return res.status(401).json({ error: 'Handshake credentials rejected' })
    }

    const updated = await federationService.updatePeer(existing.id, {
      name,
      host: normalizedHost,
      url: normalizedUrl,
      features: features || existing.features || {},
      // Ignore caller-controlled auto-accept flags; only local moderation can
      // promote a peer from pending to connected.
      status: existing.status === 'connected' ? 'connected' : 'pending',
      lastSeen: new Date().toISOString(),
      lastError: null
    })
    return res.json({
      accepted: true,
      peerId: updated.id,
      host: config.getHost(),
      name: config.config.server.name,
      features: config.config.features || {}
    })
  }

  const result = await federationService.addPeer({
    name,
    host: normalizedHost,
    url: normalizedUrl,
    sharedSecret,
    direction: 'incoming',
    features: features || {},
    // Always require local moderation approval for new incoming peers.
    status: 'pending'
  })
  if (!result?.peer) {
    return res.status(400).json({ error: result?.error || 'Failed to register peer' })
  }

  res.json({
    accepted: true,
    peerId: result.peer?.id || null,
    host: config.getHost(),
    name: config.config.server.name,
    features: config.config.features || {}
  })
})

router.post('/ping', async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  await federationService.updatePeer(verified.peer.id, {
    status: 'connected',
    lastSeen: new Date().toISOString(),
    lastError: null
  })

  res.json({
    host: config.getHost(),
    name: config.config.server.name,
    version: config.config.server.version,
    features: config.config.features || {},
    timestamp: new Date().toISOString()
  })
})

router.post('/invites/share', authenticateToken, requireFederationModerator, async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const code = normalizeBoundedText(req.body?.code, MAX_ID_LENGTH)
  const serverId = normalizeBoundedText(req.body?.serverId, MAX_ID_LENGTH)
  const serverName = normalizeBoundedText(req.body?.serverName, MAX_NAME_LENGTH) || null
  const targetPeerIdRaw = normalizeText(req.body?.targetPeerId)
  const maxUses = parseBoundedInteger(req.body?.maxUses, { min: 0, max: 1000000 })
  const expiresAtRaw = normalizeText(req.body?.expiresAt)

  if (!code || !serverId) {
    return res.status(400).json({ error: 'Code and serverId are required' })
  }
  if (!isSafeId(code)) {
    return res.status(400).json({ error: 'Invalid invite code' })
  }
  if (!isSafeId(serverId)) {
    return res.status(400).json({ error: 'Invalid serverId' })
  }

  const server = serverService.getServer(serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  let targetPeerId = null
  if (targetPeerIdRaw) {
    if (!isSafeId(targetPeerIdRaw)) {
      return res.status(400).json({ error: 'Invalid targetPeerId' })
    }
    const targetPeer = federationService.getPeer(targetPeerIdRaw)
    if (!targetPeer) {
      return res.status(404).json({ error: 'Target peer not found' })
    }
    targetPeerId = targetPeer.id
  }

  if (req.body?.maxUses !== undefined && req.body?.maxUses !== null && maxUses === null) {
    return res.status(400).json({ error: 'Invalid maxUses value' })
  }

  let expiresAt = null
  if (expiresAtRaw) {
    const expiryMs = new Date(expiresAtRaw).getTime()
    if (!Number.isFinite(expiryMs)) {
      return res.status(400).json({ error: 'Invalid expiresAt timestamp' })
    }
    if (expiryMs <= Date.now()) {
      return res.status(400).json({ error: 'expiresAt must be in the future' })
    }
    expiresAt = new Date(expiryMs).toISOString()
  }

  const shared = await federationService.shareInvite({
    code,
    serverId,
    serverName,
    targetPeerId,
    maxUses: maxUses || 0,
    expiresAt
  })
  res.json(shared)
})

router.get('/invites', authenticateToken, requireFederationModerator, (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }
  res.json(federationService.getSharedInvites())
})

router.get('/invites/public', (req, res) => {
  const hostQuery = normalizeText(req.query.host)
  const host = hostQuery ? normalizeAndValidateHost(hostQuery) : null
  if (hostQuery && !host) {
    return res.status(400).json({ error: 'Invalid host query parameter' })
  }

  const invites = federationService.getSharedInvites()
    .filter((invite) => !invite.targetPeerId || (host && federationService.getPeerByHost(host)?.id === invite.targetPeerId))
    .filter((invite) => !invite.expiresAt || new Date(invite.expiresAt) > new Date())
    .filter((invite) => !invite.maxUses || invite.uses < invite.maxUses)
    .map(({ id, code, serverId, serverName, sourceHost, sourceMainline, expiresAt }) => ({
      id,
      code,
      serverId,
      serverName,
      sourceHost,
      sourceMainline,
      expiresAt
    }))
  res.json(invites)
})

router.post('/invites/:inviteId/use', authenticateToken, requireFederationModerator, async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const inviteId = readSafeRouteId(req, res, 'inviteId', 'invite id')
  if (!inviteId) return

  const result = await federationService.useSharedInvite(inviteId)
  if (!result) return res.status(404).json({ error: 'Invite not found' })
  if (result.error) return res.status(400).json(result)
  res.json(result)
})

router.delete('/invites/:inviteId', authenticateToken, requireFederationModerator, async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const inviteId = readSafeRouteId(req, res, 'inviteId', 'invite id')
  if (!inviteId) return

  const removed = await federationService.removeSharedInvite(inviteId)
  if (!removed) return res.status(404).json({ error: 'Invite not found' })
  res.json({ success: true })
})

router.post('/relay/:peerId', authenticateToken, requireFederationModerator, async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const peerId = readSafeRouteId(req, res, 'peerId', 'peer id')
  if (!peerId) return

  const peer = federationService.getPeer(peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  if (peer.status !== 'connected' && peer.status !== 'error') {
    return res.status(400).json({ error: 'Peer not connected' })
  }

  const type = normalizeText(req.body?.type)
  const payload = req.body?.payload
  if (!type || payload === undefined) {
    return res.status(400).json({ error: 'type and payload are required' })
  }
  if (!SAFE_EVENT_TYPE_PATTERN.test(type)) {
    return res.status(400).json({ error: 'Invalid relay type' })
  }
  if (isPlainObject(payload) && Object.keys(payload).some((key) => RESERVED_OBJECT_KEYS.has(key))) {
    return res.status(400).json({ error: 'Invalid payload keys' })
  }

  const message = await federationService.queueRelayMessage(peer.id, { type, payload })
  if (!message) {
    return res.status(500).json({ error: 'Failed to queue relay message' })
  }
  await federationService.deliverQueuedMessages(peer.id).catch(() => {})
  res.json(message)
})

router.post('/relay/fetch', async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  const messages = await federationService.dequeueRelayMessages(verified.peer.id)
  await federationService.updatePeer(verified.peer.id, {
    status: 'connected',
    lastSeen: new Date().toISOString(),
    lastError: null
  })
  res.json(messages)
})

router.get('/info', (req, res) => {
  const discovery = buildFederationDiscoveryDocument()

  // Public /info is intentionally minimal; keep it aligned with the allow-listed
  // discovery document to avoid leaking auth/provider internals.
  res.json({
    host: discovery.host,
    name: discovery.name,
    instanceType: discovery.instanceType,
    software: {
      name: discovery.software,
      protocol: discovery.protocol
    },
    discoveryVersion: discovery.protocolVersion,
    federationEnabled: discovery.capabilities.federation,
    apiUrl: discovery.apiUrl,
    imageServerUrl: discovery.imageServerUrl,
    cdnEnabled: discovery.cdnEnabled,
    cdnUrl: discovery.cdnUrl
  })
})

router.get('/discover', (req, res) => {
  res.json(buildFederationDiscoveryDocument())
})

router.get('/server-info/:serverId', requireFederationPeerAuth, (req, res) => {
  const serverId = readSafeRouteId(req, res, 'serverId', 'server id')
  if (!serverId) return

  const server = serverService.getServer(serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  const snapshot = sanitizeServerSnapshot(server)
  res.json({
    id: snapshot.id,
    name: snapshot.name,
    icon: snapshot.icon,
    description: snapshot.description,
    memberCount: snapshot.memberCount,
    onlineCount: snapshot.onlineCount,
    host: snapshot.host,
    hostName: snapshot.hostName,
    createdAt: snapshot.createdAt
  })
})

router.get('/server-snapshot/:serverId', requireFederationPeerAuth, (req, res) => {
  const serverId = readSafeRouteId(req, res, 'serverId', 'server id')
  if (!serverId) return

  const server = serverService.getServer(serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  res.json(sanitizeServerSnapshot(server))
})

router.post('/member-joined', (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  const serverId = normalizeText(req.body?.serverId)
  const user = req.body?.user
  if (!serverId || !user?.id) {
    return res.status(400).json({ error: 'serverId and user are required' })
  }
  if (!isSafeId(serverId)) {
    return res.status(400).json({ error: 'Invalid serverId' })
  }
  if (!isPlainObject(user)) {
    return res.status(400).json({ error: 'Invalid user payload' })
  }
  if (!isSafeId(user.id)) {
    return res.status(400).json({ error: 'Invalid user id' })
  }

  upsertRemoteUser(user, verified.peer.host)
  upsertRemoteMember({
    serverId,
    member: {
      ...user,
      host: verified.peer.host,
      status: user.status || 'online'
    }
  }, verified.peer.host)

  res.json({ success: true })
})

router.post('/relay/push', async (req, res) => {
  if (!isFederationEnabled()) {
    return res.status(403).json({ error: 'Federation is not enabled' })
  }

  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  const id = normalizeText(req.body?.id)
  const type = normalizeText(req.body?.type)
  const payload = req.body?.payload
  const timestamp = req.body?.timestamp
  const schemaVersion = parseBoundedInteger(req.body?.schemaVersion, { min: 1, max: 50 })

  if (!id || !type || payload === undefined) {
    return res.status(400).json({ error: 'id, type, and payload are required' })
  }
  if (!isSafeId(id)) {
    return res.status(400).json({ error: 'Invalid relay id' })
  }
  if (!SAFE_EVENT_TYPE_PATTERN.test(type)) {
    return res.status(400).json({ error: 'Invalid relay type' })
  }
  if (isPlainObject(payload) && Object.keys(payload).some((key) => RESERVED_OBJECT_KEYS.has(key))) {
    return res.status(400).json({ error: 'Invalid payload keys' })
  }

  await processRelayEvent({
    id,
    type,
    payload,
    timestamp,
    schemaVersion: schemaVersion || 1,
    // Never trust caller-supplied host identity fields.
    fromHost: verified.peer.host,
    fromMainline: verified.peer.name
  }, verified.peer)

  federationService.updatePeer(verified.peer.id, {
    status: 'connected',
    lastSeen: new Date().toISOString(),
    lastError: null
  })

  res.json({ success: true })
})

router.get('/servers', requireFederationPeerAuth, (req, res) => {
  const servers = loadServersData()
  const list = servers
    .filter((server) => !server.federated && !server.remoteHost)
    .map((server) => ({
      id: server.id,
      name: server.name,
      icon: server.icon || null,
      description: server.description || '',
      memberCount: safeArray(server.members).length,
      host: config.getHost()
    }))
  res.json(list)
})

export default router
