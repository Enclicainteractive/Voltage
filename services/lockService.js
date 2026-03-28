/**
 * VoltChat Distributed Lock Service
 * 
 * Provides distributed locking mechanisms to prevent race conditions
 * in critical sections across multiple server instances
 */

import redisService from './redisService.js'

class LockService {
  constructor() {
    this.localLocks = new Map() // Fallback for non-Redis environments
    this.lockTimeouts = new Map()
  }

  /**
   * Acquire a distributed lock
   * @param {string} key - Lock key identifier
   * @param {number} ttlMs - Time to live in milliseconds
   * @param {number} timeoutMs - Maximum wait time for lock acquisition
   * @returns {Promise<string|null>} - Lock token if acquired, null if failed
   */
  async acquireLock(key, ttlMs = 30000, timeoutMs = 10000) {
    const lockKey = `lock:${key}`
    const lockToken = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const startTime = Date.now()

    // Try Redis-based distributed locking first
    if (redisService.isReady()) {
      return this.acquireRedisLock(lockKey, lockToken, ttlMs, timeoutMs, startTime)
    } else {
      // Fallback to local in-memory locking
      console.warn('[Lock] Redis unavailable, using local lock fallback')
      return this.acquireLocalLock(lockKey, lockToken, ttlMs, timeoutMs, startTime)
    }
  }

  /**
   * Redis-based distributed lock implementation
   */
  async acquireRedisLock(lockKey, lockToken, ttlMs, timeoutMs, startTime) {
    while (Date.now() - startTime < timeoutMs) {
      try {
        // Use SET NX EX for atomic lock acquisition
        const result = await redisService.client.set(
          lockKey, 
          lockToken, 
          'PX', 
          ttlMs, 
          'NX'
        )
        
        if (result === 'OK') {
          console.log(`[Lock] Acquired Redis lock: ${lockKey} with token ${lockToken}`)
          return lockToken
        }
        
        // Lock is held by someone else, wait a bit before retrying
        await this.sleep(Math.min(100, timeoutMs / 10))
        
      } catch (error) {
        console.error('[Lock] Redis lock acquisition error:', error.message)
        // Fall back to local locking on Redis errors
        return this.acquireLocalLock(lockKey, lockToken, ttlMs, timeoutMs, startTime)
      }
    }
    
    console.warn(`[Lock] Failed to acquire Redis lock ${lockKey} within ${timeoutMs}ms`)
    return null
  }

  /**
   * Local in-memory lock implementation (fallback)
   */
  async acquireLocalLock(lockKey, lockToken, ttlMs, timeoutMs, startTime) {
    while (Date.now() - startTime < timeoutMs) {
      const existingLock = this.localLocks.get(lockKey)
      
      if (!existingLock || Date.now() > existingLock.expiresAt) {
        // Lock is free or expired
        const lock = {
          token: lockToken,
          expiresAt: Date.now() + ttlMs,
          acquiredAt: Date.now()
        }
        
        this.localLocks.set(lockKey, lock)
        
        // Set timeout to auto-release
        if (this.lockTimeouts.has(lockKey)) {
          clearTimeout(this.lockTimeouts.get(lockKey))
        }
        
        const timeout = setTimeout(() => {
          this.localLocks.delete(lockKey)
          this.lockTimeouts.delete(lockKey)
        }, ttlMs)
        
        this.lockTimeouts.set(lockKey, timeout)
        
        console.log(`[Lock] Acquired local lock: ${lockKey} with token ${lockToken}`)
        return lockToken
      }
      
      // Wait before retrying
      await this.sleep(Math.min(50, timeoutMs / 20))
    }
    
    console.warn(`[Lock] Failed to acquire local lock ${lockKey} within ${timeoutMs}ms`)
    return null
  }

  /**
   * Release a distributed lock
   * @param {string} key - Lock key identifier
   * @param {string} token - Lock token from acquisition
   * @returns {Promise<boolean>} - True if released, false otherwise
   */
  async releaseLock(key, token) {
    const lockKey = `lock:${key}`
    
    if (redisService.isReady()) {
      return this.releaseRedisLock(lockKey, token)
    } else {
      return this.releaseLocalLock(lockKey, token)
    }
  }

  /**
   * Release Redis lock with Lua script for atomic check-and-delete
   */
  async releaseRedisLock(lockKey, token) {
    try {
      // Lua script ensures atomic check of token before deletion
      const luaScript = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        else
          return 0
        end
      `
      
      const result = await redisService.client.eval(luaScript, 1, String(lockKey), String(token))
      
      if (result === 1) {
        console.log(`[Lock] Released Redis lock: ${lockKey}`)
        return true
      } else {
        console.warn(`[Lock] Failed to release Redis lock ${lockKey} - token mismatch or expired`)
        return false
      }
      
    } catch (error) {
      console.error('[Lock] Redis lock release error:', error.message)
      return false
    }
  }

  /**
   * Release local lock
   */
  releaseLocalLock(lockKey, token) {
    const existingLock = this.localLocks.get(lockKey)
    
    if (existingLock && existingLock.token === token) {
      this.localLocks.delete(lockKey)
      
      if (this.lockTimeouts.has(lockKey)) {
        clearTimeout(this.lockTimeouts.get(lockKey))
        this.lockTimeouts.delete(lockKey)
      }
      
      console.log(`[Lock] Released local lock: ${lockKey}`)
      return true
    }
    
    console.warn(`[Lock] Failed to release local lock ${lockKey} - token mismatch or not found`)
    return false
  }

  /**
   * Execute a function within a distributed lock
   * @param {string} key - Lock key
   * @param {Function} fn - Function to execute
   * @param {Object} options - Lock options
   * @returns {Promise<any>} - Function result
   */
  async withLock(key, fn, options = {}) {
    const {
      ttlMs = 30000,
      timeoutMs = 10000,
      retryOnFailure = true,
      maxRetries = 3
    } = options

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const lockToken = await this.acquireLock(key, ttlMs, timeoutMs)
      
      if (!lockToken) {
        if (retryOnFailure && attempt < maxRetries) {
          const delay = Math.min(1000, 100 * Math.pow(2, attempt))
          console.warn(`[Lock] Failed to acquire lock ${key}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`)
          await this.sleep(delay)
          continue
        } else {
          throw new Error(`Failed to acquire lock: ${key}`)
        }
      }
      
      try {
        const result = await fn()
        return result
      } finally {
        await this.releaseLock(key, lockToken)
      }
    }
  }

  /**
   * Get lock status information
   */
  async getLockStatus(key) {
    const lockKey = `lock:${key}`
    
    if (redisService.isReady()) {
      try {
        const value = await redisService.client.get(lockKey)
        const ttl = await redisService.client.pttl(lockKey)
        
        return {
          locked: value !== null,
          token: value,
          ttlMs: ttl > 0 ? ttl : 0,
          backend: 'redis'
        }
      } catch (error) {
        console.error('[Lock] Failed to get Redis lock status:', error.message)
      }
    }
    
    // Check local locks
    const existingLock = this.localLocks.get(lockKey)
    if (existingLock && Date.now() <= existingLock.expiresAt) {
      return {
        locked: true,
        token: existingLock.token,
        ttlMs: existingLock.expiresAt - Date.now(),
        backend: 'local'
      }
    }
    
    return {
      locked: false,
      token: null,
      ttlMs: 0,
      backend: redisService.isReady() ? 'redis' : 'local'
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Get lock service statistics
   */
  getStats() {
    return {
      localLocks: this.localLocks.size,
      pendingTimeouts: this.lockTimeouts.size,
      backend: redisService.isReady() ? 'redis' : 'local'
    }
  }
}

// Export singleton instance
export default new LockService()