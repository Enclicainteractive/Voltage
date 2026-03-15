import redisService from './redisService.js'

class MessageBus {
  constructor() {
    this.useRedis = false
    this.localHandlers = new Map()
  }

  async init() {
    this.useRedis = redisService.isReady()
    if (this.useRedis) {
      await this.setupRedisSubscriptions()
      console.log('[MessageBus] Using Redis pub/sub for distributed messaging')
    } else {
      console.log('[MessageBus] Using local event emitter (single server mode)')
    }
  }

  async setupRedisSubscriptions() {
    const channels = [
      'volt:messages',
      'volt:presence',
      'volt:sessions',
      'volt:typing'
    ]

    for (const channel of channels) {
      await redisService.subscribe(channel, (message) => {
        this.handleMessage(channel, message)
      })
    }
  }

  handleMessage(channel, message) {
    const handlers = this.localHandlers.get(channel)
    if (handlers) {
      for (const handler of handlers) {
        handler(message)
      }
    }
  }

  async publish(channel, message) {
    if (this.useRedis) {
      return redisService.publish(channel, message)
    }
    this.handleMessage(channel, message)
    return true
  }

  subscribe(channel, handler) {
    if (!this.localHandlers.has(channel)) {
      this.localHandlers.set(channel, new Set())
    }
    this.localHandlers.get(channel).add(handler)

    return () => {
      const handlers = this.localHandlers.get(channel)
      if (handlers) {
        handlers.delete(handler)
      }
    }
  }

  async publishMessage(message) {
    return this.publish('volt:messages', {
      type: 'message',
      data: message,
      timestamp: Date.now()
    })
  }

  async publishPresence(userId, status, serverId = null) {
    return this.publish('volt:presence', {
      type: 'presence',
      userId,
      status,
      serverId,
      timestamp: Date.now()
    })
  }

  async publishTyping(userId, channelId, isTyping) {
    return this.publish('volt:typing', {
      type: 'typing',
      userId,
      channelId,
      isTyping,
      timestamp: Date.now()
    })
  }

  async publishSessionEvent(event, userId, sessionId) {
    return this.publish('volt:sessions', {
      type: 'session',
      event,
      userId,
      sessionId,
      timestamp: Date.now()
    })
  }
}

const messageBus = new MessageBus()
export default messageBus
