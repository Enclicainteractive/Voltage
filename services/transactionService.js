/**
 * VoltChat Transaction Service
 * 
 * Provides transaction management for critical database operations
 * Ensures data consistency and integrity across multiple operations
 */

import { getStorage } from './storageService.js'

class TransactionService {
  constructor() {
    this.activeTransactions = new Map()
  }

  /**
   * Execute a function within a database transaction (alias for executeTransaction)
   * @param {Function} callback - Function to execute within transaction
   * @param {Object} options - Transaction options
   * @returns {Promise<any>} - Result of callback execution
   */
  async withTransaction(callback, options = {}) {
    return this.executeTransaction(callback, options)
  }

  /**
   * Execute a function within a database transaction
   * @param {Function} callback - Function to execute within transaction
   * @param {Object} options - Transaction options
   * @returns {Promise<any>} - Result of callback execution
   */
  async executeTransaction(callback, options = {}) {
    const storage = getStorage()
    const transactionId = this.generateTransactionId()
    
    // Handle different storage backends
    if (storage.type === 'mysql' || storage.type === 'mariadb') {
      return this.executeSqlTransaction(storage, callback, transactionId, options)
    } else if (storage.type === 'sqlite') {
      return this.executeSqliteTransaction(storage, callback, transactionId, options)
    } else {
      // For non-SQL backends, execute without transaction but with error handling
      console.warn('[Transaction] Non-SQL backend detected, executing without transaction')
      return callback()
    }
  }

  /**
   * Execute MySQL/MariaDB transaction
   */
  async executeSqlTransaction(storage, callback, transactionId, options = {}) {
    const connection = await storage.pool.getConnection()
    this.activeTransactions.set(transactionId, { connection, startTime: Date.now() })
    
    try {
      // Set transaction isolation level if specified (must be before beginTransaction)
      if (options.isolationLevel) {
        await connection.execute(`SET SESSION TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`)
      }
      
      // Start transaction
      await connection.beginTransaction()
      
      // Execute the callback with the connection
      const result = await callback(connection)
      
      // Commit transaction
      await connection.commit()
      
      const duration = Date.now() - this.activeTransactions.get(transactionId).startTime
      console.log(`[Transaction] Committed transaction ${transactionId} in ${duration}ms`)
      
      return result
    } catch (error) {
      console.error(`[Transaction] Error in transaction ${transactionId}:`, error.message)
      
      try {
        await connection.rollback()
        console.log(`[Transaction] Rolled back transaction ${transactionId}`)
      } catch (rollbackError) {
        console.error(`[Transaction] Rollback failed for transaction ${transactionId}:`, rollbackError.message)
      }
      
      throw error
    } finally {
      // Clean up
      this.activeTransactions.delete(transactionId)
      connection.release()
    }
  }

  /**
   * Execute SQLite transaction
   */
  async executeSqliteTransaction(storage, callback, transactionId, options = {}) {
    const db = storage.db
    this.activeTransactions.set(transactionId, { db, startTime: Date.now() })
    
    try {
      // Begin transaction
      db.exec('BEGIN IMMEDIATE')
      
      // Execute callback
      const result = await callback(db)
      
      // Commit
      db.exec('COMMIT')
      
      const duration = Date.now() - this.activeTransactions.get(transactionId).startTime
      console.log(`[Transaction] Committed SQLite transaction ${transactionId} in ${duration}ms`)
      
      return result
    } catch (error) {
      console.error(`[Transaction] Error in SQLite transaction ${transactionId}:`, error.message)
      
      try {
        db.exec('ROLLBACK')
        console.log(`[Transaction] Rolled back SQLite transaction ${transactionId}`)
      } catch (rollbackError) {
        console.error(`[Transaction] SQLite rollback failed for transaction ${transactionId}:`, rollbackError.message)
      }
      
      throw error
    } finally {
      this.activeTransactions.delete(transactionId)
    }
  }

  /**
   * Execute multiple operations atomically
   */
  async executeAtomicOperations(operations = [], options = {}) {
    return this.executeTransaction(async (connection) => {
      const results = []
      
      for (const operation of operations) {
        try {
          const result = await operation(connection)
          results.push(result)
        } catch (error) {
          console.error('[Transaction] Operation failed:', error.message)
          throw error // This will trigger rollback
        }
      }
      
      return results
    }, options)
  }

  /**
   * Generate unique transaction ID
   */
  generateTransactionId() {
    return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Get active transaction count (for monitoring)
   */
  getActiveTransactionCount() {
    return this.activeTransactions.size
  }

  /**
   * Get transaction statistics
   */
  getTransactionStats() {
    const transactions = Array.from(this.activeTransactions.values())
    const now = Date.now()
    
    return {
      active: transactions.length,
      longestRunning: transactions.length > 0 
        ? Math.max(...transactions.map(tx => now - tx.startTime))
        : 0,
      averageDuration: transactions.length > 0
        ? transactions.reduce((sum, tx) => sum + (now - tx.startTime), 0) / transactions.length
        : 0
    }
  }
}

// Export singleton instance
export default new TransactionService()