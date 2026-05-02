import express from 'express'
import { authenticateToken, optionalAuth } from '../middleware/authMiddleware.js'
import { FILES, channelService, inviteService, serverService, saveData } from '../services/dataService.js'
import { InviteEncoder, parseCrossHostInvite, createCrossHostInvite } from '../utils/inviteEncoder.js'
import { federationService } from '../services/federationService.js'
import { getSocketIOInstance } from '../services/socketService.js'
import lockService from '../services/lockService.js'
import axios from 'axios'
import config from '../config/config.js'

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

const router = express.Router()
const LOCAL_INVITE_CODE_RE = /^[A-Z0-9]{4,64}$/

const normalizeLocalInviteCode = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (!LOCAL_INVITE_CODE_RE.test(normalized)) return null
  return normalized
}

const getInviteStateError = (invite) => {
  if (!invite || typeof invite !== 'object') return 'Invite not found'
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return 'Invite expired'
  }
  if (invite.maxUses && invite.uses >= invite.maxUses) {
    return 'Invite expired'
  }
  return null
}

const isUserBanned = (server, userId) => {
  if (!server || !userId || !Array.isArray(server.bans)) return false
  return server.bans.some(entry => entry?.userId === userId)
}

const buildJoinedMember = (user) => ({
  id: user.id,
  username: user.username || user.email,
  imageUrl: user?.imageUrl || user?.imageurl || user?.avatarUrl || user?.avatarURL || (isExternalImage(user?.avatar) ? user.avatar : null),
  avatar: resolveUserAvatar(user.id, user),
  host: user.host || config.getHost(),
  avatarHost: config.getImageServerUrl(),
  roles: ['member'],
  role: 'member',
  status: 'online',
  joinedAt: new Date().toISOString()
})

const mapJoinError = (error) => {
  switch (error?.message) {
    case 'INVITE_NOT_FOUND':
      return { status: 400, error: 'Invite not found' }
    case 'INVITE_EXPIRED':
      return { status: 400, error: 'Invite expired' }
    case 'SERVER_NOT_FOUND':
      return { status: 404, error: 'Server not found' }
    case 'INVITE_MISMATCH':
      return { status: 403, error: 'Invite/server mismatch' }
    case 'USER_BANNED':
      return { status: 403, error: 'You are banned from this server' }
    default:
      return null
  }
}

const joinLocalInviteForUser = async (inviteCode, user) => {
  let server = null
  let memberAdded = false

  await lockService.withLock(`invite_join:${inviteCode}`, async () => {
    const invite = inviteService.getInvite(inviteCode)
    if (!invite) throw new Error('INVITE_NOT_FOUND')
    const inviteStateError = getInviteStateError(invite)
    if (inviteStateError) throw new Error('INVITE_EXPIRED')

    const servers = getServers()
    const serverIndex = servers.findIndex(item => item.id === invite.serverId)
    if (serverIndex < 0) throw new Error('SERVER_NOT_FOUND')

    const targetServer = servers[serverIndex]
    if (isUserBanned(targetServer, user.id)) throw new Error('USER_BANNED')

    const existingMember = targetServer.members?.find(member => member.id === user.id)
    if (existingMember) {
      server = targetServer
      return
    }

    const consumeResult = await inviteService.useInvite(inviteCode)
    if (consumeResult?.error) {
      if (consumeResult.error === 'Invite not found') throw new Error('INVITE_NOT_FOUND')
      if (consumeResult.error === 'Invite expired') throw new Error('INVITE_EXPIRED')
      throw new Error('INVITE_EXPIRED')
    }
    if (consumeResult.serverId !== targetServer.id) {
      throw new Error('INVITE_MISMATCH')
    }

    if (!targetServer.members) targetServer.members = []
    targetServer.members.push(buildJoinedMember(user))
    servers[serverIndex] = targetServer

    await saveServers(servers)
    server = targetServer
    memberAdded = true
  }, {
    ttlMs: 10000,
    timeoutMs: 5000,
    maxRetries: 2
  })

  return { server, memberAdded }
}

const getServers = () => {
  const data = serverService.getAllServers()
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') return Object.values(data)
  return []
}

const saveServers = async (servers) => {
  const record = {}
  for (const server of servers || []) {
    if (server?.id) record[server.id] = server
  }
  // Use bulk save instead of iterating through each server
  await saveData(FILES.servers, record)
}

const getMemberRoles = (server, userId) => {
  const member = server?.members?.find(item => item?.id === userId)
  if (!member) return []
  if (Array.isArray(member.roles)) return member.roles
  return member.role ? [member.role] : []
}

const canCreateInvites = (server, userId) => {
  if (!server || !userId) return false
  if (server.ownerId === userId) return true

  const roleIds = getMemberRoles(server, userId)
  return roleIds.some(roleId => {
    const role = server.roles?.find(item => item?.id === roleId)
    if (!role?.permissions) return false
    return role.permissions.includes('all') ||
      role.permissions.includes('admin') ||
      role.permissions.includes('manage_server') ||
      role.permissions.includes('manage_invites') ||
      role.permissions.includes('create_invites')
  })
}

const syncRemoteChannels = (serverId, remoteHost, channels = []) => {
  for (const channel of channels) {
    if (!channel?.id) continue
    const nextChannel = {
      ...channel,
      serverId,
      remoteHost,
      federated: true
    }
    const existing = channelService.getChannel(channel.id)
    if (existing) channelService.updateChannel(channel.id, nextChannel)
    else channelService.createChannel(nextChannel)
  }
}

const buildFederatedServerRecord = (remoteServer, baseUrl, remoteHost, user) => ({
  id: remoteServer.id,
  name: remoteServer.name || 'Remote Server',
  icon: remoteServer.icon ? (remoteServer.icon.startsWith('http') ? remoteServer.icon : `${baseUrl}${remoteServer.icon}`) : null,
  description: remoteServer.description || '',
  banner: remoteServer.banner || null,
  remoteHost,
  remoteUrl: baseUrl,
  imageServerUrl: remoteServer.imageServerUrl || null,
  federated: true,
  memberCount: remoteServer.memberCount || 0,
  roles: Array.isArray(remoteServer.roles) ? remoteServer.roles : [],
  categories: Array.isArray(remoteServer.categories) ? remoteServer.categories : [],
  members: [{
    id: user.id,
    username: user.username,
    imageUrl: user?.imageUrl || user?.imageurl || user?.avatarUrl || user?.avatarURL || (isExternalImage(user?.avatar) ? user.avatar : null),
    avatar: resolveUserAvatar(user.id, user),
    host: user.host || config.getHost(),
    avatarHost: config.getImageServerUrl(),
    roles: ['member'],
    role: 'member',
    status: 'online',
    joinedAt: new Date().toISOString()
  }],
  createdAt: remoteServer.createdAt || new Date().toISOString()
})

const fetchRemoteServerSnapshot = async (baseUrl, serverId) => {
  const response = await axios.get(`${baseUrl}/api/federation/server-snapshot/${serverId}`, { timeout: 8000 })
  return response.data
}

// Get invite info (public - for invite page)
router.get('/:code', optionalAuth, (req, res) => {
  const code = normalizeLocalInviteCode(req.params.code)
  if (!code) {
    return res.status(404).json({ error: 'Invalid or expired invite' })
  }

  const invite = inviteService.getInvite(code)
  
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
      username: inviter.username,
      imageUrl: inviter?.imageUrl || inviter?.imageurl || inviter?.avatarUrl || inviter?.avatarURL || null,
      avatar: resolveUserAvatar(inviter.id, inviter)
    } : null,
    expiresAt: invite.expiresAt,
    uses: invite.uses,
    maxUses: invite.maxUses || 0
  })
})

// Join server via invite
router.post('/:code/join', authenticateToken, async (req, res) => {
  const code = normalizeLocalInviteCode(req.params.code)
  if (!code) {
    return res.status(400).json({ error: 'Invalid invite code' })
  }

  let joined
  try {
    joined = await joinLocalInviteForUser(code, req.user)
  } catch (error) {
    const mapped = mapJoinError(error)
    if (mapped) {
      return res.status(mapped.status).json({ error: mapped.error })
    }
    console.error('[API] Invite join error:', error)
    return res.status(500).json({ error: 'Failed to join server' })
  }

  const { server, memberAdded } = joined

  if (memberAdded) {
    console.log(`[API] User ${req.user.username} joined server ${server.name} via invite ${code}`)
  }
  
  // Emit socket events to notify clients about the new member
  if (memberAdded) try {
    const io = getSocketIOInstance()
    if (io) {
      const newMember = server.members[server.members.length - 1]
      // Notify all server members about the new member
      io.to(`server:${server.id}`).emit('server:member-joined', {
        serverId: server.id,
        member: newMember
      })
      // Force refresh the server data for all members to prevent cache issues
      io.to(`server:${server.id}`).emit('server:updated', {
        serverId: server.id,
        server: server
      })
    }
  } catch (socketError) {
    console.warn('[API] Failed to emit server join events:', socketError.message)
  }
  
  res.json(server)
})

// Cross-host invite endpoints
router.get('/cross-host/:code', optionalAuth, async (req, res) => {
  try {
    const decoded = parseCrossHostInvite(req.params.code)
    
    if (!decoded || !decoded.key) {
      return res.status(400).json({ error: 'Invalid invite code' })
    }

    const serverHost = decoded.host
    const currentHost = config.getHost()
    
    // Local invite encoded as cross-host
    if (serverHost === currentHost) {
      const invite = inviteService.getInvite(decoded.key)
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

    // Fetch invite info from the remote host.
    let remoteInvite = null
    try {
      const inviteRes = await axios.get(`${baseUrl}/api/invites/${encodeURIComponent(decoded.key)}`, { timeout: 8000 })
      remoteInvite = inviteRes.data
      const remoteInviteState = getInviteStateError(remoteInvite)
      if (remoteInviteState) {
        return res.status(400).json({ error: remoteInviteState })
      }
    } catch {
      remoteInvite = null
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
    
    if (!decoded || !decoded.key) {
      return res.status(400).json({ error: 'Invalid invite code' })
    }

    const serverHost = decoded.host
    const currentHost = config.getHost()
    
    if (serverHost === currentHost) {
      const localInviteCode = normalizeLocalInviteCode(decoded.key)
      if (!localInviteCode) {
        return res.status(400).json({ error: 'Invalid invite code' })
      }
      try {
        const joined = await joinLocalInviteForUser(localInviteCode, req.user)
        return res.json(joined.server)
      } catch (error) {
        const mapped = mapJoinError(error)
        if (mapped) {
          return res.status(mapped.status).json({ error: mapped.error })
        }
        throw error
      }
    }

    // Remote host - auto-peer and fetch details
    const remoteUrl = serverHost.startsWith('http') ? serverHost : `https://${serverHost}`
    let baseUrl
    try { baseUrl = new URL(remoteUrl).origin } catch { baseUrl = `https://${serverHost}` }

    await ensureFederationPeer(baseUrl)

    // Try to use the invite on the remote host
    let remoteServer = null
    let remoteInvite = null
    try {
      const inviteRes = await axios.get(`${baseUrl}/api/invites/${encodeURIComponent(decoded.key)}`, { timeout: 8000 })
      remoteInvite = inviteRes.data
      const remoteInviteState = getInviteStateError(remoteInvite)
      if (remoteInviteState) {
        return res.status(400).json({ error: remoteInviteState })
      }
      remoteServer = remoteInvite?.server || remoteInvite
    } catch {
      remoteServer = null
    }

    if (!remoteServer?.id) {
      return res.status(404).json({ error: 'Server not found' })
    }

    if (decoded.serverId && remoteServer.id !== decoded.serverId) {
      return res.status(400).json({ error: 'Invite/server mismatch' })
    }

    const serverId = remoteServer.id
    const servers = getServers()
    let localServer = servers.find(s => s.id === serverId && s.remoteHost === serverHost)

    if (!localServer) {
      localServer = buildFederatedServerRecord(remoteServer, baseUrl, serverHost, req.user)
      servers.push(localServer)
    } else {
      localServer = {
        ...localServer,
        ...buildFederatedServerRecord(remoteServer, baseUrl, serverHost, req.user),
        members: localServer.members || []
      }
      const existingMember = localServer.members?.find(m => m.id === req.user.id)
      if (!existingMember) {
        if (!localServer.members) localServer.members = []
        localServer.members.push({
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
        })
      }
    }

    syncRemoteChannels(serverId, serverHost, remoteServer?.channels || [])

    // Notify the remote host about the join
    try {
      const peer = federationService.getPeerByHost(serverHost)
      await axios.post(`${baseUrl}/api/federation/member-joined`, {
        serverId,
        host: currentHost,
        token: peer ? federationService.generateHandshakeToken(peer.id) : null,
        user: { id: req.user.id, username: req.user.username }
      }, { timeout: 5000 })
    } catch { /* non-critical */ }
    
    await saveServers(servers)
    console.log(`[API] User ${req.user.username} joined cross-host server ${localServer.name} (${serverHost})`)
    res.json(localServer)
  } catch (error) {
    console.error('[API] Cross-host join error:', error)
    res.status(500).json({ error: 'Failed to join server' })
  }
})

router.get('/cross-host/:code/generate-link', authenticateToken, (req, res) => {
  const decoded = parseCrossHostInvite(req.params.code)
  
  if (!decoded || !decoded.key) {
    return res.status(400).json({ error: 'Invalid invite code' })
  }

  const currentHost = config.getHost()
  if (decoded.host !== currentHost) {
    return res.status(403).json({ error: 'Can only generate links for local invites' })
  }

  const invite = inviteService.getInvite(decoded.key)
  if (!invite || invite.serverId !== decoded.serverId) {
    return res.status(404).json({ error: 'Invite not found' })
  }

  const servers = getServers()
  const server = servers.find(s => s.id === invite.serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }
  if (!canCreateInvites(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to use this invite' })
  }

  const linkData = createCrossHostInvite(decoded.serverId, decoded.channelId, currentHost, decoded.key)
  
  res.json({
    code: linkData,
    url: `https://volt.gg/inv/${linkData}`
  })
})

// Auto-peer with a remote host if not already peered
const ensureFederationPeer = async (remoteUrl) => {
  try {
    const parsedUrl = new URL(remoteUrl)
    const remoteHost = federationService.normalizeHost(parsedUrl.host)
    const currentHost = config.getHost()
    if (remoteHost === currentHost) return { local: true }

    const existing = federationService.getPeerByHost(remoteHost)
    if (existing) {
      if (existing.status !== 'connected') {
        try {
          await federationService.sendHeartbeat(existing.id)
        } catch {
          federationService.updatePeer(existing.id, { status: 'error', lastError: 'Heartbeat failed during auto-peer reuse' })
        }
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
      await federationService.sendHandshake(result.peer.id, { autoAccept: true })
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
      const inviteRes = await axios.get(`${baseUrl}/api/invites/${encodeURIComponent(String(code))}`, { timeout: 8000 })
      inviteInfo = inviteRes.data
      const remoteInviteState = getInviteStateError(inviteInfo)
      if (remoteInviteState) {
        return res.status(400).json({ error: remoteInviteState })
      }
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
    const inviteRes = await axios.get(`${baseUrl}/api/invites/${encodeURIComponent(String(code))}`, { timeout: 8000 })
    const inviteStateError = getInviteStateError(inviteRes.data)
    if (inviteStateError) {
      return res.status(400).json({ error: inviteStateError })
    }
    const remoteServer = inviteRes.data?.server?.id
      ? await fetchRemoteServerSnapshot(baseUrl, inviteRes.data.server.id).catch(() => inviteRes.data.server)
      : (inviteRes.data?.server || inviteRes.data)
    const remoteHost = new URL(baseUrl).host

    if (!remoteServer?.id) {
      return res.status(404).json({ error: 'Server not found on remote host' })
    }

    let localServer = servers.find(s => s.id === remoteServer.id && s.remoteHost === remoteHost)
    if (!localServer) {
      localServer = buildFederatedServerRecord(remoteServer, baseUrl, remoteHost, req.user)
      servers.push(localServer)
    } else {
      localServer = {
        ...localServer,
        ...buildFederatedServerRecord(remoteServer, baseUrl, remoteHost, req.user),
        members: localServer.members || []
      }
      const existingMember = localServer.members?.find(m => m.id === req.user.id)
      if (!existingMember) {
        if (!localServer.members) localServer.members = []
        localServer.members.push({
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
        })
      }
    }

    syncRemoteChannels(remoteServer.id, remoteHost, remoteServer?.channels || [])

    await saveServers(servers)
    console.log(`[API] User ${req.user.username} joined federated server ${localServer.name} from ${remoteHost}`)
    res.json(localServer)
  } catch (err) {
    console.error('[API] External join error:', err.message)
    res.status(500).json({ error: 'Failed to join external server' })
  }
})

export default router
