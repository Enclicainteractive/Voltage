import { createClient } from 'redis'

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

    let url = process.env.REDIS_URL || 
      `redis://${redisConfig.host || 'localhost'}:${redisConfig.port || 6379}/${redisConfig.db || 0}`

    if (redisConfig.password) {
      url = `redis://:${redisConfig.password}@${redisConfig.host || 'localhost'}:${redisConfig.port || 6379}/${redisConfig.db || 0}`
    }

    const clientOptions = {
      url,
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

  async set(key, value, ttlSeconds = 0) {
    if (!this.isReady()) return false
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value)
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
      await this.client.hSet(key, field, JSON.stringify(value))
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
