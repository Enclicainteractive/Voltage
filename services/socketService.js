import { v4 as uuidv4 } from 'uuid'
import { addMessage, editMessage, deleteMessage, findChannelById } from '../routes/channelRoutes.js'
import { dmMessageService, dmService, userService, reactionService, channelService, callLogService, blockService } from './dataService.js'
import { e2eService, userKeyService } from './e2eService.js'
import { e2eTrueService } from './e2eTrueService.js'
import { botService } from './botService.js'
import { federationService } from './federationService.js'
import * as crypto from './cryptoService.js'
import config from '../config/config.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json')

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

const onlineUsers = new Map()
const userSockets = new Map()
const botSockets = new Map()   // botId -> socketId
const voiceChannels = new Map()
const voiceChannelUsers = new Map()
const webrtcPeers = new Map()
const voiceHeartbeats = new Map()
const messageTimestamps = new Map()

// DM Call state - must be at module scope so all socket connections share the same state
// Active DM calls: callId -> { callerId, recipientId, conversationId, status, startTime, type }
const activeDMCalls = new Map()
// Pending incoming calls: recipientId -> [{ callId, callerId, callerInfo, conversationId, type, timestamp }]
const pendingIncomingCalls = new Map()
// Call timeout duration (30 seconds)
const CALL_TIMEOUT_MS = 30000

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
// Emoji format conversion for cross-server emoji usage
// Converts :emojiName: to :host|serverId|emojiId|name: for global rendering
// ---------------------------------------------------------------------------
const convertEmojiFormat = (content, serverId) => {
  if (!content || !serverId) return content
  
  // Load server emojis
  const servers = loadData(SERVERS_FILE, [])
  const server = servers.find(s => s.id === serverId)
  if (!server?.emojis?.length) return content
  
  const serverHost = config.getServerHost()
  
  // Match :emojiName: patterns and convert to global format
  // Format: :host|serverId|emojiId|emojiName:
  const emojiPattern = /:([a-zA-Z0-9_]+):/g
  
  return content.replace(emojiPattern, (match, emojiName) => {
    const emoji = server.emojis.find(e => e.name === emojiName)
    if (emoji) {
      // Return global format: :host|serverId|emojiId|name:
      return `:${serverHost}|${serverId}|${emoji.id}|${emojiName}:`
    }
    return match // Return original if not found
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
  // Priority order: self-hosted STUN/TURN first, then reliable public servers
  // 1. volt.voltagechat.app:32768 - self-hosted (if available)
  // 2. Google's STUN servers - reliable and fast
  // 3. Open Relay Project - only reliable free TURN service
  
  const servers = []

  // First: Self-hosted STUN/TURN server (volt.voltagechat.app)
  // This is the primary server for this deployment
  try {
    servers.push({ urls: 'stun:volt.voltagechat.app:32768' })
  } catch (e) {
    // If self-hosted STUN fails, continue with public servers
  }

  // Google's STUN servers - most reliable public STUN
  servers.push(
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  )

  // Additional reliable public STUN servers
  servers.push(
    { urls: 'stun:stun.ekiga.net' },
    { urls: 'stun:stun.xten.com' },
    { urls: 'stun:stun.schlund.de' }
  )

  // Open Relay Project - ONLY reliable free TURN service
  // Supports TURNS + SSL for firewall traversal
  servers.push(
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
    }
  )

  // Self-hosted TURN server overrides the public ones.
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

  console.log(`[Voice/ICE] Configured ${servers.length} ICE servers (${servers.filter(s => s.urls.startsWith('turn')).length} TURN, ${servers.filter(s => s.urls.startsWith('stun')).length} STUN)`)
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
  const mentionRegex = /@([a-zA-Z0-9_]+)/g
  let match
  let count = 0
  const maxMentions = 100

  while ((match = mentionRegex.exec(content)) !== null) {
    if (++count > maxMentions) break
    const username = match[1]
    const nameLower = username.toLowerCase()

    if (nameLower === 'everyone') {
      mentions.everyone = true
    } else if (nameLower === 'here') {
      mentions.here = true
    } else if (username.includes(':')) {
      const [user, host] = username.split(':')
      if (user && host) {
        const federatedId = `@${user}:${host}`
        if (!mentions.federated.includes(federatedId)) {
          mentions.federated.push(federatedId)
        }
        const users = Object.values(userService.getAllUsers() || {})
        const mentionedUser = users.find(u =>
          u.username?.toLowerCase() === user.toLowerCase() &&
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

      // Join bot's unique room for direct notifications
      socket.join(`bot:${bot.id}`)

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

        const channel = channelService.getChannel(channelId)
        const serverId = channel?.serverId
        if (serverId && !bot.servers.includes(serverId)) {
          socket.emit('bot:error', { error: 'Bot not in this server' })
          return
        }

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
        
        const channel = channelService.getChannel(channelId)
        const serverId = channel?.serverId
        if (serverId && !bot.servers.includes(serverId)) {
          socket.emit('bot:error', { error: 'Bot not in this server' })
          return
        }
        
        const participants = voiceChannelUsers.get(channelId) || []
        socket.emit('voice:participants', { channelId, participants })
      })

      socket.on('voice:join', (data) => {
        const { channelId, peerId } = data || {}
        if (!channelId) return

        const channel = channelService.getChannel(channelId)
        const serverId = channel?.serverId
        if (serverId && !bot.servers.includes(serverId)) {
          socket.emit('bot:error', { error: 'Bot not in this server' })
          return
        }

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

        const channel = channelService.getChannel(channelId)
        const serverId = channel?.serverId
        if (serverId && !bot.servers.includes(serverId)) {
          socket.emit('bot:error', { error: 'Bot not in this server' })
          return
        }

        console.log(`[Voice] Bot ${botUserId} leaving channel ${channelId}`)
        cleanupVoiceUser(io, channelId, botUserId, 'bot-leave-event')
        // Remove bot from relay map when it leaves voice
        if (userSockets.get(botUserId) === socket.id) {
          userSockets.delete(botUserId)
        }
      })

      socket.on('voice:offer', (data) => {
        const { to, offer, channelId } = data || {}
        if (channelId) {
          const channel = channelService.getChannel(channelId)
          const serverId = channel?.serverId
          if (serverId && !bot.servers.includes(serverId)) {
            return
          }
        }
        const targetSocket = userSockets.get(to) || botSockets.get(to)
        if (targetSocket) {
          io.to(targetSocket).emit('voice:offer', { from: botUserId, fromUsername: bot.name, offer, channelId })
        }
      })

      socket.on('voice:answer', (data) => {
        const { to, answer, channelId } = data || {}
        if (channelId) {
          const channel = channelService.getChannel(channelId)
          const serverId = channel?.serverId
          if (serverId && !bot.servers.includes(serverId)) {
            return
          }
        }
        const targetSocket = userSockets.get(to) || botSockets.get(to)
        if (targetSocket) {
          io.to(targetSocket).emit('voice:answer', { from: botUserId, answer, channelId })
        }
      })

      socket.on('voice:ice-candidate', (data) => {
        const { to, candidate, channelId } = data || {}
        if (channelId) {
          const channel = channelService.getChannel(channelId)
          const serverId = channel?.serverId
          if (serverId && !bot.servers.includes(serverId)) {
            return
          }
        }
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

      // Listen for bot removal from servers - immediately disconnect from that server
      socket.on('bot:remove-from-server', (data) => {
        const { serverId } = data
        if (!serverId) return
        
        // Reload bot data to get fresh server list
        const freshBot = botService.getBot(bot.id)
        if (!freshBot) {
          socket.disconnect(true)
          return
        }

        // If bot was removed from server, make them leave the server room
        if (!freshBot.servers.includes(serverId)) {
          socket.leave(`server:${serverId}`)
          console.log(`[Socket] Bot ${bot.name} removed from server ${serverId}, left server room`)
        }

        // If bot is not in any servers, disconnect them entirely
        if (freshBot.servers.length === 0) {
          console.log(`[Socket] Bot ${bot.name} not in any servers, disconnecting`)
          socket.emit('bot:kicked', { reason: 'Removed from all servers' })
          socket.disconnect(true)
        }
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
        storage:         storageInfo,
        encrypted: data.encrypted || false,
        iv: data.iv || null,
        epoch: data.epoch || null
      }

      // Convert local emoji references to global format for cross-server compatibility
      const channelServerId = channel?.serverId
      if (channelServerId) {
        message.content = convertEmojiFormat(data.content, channelServerId)
      }

      addMessage(data.channelId, message)
      io.to(`channel:${data.channelId}`).emit('message:new', message)

      // Send notifications for mentions
      sendMentionNotifications(io, socket, data.channelId, message, mentions)

      // Only deliver message to bots that are in THIS specific server
      if (channelServerId) {
        for (const [botId, botSocketId] of botSockets.entries()) {
          const botSocket = io.sockets.sockets.get(botSocketId)
          if (!botSocket) continue
          const bot = botService.getBot(botId)
          if (!bot) continue
          
          // ONLY deliver if bot is actually in this server
          if (bot.servers.includes(channelServerId)) {
            botSocket.emit('message:new', {
              ...message,
              serverId: channelServerId
            })
            // Also deliver via webhook if configured
            botService.deliverWebhookEvent(botId, 'MESSAGE_CREATE', {
              message,
              serverId: channelServerId,
              channelId: data.channelId
            })
          }
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
      const isReconnection = existingIndex >= 0
      
      if (isReconnection) {
        // User is reconnecting - update their info but don't treat as new join
        const existingUser = channelUsers[existingIndex]
        userInfo.muted = existingUser.muted || false
        userInfo.deafened = existingUser.deafened || false
        channelUsers[existingIndex] = userInfo
        console.log(`[Voice] User ${userId} reconnected to channel ${channelId}`)
        
        // Notify others that this user reconnected (not a new join)
        socket.to(`voice:${channelId}`).emit('voice:user-reconnected', {
          ...userInfo,
          isReconnection: true
        })
      } else {
        channelUsers.push(userInfo)
        console.log(`[Voice] Added new user ${userId} to channel`)
        
        // Notify others of new user
        io.to(`voice:${channelId}`).emit('voice:user-joined', userInfo)
      }
      
      markVoiceHeartbeat(userId, channelId)
      
      socket.currentVoiceChannel = channelId
      socket.join(`voice:${channelId}`)

      // Send current participants list to the joining/reconnecting user
      socket.emit('voice:participants', { 
        channelId, 
        participants: voiceChannelUsers.get(channelId),
        iceServers: getIceServers(),
        isReconnection // Let the client know if this is a reconnection
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
      // Update the user's state in the channel
      const users = voiceChannelUsers.get(channelId)
      if (users) {
        const user = users.find(u => u.id === userId)
        if (user) {
          user.isScreenSharing = enabled
        }
      }
      // Broadcast to everyone in the voice channel
      io.to(`voice:${channelId}`).emit('voice:screen-share-update', {
        userId,
        username: socket.user.username,
        enabled
      })
      console.log(`[Voice] User ${userId} ${enabled ? 'started' : 'stopped'} screen sharing in ${channelId}`)
    })

    socket.on('voice:video', (data) => {
      const { channelId, enabled } = data
      // Update the user's state in the channel
      const users = voiceChannelUsers.get(channelId)
      if (users) {
        const user = users.find(u => u.id === userId)
        if (user) {
          user.hasVideo = enabled
        }
      }
      // Broadcast to everyone in the voice channel
      io.to(`voice:${channelId}`).emit('voice:video-update', {
        userId,
        username: socket.user.username,
        enabled
      })
      console.log(`[Voice] User ${userId} ${enabled ? 'enabled' : 'disabled'} video in ${channelId}`)
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
        
        // Only deliver to bots in THIS server
        const channel = channelService.getChannel(channelId)
        const channelServerId = channel?.serverId
        if (channelServerId) {
          for (const [botId, botSocketId] of botSockets.entries()) {
            const botSocket = io.sockets.sockets.get(botSocketId)
            if (!botSocket) continue
            const bot = botService.getBot(botId)
            if (bot?.servers.includes(channelServerId)) {
              botSocket.emit('message:edited', updated)
            }
          }
        }
      }
    })

    // Message deletion via socket
    socket.on('message:delete', (data) => {
      const { messageId, channelId } = data
      const result = deleteMessage(channelId, messageId, userId)
      if (result.success) {
        io.to(`channel:${channelId}`).emit('message:deleted', { messageId, channelId })
        
        // Only deliver to bots in THIS server
        const channel = channelService.getChannel(channelId)
        const channelServerId = channel?.serverId
        if (channelServerId) {
          for (const [botId, botSocketId] of botSockets.entries()) {
            const botSocket = io.sockets.sockets.get(botSocketId)
            if (!botSocket) continue
            const bot = botService.getBot(botId)
            if (bot?.servers.includes(channelServerId)) {
              botSocket.emit('message:deleted', { messageId, channelId })
            }
          }
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

    // -------------------------------------------------------------------------
    // DM CALL handlers
    // 1-on-1 calls using the same WebRTC infrastructure as voice channels
    // (activeDMCalls, pendingIncomingCalls, CALL_TIMEOUT_MS are at module scope)
    // -------------------------------------------------------------------------

    // Helper: get all socket IDs for a user (multi-device support)
    const getUserSocketIds = (userId) => {
      const socketIds = []
      for (const [uid, sid] of userSockets.entries()) {
        if (uid === userId) socketIds.push(sid)
      }
      return socketIds
    }

    // Helper: emit to all devices of a user
    const emitToAllUserDevices = (io, userId, event, data) => {
      // Use the personal room which all sockets join
      io.to(`user:${userId}`).emit(event, data)
    }

    // Helper: clean up pending call
    const cleanupPendingCall = (recipientId, callId) => {
      const pending = pendingIncomingCalls.get(recipientId)
      if (pending) {
        const idx = pending.findIndex(c => c.callId === callId)
        if (idx >= 0) pending.splice(idx, 1)
        if (pending.length === 0) pendingIncomingCalls.delete(recipientId)
      }
    }

    // Helper: end active call and notify both parties
    const endActiveCall = (io, callId, endedBy, reason = 'ended') => {
      const call = activeDMCalls.get(callId)
      if (!call) return null

      const now = new Date().toISOString()
      const duration = Math.floor((Date.now() - new Date(call.startTime).getTime()) / 1000)

      // Determine call status
      const callStatus = reason === 'declined' ? 'declined' : reason === 'missed' ? 'missed' : reason === 'cancelled' ? 'cancelled' : 'ended'

      // Update call log
      callLogService.logCall({
        callId,
        conversationId: call.conversationId,
        callerId: call.callerId,
        recipientId: call.recipientId,
        type: call.type,
        status: callStatus,
        duration,
        endedBy,
        endedAt: now
      })

      // Create a call message in the DM conversation
      const callerInfo = userService.getUser(call.callerId)
      const recipientInfo = userService.getUser(call.recipientId)
      
      // Build call message content based on status
      let callMessageContent = ''
      let callIcon = '📞'
      
      if (callStatus === 'missed') {
        // Missed call - show as missed for caller
        callMessageContent = '📞 Missed call'
        callIcon = '📞'
      } else if (callStatus === 'declined') {
        callMessageContent = '📞 Call declined'
        callIcon = '📞'
      } else if (callStatus === 'cancelled') {
        callMessageContent = '📞 Call cancelled'
        callIcon = '📞'
      } else {
        // Completed call - show duration
        const mins = Math.floor(duration / 60)
        const secs = duration % 60
        const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
        callMessageContent = `📞 Call ended • ${durationStr}`
        callIcon = call.type === 'video' ? '📹' : '📞'
      }

      const callMessage = {
        id: uuidv4(),
        conversationId: call.conversationId,
        userId: call.callerId,
        username: callerInfo?.username || 'Unknown',
        avatar: callerInfo?.avatar || null,
        content: callMessageContent,
        timestamp: now,
        attachments: [],
        system: true,
        callLog: {
          callId,
          type: call.type,
          status: callStatus,
          duration,
          callerId: call.callerId,
          recipientId: call.recipientId,
          endedBy
        }
      }

      // Save call message to DM messages
      dmMessageService.addMessage(call.conversationId, callMessage)
      dmService.updateLastMessage(call.conversationId, call.callerId, call.recipientId)

      // Broadcast call message to DM room
      io.to(`dm:${call.conversationId}`).emit('dm:new', callMessage)

      // Notify both parties
      emitToAllUserDevices(io, call.callerId, 'call:ended', {
        callId,
        endedBy,
        reason,
        duration
      })
      emitToAllUserDevices(io, call.recipientId, 'call:ended', {
        callId,
        endedBy,
        reason,
        duration
      })

      activeDMCalls.delete(callId)
      return call
    }

    // Initiate a call
    socket.on('call:initiate', (data) => {
      const { recipientId, conversationId, type = 'audio' } = data

      // Check if blocked
      if (blockService.isBlocked(userId, recipientId)) {
        socket.emit('call:error', { error: 'Cannot call blocked user' })
        return
      }

      // Check if recipient is online
      if (!isUserOnline(recipientId)) {
        socket.emit('call:error', { error: 'User is offline', code: 'USER_OFFLINE' })
        return
      }

      // Check if there's already an active call between these users
      for (const [callId, call] of activeDMCalls.entries()) {
        if ((call.callerId === userId && call.recipientId === recipientId) ||
            (call.callerId === recipientId && call.recipientId === userId)) {
          socket.emit('call:error', { error: 'Call already in progress', code: 'CALL_IN_PROGRESS' })
          return
        }
      }

      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const callerInfo = {
        id: userId,
        username: socket.user.username || socket.user.email,
        avatar: socket.user.avatar
      }

      // Create call record
      activeDMCalls.set(callId, {
        callerId: userId,
        recipientId,
        conversationId,
        status: 'ringing',
        startTime: new Date().toISOString(),
        type
      })

      // Add to pending calls for recipient
      if (!pendingIncomingCalls.has(recipientId)) {
        pendingIncomingCalls.set(recipientId, [])
      }
      pendingIncomingCalls.get(recipientId).push({
        callId,
        callerId: userId,
        callerInfo,
        conversationId,
        type,
        timestamp: Date.now()
      })

      // Log call start
      callLogService.logCall({
        callId,
        conversationId,
        callerId: userId,
        recipientId,
        type,
        status: 'started'
      })

      // Notify caller that call is ringing
      socket.emit('call:ringing', {
        callId,
        recipientId,
        conversationId,
        type
      })

      // Ring all devices of recipient
      emitToAllUserDevices(io, recipientId, 'call:incoming', {
        callId,
        caller: callerInfo,
        conversationId,
        type,
        iceServers: getIceServers()
      })

      console.log(`[Call] ${userId} -> ${recipientId}: ${type} call initiated (${callId})`)

      // Set timeout for missed call
      setTimeout(() => {
        const call = activeDMCalls.get(callId)
        if (call && call.status === 'ringing') {
          // Call still ringing after timeout = missed
          cleanupPendingCall(recipientId, callId)
          endActiveCall(io, callId, recipientId, 'missed')
          
          // Notify caller of missed call
          emitToAllUserDevices(io, userId, 'call:missed', {
            callId,
            recipientId
          })
          
          console.log(`[Call] ${callId} missed (timeout)`)
        }
      }, CALL_TIMEOUT_MS)
    })

    // Accept incoming call
    socket.on('call:accept', (data) => {
      const { callId } = data
      const call = activeDMCalls.get(callId)

      if (!call) {
        socket.emit('call:error', { error: 'Call not found', code: 'CALL_NOT_FOUND' })
        return
      }

      if (call.recipientId !== userId) {
        socket.emit('call:error', { error: 'Not authorized to accept this call', code: 'UNAUTHORIZED' })
        return
      }

      // Update call status
      call.status = 'active'
      call.acceptedAt = new Date().toISOString()

      // Remove from pending
      cleanupPendingCall(userId, callId)

      // Update call log
      callLogService.logCall({
        callId,
        conversationId: call.conversationId,
        callerId: call.callerId,
        recipientId: call.recipientId,
        type: call.type,
        status: 'accepted'
      })

      // Notify caller that call was accepted
      emitToAllUserDevices(io, call.callerId, 'call:accepted', {
        callId,
        recipientId: userId,
        iceServers: getIceServers()
      })

      // Confirm to acceptor
      socket.emit('call:connected', {
        callId,
        callerId: call.callerId,
        iceServers: getIceServers()
      })

      console.log(`[Call] ${callId} accepted by ${userId}`)
    })

    // Decline incoming call
    socket.on('call:decline', (data) => {
      const { callId } = data
      const call = activeDMCalls.get(callId)

      if (!call) {
        socket.emit('call:error', { error: 'Call not found' })
        return
      }

      if (call.recipientId !== userId) {
        socket.emit('call:error', { error: 'Not authorized' })
        return
      }

      cleanupPendingCall(userId, callId)
      endActiveCall(io, callId, userId, 'declined')

      console.log(`[Call] ${callId} declined by ${userId}`)
    })

    // End active call
    socket.on('call:end', (data) => {
      const { callId } = data
      const call = activeDMCalls.get(callId)

      if (!call) {
        socket.emit('call:error', { error: 'Call not found' })
        return
      }

      if (call.callerId !== userId && call.recipientId !== userId) {
        socket.emit('call:error', { error: 'Not authorized' })
        return
      }

      cleanupPendingCall(call.recipientId, callId)
      endActiveCall(io, callId, userId, 'ended')

      console.log(`[Call] ${callId} ended by ${userId}`)
    })

    // Cancel outgoing call (caller hangs up before answer)
    socket.on('call:cancel', (data) => {
      const { callId } = data
      const call = activeDMCalls.get(callId)

      if (!call) {
        socket.emit('call:error', { error: 'Call not found' })
        return
      }

      if (call.callerId !== userId) {
        socket.emit('call:error', { error: 'Only caller can cancel' })
        return
      }

      cleanupPendingCall(call.recipientId, callId)
      endActiveCall(io, callId, userId, 'cancelled')

      console.log(`[Call] ${callId} cancelled by caller ${userId}`)
    })

    // WebRTC signaling for DM calls
    socket.on('call:offer', (data) => {
      const { callId, to, offer } = data
      const call = activeDMCalls.get(callId)

      if (!call) return
      if (call.callerId !== userId && call.recipientId !== userId) return

      const targetSocket = userSockets.get(to)
      if (targetSocket) {
        io.to(targetSocket).emit('call:offer', {
          from: userId,
          fromUsername: socket.user.username,
          offer,
          callId
        })
      }
    })

    socket.on('call:answer', (data) => {
      const { callId, to, answer } = data
      const call = activeDMCalls.get(callId)

      if (!call) return
      if (call.callerId !== userId && call.recipientId !== userId) return

      const targetSocket = userSockets.get(to)
      if (targetSocket) {
        io.to(targetSocket).emit('call:answer', {
          from: userId,
          answer,
          callId
        })
      }
    })

    socket.on('call:ice-candidate', (data) => {
      const { callId, to, candidate } = data
      const call = activeDMCalls.get(callId)

      if (!call) return
      if (call.callerId !== userId && call.recipientId !== userId) return

      const targetSocket = userSockets.get(to)
      if (targetSocket) {
        io.to(targetSocket).emit('call:ice-candidate', {
          from: userId,
          candidate,
          callId
        })
      }
    })

    // Mute/Deafen during call
    socket.on('call:mute', (data) => {
      const { callId, muted } = data
      const call = activeDMCalls.get(callId)
      if (!call) return
      if (call.callerId !== userId && call.recipientId !== userId) return

      const otherId = call.callerId === userId ? call.recipientId : call.callerId
      emitToAllUserDevices(io, otherId, 'call:user-muted', {
        callId,
        userId,
        muted
      })
    })

    socket.on('call:deafen', (data) => {
      const { callId, deafened } = data
      const call = activeDMCalls.get(callId)
      if (!call) return
      if (call.callerId !== userId && call.recipientId !== userId) return

      const otherId = call.callerId === userId ? call.recipientId : call.callerId
      emitToAllUserDevices(io, otherId, 'call:user-deafened', {
        callId,
        userId,
        deafened
      })
    })

    // Video toggle during call
    socket.on('call:video-toggle', (data) => {
      const { callId, enabled } = data
      const call = activeDMCalls.get(callId)
      if (!call) return
      if (call.callerId !== userId && call.recipientId !== userId) return

      const otherId = call.callerId === userId ? call.recipientId : call.callerId
      emitToAllUserDevices(io, otherId, 'call:video-toggled', {
        callId,
        userId,
        enabled
      })
    })

    // Get call history for a conversation
    socket.on('call:get-history', async (data) => {
      const { conversationId, limit = 20 } = data
      const logs = callLogService.getCallLogs(conversationId, limit)
      socket.emit('call:history', { conversationId, logs })
    })

    // Clean up calls on disconnect
    socket.on('disconnect', () => {
      // End any active calls this user is in
      for (const [callId, call] of activeDMCalls.entries()) {
        if (call.callerId === userId || call.recipientId === userId) {
          cleanupPendingCall(call.recipientId, callId)
          endActiveCall(io, callId, userId, 'disconnected')
        }
      }

      // Remove any pending incoming calls for this user
      pendingIncomingCalls.delete(userId)
    })

    // Reaction handlers
    socket.on('reaction:add', (data) => {
      const { messageId, emoji, channelId } = data
      const reactions = reactionService.addReaction(messageId, userId, emoji)
      const reactionPayload = { messageId, reactions, action: 'add', userId, emoji }
      io.to(`channel:${channelId}`).emit('reaction:updated', reactionPayload)
      
      // Only deliver to bots in THIS server
      const channel = channelService.getChannel(channelId)
      const channelServerId = channel?.serverId
      if (channelServerId) {
        for (const [botId, botSocketId] of botSockets.entries()) {
          const botSocket = io.sockets.sockets.get(botSocketId)
          if (!botSocket) continue
          const bot = botService.getBot(botId)
          if (bot?.servers.includes(channelServerId)) {
            botSocket.emit('reaction:updated', reactionPayload)
          }
        }
      }
    })

    socket.on('reaction:remove', (data) => {
      const { messageId, emoji, channelId } = data
      const reactions = reactionService.removeReaction(messageId, userId, emoji)
      const reactionPayload = { messageId, reactions, action: 'remove', userId, emoji }
      io.to(`channel:${channelId}`).emit('reaction:updated', reactionPayload)
      
      // Only deliver to bots in THIS server
      const channel = channelService.getChannel(channelId)
      const channelServerId = channel?.serverId
      if (channelServerId) {
        for (const [botId, botSocketId] of botSockets.entries()) {
          const botSocket = io.sockets.sockets.get(botSocketId)
          if (!botSocket) continue
          const bot = botService.getBot(botId)
          if (bot?.servers.includes(channelServerId)) {
            botSocket.emit('reaction:updated', reactionPayload)
          }
        }
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

      // Immediately clean up voice channel presence on disconnect
      // This ensures other users don't have to wait for heartbeat timeout
      // when someone's browser crashes or network drops
      if (socket.currentVoiceChannel) {
        const channelId = socket.currentVoiceChannel
        console.log(`[Voice] User ${userId} disconnected from channel ${channelId}, cleaning up immediately`)
        cleanupVoiceUser(io, channelId, userId, 'disconnect')
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
