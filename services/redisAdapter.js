const { Adapter } = require('socket.io-adapter')
const Redis = require('redis')

const ALLOWED_REDIS_PROTOCOLS = new Set(['redis:', 'rediss:'])

const safeErrorMessage = (error) => {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

const isPrivateRedisHost = (rawHost) => {
  const host = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  if (host.startsWith('127.')) return true
  if (host.startsWith('10.')) return true
  if (host.startsWith('192.168.')) return true
  if (host.startsWith('169.254.')) return true
  if (host.startsWith('172.')) {
    const second = Number.parseInt(host.split('.')[1], 10)
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  return false
}

const parseRedisUrl = (url) => {
  try {
    const parsed = new URL(url)
    if (!ALLOWED_REDIS_PROTOCOLS.has(parsed.protocol)) return null
    return parsed
  } catch {
    return null
  }
}

const formatHostForRedisUrl = (rawHost) => {
  const host = String(rawHost || '').trim()
  if (!host) return 'localhost'
  if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) return `[${host}]`
  return host
}

const buildRedisUrlFromConfig = (redisConfig = {}) => {
  const host = formatHostForRedisUrl(redisConfig.host || 'localhost')
  const port = Number.parseInt(redisConfig.port, 10)
  const db = Number.parseInt(redisConfig.db, 10)
  const password = redisConfig.password ? String(redisConfig.password) : ''
  const protocol = redisConfig.tls === true || redisConfig.ssl === true ? 'rediss' : 'redis'
  const safePort = Number.isFinite(port) && port > 0 ? port : 6379
  const safeDb = Number.isFinite(db) && db >= 0 ? db : 0
  const authSegment = password ? `:${encodeURIComponent(password)}@` : ''
  return `${protocol}://${authSegment}${host}:${safePort}/${safeDb}`
}

const applyPasswordToRedisUrl = (url, rawPassword) => {
  const password = rawPassword ? String(rawPassword) : ''
  if (!password) return url
  const parsed = parseRedisUrl(url)
  if (!parsed || parsed.password) return url
  parsed.password = password
  return parsed.toString()
}

const resolveRedisConnectionInfo = (url, fallbackHost = 'localhost') => {
  const parsed = parseRedisUrl(url)
  if (!parsed) return null
  return {
    url: parsed.toString(),
    host: parsed.hostname || fallbackHost,
    protocol: parsed.protocol,
    password: parsed.password || ''
  }
}

class RedisAdapter extends Adapter {
  constructor(nsp, redisConfig = {}) {
    super(nsp)
    
    this.redisConfig = {
      host: redisConfig.host || process.env.REDIS_HOST || 'localhost',
      port: redisConfig.port || process.env.REDIS_PORT || 6379,
      password: redisConfig.password || process.env.REDIS_PASSWORD,
      db: redisConfig.db || process.env.REDIS_DB || 0,
      tls: redisConfig.tls === true || redisConfig.ssl === true || process.env.REDIS_TLS === 'true',
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      ...redisConfig
    }

    this.nodeId = redisConfig.nodeId || `socket-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.prefix = redisConfig.prefix || 'socket.io'
    this.redisClient = null
    this.redisSubscriber = null
    this.initialized = false
  }

  async init() {
    try {
      const environmentPassword = process.env.REDIS_PASSWORD
      let url = process.env.REDIS_URL || buildRedisUrlFromConfig(this.redisConfig)
      url = applyPasswordToRedisUrl(url, environmentPassword || this.redisConfig.password)

      const connectionInfo = resolveRedisConnectionInfo(url, this.redisConfig.host || 'localhost')
      if (!connectionInfo) {
        throw new Error('REDIS_URL must use redis:// or rediss:// and be a valid URL')
      }

      const allowInsecureRedis = process.env.ALLOW_INSECURE_REDIS === 'true'
      const hasPassword = Boolean(connectionInfo.password) || Boolean(environmentPassword) || Boolean(this.redisConfig.password)
      if (process.env.NODE_ENV === 'production' && !allowInsecureRedis && !hasPassword) {
        throw new Error(
          `Refusing insecure production connection: host=${connectionInfo.host}, password=missing`
        )
      }

      if (
        process.env.NODE_ENV === 'production' &&
        !allowInsecureRedis &&
        !isPrivateRedisHost(connectionInfo.host) &&
        connectionInfo.protocol !== 'rediss:'
      ) {
        throw new Error(
          `Refusing insecure production connection: host=${connectionInfo.host}, tls=disabled`
        )
      }

      const clientOptions = {
        ...this.redisConfig,
        url: connectionInfo.url
      }

      // Create Redis clients
      this.redisClient = Redis.createClient(clientOptions)
      this.redisSubscriber = this.redisClient.duplicate()

      // Connect to Redis
      await Promise.all([
        this.redisClient.connect(),
        this.redisSubscriber.connect()
      ])

      // Set up subscriptions
      await this.setupSubscriptions()

      this.initialized = true
      console.log(`[RedisAdapter] Initialized for node ${this.nodeId}`)
    } catch (error) {
      console.error('[RedisAdapter] Failed to initialize:', safeErrorMessage(error))
      throw error
    }
  }

  async setupSubscriptions() {
    // Subscribe to all channels for this namespace
    const channels = [
      `${this.prefix}#${this.nsp.name}#`,
      `${this.prefix}#${this.nsp.name}#*`
    ]

    for (const channel of channels) {
      await this.redisSubscriber.pSubscribe(channel)
    }

    // Handle incoming messages
    this.redisSubscriber.on('pmessage', (pattern, channel, message) => {
      this.onMessage(channel, message)
    })
  }

  onMessage(channel, message) {
    try {
      const data = JSON.parse(message)
      
      // Ignore messages from this node
      if (data.nodeId === this.nodeId) return

      // Extract room and event info from channel
      const parts = channel.split('#')
      if (parts.length < 3) return

      const room = parts[2]
      
      this.broadcast(data.packet, {
        rooms: data.opts?.rooms || new Set([room]),
        except: data.opts?.except || new Set(),
        flags: data.opts?.flags || {}
      })
    } catch (error) {
      console.error('[RedisAdapter] Error processing message:', safeErrorMessage(error))
    }
  }

  broadcast(packet, opts = {}) {
    const rooms = opts.rooms || new Set()
    const except = opts.except || new Set()

    // Broadcast locally first
    super.broadcast(packet, opts)

    // Then broadcast to other nodes via Redis
    this.publishToRedis(packet, opts)
  }

  async publishToRedis(packet, opts) {
    if (!this.initialized) return

    try {
      const message = JSON.stringify({
        nodeId: this.nodeId,
        packet,
        opts: {
          rooms: Array.from(opts.rooms || new Set()),
          except: Array.from(opts.except || new Set()),
          flags: opts.flags || {}
        },
        timestamp: Date.now()
      })

      // Publish to all rooms
      for (const room of (opts.rooms || new Set())) {
        const channel = `${this.prefix}#${this.nsp.name}#${room}`
        await this.redisClient.publish(channel, message)
      }

      // If no specific rooms, broadcast to all
      if (!opts.rooms || opts.rooms.size === 0) {
        const channel = `${this.prefix}#${this.nsp.name}#`
        await this.redisClient.publish(channel, message)
      }
    } catch (error) {
      console.error('[RedisAdapter] Error publishing to Redis:', safeErrorMessage(error))
    }
  }

  addAll(id, rooms) {
    super.addAll(id, rooms)
    
    // Notify other nodes about room joins
    this.notifyRoomChange(id, 'join', Array.from(rooms))
  }

  del(id, room) {
    super.del(id, room)
    
    // Notify other nodes about room leave
    this.notifyRoomChange(id, 'leave', [room])
  }

  delAll(id) {
    const rooms = this.sids.get(id)
    super.delAll(id)
    
    // Notify other nodes about disconnect
    if (rooms) {
      this.notifyRoomChange(id, 'disconnect', Array.from(rooms))
    }
  }

  async notifyRoomChange(socketId, action, rooms) {
    if (!this.initialized) return

    try {
      const message = JSON.stringify({
        nodeId: this.nodeId,
        type: 'room-change',
        socketId,
        action,
        rooms,
        timestamp: Date.now()
      })

      const channel = `${this.prefix}#${this.nsp.name}#room-changes`
      await this.redisClient.publish(channel, message)
    } catch (error) {
      console.error('[RedisAdapter] Error notifying room change:', safeErrorMessage(error))
    }
  }

  // Custom methods for cluster coordination

  async getSocketsInRoom(room) {
    if (!this.initialized) {
      return super.sockets(new Set([room]))
    }

    try {
      // Get local sockets
      const localSockets = super.sockets(new Set([room]))

      // Get remote sockets from Redis
      const key = `${this.prefix}:rooms:${this.nsp.name}:${room}`
      const remoteSockets = await this.redisClient.sMembers(key) || []

      // Combine and deduplicate
      const allSockets = new Set([...localSockets, ...remoteSockets])
      return allSockets
    } catch (error) {
      console.error('[RedisAdapter] Error getting sockets in room:', safeErrorMessage(error))
      return super.sockets(new Set([room]))
    }
  }

  async getRoomsForSocket(socketId) {
    if (!this.initialized) {
      return this.sids.get(socketId) || new Set()
    }

    try {
      // Get local rooms
      const localRooms = this.sids.get(socketId) || new Set()

      // Get remote rooms from Redis
      const key = `${this.prefix}:sockets:${this.nsp.name}:${socketId}`
      const remoteRooms = await this.redisClient.sMembers(key) || []

      // Combine
      const allRooms = new Set([...localRooms, ...remoteRooms])
      return allRooms
    } catch (error) {
      console.error('[RedisAdapter] Error getting rooms for socket:', safeErrorMessage(error))
      return this.sids.get(socketId) || new Set()
    }
  }

  async getClusterStats() {
    if (!this.initialized) {
      return {
        nodes: 1,
        totalSockets: this.sids.size,
        totalRooms: this.rooms.size
      }
    }

    try {
      const stats = {
        nodeId: this.nodeId,
        localSockets: this.sids.size,
        localRooms: this.rooms.size,
        timestamp: Date.now()
      }

      // Store our stats
      const key = `${this.prefix}:stats:${this.nodeId}`
      await this.redisClient.setEx(key, 60, JSON.stringify(stats))

      // Get all node stats
      const keys = await this.redisClient.keys(`${this.prefix}:stats:*`)
      const allStats = []

      for (const key of keys) {
        try {
          const data = await this.redisClient.get(key)
          if (data) {
            allStats.push(JSON.parse(data))
          }
        } catch (e) {
          // Skip invalid stats
        }
      }

      return {
        nodes: allStats.length,
        totalSockets: allStats.reduce((sum, s) => sum + s.localSockets, 0),
        totalRooms: allStats.reduce((sum, s) => sum + s.localRooms, 0),
        nodeStats: allStats
      }
    } catch (error) {
      console.error('[RedisAdapter] Error getting cluster stats:', safeErrorMessage(error))
      return {
        nodes: 1,
        totalSockets: this.sids.size,
        totalRooms: this.rooms.size
      }
    }
  }

  async broadcastToAllNodes(event, data) {
    if (!this.initialized) return

    try {
      const message = JSON.stringify({
        nodeId: this.nodeId,
        type: 'cluster-broadcast',
        event,
        data,
        timestamp: Date.now()
      })

      const channel = `${this.prefix}#${this.nsp.name}#cluster`
      await this.redisClient.publish(channel, message)
    } catch (error) {
      console.error('[RedisAdapter] Error broadcasting to all nodes:', safeErrorMessage(error))
    }
  }

  async fetchSockets(opts = {}) {
    // This method should return socket instances from all nodes
    // For now, return local sockets only
    const localSockets = await super.fetchSockets(opts)
    
    // In a full implementation, we would query other nodes
    // and aggregate their socket information
    return localSockets
  }

  async serverSideEmit(packet, opts = {}) {
    // Emit to all server instances
    if (!this.initialized) return

    try {
      const message = JSON.stringify({
        nodeId: this.nodeId,
        type: 'server-side-emit',
        packet,
        opts,
        timestamp: Date.now()
      })

      const channel = `${this.prefix}#server-side`
      await this.redisClient.publish(channel, message)
    } catch (error) {
      console.error('[RedisAdapter] Error in serverSideEmit:', safeErrorMessage(error))
    }
  }

  async close() {
    try {
      if (this.redisClient) {
        await this.redisClient.disconnect()
      }
      if (this.redisSubscriber) {
        await this.redisSubscriber.disconnect()
      }
      console.log(`[RedisAdapter] Closed for node ${this.nodeId}`)
    } catch (error) {
      console.error('[RedisAdapter] Error during close:', safeErrorMessage(error))
    }
  }
}

// Factory function to create adapter
function createRedisAdapter(redisConfig = {}) {
  return function(nsp) {
    return new RedisAdapter(nsp, redisConfig)
  }
}

module.exports = { RedisAdapter, createRedisAdapter }
