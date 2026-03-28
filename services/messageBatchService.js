/**
 * VoltChat Message Batching Service
 * 
 * Optimizes message processing through intelligent batching and queue management
 */

import transactionService from './transactionService.js'
import lockService from './lockService.js'
import circuitBreakerManager from './circuitBreaker.js'
import healthService from './healthService.js'

class MessageBatchService {
  constructor() {
    this.batches = new Map() // channelId -> batch queue
    this.dmBatches = new Map() // conversationId -> batch queue
    this.processingInterval = null
    this.isProcessing = false
    
    this.config = {
      maxBatchSize: 50,
      maxBatchAge: 1000, // 1 second
      processingInterval: 500, // Process every 500ms
      maxRetries: 3,
      retryDelay: 1000
    }
    
    this.metrics = {
      messagesProcessed: 0,
      batchesProcessed: 0,
      averageBatchSize: 0,
      processingErrors: 0,
      duplicatesSkipped: 0
    }
  }

  /**
   * Start the batch processing system
   */
  start() {
    if (this.processingInterval) return
    
    this.processingInterval = setInterval(() => {
      this.processBatches().catch(error => {
        console.error('[MessageBatch] Error processing batches:', error.message)
        this.metrics.processingErrors++
      })
    }, this.config.processingInterval)
    
    console.log('[MessageBatch] Message batching service started')
  }

  /**
   * Stop the batch processing system
   */
  stop() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval)
      this.processingInterval = null
    }
    console.log('[MessageBatch] Message batching service stopped')
  }

  /**
   * Add a message to the batch queue
   */
  queueMessage(channelId, message, isDM = false) {
    const batchMap = isDM ? this.dmBatches : this.batches
    const batchKey = channelId
    
    if (!batchMap.has(batchKey)) {
      batchMap.set(batchKey, {
        messages: [],
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        processingCount: 0
      })
    }
    
    const batch = batchMap.get(batchKey)
    
    // Check for duplicate messages
    if (batch.messages.some(msg => msg.id === message.id)) {
      this.metrics.duplicatesSkipped++
      return false
    }
    
    batch.messages.push({
      ...message,
      queuedAt: Date.now(),
      retryCount: 0
    })
    batch.lastUpdated = Date.now()
    
    // Process immediately if batch is full
    if (batch.messages.length >= this.config.maxBatchSize) {
      setImmediate(() => this.processSingleBatch(batchKey, isDM))
    }
    
    return true
  }

  /**
   * Queue multiple messages at once (bulk operation)
   */
  queueMessages(channelId, messages, isDM = false) {
    let queued = 0
    for (const message of messages) {
      if (this.queueMessage(channelId, message, isDM)) {
        queued++
      }
    }
    return queued
  }

  /**
   * Process all pending batches
   */
  async processBatches() {
    if (this.isProcessing) return
    
    this.isProcessing = true
    const start = Date.now()
    
    try {
      // Process channel messages
      await this.processBatchMap(this.batches, false)
      
      // Process DM messages  
      await this.processBatchMap(this.dmBatches, true)
      
    } finally {
      this.isProcessing = false
      
      // Record processing metrics
      const duration = Date.now() - start
      if (duration > 100) { // Track slow batch processing
        healthService.recordDatabaseQuery(duration, true)
      }
    }
  }

  /**
   * Process a map of batches
   */
  async processBatchMap(batchMap, isDM) {
    const batchesToProcess = []
    const now = Date.now()
    
    // Find batches that need processing
    for (const [key, batch] of batchMap) {
      const age = now - batch.createdAt
      const shouldProcess = batch.messages.length >= this.config.maxBatchSize ||
                           age >= this.config.maxBatchAge ||
                           batch.processingCount > 0
      
      if (shouldProcess && batch.messages.length > 0) {
        batchesToProcess.push({ key, batch, isDM })
      }
    }
    
    // Process batches in parallel (limited concurrency)
    const concurrency = 3
    for (let i = 0; i < batchesToProcess.length; i += concurrency) {
      const chunk = batchesToProcess.slice(i, i + concurrency)
      await Promise.all(
        chunk.map(({ key, isDM }) => this.processSingleBatch(key, isDM))
      )
    }
  }

  /**
   * Process a single batch
   */
  async processSingleBatch(batchKey, isDM) {
    const batchMap = isDM ? this.dmBatches : this.batches
    const batch = batchMap.get(batchKey)
    
    if (!batch || batch.messages.length === 0) return
    
    const lockKey = `message_batch_${isDM ? 'dm' : 'channel'}_${batchKey}`
    const messages = [...batch.messages] // Copy to avoid modification during processing
    batch.processingCount++
    
    try {
      await lockService.withLock(lockKey, async () => {
        await this.processBatchWithRetry(batchKey, messages, isDM)
      }, {
        ttlMs: 30000,
        timeoutMs: 5000,
        maxRetries: 1
      })
      
      // Clear processed messages
      batch.messages = batch.messages.filter(msg => 
        !messages.some(processedMsg => processedMsg.id === msg.id)
      )
      
      // Remove empty batches
      if (batch.messages.length === 0) {
        batchMap.delete(batchKey)
      } else {
        batch.processingCount--
      }
      
      // Update metrics
      this.updateMetrics(messages.length)
      
    } catch (error) {
      console.error(`[MessageBatch] Error processing batch ${batchKey}:`, error.message)
      this.metrics.processingErrors++
      
      // Mark failed messages for retry
      for (const message of messages) {
        message.retryCount = (message.retryCount || 0) + 1
        if (message.retryCount >= this.config.maxRetries) {
          console.error(`[MessageBatch] Message ${message.id} exceeded max retries, dropping`)
          batch.messages = batch.messages.filter(msg => msg.id !== message.id)
        }
      }
      
      batch.processingCount--
    }
  }

  /**
   * Process a batch with retry logic and circuit breaker protection
   */
  async processBatchWithRetry(batchKey, messages, isDM) {
    const breakerKey = `message_batch_${isDM ? 'dm' : 'channel'}`
    
    return await circuitBreakerManager.executeWithFallback(
      breakerKey,
      async () => {
        if (isDM) {
          await this.processDMMessageBatch(batchKey, messages)
        } else {
          await this.processChannelMessageBatch(batchKey, messages)
        }
      },
      async () => {
        console.warn(`[MessageBatch] Circuit breaker open for ${breakerKey}, queuing for later retry`)
        // Reschedule for later processing
        setTimeout(() => {
          this.processSingleBatch(batchKey, isDM)
        }, this.config.retryDelay)
      },
      {
        failureThreshold: 5,
        resetTimeout: 30000
      }
    )
  }

  /**
   * Process channel message batch with transaction
   */
  async processChannelMessageBatch(channelId, messages) {
    await transactionService.withTransaction(async (transaction) => {
      const { addMessage } = await import('../routes/channelRoutes.js')
      
      for (const message of messages) {
        try {
          await addMessage(channelId, message, { transaction })
        } catch (error) {
          console.error(`[MessageBatch] Error adding channel message ${message.id}:`, error.message)
          throw error // Will trigger transaction rollback
        }
      }
    })
    
    console.log(`[MessageBatch] Processed ${messages.length} channel messages for ${channelId}`)
  }

  /**
   * Process DM message batch with transaction
   */
  async processDMMessageBatch(conversationId, messages) {
    await transactionService.withTransaction(async (transaction) => {
      const { dmMessageService } = await import('./dataService.js')
      
      for (const message of messages) {
        try {
          await dmMessageService.addMessage(conversationId, message, { transaction })
        } catch (error) {
          console.error(`[MessageBatch] Error adding DM message ${message.id}:`, error.message)
          throw error // Will trigger transaction rollback
        }
      }
    })
    
    console.log(`[MessageBatch] Processed ${messages.length} DM messages for ${conversationId}`)
  }

  /**
   * Update processing metrics
   */
  updateMetrics(batchSize) {
    this.metrics.messagesProcessed += batchSize
    this.metrics.batchesProcessed++
    
    // Update average batch size (rolling average)
    const alpha = 0.1
    this.metrics.averageBatchSize = 
      (alpha * batchSize) + ((1 - alpha) * this.metrics.averageBatchSize)
  }

  /**
   * Get batch processing metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      pendingBatches: this.batches.size + this.dmBatches.size,
      pendingMessages: this.getPendingMessageCount(),
      averageBatchSize: Math.round(this.metrics.averageBatchSize * 100) / 100,
      successRate: this.metrics.batchesProcessed > 0 
        ? ((this.metrics.batchesProcessed - this.metrics.processingErrors) / this.metrics.batchesProcessed) * 100
        : 100
    }
  }

  /**
   * Get total pending message count
   */
  getPendingMessageCount() {
    let count = 0
    
    for (const batch of this.batches.values()) {
      count += batch.messages.length
    }
    
    for (const batch of this.dmBatches.values()) {
      count += batch.messages.length
    }
    
    return count
  }

  /**
   * Force process all pending batches immediately
   */
  async flushAll() {
    console.log('[MessageBatch] Flushing all pending batches...')
    
    const allBatches = [
      ...Array.from(this.batches.keys()).map(key => ({ key, isDM: false })),
      ...Array.from(this.dmBatches.keys()).map(key => ({ key, isDM: true }))
    ]
    
    await Promise.all(
      allBatches.map(({ key, isDM }) => this.processSingleBatch(key, isDM))
    )
    
    console.log('[MessageBatch] All batches flushed')
  }

  /**
   * Clear all pending batches (emergency cleanup)
   */
  clearAll() {
    this.batches.clear()
    this.dmBatches.clear()
    console.log('[MessageBatch] All pending batches cleared')
  }

  /**
   * Get detailed batch status for monitoring
   */
  getBatchStatus() {
    const channelBatches = {}
    const dmBatches = {}
    
    for (const [key, batch] of this.batches) {
      channelBatches[key] = {
        messageCount: batch.messages.length,
        age: Date.now() - batch.createdAt,
        processing: batch.processingCount > 0
      }
    }
    
    for (const [key, batch] of this.dmBatches) {
      dmBatches[key] = {
        messageCount: batch.messages.length,
        age: Date.now() - batch.createdAt,
        processing: batch.processingCount > 0
      }
    }
    
    return {
      channels: channelBatches,
      dms: dmBatches,
      metrics: this.getMetrics()
    }
  }
}

// Export singleton instance
export default new MessageBatchService()