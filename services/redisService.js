import { createClient } from 'redis'

const ALLOWED_REDIS_PROTOCOLS = new Set(['redis:', 'rediss:'])

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
  // common internal DNS labels
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

class RedisService {
  constructor() {
    this.client = null
    this.subscriber = null
    this.publisher = null
    this.isConnected = false
    this.subscribers = new Map()
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 10
  }

  async connect() {
    const config = await import('../config/config.js')
    const cfg = config.default
    
    const redisConfig = cfg.config.cache?.redis || cfg.config.queue?.redis || cfg.config.storage?.redis || {}

    const environmentPassword = process.env.REDIS_PASSWORD
    let url = process.env.REDIS_URL || buildRedisUrlFromConfig(redisConfig)
    if (!process.env.REDIS_URL && redisConfig.password) {
      url = buildRedisUrlFromConfig(redisConfig)
    }
    url = applyPasswordToRedisUrl(url, environmentPassword || redisConfig.password)

    const connectionInfo = resolveRedisConnectionInfo(url, redisConfig.host || 'localhost')
    if (!connectionInfo) {
      console.error(
        '[Redis] Refusing to connect: REDIS_URL must use redis:// or rediss:// and be a valid URL'
      )
      return false
    }

    const resolvedRedisHost = connectionInfo.host
    const hasPassword = Boolean(redisConfig.password) || Boolean(environmentPassword) || Boolean(connectionInfo.password)
    const isRemoteHost = !isPrivateRedisHost(resolvedRedisHost)
    const allowInsecureRedis = process.env.ALLOW_INSECURE_REDIS === 'true'
    if (
      process.env.NODE_ENV === 'production' &&
      !allowInsecureRedis &&
      !hasPassword
    ) {
      console.error(
        `[Redis] Refusing insecure production connection: host=${resolvedRedisHost}, password=missing. ` +
        'Set ALLOW_INSECURE_REDIS=true only for temporary emergency bypass.'
      )
      return false
    }

    if (
      process.env.NODE_ENV === 'production' &&
      !allowInsecureRedis &&
      isRemoteHost &&
      connectionInfo.protocol !== 'rediss:'
    ) {
      console.error(
        `[Redis] Refusing insecure production connection: host=${resolvedRedisHost}, tls=disabled. ` +
        'Use a rediss:// URL for remote Redis hosts or set ALLOW_INSECURE_REDIS=true only for temporary emergency bypass.'
      )
      return false
    }

    const clientOptions = {
      url: connectionInfo.url,
      socket: {
        reconnectStrategy: (retries) => {
          this.reconnectAttempts = retries
          if (retries > this.maxReconnectAttempts) {
            console.error('[Redis] Max reconnection attempts reached')
            return new Error('Max reconnection attempts reached')
          }
          console.log(`[Redis] Reconnecting... attempt ${retries}`)
          return Math.min(retries * 100, 3000)
        },
        connectTimeout: 10000,
        keepAlive: 30000
      },
      legacyMode: false
    }

    try {
      this.client = createClient(clientOptions)
      this.subscriber = this.client.duplicate()
      this.publisher = this.client.duplicate()

      this.client.on('error', (err) => console.error('[Redis Client Error]', err.message))
      this.subscriber.on('error', (err) => console.error('[Redis Subscriber Error]', err.message))
      this.publisher.on('error', (err) => console.error('[Redis Publisher Error]', err.message))

      await Promise.all([
        this.client.connect(),
        this.subscriber.connect(),
        this.publisher.connect()
      ])

      this.isConnected = true
      this.reconnectAttempts = 0
      console.log('[Redis] Connected successfully')
      return true
    } catch (err) {
      console.error('[Redis] Connection failed:', err.message)
      return false
    }
  }

  isReady() {
    return this.isConnected && this.client?.isOpen
  }

  async publish(channel, message) {
    if (!this.isReady()) {
      console.warn('[Redis] Publisher not ready, queuing message')
      return false
    }
    try {
      await this.publisher.publish(channel, JSON.stringify(message))
      return true
    } catch (err) {
      console.error('[Redis] Publish error:', err.message)
      return false
    }
  }

  async subscribe(channel, callback) {
    if (!this.isReady()) {
      console.warn('[Redis] Subscriber not ready')
      return false
    }
    try {
      await this.subscriber.subscribe(channel, (message) => {
        try {
          callback(JSON.parse(message))
        } catch (e) {
          callback(message)
        }
      })
      this.subscribers.set(channel, callback)
      return true
    } catch (err) {
      console.error('[Redis] Subscribe error:', err.message)
      return false
    }
  }

  async unsubscribe(channel) {
    if (!this.isReady()) return
    try {
      await this.subscriber.unsubscribe(channel)
      this.subscribers.delete(channel)
    } catch (err) {
      console.error('[Redis] Unsubscribe error:', err.message)
    }
  }

  // Helper to serialize values, handling BigInt and other special types
  serialize(value) {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (typeof value === 'bigint') return String(value)
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) {
      return JSON.stringify(value.map(item => this.serialize(item)))
    }
    if (typeof value === 'object') {
      const serialized = {}
      for (const [k, v] of Object.entries(value)) {
        serialized[k] = this.serialize(v)
      }
      return JSON.stringify(serialized)
    }
    return JSON.stringify(value)
  }

  async set(key, value, ttlSeconds = 0) {
    if (!this.isReady()) return false
    try {
      const serialized = typeof value === 'string' ? value : this.serialize(value)
      if (ttlSeconds > 0) {
        await this.client.setEx(key, ttlSeconds, serialized)
      } else {
        await this.client.set(key, serialized)
      }
      return true
    } catch (err) {
      console.error('[Redis] Set error:', err.message)
      return false
    }
  }

  async get(key) {
    if (!this.isReady()) return null
    try {
      const value = await this.client.get(key)
      if (!value) return null
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    } catch (err) {
      console.error('[Redis] Get error:', err.message)
      return null
    }
  }

  async del(key) {
    if (!this.isReady()) return false
    try {
      await this.client.del(key)
      return true
    } catch (err) {
      console.error('[Redis] Del error:', err.message)
      return false
    }
  }

  async incr(key) {
    if (!this.isReady()) return null
    try {
      return await this.client.incr(key)
    } catch (err) {
      console.error('[Redis] Incr error:', err.message)
      return null
    }
  }

  async decr(key) {
    if (!this.isReady()) return null
    try {
      return await this.client.decr(key)
    } catch (err) {
      console.error('[Redis] Decr error:', err.message)
      return null
    }
  }

  async expire(key, seconds) {
    if (!this.isReady()) return false
    try {
      await this.client.expire(key, seconds)
      return true
    } catch (err) {
      console.error('[Redis] Expire error:', err.message)
      return false
    }
  }

  async hset(key, field, value) {
    if (!this.isReady()) return false
    try {
      await this.client.hSet(key, field, this.serialize(value))
      return true
    } catch (err) {
      console.error('[Redis] HSet error:', err.message)
      return false
    }
  }

  async hget(key, field) {
    if (!this.isReady()) return null
    try {
      const value = await this.client.hGet(key, field)
      if (!value) return null
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    } catch (err) {
      console.error('[Redis] HGet error:', err.message)
      return null
    }
  }

  async hgetall(key) {
    if (!this.isReady()) return {}
    try {
      const data = await this.client.hGetAll(key)
      const result = {}
      for (const [k, v] of Object.entries(data)) {
        try {
          result[k] = JSON.parse(v)
        } catch {
          result[k] = v
        }
      }
      return result
    } catch (err) {
      console.error('[Redis] HGetAll error:', err.message)
      return {}
    }
  }

  async hdel(key, field) {
    if (!this.isReady()) return false
    try {
      await this.client.hDel(key, field)
      return true
    } catch (err) {
      console.error('[Redis] HDel error:', err.message)
      return false
    }
  }

  async sadd(key, member) {
    if (!this.isReady()) return false
    try {
      await this.client.sAdd(key, member)
      return true
    } catch (err) {
      console.error('[Redis] SAdd error:', err.message)
      return false
    }
  }

  async srem(key, member) {
    if (!this.isReady()) return false
    try {
      await this.client.sRem(key, member)
      return true
    } catch (err) {
      console.error('[Redis] SRem error:', err.message)
      return false
    }
  }

  async smembers(key) {
    if (!this.isReady()) return []
    try {
      return await this.client.sMembers(key)
    } catch (err) {
      console.error('[Redis] SMembers error:', err.message)
      return []
    }
  }

  async disconnect() {
    try {
      if (this.client) await this.client.quit()
      if (this.subscriber) await this.subscriber.quit()
      if (this.publisher) await this.publisher.quit()
      this.isConnected = false
    } catch (err) {
      console.error('[Redis] Disconnect error:', err.message)
    }
  }

  /**
   * Returns the raw redis client instances needed by @socket.io/redis-adapter.
   * Both pub and sub must be separate clients per the adapter docs.
   */
  getAdapterClients() {
    return {
      pubClient: this.publisher,
      subClient: this.subscriber
    }
  }
}

const redisService = new RedisService()
export default redisService
