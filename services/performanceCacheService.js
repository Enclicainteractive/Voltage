const Redis = require('redis')
const { performance } = require('perf_hooks')

class PerformanceCacheService {
  constructor() {
    this.redisClient = null
    this.localCache = new Map()
    this.cacheStats = {
      hits: 0,
      misses: 0,
      sets: 0,
      errors: 0
    }
    this.maxLocalCacheSize = 1000
    this.defaultTTL = 3600 // 1 hour
  }

  async initialize() {
    try {
      this.redisClient = Redis.createClient({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true
      })

      await this.redisClient.connect()
      console.log('[PerformanceCache] Redis connected successfully')
      
      // Set up cache cleanup
      this.setupCacheCleanup()
      
      return true
    } catch (error) {
      console.error('[PerformanceCache] Redis connection failed:', error)
      console.log('[PerformanceCache] Falling back to local cache only')
      return false
    }
  }

  setupCacheCleanup() {
    // Clean up local cache periodically
    setInterval(() => {
      if (this.localCache.size > this.maxLocalCacheSize) {
        const entries = Array.from(this.localCache.entries())
        const toDelete = entries.slice(0, Math.floor(this.maxLocalCacheSize * 0.3))
        toDelete.forEach(([key]) => this.localCache.delete(key))
      }
    }, 60000) // Every minute

    // Log cache stats periodically
    setInterval(() => {
      console.log('[PerformanceCache] Stats:', this.cacheStats)
    }, 300000) // Every 5 minutes
  }

  // Generate cache key with namespace
  generateKey(namespace, key, params = {}) {
    const paramString = Object.keys(params).length > 0 ? 
      ':' + Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&') : ''
    
    return `voltchat:cache:${namespace}:${key}${paramString}`
  }

  // Get from cache with fallback
  async get(namespace, key, params = {}) {
    const cacheKey = this.generateKey(namespace, key, params)
    const startTime = performance.now()

    try {
      // Try local cache first (fastest)
      if (this.localCache.has(cacheKey)) {
        const localData = this.localCache.get(cacheKey)
        if (localData.expires > Date.now()) {
          this.cacheStats.hits++
          return JSON.parse(localData.value)
        } else {
          this.localCache.delete(cacheKey)
        }
      }

      // Try Redis cache
      if (this.redisClient) {
        const redisData = await this.redisClient.get(cacheKey)
        if (redisData) {
          const parsedData = JSON.parse(redisData)
          
          // Store in local cache for faster future access
          this.localCache.set(cacheKey, {
            value: redisData,
            expires: Date.now() + (this.defaultTTL * 1000)
          })
          
          this.cacheStats.hits++
          return parsedData
        }
      }

      this.cacheStats.misses++
      return null

    } catch (error) {
      console.error('[PerformanceCache] Get error:', error)
      this.cacheStats.errors++
      return null
    }
  }

  // Set cache with TTL
  async set(namespace, key, value, ttl = null, params = {}) {
    const cacheKey = this.generateKey(namespace, key, params)
    const serializedValue = JSON.stringify(value)
    const cacheTTL = ttl || this.defaultTTL

    try {
      // Store in local cache
      this.localCache.set(cacheKey, {
        value: serializedValue,
        expires: Date.now() + (cacheTTL * 1000)
      })

      // Store in Redis
      if (this.redisClient) {
        await this.redisClient.setEx(cacheKey, cacheTTL, serializedValue)
      }

      this.cacheStats.sets++
      return true

    } catch (error) {
      console.error('[PerformanceCache] Set error:', error)
      this.cacheStats.errors++
      return false
    }
  }

  // Delete from cache
  async delete(namespace, key, params = {}) {
    const cacheKey = this.generateKey(namespace, key, params)

    try {
      this.localCache.delete(cacheKey)
      
      if (this.redisClient) {
        await this.redisClient.del(cacheKey)
      }

      return true
    } catch (error) {
      console.error('[PerformanceCache] Delete error:', error)
      return false
    }
  }

  // Clear cache by pattern
  async clearPattern(pattern) {
    try {
      // Clear local cache by pattern
      const keysToDelete = Array.from(this.localCache.keys())
        .filter(key => key.includes(pattern))
      
      keysToDelete.forEach(key => this.localCache.delete(key))

      // Clear Redis cache by pattern
      if (this.redisClient) {
        const keys = await this.redisClient.keys(`*${pattern}*`)
        if (keys.length > 0) {
          await this.redisClient.del(keys)
        }
      }

      return true
    } catch (error) {
      console.error('[PerformanceCache] Clear pattern error:', error)
      return false
    }
  }

  // Cache with automatic refresh
  async getOrFetch(namespace, key, fetchFunction, ttl = null, params = {}) {
    const cachedValue = await this.get(namespace, key, params)
    
    if (cachedValue !== null) {
      return cachedValue
    }

    // Fetch fresh data
    try {
      const freshValue = await fetchFunction()
      await this.set(namespace, key, freshValue, ttl, params)
      return freshValue
    } catch (error) {
      console.error('[PerformanceCache] Fetch function error:', error)
      throw error
    }
  }

  // Specific caching methods for VoltChat entities

  // User profile caching
  async cacheUserProfile(userId, profile, ttl = 3600) {
    return this.set('users', 'profile', profile, ttl, { userId })
  }

  async getUserProfile(userId) {
    return this.get('users', 'profile', { userId })
  }

  // Server list caching
  async cacheUserServers(userId, servers, ttl = 1800) {
    return this.set('users', 'servers', servers, ttl, { userId })
  }

  async getUserServers(userId) {
    return this.get('users', 'servers', { userId })
  }

  // Channel list caching
  async cacheServerChannels(serverId, channels, ttl = 1800) {
    return this.set('servers', 'channels', channels, ttl, { serverId })
  }

  async getServerChannels(serverId) {
    return this.get('servers', 'channels', { serverId })
  }

  // Member list caching
  async cacheServerMembers(serverId, members, ttl = 900) {
    return this.set('servers', 'members', members, ttl, { serverId })
  }

  async getServerMembers(serverId) {
    return this.get('servers', 'members', { serverId })
  }

  // Message cache (for recent messages)
  async cacheRecentMessages(channelId, messages, ttl = 300) {
    return this.set('messages', 'recent', messages, ttl, { channelId })
  }

  async getRecentMessages(channelId) {
    return this.get('messages', 'recent', { channelId })
  }

  // Permissions caching
  async cacheUserPermissions(userId, serverId, permissions, ttl = 1800) {
    return this.set('permissions', 'user', permissions, ttl, { userId, serverId })
  }

  async getUserPermissions(userId, serverId) {
    return this.get('permissions', 'user', { userId, serverId })
  }

  // Session caching
  async cacheUserSession(sessionToken, sessionData, ttl = 7200) {
    return this.set('sessions', 'data', sessionData, ttl, { token: sessionToken })
  }

  async getUserSession(sessionToken) {
    return this.get('sessions', 'data', { token: sessionToken })
  }

  // Search results caching
  async cacheSearchResults(query, results, ttl = 300) {
    const queryHash = Buffer.from(query).toString('base64')
    return this.set('search', 'results', results, ttl, { query: queryHash })
  }

  async getSearchResults(query) {
    const queryHash = Buffer.from(query).toString('base64')
    return this.get('search', 'results', { query: queryHash })
  }

  // Invalidation methods
  async invalidateUser(userId) {
    await this.clearPattern(`users:*:userId=${userId}`)
    await this.clearPattern(`permissions:*:userId=${userId}`)
  }

  async invalidateServer(serverId) {
    await this.clearPattern(`servers:*:serverId=${serverId}`)
    await this.clearPattern(`permissions:*:serverId=${serverId}`)
  }

  async invalidateChannel(channelId) {
    await this.clearPattern(`messages:*:channelId=${channelId}`)
  }

  // Performance monitoring
  getCacheStats() {
    return {
      ...this.cacheStats,
      hitRate: this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses) || 0,
      localCacheSize: this.localCache.size,
      redisConnected: !!this.redisClient
    }
  }

  // Health check
  async healthCheck() {
    try {
      if (this.redisClient) {
        await this.redisClient.ping()
        return { status: 'healthy', redis: 'connected' }
      } else {
        return { status: 'degraded', redis: 'disconnected', message: 'Using local cache only' }
      }
    } catch (error) {
      return { status: 'unhealthy', error: error.message }
    }
  }

  async shutdown() {
    try {
      if (this.redisClient) {
        await this.redisClient.disconnect()
      }
      this.localCache.clear()
    } catch (error) {
      console.error('[PerformanceCache] Shutdown error:', error)
    }
  }
}

// Singleton instance
let cacheService = null

const getCacheService = () => {
  if (!cacheService) {
    cacheService = new PerformanceCacheService()
  }
  return cacheService
}

module.exports = { PerformanceCacheService, getCacheService }