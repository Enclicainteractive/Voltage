import redisService from './redisService.js'

class WebSocketManager {
  constructor() {
    this.connections = new Map()
    this.userSockets = new Map()
    this.serverRooms = new Map()
    this.channelRooms = new Map()
    this.draining = false
    this.drainTimeout = null
    this.useRedis = false
    this.stats = {
      totalConnections: 0,
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransferred: 0
    }
  }

  init() {
    this.useRedis = redisService.isReady()
    if (this.useRedis) {
      this.setupRedisPresence()
    }
    this.startStatsTracking()
  }

  async setupRedisPresence() {
    if (!this.useRedis) return

    await redisService.subscribe('volt:presence', async (message) => {
      if (message.type === 'presence') {
        await this.broadcastToUserSockets(message.userId, 'presence:update', {
          userId: message.userId,
          status: message.status,
          serverId: message.serverId
        })
      }
    })
  }

  startStatsTracking() {
    setInterval(() => {
      this.stats.onlineUsers = this.userSockets.size
      this.stats.totalRooms = this.serverRooms.size + this.channelRooms.size
    }, 10000)
  }

  addConnection(socket) {
    const connId = socket.id
    this.connections.set(connId, {
      socket,
      userId: socket.userId,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      ip: socket.handshake?.address,
      userAgent: socket.handshake?.headers?.['user-agent']
    })

    if (socket.userId) {
      if (!this.userSockets.has(socket.userId)) {
        this.userSockets.set(socket.userId, new Set())
      }
      this.userSockets.get(socket.userId).add(socket.id)
      
      if (this.useRedis) {
        redisService.hset('volt:online_users', socket.userId, {
          connectedAt: Date.now(),
          socketId: socket.id,
          serverId: socket.serverId
        })
      }
    }

    this.stats.totalConnections++

    socket.on('disconnect', () => this.removeConnection(socket))
    socket.onAny(() => {
      const conn = this.connections.get(connId)
      if (conn) conn.lastActivity = Date.now()
    })
  }

  removeConnection(socket) {
    const connId = socket.id
    const conn = this.connections.get(connId)

    if (conn?.userId) {
      const userConns = this.userSockets.get(conn.userId)
      if (userConns) {
        userConns.delete(socket.id)
        if (userConns.size === 0) {
          this.userSockets.delete(conn.userId)
          if (this.useRedis) {
            redisService.hdel('volt:online_users', conn.userId)
          }
        }
      }
    }

    this.connections.delete(connId)
  }

  joinServer(socketId, serverId) {
    const conn = this.connections.get(socketId)
    if (!conn) return false

    const roomKey = `server:${serverId}`
    if (!this.serverRooms.has(roomKey)) {
      this.serverRooms.set(roomKey, new Set())
    }
    this.serverRooms.get(roomKey).add(socketId)
    conn.socket.join(roomKey)
    return true
  }

  leaveServer(socketId, serverId) {
    const conn = this.connections.get(socketId)
    if (!conn) return false

    const roomKey = `server:${serverId}`
    const room = this.serverRooms.get(roomKey)
    if (room) {
      room.delete(socketId)
      if (room.size === 0) {
        this.serverRooms.delete(roomKey)
      }
    }
    conn.socket.leave(roomKey)
    return true
  }

  joinChannel(socketId, channelId) {
    const conn = this.connections.get(socketId)
    if (!conn) return false

    const roomKey = `channel:${channelId}`
    if (!this.channelRooms.has(roomKey)) {
      this.channelRooms.set(roomKey, new Set())
    }
    this.channelRooms.get(roomKey).add(socketId)
    conn.socket.join(roomKey)
    return true
  }

  leaveChannel(socketId, channelId) {
    const conn = this.connections.get(socketId)
    if (!conn) return false

    const roomKey = `channel:${channelId}`
    const room = this.channelRooms.get(roomKey)
    if (room) {
      room.delete(socketId)
      if (room.size === 0) {
        this.channelRooms.delete(roomKey)
      }
    }
    conn.socket.leave(roomKey)
    return true
  }

  async broadcastToChannel(channelId, event, data, excludeSocketId = null) {
    const roomKey = `channel:${channelId}`
    const room = this.channelRooms.get(roomKey)
    
    if (room) {
      for (const socketId of room) {
        if (socketId !== excludeSocketId) {
          const conn = this.connections.get(socketId)
          if (conn) {
            conn.socket.emit(event, data)
            this.stats.messagesSent++
          }
        }
      }
    }

    if (this.useRedis) {
      await redisService.publish('volt:messages', {
        type: 'channel_broadcast',
        channelId,
        event,
        data,
        excludeSocketId
      })
    }
  }

  async broadcastToServer(serverId, event, data, excludeSocketId = null) {
    const roomKey = `server:${serverId}`
    const room = this.serverRooms.get(roomKey)
    
    if (room) {
      for (const socketId of room) {
        if (socketId !== excludeSocketId) {
          const conn = this.connections.get(socketId)
          if (conn) {
            conn.socket.emit(event, data)
            this.stats.messagesSent++
          }
        }
      }
    }

    if (this.useRedis) {
      await redisService.publish('volt:messages', {
        type: 'server_broadcast',
        serverId,
        event,
        data,
        excludeSocketId
      })
    }
  }

  async broadcastToUserSockets(userId, event, data) {
    const userConns = this.userSockets.get(userId)
    
    if (userConns) {
      for (const socketId of userConns) {
        const conn = this.connections.get(socketId)
        if (conn) {
          conn.socket.emit(event, data)
          this.stats.messagesSent++
        }
      }
    }

    if (this.useRedis) {
      await redisService.publish('volt:messages', {
        type: 'user_broadcast',
        userId,
        event,
        data
      })
    }
  }

  broadcastToAll(event, data) {
    for (const conn of this.connections.values()) {
      conn.socket.emit(event, data)
      this.stats.messagesSent++
    }
  }

  startDrain(timeoutMs = 30000) {
    if (this.draining) return
    
    this.draining = true
    console.log('[WebSocket] Starting connection drain...')

    this.drainTimeout = setTimeout(() => {
      console.log('[WebSocket] Drain timeout, forcing close')
      this.forceCloseAll()
    }, timeoutMs)

    this.broadcastToAll('server:draining', {
      message: 'Server is restarting',
      reconnectAfter: 5000
    })
  }

  cancelDrain() {
    if (!this.draining) return

    this.draining = false
    if (this.drainTimeout) {
      clearTimeout(this.drainTimeout)
      this.drainTimeout = null
    }
    console.log('[WebSocket] Drain cancelled')
  }

  completeDrain() {
    if (!this.draining) return

    this.draining = false
    if (this.drainTimeout) {
      clearTimeout(this.drainTimeout)
      this.drainTimeout = null
    }
    console.log('[WebSocket] Drain complete')
  }

  forceCloseAll() {
    for (const conn of this.connections.values()) {
      conn.socket.disconnect(true)
    }
    this.connections.clear()
    this.userSockets.clear()
  }

  getConnectionCount() {
    return this.connections.size
  }

  getUserCount() {
    return this.userSockets.size
  }

  getStats() {
    return {
      ...this.stats,
      connections: this.connections.size,
      uniqueUsers: this.userSockets.size,
      serverRooms: this.serverRooms.size,
      channelRooms: this.channelRooms.size,
      isDraining: this.draining
    }
  }

  getConnectionInfo(socketId) {
    return this.connections.get(socketId)
  }

  getOnlineUsers() {
    return Array.from(this.userSockets.keys())
  }

  async getAllOnlineUsersRedis() {
    if (!this.useRedis) return this.getOnlineUsers()
    return Object.keys(await redisService.hgetall('volt:online_users'))
  }
}

const wsManager = new WebSocketManager()
export default wsManager
