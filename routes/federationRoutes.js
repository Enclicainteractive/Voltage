import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { federationService } from '../services/federationService.js'
import {
  FILES,
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
  const enclica = oauthSettings?.enclica || {}
  const oauthProvider = oauthSettings?.provider || null
  const oauthEnabled = config.isOAuthEnabled()
  const localAuthEnabled = config.isLocalAuthEnabled()
  const allowRegistration = config.isRegistrationAllowed()
  const serverUrl = config.getServerUrl()
  const host = config.getHost()

  return {
    software: 'voltchat',
    protocol: 'voltchat-federation',
    protocolVersion: 1,
    instanceType: 'voltchat-mainnet',
    validMainnet: config.isMainline(),
    host,
    name: config.config.server.name,
    version: config.config.server.version,
    mode: config.config.server.mode,
    description: config.config.server.description || '',
    website: serverUrl,
    inviteBaseUrl: serverUrl,
    endpoints: {
      api: serverUrl,
      socket: serverUrl,
      images: config.getImageServerUrl(),
      federation: `${serverUrl}/api/federation`,
      auth: `${serverUrl}/api/auth`,
      discovery: `${serverUrl}/.well-known/voltchat`
    },
    capabilities: {
      federation: config.config.federation?.enabled || false,
      remoteInvites: true,
      remoteUsers: true,
      relayPush: true,
      relayFetch: true,
      serverSnapshots: true,
      autoDiscovery: true,
      usernameAddressing: true
    },
    auth: {
      local: {
        enabled: localAuthEnabled,
        canRegister: localAuthEnabled && allowRegistration
      },
      oauth: {
        enabled: oauthEnabled,
        provider: oauthProvider,
        clientId: oauthEnabled && oauthProvider === 'enclica' ? (enclica.clientId || null) : null,
        authUrl: oauthEnabled && oauthProvider === 'enclica' ? (enclica.authUrl || null) : null,
        tokenUrl: oauthEnabled && oauthProvider === 'enclica' ? (enclica.tokenUrl || null) : null,
        revokeUrl: oauthEnabled && oauthProvider === 'enclica' ? (enclica.revokeUrl || null) : null
      }
    },
    features: config.config.features,
    verification: {
      valid: Boolean(serverUrl && host),
      checkedAt: new Date().toISOString(),
      serverUrl,
      host
    },
    peerCount: federationService.getPeers().filter((peer) => peer.status === 'connected').length,
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
  return federationService.verifyHandshakeToken(token, host)
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

router.get('/peers', authenticateToken, (req, res) => {
  const peers = federationService.getPeers()
  res.json(peers.map(({ sharedSecret, ...peer }) => peer))
})

router.get('/peers/:peerId', authenticateToken, (req, res) => {
  const peer = federationService.getPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  const { sharedSecret, ...safePeer } = peer
  res.json(safePeer)
})

router.post('/peers', authenticateToken, async (req, res) => {
  if (!config.config.federation?.enabled) {
    return res.status(400).json({ error: 'Federation is not enabled' })
  }

  const { name, host, url } = req.body
  if (!name || !(host || url)) {
    return res.status(400).json({ error: 'Name and host/url are required' })
  }

  const result = federationService.addPeer({ name, host, url, direction: 'outgoing' })
  if (result.error && result.peer) return res.status(409).json(result)
  if (!result.peer) return res.status(400).json(result)

  try {
    await federationService.sendHandshake(result.peer.id, { autoAccept: false })
  } catch (err) {
    federationService.updatePeer(result.peer.id, { status: 'pending', lastError: err.message })
  }

  const { sharedSecret, ...safePeer } = federationService.getPeer(result.peer.id)
  res.json(safePeer)
})

router.post('/peers/:peerId/accept', authenticateToken, async (req, res) => {
  const peer = federationService.acceptPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })

  try {
    await federationService.sendHeartbeat(peer.id)
    await federationService.deliverQueuedMessages(peer.id)
  } catch (err) {
    federationService.updatePeer(peer.id, { status: 'error', lastError: err.message })
  }

  const { sharedSecret, ...safePeer } = federationService.getPeer(peer.id)
  res.json(safePeer)
})

router.post('/peers/:peerId/reject', authenticateToken, (req, res) => {
  const peer = federationService.rejectPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  res.json({ success: true })
})

router.delete('/peers/:peerId', authenticateToken, (req, res) => {
  federationService.removePeer(req.params.peerId)
  res.json({ success: true })
})

router.post('/handshake', async (req, res) => {
  const { name, host, url, sharedSecret, features, autoAccept } = req.body
  if (!name || !host || !url || !sharedSecret) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  const existing = federationService.getPeerByHost(host)
  if (existing) {
    const updated = federationService.updatePeer(existing.id, {
      name,
      host,
      url,
      features: features || existing.features || {},
      status: autoAccept ? 'connected' : existing.status,
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

  const result = federationService.addPeer({
    name,
    host,
    url,
    sharedSecret,
    direction: 'incoming',
    features: features || {},
    status: autoAccept ? 'connected' : 'pending'
  })

  res.json({
    accepted: true,
    peerId: result.peer?.id || null,
    host: config.getHost(),
    name: config.config.server.name,
    features: config.config.features || {}
  })
})

router.post('/ping', (req, res) => {
  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  federationService.updatePeer(verified.peer.id, {
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

router.post('/invites/share', authenticateToken, (req, res) => {
  const { code, serverId, serverName, targetPeerId, maxUses, expiresAt } = req.body
  if (!code || !serverId) {
    return res.status(400).json({ error: 'Code and serverId are required' })
  }

  const shared = federationService.shareInvite({
    code,
    serverId,
    serverName,
    targetPeerId,
    maxUses,
    expiresAt
  })
  res.json(shared)
})

router.get('/invites', authenticateToken, (req, res) => {
  res.json(federationService.getSharedInvites())
})

router.get('/invites/public', (req, res) => {
  const host = federationService.normalizeHost(req.query.host)
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

router.post('/invites/:inviteId/use', authenticateToken, (req, res) => {
  const result = federationService.useSharedInvite(req.params.inviteId)
  if (!result) return res.status(404).json({ error: 'Invite not found' })
  if (result.error) return res.status(400).json(result)
  res.json(result)
})

router.delete('/invites/:inviteId', authenticateToken, (req, res) => {
  federationService.removeSharedInvite(req.params.inviteId)
  res.json({ success: true })
})

router.post('/relay/:peerId', authenticateToken, async (req, res) => {
  const peer = federationService.getPeer(req.params.peerId)
  if (!peer) return res.status(404).json({ error: 'Peer not found' })
  if (peer.status !== 'connected' && peer.status !== 'error') {
    return res.status(400).json({ error: 'Peer not connected' })
  }

  const { type, payload } = req.body
  if (!type || payload === undefined) {
    return res.status(400).json({ error: 'type and payload are required' })
  }

  const message = federationService.queueRelayMessage(peer.id, { type, payload })
  await federationService.deliverQueuedMessages(peer.id).catch(() => {})
  res.json(message)
})

router.post('/relay/fetch', (req, res) => {
  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  const messages = federationService.dequeueRelayMessages(verified.peer.id)
  federationService.updatePeer(verified.peer.id, {
    status: 'connected',
    lastSeen: new Date().toISOString(),
    lastError: null
  })
  res.json(messages)
})

router.get('/info', (req, res) => {
  const discovery = buildFederationDiscoveryDocument()

  res.json({
    instanceType: discovery.instanceType,
    discoveryVersion: discovery.protocolVersion,
    host: discovery.host,
    name: discovery.name,
    version: discovery.version,
    mode: discovery.mode,
    description: discovery.description,
    website: discovery.website,
    socketUrl: discovery.endpoints.socket,
    inviteBaseUrl: discovery.inviteBaseUrl,
    mainnet: discovery.validMainnet,
    federationEnabled: discovery.capabilities.federation,
    features: discovery.features,
    capabilities: discovery.capabilities,
    software: {
      name: discovery.software,
      protocol: discovery.protocol,
      version: discovery.version
    },
    verification: discovery.verification,
    auth: discovery.auth,
    peerCount: discovery.peerCount,
    apiUrl: discovery.apiUrl,
    imageServerUrl: discovery.imageServerUrl,
    cdnEnabled: discovery.cdnEnabled,
    cdnUrl: discovery.cdnUrl
  })
})

router.get('/discover', (req, res) => {
  res.json(buildFederationDiscoveryDocument())
})

router.get('/server-info/:serverId', (req, res) => {
  const server = serverService.getServer(req.params.serverId)
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

router.get('/server-snapshot/:serverId', (req, res) => {
  const server = serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  res.json(sanitizeServerSnapshot(server))
})

router.post('/member-joined', (req, res) => {
  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  const { serverId, user } = req.body
  if (!serverId || !user?.id) {
    return res.status(400).json({ error: 'serverId and user are required' })
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
  const verified = verifyFederationRequest(req)
  if (!verified) {
    return res.status(401).json({ error: 'Missing or invalid federation credentials' })
  }

  const { id, type, payload, timestamp, schemaVersion, fromHost, fromMainline } = req.body
  if (!id || !type || payload === undefined) {
    return res.status(400).json({ error: 'id, type, and payload are required' })
  }

  await processRelayEvent({
    id,
    type,
    payload,
    timestamp,
    schemaVersion: schemaVersion || 1,
    fromHost: fromHost || verified.peer.host,
    fromMainline: fromMainline || verified.peer.name
  }, verified.peer)

  federationService.updatePeer(verified.peer.id, {
    status: 'connected',
    lastSeen: new Date().toISOString(),
    lastError: null
  })

  res.json({ success: true })
})

router.get('/servers', (req, res) => {
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
