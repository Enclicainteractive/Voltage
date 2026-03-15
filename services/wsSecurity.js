import crypto from 'crypto'
import { securityManager } from '../middleware/securityMiddleware.js'
import securityLogger from './securityLogger.js'

class WebSocketSecurity {
  constructor() {
    this.connections = new Map()
    this.messageQueues = new Map()
    this.pingIntervals = new Map()
    this.maxConnectionsPerUser = 5
    this.maxMessageSize = 64 * 1024
    this.messageRateLimit = 100
    this.connectionTimeouts = new Map()
    this.pingIntervalMs = 25000     // Send a ping every 25s
    this.pingTimeoutMs = 90000      // Allow 90s without a pong before disconnecting
    this.missedPongsLimit = 3       // Disconnect after 3 missed pongs
  }

  validateConnection(socket, next) {
    const ip = socket.handshake.address || 'unknown'
    const userId = socket.userId

    if (securityManager.isBlacklisted(ip)) {
      securityLogger.logBlockedIP(ip, 'websocket_connection')
      return next(new Error('Connection rejected'))
    }

    if (userId) {
      const userConnections = Array.from(this.connections.values()).filter(
        c => c.userId === userId
      ).length

      if (userConnections >= this.maxConnectionsPerUser) {
        console.log(`[WS Security] User ${userId} exceeded connection limit`)
        return next(new Error('Too many connections'))
      }
    }

    const connId = crypto.randomBytes(16).toString('hex')
    socket.connId = connId

    this.connections.set(connId, {
      socket,
      ip,
      userId,
      connectedAt: Date.now(),
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      lastActivity: Date.now(),
      lastPong: Date.now(),
      missedPongs: 0,
    })

    this.startPing(socket, connId)

    socket.onAny(() => {
      const conn = this.connections.get(connId)
      if (conn) {
        conn.lastActivity = Date.now()
      }
    })

    // Listen for pong responses from the client
    socket.on('ws:pong', () => {
      const conn = this.connections.get(connId)
      if (conn) {
        conn.lastPong = Date.now()
        conn.missedPongs = 0
        conn.lastActivity = Date.now()
      }
    })

    socket.on('disconnect', () => {
      this.removeConnection(connId)
    })

    securityLogger.logSecurityEvent('WEBSOCKET_CONNECT', {
      ip,
      userId,
      connId,
    })

    next()
  }

  startPing(socket, connId) {
    const interval = setInterval(() => {
      if (!socket.connected) {
        clearInterval(interval)
        return
      }

      const conn = this.connections.get(connId)
      if (!conn) {
        clearInterval(interval)
        return
      }

      // Check if the client has gone completely silent (no pong AND no activity)
      const timeSinceLastPong = Date.now() - conn.lastPong
      if (timeSinceLastPong > this.pingTimeoutMs) {
        conn.missedPongs++
        if (conn.missedPongs >= this.missedPongsLimit) {
          console.log(`[WS Security] Connection unresponsive (${conn.missedPongs} missed pongs, last pong ${Math.round(timeSinceLastPong / 1000)}s ago), disconnecting ${connId}`)
          socket.disconnect(true)
          return
        }
      }

      // Send a ping to the client — the client should respond with ws:pong
      try {
        socket.emit('ws:ping', { ts: Date.now() })
      } catch {
        // Socket may have been destroyed between the check and the emit
      }
    }, this.pingIntervalMs)

    this.pingIntervals.set(connId, interval)
  }

  removeConnection(connId) {
    const conn = this.connections.get(connId)
    if (conn) {
      securityLogger.logSecurityEvent('WEBSOCKET_DISCONNECT', {
        ip: conn.ip,
        userId: conn.userId,
        connId,
        duration: Date.now() - conn.connectedAt,
        messagesReceived: conn.messagesReceived,
        messagesSent: conn.messagesSent,
      })

      this.connections.delete(connId)
    }

    const interval = this.pingIntervals.get(connId)
    if (interval) {
      clearInterval(interval)
      this.pingIntervals.delete(connId)
    }
  }

  validateMessage(socket, event, data) {
    const connId = socket.connId
    const conn = this.connections.get(connId)

    if (!conn) return false

    const now = Date.now()
    const windowMs = 60000

    const key = `${connId}:rate`
    let rateData = this.messageQueues.get(key) || { count: 0, resetTime: now + windowMs }

    if (now > rateData.resetTime) {
      rateData.count = 0
      rateData.resetTime = now + windowMs
    }

    rateData.count++
    this.messageQueues.set(key, rateData)

    if (rateData.count > this.messageRateLimit) {
      console.log(`[WS Security] Rate limit exceeded for ${connId}`)
      socket.emit('error', { message: 'Rate limit exceeded' })
      return false
    }

    const messageSize = JSON.stringify(data).length
    if (messageSize > this.maxMessageSize) {
      console.log(`[WS Security] Message too large for ${connId}: ${messageSize} bytes`)
      return false
    }

    conn.messagesReceived++
    conn.bytesReceived += messageSize
    conn.lastActivity = now

    return true
  }

  sanitizeEventData(data) {
    if (typeof data === 'string') {
      return data
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
    }

    if (typeof data === 'object' && data !== null) {
      const sanitized = {}
      for (const [key, value] of Object.entries(data)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue
        }
        sanitized[key] = this.sanitizeEventData(value)
      }
      return sanitized
    }

    return data
  }

  getConnectionStats() {
    const stats = {
      totalConnections: this.connections.size,
      uniqueUsers: new Set(Array.from(this.connections.values()).map(c => c.userId).filter(Boolean)).size,
      totalMessagesReceived: 0,
      totalBytesReceived: 0,
    }

    for (const conn of this.connections.values()) {
      stats.totalMessagesReceived += conn.messagesReceived
      stats.totalBytesReceived += conn.bytesReceived
    }

    return stats
  }

  disconnectUser(userId) {
    const disconnected = []
    for (const [connId, conn] of this.connections) {
      if (conn.userId === userId) {
        conn.socket.disconnect(true)
        disconnected.push(connId)
      }
    }
    return disconnected
  }

  disconnectIP(ip) {
    const disconnected = []
    for (const [connId, conn] of this.connections) {
      if (conn.ip === ip) {
        conn.socket.disconnect(true)
        disconnected.push(connId)
      }
    }
    return disconnected
  }

  getConnectionByUserId(userId) {
    return Array.from(this.connections.values()).filter(c => c.userId === userId)
  }

  broadcastToAdmins(event, data) {
    for (const conn of this.connections.values()) {
      if (conn.socket.isAdmin) {
        conn.socket.emit(event, data)
      }
    }
  }
}

const wsSecurity = new WebSocketSecurity()

setInterval(() => {
  for (const [key, data] of wsSecurity.messageQueues) {
    if (Date.now() > data.resetTime) {
      wsSecurity.messageQueues.delete(key)
    }
  }
}, 60000)

export default wsSecurity
