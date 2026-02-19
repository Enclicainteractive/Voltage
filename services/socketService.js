import { v4 as uuidv4 } from 'uuid'
import { addMessage, editMessage, deleteMessage, findChannelById } from '../routes/channelRoutes.js'
import { dmMessageService, dmService, userService, reactionService } from './dataService.js'
import { e2eService, userKeyService } from './e2eService.js'
import { e2eTrueService } from './e2eTrueService.js'
import { botService } from './botService.js'
import { federationService } from './federationService.js'
import * as crypto from './cryptoService.js'
import config from '../config/config.js'

const onlineUsers = new Map()
const userSockets = new Map()
const botSockets = new Map()   // botId -> socketId
const voiceChannels = new Map()
const voiceChannelUsers = new Map()
const webrtcPeers = new Map()
const voiceHeartbeats = new Map()
const messageTimestamps = new Map()

// Consensus tracking for voice connections
const peerConnectionStates = new Map()  // userId -> { channelId, states: Map<targetPeerId, state>, lastUpdate }
const channelConsensusState = new Map()   // channelId -> { status, lastReconnect, failureCount }
const CONSENSUS_THRESHOLD_PERCENT = 50    // Majority = 50%+ reporting failure
const CONSENSUS_CHECK_INTERVAL_MS = 5000  // Check every 5 seconds
const FORCE_RECONNECT_COOLDOWN_MS = 30000 // Min 30s between force-reconnects
const PEER_STATE_REPORT_TIMEOUT_MS = 10000 // Ignore reports older than 10s
let consensusMonitorStarted = false

const HEARTBEAT_TIMEOUT_MS = 20000
const HEARTBEAT_CHECK_INTERVAL_MS = 5000
let heartbeatMonitorStarted = false

const markVoiceHeartbeat = (userId, channelId) => {
  voiceHeartbeats.set(userId, {
    channelId,
    lastHeartbeat: Date.now()
  })
}

// ---------------------------------------------------------------------------
// ICE server configuration
// Build the list of STUN/TURN servers to send to clients on voice:join.
// Clients should use these for RTCPeerConnection iceServers.
// TURN credentials can be set via environment variables:
//   TURN_URL   e.g. "turn:your-server.com:3478"
//   TURN_USER  username
//   TURN_PASS  credential
// ---------------------------------------------------------------------------
const getIceServers = () => {
  const servers = [
    // STUN — direct P2P when peers are on open networks
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },

    // ── Public TURN relay servers ──────────────────────────────────────────
    // These relay audio when STUN-only ICE fails (symmetric NAT, firewalls).
    // All use hardcoded public credentials — no account or API key needed.

    // Open Relay Project (metered.ca) — widely used public TURN
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turns:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },

    // Numb (viagenie.ca) — long-running free public TURN
    {
      urls: 'turn:numb.viagenie.ca',
      username: 'webrtc@live.com',
      credential: 'muazkh'
    },

    // Xirsys public demo (unauthenticated, best-effort)
    {
      urls: 'turn:global.turn.twilio.com:3478?transport=udp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
  ]

  // Self-hosted TURN server overrides the free public one above.
  // Set TURN_URL, TURN_USER, TURN_PASS env vars or voice config keys.
  const turnUrl  = process.env.TURN_URL  || config.config?.voice?.turnUrl  || null
  const turnUser = process.env.TURN_USER || config.config?.voice?.turnUser || null
  const turnPass = process.env.TURN_PASS || config.config?.voice?.turnPass || null

  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: turnUrl,  username: turnUser, credential: turnPass })
    const turnsUrl = turnUrl.replace(/^turn:/, 'turns:')
    if (turnsUrl !== turnUrl) {
      servers.push({ urls: turnsUrl, username: turnUser, credential: turnPass })
    }
  }

  return servers
}

const clearVoiceHeartbeat = (userId) => {
  voiceHeartbeats.delete(userId)
}

const cleanupVoiceUser = (io, channelId, userId, reason = 'leave') => {
  const channelSet = voiceChannels.get(channelId)
  const users = voiceChannelUsers.get(channelId)
  const hadUser = channelSet?.has(userId) || users?.some(u => u.id === userId)

  if (!hadUser) return false

  channelSet?.delete(userId)

  if (users) {
    const index = users.findIndex(u => u.id === userId)
    if (index >= 0) users.splice(index, 1)
  }

  const socketId = userSockets.get(userId)
  if (socketId) {
    const userSocket = io.sockets.sockets.get(socketId)
    if (userSocket) {
      userSocket.leave(`voice:${channelId}`)
      if (userSocket.currentVoiceChannel === channelId) {
        userSocket.currentVoiceChannel = null
      }
    }
  }

  clearVoiceHeartbeat(userId)

  io.to(`voice:${channelId}`).emit('voice:user-left', { userId, channelId })
  console.log(`[Voice] Cleaned user ${userId} from channel ${channelId} (${reason})`)
  return true
}

const startHeartbeatMonitor = (io) => {
  if (heartbeatMonitorStarted) return
  heartbeatMonitorStarted = true

  setInterval(() => {
    const now = Date.now()
    for (const [userId, hb] of voiceHeartbeats.entries()) {
      if (now - hb.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        cleanupVoiceUser(io, hb.channelId, userId, 'heartbeat-timeout')
      }
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// Consensus monitoring for voice connections
// Tracks peer connection states and triggers force-reconnect when consensus breaks
// ---------------------------------------------------------------------------

const recordPeerState = (reporterId, channelId, targetPeerId, state) => {
  if (!peerConnectionStates.has(reporterId)) {
    peerConnectionStates.set(reporterId, { channelId, states: new Map(), lastUpdate: Date.now() })
  }
  const reporter = peerConnectionStates.get(reporterId)
  reporter.states.set(targetPeerId, { state, timestamp: Date.now() })
  reporter.lastUpdate = Date.now()
}

const cleanupStalePeerStates = () => {
  const now = Date.now()
  for (const [userId, data] of peerConnectionStates.entries()) {
    // Remove stale entries for this reporter
    for (const [targetId, report] of data.states.entries()) {
      if (now - report.timestamp > PEER_STATE_REPORT_TIMEOUT_MS) {
        data.states.delete(targetId)
      }
    }
    // Remove reporter if no valid states
    if (data.states.size === 0) {
      peerConnectionStates.delete(userId)
    }
  }
}

const checkConsensus = (io, channelId) => {
  const users = voiceChannelUsers.get(channelId)
  if (!users || users.length < 2) return

  const now = Date.now()
  const validReporters = []
  const failureCounts = new Map()

  // Collect all valid peer state reports
  for (const user of users) {
    const reporterData = peerConnectionStates.get(user.id)
    if (!reporterData || reporterData.channelId !== channelId) continue
    
    // Check if reporter data is fresh
    if (now - reporterData.lastUpdate > PEER_STATE_REPORT_TIMEOUT_MS) continue
    
    validReporters.push(user.id)
    
    // Count failures reported by this reporter
    for (const [targetId, report] of reporterData.states.entries()) {
      if (report.state === 'failed' || report.state === 'closed' || report.state === 'disconnected') {
        failureCounts.set(targetId, (failureCounts.get(targetId) || 0) + 1)
      }
    }
  }

  if (validReporters.length === 0) return

  const totalReporters = validReporters.length
  const consensusState = channelConsensusState.get(channelId) || { lastReconnect: 0, failureCount: 0 }

  // Check for consensus failure (majority reporting failure for a peer)
  for (const [targetId, failCount] of failureCounts.entries()) {
    const failurePercent = (failCount / totalReporters) * 100
    
    if (failurePercent >= CONSENSUS_THRESHOLD_PERCENT) {
      // Check cooldown
      if (now - consensusState.lastReconnect < FORCE_RECONNECT_COOLDOWN_MS) {
        console.log(`[Voice/Consensus] ${targetId} has ${failurePercent.toFixed(1)}% failures in ${channelId}, but on cooldown`)
        return
      }

      console.log(`[Voice/Consensus] BREAKDOWN: ${targetId} has ${failurePercent.toFixed(1)}% failures (${failCount}/${totalReporters}) in ${channelId}`)
      
      // Update consensus state
      consensusState.lastReconnect = now
      consensusState.failureCount = (consensusState.failureCount || 0) + 1
      channelConsensusState.set(channelId, consensusState)

      // Broadcast force-reconnect to ALL peers in the channel
      io.to(`voice:${channelId}`).emit('voice:force-reconnect', {
        channelId,
        reason: 'consensus-broken',
        targetPeer: targetId,
        failurePercent: Math.round(failurePercent),
        failedPeers: failCount,
        totalPeers: totalReporters,
        timestamp: now
      })

      console.log(`[Voice/Consensus] Force-reconnect broadcast to voice:${channelId} for ${targetId}`)
      
      // Clear the problematic peer's state reports to allow fresh start
      for (const [reporterId, data] of peerConnectionStates.entries()) {
        if (data.channelId === channelId) {
          data.states.delete(targetId)
        }
      }
      
      // Only trigger one force-reconnect per check
      break
    }
  }
}

const startConsensusMonitor = (io) => {
  if (consensusMonitorStarted) return
  consensusMonitorStarted = true

  setInterval(() => {
    cleanupStalePeerStates()
    
    // Check consensus for each active voice channel
    for (const [channelId, users] of voiceChannelUsers.entries()) {
      if (users && users.length >= 2) {
        checkConsensus(io, channelId)
      }
    }
  }, CONSENSUS_CHECK_INTERVAL_MS)
}

export const getVoiceChannelUsers = (channelId) => {
  return voiceChannelUsers.get(channelId) || []
}

export const getOnlineUserIds = () => {
  return Array.from(onlineUsers.keys())
}

export const isUserOnline = (userId) => {
  return onlineUsers.has(userId)
}

export const emitToUser = (io, userId, event, data) => {
  const socketId = userSockets.get(userId)
  if (socketId) {
    io.to(socketId).emit(event, data)
    return true
  }
  return false
}

const isChannelAgeRestricted = (channelId) => {
  const channel = findChannelById(channelId)
  return !!channel?.nsfw
}

// Parse mentions from message content
// Supports: @everyone, @here, @username, @username:host (federated)
const parseMentions = (content) => {
  const mentions = { users: [], usernames: [], federated: [], everyone: false, here: false }
  // Match @username or @username:host — colon separates username from host in federated format
  const mentionRegex = /@([a-zA-Z0-9_\-\.]+)(?::([a-zA-Z0-9_\-\.]+))?/g
  let match

  while ((match = mentionRegex.exec(content)) !== null) {
    const username = match[1]
    const host = match[2] || null  // host part after colon, null for local mentions
    const nameLower = username.toLowerCase()

    if (nameLower === 'everyone') {
      mentions.everyone = true
    } else if (nameLower === 'here') {
      mentions.here = true
    } else if (host) {
      // Federated mention: @username:host
      // Record for federation relay; try to find a local shadow user too
      const federatedId = `@${username}:${host}`
      if (!mentions.federated.includes(federatedId)) {
        mentions.federated.push(federatedId)
      }
      // Also try to resolve locally (remote user may be cached)
      const users = Object.values(userService.getAllUsers() || {})
      const mentionedUser = users.find(u =>
        u.username?.toLowerCase() === nameLower &&
        (u.host === host || u.federatedHost === host)
      )
      if (mentionedUser) {
        if (!mentions.users.includes(mentionedUser.id)) {
          mentions.users.push(mentionedUser.id)
        }
        if (!mentions.usernames.includes(mentionedUser.username || username)) {
          mentions.usernames.push(mentionedUser.username || username)
        }
      }
    } else {
      // Local mention: @username
      const users = Object.values(userService.getAllUsers() || {})
      const mentionedUser = users.find(u => 
        u.username?.toLowerCase() === nameLower || 
        u.email?.toLowerCase().startsWith(nameLower)
      )
      if (mentionedUser) {
        if (!mentions.users.includes(mentionedUser.id)) {
          mentions.users.push(mentionedUser.id)
        }
        if (!mentions.usernames.includes(mentionedUser.username || username)) {
          mentions.usernames.push(mentionedUser.username || username)
        }
      }
    }
  }

  return mentions
}

// Send notification events for mentions
const sendMentionNotifications = (io, senderSocket, channelId, message, mentions) => {
  const serverId = senderSocket.currentServer
  const notifyPayloadBase = {
    channelId,
    messageId: message.id,
    senderId: message.userId,
    senderName: message.username,
    content: message.content.slice(0, 100)
  }

  // @everyone — notify ALL server members (not just those in the channel room)
  if (mentions.everyone) {
    const serverRoom = serverId ? (io.sockets.adapter.rooms.get(`server:${serverId}`) || new Set()) : new Set()
    // Fall back to channel room if no server room
    const targetRoom = serverRoom.size > 0 ? serverRoom : (io.sockets.adapter.rooms.get(`channel:${channelId}`) || new Set())
    const notified = new Set()

    targetRoom.forEach(socketId => {
      const s = io.sockets.sockets.get(socketId)
      if (s && s.user.id !== message.userId && !notified.has(s.user.id)) {
        s.emit('notification:mention', { type: 'everyone', ...notifyPayloadBase })
        notified.add(s.user.id)
      }
    })
    return // @everyone supersedes other mention types
  }

  // @here — notify ONLINE server members
  if (mentions.here) {
    const serverRoom = serverId ? (io.sockets.adapter.rooms.get(`server:${serverId}`) || new Set()) : new Set()
    const targetRoom = serverRoom.size > 0 ? serverRoom : (io.sockets.adapter.rooms.get(`channel:${channelId}`) || new Set())
    const notified = new Set()

    targetRoom.forEach(socketId => {
      const s = io.sockets.sockets.get(socketId)
      // Skip bot sockets — they have no .user property
      if (s && s.user?.id && s.user.id !== message.userId && onlineUsers.has(s.user.id) && !notified.has(s.user.id)) {
        s.emit('notification:mention', { type: 'here', ...notifyPayloadBase })
        notified.add(s.user.id)
      }
    })
  }

  // @username — notify the specific user via their personal room (works whether online or offline reconnect)
  mentions.users.forEach(targetUserId => {
    if (targetUserId === message.userId) return

    // Emit via personal room — this reaches the user wherever they are (any channel/server view)
    io.to(`user:${targetUserId}`).emit('notification:mention', {
      type: 'user',
      ...notifyPayloadBase,
      offline: !onlineUsers.has(targetUserId)
    })
  })

  // Federated mentions: @username:host — relay notification to the peer server
  if (mentions.federated && mentions.federated.length > 0) {
    const localHost = config.getHost()
    mentions.federated.forEach(federatedId => {
      // federatedId format: @username:host
      const colonIdx = federatedId.indexOf(':')
      if (colonIdx === -1) return
      const targetUsername = federatedId.slice(1, colonIdx) // strip leading @
      const targetHost = federatedId.slice(colonIdx + 1)
      // Don't relay to ourselves
      if (targetHost === localHost) return
      // Find the peer for this host
      const peer = federationService.getPeerByHost?.(targetHost)
      if (!peer || peer.status !== 'connected') return
      // Queue a relay event to the peer server for the mention notification
      federationService.queueRelayMessage?.(peer.id, {
        type: 'mention:relay',
        payload: {
          targetUsername,
          targetHost,
          federatedId,
          channelId,
          messageId: message.id,
          senderId: message.userId,
          senderName: message.username,
          senderHost: localHost,
          content: message.content.slice(0, 100),
          timestamp: message.timestamp
        }
      })
    })
  }
}

export const setupSocketHandlers = (io) => {
  startHeartbeatMonitor(io)
  startConsensusMonitor(io)

  io.on('connection', (socket) => {
    // -------------------------------------------------------------------------
    // BOT connection path
    // -------------------------------------------------------------------------
    if (socket.botId) {
      const bot = botService.getBot(socket.botId)
      if (!bot) {
        socket.disconnect(true)
        return
      }

      botService.setBotStatus(bot.id, 'online')
      botSockets.set(bot.id, socket.id)

      for (const serverId of bot.servers) {
        socket.join(`server:${serverId}`)
      }

      socket.emit('bot:ready', {
        botId:   bot.id,
        name:    bot.name,
        servers: bot.servers
      })

      // Broadcast the bot's online presence with any persisted customStatus
      io.emit('user:status', {
        userId:       bot.id,
        status:       'online',
        customStatus: bot.customStatus ?? null,
        isBot:        true
      })

      console.log(`[Socket] Bot ready: ${bot.name} (${bot.id}), servers: ${bot.servers.length}`)

      // Allow the bot to send messages via socket (used by Wire's REST fallback)
      socket.on('bot:send-message', (data) => {
        if (!botService.hasPermission(bot.id, 'messages:send')) return
        const { channelId, content, embeds } = data
        const cdnConfig = config.getCdnConfig()
        const message = {
          id: uuidv4(),
          channelId,
          userId: bot.id,
          username: bot.name,
          avatar: bot.avatar,
          content: content || '',
          embeds: embeds || [],
          bot: true,
          timestamp: new Date().toISOString(),
          attachments: [],
          storage: {
            cdn: cdnConfig?.enabled ? cdnConfig.provider : 'local',
            storageNode: config.getHost(),
            serverUrl: config.getServerUrl()
          }
        }
        addMessage(channelId, message)
        io.to(`channel:${channelId}`).emit('message:new', message)
      })

      // -----------------------------------------------------------------------
      // BOT voice handlers — bots need to join/leave voice channels and
      // participate in WebRTC signalling just like users.  Because bots are
      // registered in botSockets (not userSockets) we register the handlers
      // here explicitly so the bot socket can act as a voice peer.
      // -----------------------------------------------------------------------

      const botUserId = bot.id

      socket.on('voice:get-participants', (data) => {
        const { channelId } = data || {}
        if (!channelId) return
        const participants = voiceChannelUsers.get(channelId) || []
        socket.emit('voice:participants', { channelId, participants })
      })

      socket.on('voice:join', (data) => {
        const { channelId, peerId } = data || {}
        if (!channelId) return

        console.log(`[Voice] Bot ${botUserId} joining channel ${channelId}`)

        // Leave any previous channel first
        if (socket.currentVoiceChannel && socket.currentVoiceChannel !== channelId) {
          cleanupVoiceUser(io, socket.currentVoiceChannel, botUserId, 'bot-switch-channel')
        }

        if (!voiceChannels.has(channelId)) {
          voiceChannels.set(channelId, new Set())
          voiceChannelUsers.set(channelId, [])
        }

        voiceChannels.get(channelId).add(botUserId)

        const botInfo = {
          id: botUserId,
          username: bot.name,
          avatar: bot.avatar || null,
          peerId,
          channelId,
          bot: true,
          muted: false,
          deafened: false
        }

        const channelUsers = voiceChannelUsers.get(channelId)
        const existingIndex = channelUsers.findIndex(u => u.id === botUserId)
        if (existingIndex >= 0) {
          channelUsers[existingIndex] = botInfo
          console.log(`[Voice] Updated existing bot ${botUserId} in channel`)
        } else {
          channelUsers.push(botInfo)
          console.log(`[Voice] Added bot ${botUserId} to channel`)
        }

        markVoiceHeartbeat(botUserId, channelId)

        socket.currentVoiceChannel = channelId
        socket.join(`voice:${channelId}`)

        // Register bot socket so WebRTC relay can reach it
        userSockets.set(botUserId, socket.id)

        io.to(`voice:${channelId}`).emit('voice:user-joined', botInfo)

        socket.emit('voice:participants', {
          channelId,
          participants: voiceChannelUsers.get(channelId),
          iceServers: getIceServers()
        })
      })

      socket.on('voice:heartbeat', (data = {}) => {
        const { channelId } = data
        if (!channelId) return
        const users = voiceChannelUsers.get(channelId)
        if (users?.some(u => u.id === botUserId)) {
          markVoiceHeartbeat(botUserId, channelId)
        }
      })

      socket.on('voice:leave', (channelId) => {
        if (!channelId) return
        console.log(`[Voice] Bot ${botUserId} leaving channel ${channelId}`)
        cleanupVoiceUser(io, channelId, botUserId, 'bot-leave-event')
        // Remove bot from relay map when it leaves voice
        if (userSockets.get(botUserId) === socket.id) {
          userSockets.delete(botUserId)
        }
      })

      socket.on('voice:offer', (data) => {
        const { to, offer, channelId } = data || {}
        const targetSocket = userSockets.get(to) || botSockets.get(to)
        if (targetSocket) {
          io.to(targetSocket).emit('voice:offer', { from: botUserId, fromUsername: bot.name, offer, channelId })
        }
      })

      socket.on('voice:answer', (data) => {
        const { to, answer, channelId } = data || {}
        const targetSocket = userSockets.get(to) || botSockets.get(to)
        if (targetSocket) {
          io.to(targetSocket).emit('voice:answer', { from: botUserId, answer, channelId })
        }
      })

      socket.on('voice:ice-candidate', (data) => {
        const { to, candidate, channelId } = data || {}
        const targetSocket = userSockets.get(to) || botSockets.get(to)
        if (targetSocket) {
          io.to(targetSocket).emit('voice:ice-candidate', { from: botUserId, candidate, channelId })
        }
      })

      // Wire can emit this to update status + customStatus instantly via the
      // already-open WebSocket without a REST round-trip.
      socket.on('bot:status-change', (data = {}) => {
        const { status, customStatus } = data
        const newStatus = status || 'online'
        botService.setBotStatus(bot.id, newStatus, customStatus)
        io.emit('user:status', {
          userId:       bot.id,
          status:       newStatus,
          customStatus: customStatus ?? null,
          isBot:        true
        })
      })

      socket.on('disconnect', () => {
        botService.setBotStatus(bot.id, 'offline')
        botSockets.delete(bot.id)
        // Clean up voice presence if the bot was in a channel
        if (socket.currentVoiceChannel) {
          cleanupVoiceUser(io, socket.currentVoiceChannel, botUserId, 'bot-disconnect')
        }
        // Clean up relay entry
        if (userSockets.get(botUserId) === socket.id) {
          userSockets.delete(botUserId)
        }
        // Broadcast offline so sidebars update immediately
        io.emit('user:status', {
          userId:       bot.id,
          status:       'offline',
          customStatus: null,
          isBot:        true
        })
        console.log(`[Socket] Bot disconnected: ${bot.name} (${bot.id})`)
      })

      return
    }

    // -------------------------------------------------------------------------
    // USER connection path
    // -------------------------------------------------------------------------
    const userId = socket.user.id
     console.log(`User connected: ${userId}`)

    // Join user's personal room for mentions/notifications
    socket.join(`user:${userId}`)

    // Clean up stale voice channel data from previous session, but keep recent heartbeats
    for (const [channelId, users] of voiceChannelUsers.entries()) {
      const userIndex = users.findIndex(u => u.id === userId)
      if (userIndex >= 0) {
        const heartbeat = voiceHeartbeats.get(userId)
        const isStale = !heartbeat || heartbeat.channelId !== channelId || (Date.now() - heartbeat.lastHeartbeat > HEARTBEAT_TIMEOUT_MS)
        if (isStale) {
          cleanupVoiceUser(io, channelId, userId, 'stale-on-connect')
        } else {
          console.log(`[Voice] Preserving user ${userId} in channel ${channelId} (recent heartbeat)`)        
        }
      }
    }

    onlineUsers.set(userId, {
      id: userId,
      username: socket.user.username || socket.user.email,
      avatar: socket.user.avatar,
      status: 'online',
      connectedAt: new Date()
    })

    userSockets.set(userId, socket.id)

    // Load the user's persisted customStatus so it is included in the
    // on-connect broadcast (allows other clients to show it immediately).
    const persistedUser = userService.getUser(userId)
    const persistedCustomStatus = persistedUser?.customStatus || null

    // Also restore the user's last known status preference if not 'offline'
    const persistedStatus = persistedUser?.status && persistedUser.status !== 'offline'
      ? persistedUser.status
      : 'online'

    // Update the in-memory entry with the persisted values
    onlineUsers.get(userId).status = persistedStatus
    if (persistedCustomStatus) onlineUsers.get(userId).customStatus = persistedCustomStatus

    socket.emit('connected', { userId, socketId: socket.id })
    io.emit('user:status', {
      userId,
      status: persistedStatus,
      customStatus: persistedCustomStatus
    })

    socket.on('server:join', (serverId) => {
      socket.join(`server:${serverId}`)
      socket.currentServer = serverId
    })

    socket.on('channel:join', (channelId) => {
      if (socket.currentChannel) {
        socket.leave(`channel:${socket.currentChannel}`)
      }
      socket.join(`channel:${channelId}`)
      socket.currentChannel = channelId
    })

    socket.on('message:send', (data) => {
      if (isChannelAgeRestricted(data.channelId) && !userService.isAgeVerified(userId)) {
        socket.emit('message:error', { channelId: data.channelId, code: 'AGE_VERIFICATION_REQUIRED', error: 'Age verification required for this channel' })
        return
      }

      const channel = findChannelById(data.channelId)
      const slowMode = channel?.slowMode || 0
      
      if (slowMode > 0) {
        const key = `${userId}:${data.channelId}`
        const lastMessageTime = messageTimestamps.get(key) || 0
        const now = Date.now()
        const timeSinceLastMessage = now - lastMessageTime
        
        if (timeSinceLastMessage < slowMode * 1000) {
          const remainingTime = Math.ceil((slowMode * 1000 - timeSinceLastMessage) / 1000)
          socket.emit('message:error', { 
            channelId: data.channelId, 
            code: 'SLOWMODE', 
            error: `Slowmode is active. You can send another message in ${remainingTime} seconds.` 
          })
          return
        }
        
        messageTimestamps.set(key, now)
      }

      // Parse mentions from content
      const mentions = parseMentions(data.content)

      // Build CDN/storage metadata for the message
      const cdnConfig = config.getCdnConfig()
      const storageInfo = {
        cdn: cdnConfig?.enabled ? cdnConfig.provider : 'local',
        storageNode: config.getHost(),
        serverUrl: config.getServerUrl()
      }

      const message = {
        id: uuidv4(),
        channelId: data.channelId,
        userId: userId,
        username: socket.user.username || socket.user.email,
        avatar: socket.user.avatar,
        content: data.content,
        mentions: mentions,
        timestamp: new Date().toISOString(),
        attachments: data.attachments || [],
        storage: storageInfo,
        encrypted: data.encrypted || false,
        iv: data.iv || null,
        epoch: data.epoch || null
      }

      addMessage(data.channelId, message)
      io.to(`channel:${data.channelId}`).emit('message:new', message)

      // Send notifications for mentions
      sendMentionNotifications(io, socket, data.channelId, message, mentions)

      // Deliver message:new to all connected bots in every server the channel belongs to
      const allServers = socket.currentServer
        ? [socket.currentServer]
        : []
      // Also check all servers this channel might belong to via bot server memberships
      const checkedBots = new Set()
      for (const [botId, botSocketId] of botSockets.entries()) {
        if (checkedBots.has(botId)) continue
        const botSocket = io.sockets.sockets.get(botSocketId)
        if (!botSocket) continue
        const bot = botService.getBot(botId)
        if (!bot) continue
        // Deliver if the bot is in any server that contains this channel
        const botInServer = allServers.some(sid => bot.servers.includes(sid))
          || bot.servers.some(sid => botSocket.rooms.has(`server:${sid}`))
        if (botInServer) {
          checkedBots.add(botId)
          botSocket.emit('message:new', {
            ...message,
            serverId: socket.currentServer || null
          })
          // Also deliver via webhook if configured
          botService.deliverWebhookEvent(botId, 'MESSAGE_CREATE', {
            message,
            serverId: socket.currentServer,
            channelId: data.channelId
          })
        }
      }
    })

    socket.on('message:typing', (data) => {
      socket.to(`channel:${data.channelId}`).emit('user:typing', {
        userId,
        username: socket.user.username || socket.user.email,
        channelId: data.channelId
      })
    })

      socket.on('voice:get-participants', (data) => {
        const { channelId } = data
        const participants = voiceChannelUsers.get(channelId) || []
        socket.emit('voice:participants', { channelId, participants, iceServers: getIceServers() })
      })

    socket.on('voice:join', (data) => {
      const { channelId, peerId } = data
      
      console.log(`[Voice] User ${userId} joining channel ${channelId}`)
      
      // If user was in a different voice channel, leave it first
      if (socket.currentVoiceChannel && socket.currentVoiceChannel !== channelId) {
        cleanupVoiceUser(io, socket.currentVoiceChannel, userId, 'switch-channel')
      }
      
      if (!voiceChannels.has(channelId)) {
        voiceChannels.set(channelId, new Set())
        voiceChannelUsers.set(channelId, [])
      }
      
      voiceChannels.get(channelId).add(userId)
      
      const userInfo = {
        id: userId,
        username: socket.user.username || socket.user.email,
        avatar: socket.user.avatar,
        peerId,
        channelId,   // include channelId so clients know which channel this join is for
        muted: false,
        deafened: false
      }
      
      const channelUsers = voiceChannelUsers.get(channelId)
      const existingIndex = channelUsers.findIndex(u => u.id === userId)
      if (existingIndex >= 0) {
        // User already exists, update their info
        channelUsers[existingIndex] = userInfo
        console.log(`[Voice] Updated existing user ${userId} in channel`)
      } else {
        channelUsers.push(userInfo)
        console.log(`[Voice] Added new user ${userId} to channel`)
      }
      
      markVoiceHeartbeat(userId, channelId)
      
      socket.currentVoiceChannel = channelId
      socket.join(`voice:${channelId}`)
      
      io.to(`voice:${channelId}`).emit('voice:user-joined', userInfo)

      socket.emit('voice:participants', { 
        channelId, 
        participants: voiceChannelUsers.get(channelId),
        iceServers: getIceServers()
      })
    })

    socket.on('voice:heartbeat', (data = {}) => {
      const { channelId } = data
      if (!channelId) return
      const users = voiceChannelUsers.get(channelId)
      if (users?.some(u => u.id === userId)) {
        markVoiceHeartbeat(userId, channelId)
      }
    })

    socket.on('voice:signal', (data) => {
      const targetSocket = userSockets.get(data.to) || botSockets.get(data.to)
      if (targetSocket) {
        io.to(targetSocket).emit('voice:signal', {
          from: userId,
          fromUsername: socket.user.username,
          signal: data.signal,
          type: data.type
        })
      }
    })

    socket.on('voice:offer', (data) => {
      const { to, offer, channelId } = data
      console.log(`[Voice] Received voice:offer from ${userId} to ${to}`)
      const targetSocket = userSockets.get(to) || botSockets.get(to)
      if (targetSocket) {
        io.to(targetSocket).emit('voice:offer', {
          from: userId,
          fromUsername: socket.user.username,
          offer,
          channelId
        })
      } else {
        console.log(`[Voice] Target socket not found for user/bot ${to}`)
      }
    })

    socket.on('voice:answer', (data) => {
      const { to, answer, channelId } = data
      console.log(`[Voice] Received voice:answer from ${userId} to ${to}`)
      const targetSocket = userSockets.get(to) || botSockets.get(to)
      if (targetSocket) {
        io.to(targetSocket).emit('voice:answer', {
          from: userId,
          answer,
          channelId
        })
      }
    })

    socket.on('voice:ice-candidate', (data) => {
      const { to, candidate, channelId } = data
      console.log(`[Voice] Received voice:ice-candidate from ${userId} to ${to}`)
      const targetSocket = userSockets.get(to) || botSockets.get(to)
      if (targetSocket) {
        io.to(targetSocket).emit('voice:ice-candidate', {
          from: userId,
          candidate,
          channelId
        })
      }
    })

    socket.on('voice:screen-share', (data) => {
      const { channelId, enabled } = data
      io.to(`voice:${channelId}`).emit('voice:screen-share-update', {
        userId,
        username: socket.user.username,
        enabled
      })
    })

    socket.on('voice:mute', (data) => {
      const { channelId, muted } = data
      const users = voiceChannelUsers.get(channelId)
      if (users) {
        const user = users.find(u => u.id === userId)
        if (user) {
          user.muted = muted
          io.to(`voice:${channelId}`).emit('voice:user-updated', { userId, muted })
        }
      }
    })

    socket.on('voice:deafen', (data) => {
      const { channelId, deafened } = data
      const users = voiceChannelUsers.get(channelId)
      if (users) {
        const user = users.find(u => u.id === userId)
        if (user) {
          user.deafened = deafened
          io.to(`voice:${channelId}`).emit('voice:user-updated', { userId, deafened })
        }
      }
    })

    // Peer state reporting for consensus monitoring
    socket.on('voice:peer-state-report', (data) => {
      const { channelId, targetPeerId, state, timestamp } = data
      if (!channelId || !targetPeerId || !state) return
      
      // Verify user is in this channel
      const users = voiceChannelUsers.get(channelId)
      if (!users || !users.find(u => u.id === userId)) return
      
      recordPeerState(userId, channelId, targetPeerId, state)
    })

    socket.on('voice:leave', (channelId) => {
      console.log(`[Voice] User ${userId} leaving channel ${channelId}`)
      
      if (!channelId) return
      if (!cleanupVoiceUser(io, channelId, userId, 'leave-event')) {
        console.log(`[Voice] Channel ${channelId} not found in voiceChannels`)
      }
    })

    socket.on('status:change', (data) => {
      const { status, customStatus } = typeof data === 'string' ? { status: data } : data
      const user = onlineUsers.get(userId)
      if (user) {
        user.status = status
        if (customStatus !== undefined) user.customStatus = customStatus
        userService.setStatus(userId, status, customStatus)
        io.emit('user:status', { userId, status, customStatus })
      }
    })

    // Message editing via socket
    socket.on('message:edit', (data) => {
      const { messageId, channelId, content } = data
      const updated = editMessage(channelId, messageId, userId, content)
      if (updated) {
        io.to(`channel:${channelId}`).emit('message:edited', updated)
        // Deliver to connected bots
        for (const [botId, botSocketId] of botSockets.entries()) {
          const botSocket = io.sockets.sockets.get(botSocketId)
          if (botSocket) botSocket.emit('message:edited', updated)
        }
      }
    })

    // Message deletion via socket
    socket.on('message:delete', (data) => {
      const { messageId, channelId } = data
      const result = deleteMessage(channelId, messageId, userId)
      if (result.success) {
        io.to(`channel:${channelId}`).emit('message:deleted', { messageId, channelId })
        // Deliver to connected bots
        for (const [botId, botSocketId] of botSockets.entries()) {
          const botSocket = io.sockets.sockets.get(botSocketId)
          if (botSocket) botSocket.emit('message:deleted', { messageId, channelId })
        }
      }
    })

    // DM handlers
    socket.on('dm:join', (conversationId) => {
      if (socket.currentDM) {
        socket.leave(`dm:${socket.currentDM}`)
      }
      socket.join(`dm:${conversationId}`)
      socket.currentDM = conversationId
    })

    socket.on('dm:send', (data) => {
      const { conversationId, content, recipientId } = data
      
      const cdnConfig = config.getCdnConfig()
      const storageInfo = {
        cdn: cdnConfig?.enabled ? cdnConfig.provider : 'local',
        storageNode: config.getHost(),
        serverUrl: config.getServerUrl()
      }

      const message = {
        id: uuidv4(),
        conversationId,
        userId: userId,
        username: socket.user.username || socket.user.email,
        avatar: socket.user.avatar,
        content,
        timestamp: new Date().toISOString(),
        attachments: data.attachments || [],
        storage: storageInfo,
        encrypted: data.encrypted || false,
        iv: data.iv || null,
        epoch: data.epoch || null
      }

      dmMessageService.addMessage(conversationId, message)
      dmService.updateLastMessage(conversationId, userId, recipientId)
      
      io.to(`dm:${conversationId}`).emit('dm:new', message)
      
      const recipientSocket = userSockets.get(recipientId)
      if (recipientSocket) {
        io.to(recipientSocket).emit('dm:notification', {
          conversationId,
          message,
          from: {
            id: userId,
            username: socket.user.username,
            avatar: socket.user.avatar
          }
        })
      }
    })

    socket.on('dm:typing', (data) => {
      socket.to(`dm:${data.conversationId}`).emit('dm:typing', {
        userId,
        username: socket.user.username || socket.user.email,
        conversationId: data.conversationId
      })
    })

    // Reaction handlers
    socket.on('reaction:add', (data) => {
      const { messageId, emoji, channelId } = data
      const reactions = reactionService.addReaction(messageId, userId, emoji)
      const reactionPayload = { messageId, reactions, action: 'add', userId, emoji }
      io.to(`channel:${channelId}`).emit('reaction:updated', reactionPayload)
      for (const [botId, botSocketId] of botSockets.entries()) {
        const botSocket = io.sockets.sockets.get(botSocketId)
        if (botSocket) botSocket.emit('reaction:updated', reactionPayload)
      }
    })

    socket.on('reaction:remove', (data) => {
      const { messageId, emoji, channelId } = data
      const reactions = reactionService.removeReaction(messageId, userId, emoji)
      const reactionPayload = { messageId, reactions, action: 'remove', userId, emoji }
      io.to(`channel:${channelId}`).emit('reaction:updated', reactionPayload)
      for (const [botId, botSocketId] of botSockets.entries()) {
        const botSocket = io.sockets.sockets.get(botSocketId)
        if (botSocket) botSocket.emit('reaction:updated', reactionPayload)
      }
    })

    // Pinned message handlers
    socket.on('message:pin', (data) => {
      const { messageId, channelId } = data
      io.to(`channel:${channelId}`).emit('message:pinned', { messageId, channelId, pinnedBy: userId })
    })

    socket.on('message:unpin', (data) => {
      const { messageId, channelId } = data
      io.to(`channel:${channelId}`).emit('message:unpinned', { messageId, channelId })
    })

    // Friend request notification
    socket.on('friend:request', (data) => {
      const { toUserId } = data
      const targetSocket = userSockets.get(toUserId)
      if (targetSocket) {
        io.to(targetSocket).emit('friend:request:received', {
          from: {
            id: userId,
            username: socket.user.username,
            avatar: socket.user.avatar
          }
        })
      }
    })

    // Server update handlers - emit to all users in the server
    socket.on('server:update', (data) => {
      const { serverId, server } = data
      io.to(`server:${serverId}`).emit('server:updated', server)
    })

    socket.on('channel:create', (data) => {
      const { serverId, channel } = data
      io.to(`server:${serverId}`).emit('channel:created', channel)
    })

    socket.on('channel:update', (data) => {
      const { serverId, channel } = data
      io.to(`server:${serverId}`).emit('channel:updated', channel)
    })

    socket.on('channel:delete', (data) => {
      const { serverId, channelId } = data
      io.to(`server:${serverId}`).emit('channel:deleted', { channelId })
    })

    socket.on('channel:order', (data) => {
      const { serverId, channels } = data
      io.to(`server:${serverId}`).emit('channel:order-updated', channels)
    })

    socket.on('role:create', (data) => {
      const { serverId, role } = data
      io.to(`server:${serverId}`).emit('role:created', role)
    })

    socket.on('role:update', (data) => {
      const { serverId, role } = data
      io.to(`server:${serverId}`).emit('role:updated', role)
    })

    socket.on('role:delete', (data) => {
      const { serverId, roleId } = data
      io.to(`server:${serverId}`).emit('role:deleted', { roleId })
    })

    // E2E Encryption handlers
    socket.on('e2e:get-server-status', (serverId) => {
      const keys = e2eService.getServerKeys(serverId)
      socket.emit('e2e:server-status', {
        serverId,
        enabled: keys?.enabled || false,
        keyId: keys?.keyId || null
      })
    })

    socket.on('e2e:join-server', async (serverId) => {
      if (!e2eService.isEncryptionEnabled(serverId)) {
        socket.emit('e2e:not-enabled', { serverId })
        return
      }

      const userKeys = userKeyService.getUserKeys(userId)
      if (!userKeys?.privateKey) {
        socket.emit('e2e:no-keys', { serverId })
        return
      }

      const symmetricKey = e2eService.getSymmetricKey(serverId)
      if (!symmetricKey) {
        socket.emit('e2e:error', { serverId, error: 'Server keys not found' })
        return
      }

      try {
        const encryptedKey = crypto.encryptKeyForUser(symmetricKey, userKeys.publicKey)
        e2eService.setMemberEncryptedKey(serverId, userId, encryptedKey)

        socket.emit('e2e:joined', {
          serverId,
          keyId: e2eService.getServerKeys(serverId)?.keyId
        })

        io.to(`server:${serverId}`).emit('e2e:member-joined', {
          serverId,
          userId,
          publicKey: userKeys.publicKey
        })
      } catch (err) {
        console.error('[E2E] Error joining server encryption:', err)
        socket.emit('e2e:error', { serverId, error: 'Failed to join encryption' })
      }
    })

    socket.on('e2e:request-member-keys', (serverId) => {
      if (!e2eService.isEncryptionEnabled(serverId)) {
        return
      }

      const serverKeys = e2eService.getServerKeys(serverId)
      const memberKeys = serverKeys?.memberKeys || {}

      const keysToShare = Object.entries(memberKeys)
        .filter(([id]) => id !== userId)
        .map(([id, data]) => ({
          userId: id,
          encryptedKey: data.encryptedKey
        }))

      socket.emit('e2e:member-keys', {
        serverId,
        keys: keysToShare
      })
    })

    socket.on('e2e:get-my-encrypted-key', (serverId) => {
      if (!e2eService.isEncryptionEnabled(serverId)) {
        return
      }

      const serverKeys = e2eService.getServerKeys(serverId)
      const memberKeys = serverKeys?.memberKeys || {}
      const userEncryptedKey = memberKeys[userId]

      if (userEncryptedKey) {
        socket.emit('e2e:my-encrypted-key', {
          serverId,
          keyId: serverKeys?.keyId,
          encryptedKey: userEncryptedKey.encryptedKey
        })
      }
    })

    // === True E2EE handlers ===

    socket.on('e2e-true:register-device', (data) => {
      const { deviceId, identityPublicKey, signedPreKey, signedPreKeySignature, oneTimePreKeys } = data
      if (!deviceId || !identityPublicKey || !signedPreKey) return

      e2eTrueService.uploadDeviceKeyBundle(userId, deviceId, {
        identityPublicKey, signedPreKey, signedPreKeySignature,
        oneTimePreKeys: oneTimePreKeys || []
      })

      socket.deviceId = deviceId
      socket.emit('e2e-true:device-registered', { deviceId })
    })

    socket.on('e2e-true:request-device-keys', (data) => {
      const { targetUserId, targetDeviceId } = data
      const bundle = e2eTrueService.getDeviceKeyBundle(targetUserId, targetDeviceId)
      socket.emit('e2e-true:device-keys', { targetUserId, targetDeviceId, bundle })
    })

    socket.on('e2e-true:distribute-sender-key', (data) => {
      const { groupId, epoch, toUserId, toDeviceId, encryptedKeyBlob } = data
      if (!groupId || !epoch || !toUserId || !toDeviceId || !encryptedKeyBlob) return

      e2eTrueService.storeEncryptedSenderKey(
        groupId, epoch, userId, socket.deviceId || 'default',
        toUserId, toDeviceId, encryptedKeyBlob
      )

      e2eTrueService.queueKeyUpdate(toUserId, toDeviceId, {
        groupId, epoch, encryptedKeyBlob,
        fromUserId: userId, fromDeviceId: socket.deviceId || 'default'
      })

      emitToUser(io, toUserId, 'e2e-true:sender-key-available', {
        groupId, epoch, fromUserId: userId
      })
    })

    socket.on('e2e-true:fetch-queued-updates', (data) => {
      const deviceId = data?.deviceId || socket.deviceId || 'default'
      const keyUpdates = e2eTrueService.dequeueKeyUpdates(userId, deviceId)
      const messages = e2eTrueService.dequeueEncryptedMessages(userId, deviceId)
      socket.emit('e2e-true:queued-updates', { keyUpdates, messages })
    })

    socket.on('e2e-true:advance-epoch', (data) => {
      const { groupId, reason } = data
      if (!groupId) return
      const epoch = e2eTrueService.advanceEpoch(groupId, reason || 'manual', userId)
      if (epoch) {
        io.to(`server:${groupId}`).emit('e2e-true:epoch-advanced', {
          groupId, epoch: epoch.epoch, reason, triggeredBy: userId
        })
      }
    })

    socket.on('e2e:leave-server', (serverId) => {
      e2eService.removeMemberKey(serverId, userId)
      io.to(`server:${serverId}`).emit('e2e:member-left', {
        serverId,
        userId
      })
    })

    socket.on('disconnect', (reason) => {
      console.log(`User disconnected: ${userId}, reason: ${reason}`)

      // Do not force immediate leave; rely on heartbeat timeout to clean stale voice users
      if (socket.currentVoiceChannel) {
        markVoiceHeartbeat(userId, socket.currentVoiceChannel)
      }
      
      // Leave all rooms
      if (socket.currentServer) {
        socket.leave(`server:${socket.currentServer}`)
      }
      if (socket.currentChannel) {
        socket.leave(`channel:${socket.currentChannel}`)
      }
      if (socket.currentDM) {
        socket.leave(`dm:${socket.currentDM}`)
      }
      
      // Remove from online tracking
      onlineUsers.delete(userId)
      userSockets.delete(userId)
      
      // Broadcast offline status to all clients
      io.emit('user:status', { 
        userId, 
        status: 'offline',
        disconnectedAt: new Date().toISOString()
      })

      // Notify server members
      if (socket.currentServer) {
        io.to(`server:${socket.currentServer}`).emit('member:offline', {
          userId,
          username: socket.user.username || socket.user.email
        })
      }
    })
  })
}

export const getOnlineUsers = () => {
  return Array.from(onlineUsers.values())
}

export const getUserSocket = (userId) => {
  return userSockets.get(userId)
}
