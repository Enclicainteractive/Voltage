const { performance } = require('perf_hooks')

class QueryBatchingService {
  constructor(dbConnection) {
    this.db = dbConnection
    this.queryQueue = new Map()
    this.batchTimeout = 10 // milliseconds
    this.maxBatchSize = 50
    this.processingBatches = new Set()
    this.metrics = {
      batchesProcessed: 0,
      queriesBatched: 0,
      timesSaved: 0,
      averageBatchSize: 0
    }
    
    // Query type configurations
    this.batchConfigs = {
      'SELECT': {
        timeout: 5,
        maxBatchSize: 100,
        canBatch: this.canBatchSelect.bind(this)
      },
      'INSERT': {
        timeout: 15,
        maxBatchSize: 1000,
        canBatch: this.canBatchInsert.bind(this)
      },
      'UPDATE': {
        timeout: 10,
        maxBatchSize: 50,
        canBatch: this.canBatchUpdate.bind(this)
      },
      'DELETE': {
        timeout: 20,
        maxBatchSize: 25,
        canBatch: this.canBatchDelete.bind(this)
      }
    }
  }

  // Main query execution method with batching
  async executeQuery(sql, params = [], options = {}) {
    const queryType = this.getQueryType(sql)
    const batchKey = this.generateBatchKey(sql, queryType)
    
    // Skip batching for queries that can't be batched
    if (options.skipBatch || !this.canBatch(queryType, sql)) {
      return this.executeDirectly(sql, params)
    }

    return new Promise((resolve, reject) => {
      const queryItem = {
        sql,
        params,
        resolve,
        reject,
        timestamp: Date.now(),
        options
      }

      this.addToBatch(batchKey, queryItem, queryType)
    })
  }

  addToBatch(batchKey, queryItem, queryType) {
    if (!this.queryQueue.has(batchKey)) {
      this.queryQueue.set(batchKey, {
        queries: [],
        timer: null,
        queryType,
        config: this.batchConfigs[queryType] || this.batchConfigs['SELECT']
      })
    }

    const batch = this.queryQueue.get(batchKey)
    batch.queries.push(queryItem)

    // Process batch if it reaches max size
    if (batch.queries.length >= batch.config.maxBatchSize) {
      this.processBatch(batchKey)
    } else if (!batch.timer) {
      // Set timer for batch processing
      batch.timer = setTimeout(() => {
        this.processBatch(batchKey)
      }, batch.config.timeout)
    }
  }

  async processBatch(batchKey) {
    const batch = this.queryQueue.get(batchKey)
    if (!batch || batch.queries.length === 0) return

    this.queryQueue.delete(batchKey)
    
    if (batch.timer) {
      clearTimeout(batch.timer)
    }

    // Prevent concurrent processing of same batch
    if (this.processingBatches.has(batchKey)) return
    this.processingBatches.add(batchKey)

    try {
      await this.executeBatch(batch)
    } catch (error) {
      console.error('[QueryBatching] Batch execution failed:', error)
      // Reject all queries in batch
      batch.queries.forEach(query => {
        query.reject(error)
      })
    } finally {
      this.processingBatches.delete(batchKey)
    }
  }

  async executeBatch(batch) {
    const startTime = performance.now()
    const { queries, queryType } = batch

    this.metrics.batchesProcessed++
    this.metrics.queriesBatched += queries.length
    this.updateAverageBatchSize(queries.length)

    switch (queryType) {
      case 'SELECT':
        await this.executeBatchSelect(queries)
        break
      case 'INSERT':
        await this.executeBatchInsert(queries)
        break
      case 'UPDATE':
        await this.executeBatchUpdate(queries)
        break
      case 'DELETE':
        await this.executeBatchDelete(queries)
        break
      default:
        // Execute queries individually if batching not supported
        await this.executeQueriesIndividually(queries)
    }

    const executionTime = performance.now() - startTime
    this.metrics.timesSaved += Math.max(0, (queries.length * 2) - executionTime) // Estimate time saved
  }

  async executeBatchSelect(queries) {
    // Group identical SELECT queries
    const queryGroups = new Map()

    queries.forEach(query => {
      const normalizedSql = this.normalizeSelectQuery(query.sql)
      if (!queryGroups.has(normalizedSql)) {
        queryGroups.set(normalizedSql, [])
      }
      queryGroups.get(normalizedSql).push(query)
    })

    // Execute each group
    for (const [normalizedSql, groupQueries] of queryGroups) {
      try {
        if (groupQueries.length === 1) {
          // Single query - execute directly
          const query = groupQueries[0]
          const result = await this.db.query(query.sql, query.params)
          query.resolve(result)
        } else {
          // Multiple identical queries - execute once and share result
          const firstQuery = groupQueries[0]
          const result = await this.db.query(firstQuery.sql, firstQuery.params)
          
          groupQueries.forEach(query => {
            query.resolve(result)
          })
        }
      } catch (error) {
        groupQueries.forEach(query => {
          query.reject(error)
        })
      }
    }
  }

  async executeBatchInsert(queries) {
    // Group INSERT queries by table
    const tableGroups = new Map()

    queries.forEach(query => {
      const tableName = this.extractTableName(query.sql)
      if (!tableGroups.has(tableName)) {
        tableGroups.set(tableName, [])
      }
      tableGroups.get(tableName).push(query)
    })

    for (const [tableName, groupQueries] of tableGroups) {
      try {
        if (groupQueries.length === 1) {
          const query = groupQueries[0]
          const result = await this.db.query(query.sql, query.params)
          query.resolve(result)
        } else {
          // Create bulk INSERT query
          const bulkResult = await this.executeBulkInsert(tableName, groupQueries)
          
          // Resolve all queries with appropriate results
          groupQueries.forEach((query, index) => {
            query.resolve({
              insertId: bulkResult.insertId + index,
              affectedRows: 1,
              ...bulkResult
            })
          })
        }
      } catch (error) {
        groupQueries.forEach(query => {
          query.reject(error)
        })
      }
    }
  }

  async executeBulkInsert(tableName, queries) {
    // Extract column names from first query
    const firstQuery = queries[0]
    const columns = this.extractInsertColumns(firstQuery.sql)
    
    if (!columns) {
      // Fallback to individual execution
      return this.executeQueriesIndividually(queries)
    }

    // Build VALUES clause for all queries
    const values = queries.map(query => {
      return `(${query.params.map(() => '?').join(', ')})`
    }).join(', ')

    const allParams = queries.flatMap(query => query.params)
    const bulkSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${values}`

    return await this.db.query(bulkSql, allParams)
  }

  async executeBatchUpdate(queries) {
    // Group UPDATE queries by table and SET clause
    const updateGroups = new Map()

    queries.forEach(query => {
      const key = this.generateUpdateKey(query.sql)
      if (!updateGroups.has(key)) {
        updateGroups.set(key, [])
      }
      updateGroups.get(key).push(query)
    })

    for (const [key, groupQueries] of updateGroups) {
      try {
        if (groupQueries.length === 1) {
          const query = groupQueries[0]
          const result = await this.db.query(query.sql, query.params)
          query.resolve(result)
        } else {
          // Create batch UPDATE with CASE statements
          await this.executeBatchUpdateWithCase(groupQueries)
        }
      } catch (error) {
        groupQueries.forEach(query => {
          query.reject(error)
        })
      }
    }
  }

  async executeBatchUpdateWithCase(queries) {
    // For complex UPDATE batching, fall back to individual execution
    // In production, you could implement CASE-based bulk updates
    return this.executeQueriesIndividually(queries)
  }

  async executeBatchDelete(queries) {
    // Group DELETE queries by table
    const tableGroups = new Map()

    queries.forEach(query => {
      const tableName = this.extractTableName(query.sql)
      if (!tableGroups.has(tableName)) {
        tableGroups.set(tableName, [])
      }
      tableGroups.get(tableName).push(query)
    })

    for (const [tableName, groupQueries] of tableGroups) {
      try {
        if (groupQueries.length === 1) {
          const query = groupQueries[0]
          const result = await this.db.query(query.sql, query.params)
          query.resolve(result)
        } else {
          // Create bulk DELETE with IN clause
          await this.executeBulkDelete(tableName, groupQueries)
        }
      } catch (error) {
        groupQueries.forEach(query => {
          query.reject(error)
        })
      }
    }
  }

  async executeBulkDelete(tableName, queries) {
    // Extract WHERE conditions and create IN clause
    const ids = queries.map(query => {
      // Extract ID from WHERE clause (simplified)
      return query.params[0]
    })

    const bulkSql = `DELETE FROM ${tableName} WHERE id IN (${ids.map(() => '?').join(', ')})`
    const result = await this.db.query(bulkSql, ids)

    queries.forEach(query => {
      query.resolve({
        affectedRows: 1, // Approximate
        ...result
      })
    })
  }

  async executeQueriesIndividually(queries) {
    const results = await Promise.allSettled(
      queries.map(async (query) => {
        try {
          const result = await this.db.query(query.sql, query.params)
          query.resolve(result)
          return result
        } catch (error) {
          query.reject(error)
          throw error
        }
      })
    )

    return results
  }

  async executeDirectly(sql, params) {
    return await this.db.query(sql, params)
  }

  // Utility methods
  getQueryType(sql) {
    const trimmed = sql.trim().toUpperCase()
    if (trimmed.startsWith('SELECT')) return 'SELECT'
    if (trimmed.startsWith('INSERT')) return 'INSERT'
    if (trimmed.startsWith('UPDATE')) return 'UPDATE'
    if (trimmed.startsWith('DELETE')) return 'DELETE'
    return 'OTHER'
  }

  generateBatchKey(sql, queryType) {
    // Create a key for batching similar queries
    const normalizedSql = this.normalizeSql(sql)
    return `${queryType}:${normalizedSql}`
  }

  normalizeSql(sql) {
    // Remove extra whitespace and normalize for batching
    return sql.replace(/\s+/g, ' ').trim().toLowerCase()
  }

  normalizeSelectQuery(sql) {
    // Normalize SELECT queries for grouping
    return sql.replace(/\s+/g, ' ').replace(/\?/g, 'PARAM').trim().toLowerCase()
  }

  extractTableName(sql) {
    // Extract table name from SQL query
    const match = sql.match(/(?:FROM|INTO|UPDATE)\s+([`\w]+)/i)
    return match ? match[1].replace(/`/g, '') : null
  }

  extractInsertColumns(sql) {
    // Extract column names from INSERT query
    const match = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i)
    return match ? match[1].split(',').map(col => col.trim()) : null
  }

  generateUpdateKey(sql) {
    // Generate key for grouping UPDATE queries
    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i)
    const tableName = this.extractTableName(sql)
    return `${tableName}:${setMatch ? setMatch[1] : sql}`
  }

  // Batching rules
  canBatch(queryType, sql) {
    const config = this.batchConfigs[queryType]
    return config && config.canBatch(sql)
  }

  canBatchSelect(sql) {
    // Don't batch complex SELECT queries
    const hasSubquery = sql.includes('SELECT') && sql.lastIndexOf('SELECT') > 0
    const hasJoins = /\b(JOIN|UNION|INTERSECT|EXCEPT)\b/i.test(sql)
    return !hasSubquery && !hasJoins
  }

  canBatchInsert(sql) {
    // Don't batch INSERT queries with ON DUPLICATE KEY or complex logic
    return !sql.includes('ON DUPLICATE KEY') && !sql.includes('SELECT')
  }

  canBatchUpdate(sql) {
    // Don't batch UPDATE queries with subqueries or complex WHERE clauses
    return !sql.includes('SELECT') && !sql.includes('CASE')
  }

  canBatchDelete(sql) {
    // Don't batch DELETE queries with JOINs or complex WHERE clauses
    return !sql.includes('JOIN') && !sql.includes('SELECT')
  }

  updateAverageBatchSize(batchSize) {
    const currentAvg = this.metrics.averageBatchSize
    const batchCount = this.metrics.batchesProcessed
    this.metrics.averageBatchSize = ((currentAvg * (batchCount - 1)) + batchSize) / batchCount
  }

  // Performance monitoring
  getMetrics() {
    return {
      ...this.metrics,
      queueSize: this.queryQueue.size,
      processingBatches: this.processingBatches.size,
      efficiency: this.metrics.queriesBatched / Math.max(1, this.metrics.batchesProcessed)
    }
  }

  // Cleanup and shutdown
  async shutdown() {
    // Process remaining batches
    const remainingBatches = Array.from(this.queryQueue.keys())
    
    await Promise.all(
      remainingBatches.map(batchKey => this.processBatch(batchKey))
    )

    this.queryQueue.clear()
    this.processingBatches.clear()
  }

  // Specific VoltChat query optimizations
  async batchMessageInserts(messages) {
    const queries = messages.map(message => ({
      sql: 'INSERT INTO messages (channel_id, user_id, content, timestamp, attachments) VALUES (?, ?, ?, ?, ?)',
      params: [message.channel_id, message.user_id, message.content, message.timestamp, JSON.stringify(message.attachments || [])]
    }))

    return Promise.all(queries.map(query => 
      this.executeQuery(query.sql, query.params)
    ))
  }

  async batchUserProfileUpdates(updates) {
    const queries = updates.map(update => ({
      sql: 'UPDATE users SET last_active = ?, status = ? WHERE id = ?',
      params: [update.last_active, update.status, update.user_id]
    }))

    return Promise.all(queries.map(query => 
      this.executeQuery(query.sql, query.params)
    ))
  }

  async batchChannelMembershipChecks(userId, channelIds) {
    const placeholders = channelIds.map(() => '?').join(', ')
    const sql = `
      SELECT cm.channel_id 
      FROM channel_members cm 
      JOIN channels c ON cm.channel_id = c.id 
      WHERE cm.user_id = ? AND c.id IN (${placeholders})
    `
    
    return this.executeQuery(sql, [userId, ...channelIds], { skipBatch: true })
  }
}

module.exports = QueryBatchingService