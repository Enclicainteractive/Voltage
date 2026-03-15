import redisService from './redisService.js'

class RequestQueue {
  constructor() {
    this.useRedis = false
    this.localQueue = []
    this.processing = false
    this.priorityLevels = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3
    }
  }

  init() {
    this.useRedis = redisService.isReady()
    if (this.useRedis) {
      console.log('[RequestQueue] Using Redis-backed queue')
    } else {
      console.log('[RequestQueue] Using in-memory queue')
    }
  }

  async enqueue(data, priority = 'normal') {
    const item = {
      id: crypto.randomUUID(),
      data,
      priority: this.priorityLevels[priority] ?? 2,
      enqueuedAt: Date.now(),
      attempts: 0
    }

    if (this.useRedis) {
      await redisService.client.lPush('volt:queue', JSON.stringify(item))
      await redisService.client.zAdd('volt:queue_priority', {
        score: item.priority,
        value: item.id
      })
    } else {
      this.localQueue.push(item)
      this.localQueue.sort((a, b) => a.priority - b.priority)
    }

    return item.id
  }

  async dequeue() {
    if (this.useRedis) {
      const itemStr = await redisService.client.rPop('volt:queue')
      if (itemStr) {
        return JSON.parse(itemStr)
      }
    } else {
      return this.localQueue.shift()
    }
    return null
  }

  async process(handler, options = {}) {
    const {
      maxAttempts = 3,
      backoffMs = 1000,
      concurrency = 5,
      timeout = 30000
    } = options

    if (this.processing) return
    this.processing = true

    const workers = []
    for (let i = 0; i < concurrency; i++) {
      workers.push(this.worker(handler, maxAttempts, backoffMs, timeout))
    }

    await Promise.all(workers)
    this.processing = false
  }

  async worker(handler, maxAttempts, backoffMs, timeout) {
    while (true) {
      const item = await this.dequeue()
      if (!item) break

      try {
        const result = await Promise.race([
          handler(item.data),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), timeout)
          )
        ])
        
        if (item.callback) {
          item.callback(null, result)
        }
      } catch (err) {
        item.attempts++
        
        if (item.attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, backoffMs * item.attempts))
          await this.enqueue(item.data, item.priority)
        } else {
          if (item.onError) {
            item.onError(err)
          }
        }
      }
    }
  }

  async getQueueLength() {
    if (this.useRedis) {
      return await redisService.client.lLen('volt:queue')
    }
    return this.localQueue.length
  }

  async clear() {
    if (this.useRedis) {
      await redisService.client.del('volt:queue')
      await redisService.client.del('volt:queue_priority')
    } else {
      this.localQueue = []
    }
  }
}

class MessagePriorityQueue extends RequestQueue {
  constructor() {
    super()
    this.queues = {
      direct: [],
      group: [],
      channel: [],
      broadcast: []
    }
  }

  async enqueueMessage(message, type, priority = 'normal') {
    return this.enqueue({ message, type }, priority)
  }

  async processMessages(handler) {
    return this.process(handler, {
      concurrency: 10,
      timeout: 10000
    })
  }
}

const requestQueue = new RequestQueue()
const messageQueue = new MessagePriorityQueue()

export { RequestQueue, MessagePriorityQueue, requestQueue, messageQueue }
