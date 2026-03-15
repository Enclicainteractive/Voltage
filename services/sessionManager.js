import redisService from './redisService.js'

const SESSION_TTL = 7 * 24 * 60 * 60
const SESSION_PREFIX = 'volt:session:'
const USER_SESSIONS_PREFIX = 'volt:user_sessions:'

class SessionManager {
  constructor() {
    this.useRedis = false
  }

  async init() {
    this.useRedis = redisService.isReady()
    if (this.useRedis) {
      console.log('[Session] Using Redis-backed sessions')
    } else {
      console.log('[Session] Using in-memory sessions (fallback)')
      this.sessions = new Map()
    }
  }

  async createSession(userId, data = {}) {
    const sessionId = crypto.randomUUID()
    const sessionData = {
      userId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ...data
    }

    if (this.useRedis) {
      await redisService.set(
        `${SESSION_PREFIX}${sessionId}`,
        sessionData,
        SESSION_TTL
      )
      await redisService.sadd(`${USER_SESSIONS_PREFIX}${userId}`, sessionId)
    } else {
      this.sessions.set(sessionId, sessionData)
    }

    return sessionId
  }

  async getSession(sessionId) {
    if (this.useRedis) {
      return await redisService.get(`${SESSION_PREFIX}${sessionId}`)
    } else {
      return this.sessions.get(sessionId) || null
    }
  }

  async updateSession(sessionId, data) {
    const session = await this.getSession(sessionId)
    if (!session) return false

    const updated = {
      ...session,
      ...data,
      lastActivity: Date.now()
    }

    if (this.useRedis) {
      await redisService.set(
        `${SESSION_PREFIX}${sessionId}`,
        updated,
        SESSION_TTL
      )
    } else {
      this.sessions.set(sessionId, updated)
    }

    return true
  }

  async deleteSession(sessionId) {
    const session = await this.getSession(sessionId)
    if (!session) return false

    if (this.useRedis) {
      await redisService.del(`${SESSION_PREFIX}${sessionId}`)
      await redisService.srem(`${USER_SESSIONS_PREFIX}${session.userId}`, sessionId)
    } else {
      this.sessions.delete(sessionId)
    }

    return true
  }

  async getUserSessions(userId) {
    if (this.useRedis) {
      const sessionIds = await redisService.smembers(`${USER_SESSIONS_PREFIX}${userId}`)
      const sessions = []
      for (const sessionId of sessionIds) {
        const session = await this.getSession(sessionId)
        if (session) sessions.push(session)
      }
      return sessions
    } else {
      return Array.from(this.sessions.values()).filter(s => s.userId === userId)
    }
  }

  async deleteUserSessions(userId) {
    const sessions = await this.getUserSessions(userId)
    for (const session of sessions) {
      await this.deleteSession(session.sessionId || this.findSessionId(session))
    }
  }

  findSessionId(sessionData) {
    if (this.useRedis) return null
    for (const [id, s] of this.sessions) {
      if (s === sessionData) return id
    }
    return null
  }

  async refreshSession(sessionId) {
    if (this.useRedis) {
      await redisService.expire(`${SESSION_PREFIX}${sessionId}`, SESSION_TTL)
    }
  }

  async getOnlineCount() {
    if (!this.useRedis) return this.sessions?.size || 0
    // Use SCAN instead of KEYS to avoid blocking Redis with O(n) KEYS command
    try {
      const client = redisService.client
      if (!client) return 0
      let cursor = '0'
      let count = 0
      do {
        const result = await client.scan(cursor, 'MATCH', `${SESSION_PREFIX}*`, 'COUNT', 100)
        cursor = String(result[0])
        count += result[1].length
      } while (cursor !== '0')
      return count
    } catch (err) {
      console.error('[Session] Error counting sessions:', err.message)
      return 0
    }
  }
}

const sessionManager = new SessionManager()
export default sessionManager
