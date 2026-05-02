/**
 * VoltChat Data Service
 * 
 * This module provides the data layer for VoltChat, handling all database operations
 * and serving as the interface between the API routes and the underlying storage.
 * 
 * SUPPORTED STORAGE BACKENDS:
 * - MySQL/MariaDB (recommended for production)
 * - PostgreSQL
 * - SQLite (development only)
 * - MongoDB
 * - Redis
 * 
 * IMPORTANT: JSON file storage is deprecated and will be removed in a future version.
 * Please migrate to a database backend for production use.
 * 
 * @author VoltChat Team
 * @license MIT
 */

import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'
import { getStorage, resetStorage as resetStorageLayer } from './storageService.js'
import redisService from './redisService.js'
import circuitBreakerManager from './circuitBreaker.js'
import { globalCoalescer, messageCache } from './cacheService.js'
import transactionService from './transactionService.js'
import lockService from './lockService.js'
import {
  getAgeVerificationJurisdiction,
  getAgeVerificationJurisdictionCode,
  normalizeAgeVerification
} from '../utils/ageVerificationPolicy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Data directory - determined at runtime from config
// This cannot be a constant because config must be loaded first
// WARNING: Calling this before config.load() will result in incorrect path
let _dataDir = null

// Cache for FILES object to avoid rebuilding on every access
// FILES contains paths to all data files (users.json, servers.json, etc.)
let _filesCache = null

/**
 * Get the data directory path from config
 * @returns {string} Path to data directory
 */
const getDataDir = () => {
  if (_dataDir) return _dataDir
  config.load()
  _dataDir = config.config.storage?.json?.dataDir || path.join(__dirname, '..', '..', 'data')
  return _dataDir
}

// Data directory is no longer used for storage. JSON is deprecated.
// This no-op remains for backward compatibility with buildFiles().
const ensureDataDir = () => {}

// Build the FILES object with correct paths
const buildFiles = () => {
  ensureDataDir()
  const dataDir = getDataDir()
  return {
    users: path.join(dataDir, 'users.json'),
    friends: path.join(dataDir, 'friends.json'),
    friendRequests: path.join(dataDir, 'friend-requests.json'),
    bots: path.join(dataDir, 'bots.json'),
    categories: path.join(dataDir, 'categories.json'),
    e2eKeys: path.join(dataDir, 'e2e-keys.json'),
    dms: path.join(dataDir, 'dms.json'),
    dmMessages: path.join(dataDir, 'dm-messages.json'),
    servers: path.join(dataDir, 'servers.json'),
    channels: path.join(dataDir, 'channels.json'),
    messages: path.join(dataDir, 'messages.json'),
    reactions: path.join(dataDir, 'reactions.json'),
    serverInvites: path.join(dataDir, 'server-invites.json'),
    blocked: path.join(dataDir, 'blocked.json'),
    files: path.join(dataDir, 'files.json'),
    attachments: path.join(dataDir, 'attachments.json'),
    discovery: path.join(dataDir, 'discovery.json'),
    serverEvents: path.join(dataDir, 'server-events.json'),
    globalBans: path.join(dataDir, 'global-bans.json'),
    serverBans: path.join(dataDir, 'server-bans.json'),
    adminLogs: path.join(dataDir, 'admin-logs.json'),
    systemMessages: path.join(dataDir, 'system-messages.json'),
    e2eTrue: path.join(dataDir, 'e2e-true.json'),
    pinnedMessages: path.join(dataDir, 'pinned-messages.json'),
    selfVolts: path.join(dataDir, 'self-volts.json'),
    federation: path.join(dataDir, 'federation.json'),
    serverStart: path.join(dataDir, 'server-start.json'),
    callLogs: path.join(dataDir, 'call-logs.json'),
    reports: path.join(dataDir, 'moderation-reports.json')
  }
}

// Get FILES, building lazily on first access
const getFILES = () => {
  if (!_filesCache) {
    _filesCache = buildFiles()
  }
  return _filesCache
}

// Export FILES as a getter-based object for backward compatibility
export const FILES = new Proxy({}, {
  get(target, prop) {
    const files = getFILES()
    return files[prop]
  },
  ownKeys(target) {
    const files = getFILES()
    return Object.keys(files)
  },
  getOwnPropertyDescriptor(target, prop) {
    const files = getFILES()
    if (prop in files) {
      return { enumerable: true, configurable: true, value: files[prop] }
    }
    return undefined
  }
})

// For backward compatibility, also export getDataDir
export { getDataDir }

let storageService = null
let useStorage = false
let storageCache = {}
let cacheDirty = {}
const REDIS_CACHE_PREFIX = 'volt:data:'
const tableColumnCache = new Map()

// Tables that are too large to keep fully in memory.
// These tables will NOT be preloaded into storageCache during startup;
// instead they are queried on-demand from the database.
const LAZY_TABLES = new Set(['messages', 'dm_messages', 'reactions'])

/**
 * Get a connection from the underlying database pool for direct queries.
 * Returns null if no pool-based backend is available.
 */
const getPoolConnection = async () => {
  if (!storageService?.pool) return null
  try {
    return await storageService.pool.getConnection()
  } catch (err) {
    console.error('[DataService] Failed to get pool connection:', err.message)
    return null
  }
}

/**
 * Execute a direct parameterized query against the database.
 * Automatically acquires and releases a connection from the pool.
 * Protected by circuit breaker to avoid hammering a failing DB.
 * Returns rows on success, null on failure.
 */
const directQueryCache = new Map()
// Optimize: Increased cache TTL for better query performance
const DIRECT_QUERY_CACHE_TTL = 3000

const getDirectQueryCacheKey = (sql, params) => `${sql}:${JSON.stringify(params)}`

const directQuery = async (sql, params = []) => {
  const isSelectQuery = sql.trim().toUpperCase().startsWith('SELECT')
  const isInsertQuery = sql.trim().toUpperCase().startsWith('INSERT')
  
  if (isSelectQuery) {
    const cacheKey = getDirectQueryCacheKey(sql, params)
    const cached = directQueryCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < DIRECT_QUERY_CACHE_TTL) {
      return cached.rows
    }
  }

  try {
    if (storageService?.type === 'sqlite' && storageService?.db) {
      let result
      if (isSelectQuery) {
        result = storageService.db.prepare(sql).all(...params)
      } else if (isInsertQuery) {
        result = storageService.db.prepare(sql).run(...params)
      } else {
        result = storageService.db.prepare(sql).run(...params)
      }

      if (isSelectQuery && result) {
        const cacheKey = getDirectQueryCacheKey(sql, params)
        directQueryCache.set(cacheKey, { rows: result, timestamp: Date.now() })
        setTimeout(() => {
          directQueryCache.delete(cacheKey)
        }, DIRECT_QUERY_CACHE_TTL + 500)
      }

      return result
    }

    const result = await circuitBreakerManager.execute('db:query', async () => {
      const conn = await getPoolConnection()
      if (!conn) throw new Error('No pool connection available')
      try {
        const rows = await conn.query(sql, params)
        return rows
      } finally {
        conn.release()
      }
    }, { failureThreshold: 20, resetTimeout: 10000 })

    if (isSelectQuery && result) {
      const cacheKey = getDirectQueryCacheKey(sql, params)
      directQueryCache.set(cacheKey, { rows: result, timestamp: Date.now() })
      setTimeout(() => {
        directQueryCache.delete(cacheKey)
      }, DIRECT_QUERY_CACHE_TTL + 500)
    }

    return result
  } catch (err) {
    if (err.message === 'Circuit breaker is OPEN') {
      console.warn('[DataService] Circuit breaker OPEN - DB may be overloaded')
    } else {
      console.error('[DataService] Direct query error:', err.message, '| SQL:', sql.substring(0, 100))
    }
    return null
  }
}

/**
 * Check whether we can use direct DB queries (pool-backed storage).
 */
const supportsDirectQuery = () => {
  if (!useStorage) return false
  const storage = getStorage()
  // SQLite uses .db, other databases use .pool
  if (storage?.type === 'sqlite') {
    return !!storage?.db
  }
  return !!storage?.pool
}

const getDirectTableColumns = async (table) => {
  const cacheKey = String(table || '').trim()
  if (!cacheKey) return []
  if (tableColumnCache.has(cacheKey)) return tableColumnCache.get(cacheKey)

  if (!supportsDirectQuery()) return []

  try {
    let rows = await directQuery(`SHOW COLUMNS FROM ${cacheKey}`)
    if (Array.isArray(rows) && rows.length > 0) {
      const columns = rows.map(row => row?.Field || row?.field || row?.COLUMN_NAME || row?.column_name).filter(Boolean)
      tableColumnCache.set(cacheKey, columns)
      return columns
    }
  } catch {
    // Ignore and fall through to empty result.
  }

  return []
}

const resolveMessageTimeColumn = async () => {
  const columns = await getDirectTableColumns('messages')
  if (columns.includes('timestamp')) return 'timestamp'
  if (columns.includes('createdAt')) return 'createdAt'
  return 'timestamp'
}

// Lazy-built lookup maps
let _fileToTableCache = null
let _managedDataFilesCache = null
let _storageTablesCache = null

const getFileToTable = () => {
  if (!_fileToTableCache) {
    const files = getFILES()
    _fileToTableCache = {
      [files.users]: 'users',
      [files.friends]: 'friends',
      [files.friendRequests]: 'friend_requests',
      [files.bots]: 'bots',
      [files.categories]: 'categories',
      [files.e2eKeys]: 'e2e_keys',
      [files.servers]: 'servers',
      [files.channels]: 'channels',
      [files.messages]: 'messages',
      [files.serverInvites]: 'invites',
      [files.dms]: 'dms',
      [files.dmMessages]: 'dm_messages',
      [files.reactions]: 'reactions',
      [files.blocked]: 'blocked',
      [files.files]: 'files',
      [files.attachments]: 'attachments',
      [files.discovery]: 'discovery',
      [files.serverEvents]: 'server_events',
      [files.globalBans]: 'global_bans',
      [files.serverBans]: 'server_bans',
      [files.adminLogs]: 'admin_logs',
      [files.systemMessages]: 'system_messages',
      [files.e2eTrue]: 'e2e_true_state',
      [files.pinnedMessages]: 'pinned_messages',
      [files.selfVolts]: 'self_volts',
      [files.federation]: 'federation',
      [files.serverStart]: 'server_start',
      [files.callLogs]: 'call_logs',
      [files.reports]: 'moderation_reports'
    }
  }
  return _fileToTableCache
}

const getManagedDataFiles = () => {
  if (!_managedDataFilesCache) {
    const fileToTable = getFileToTable()
    _managedDataFilesCache = new Set(
      Object.keys(fileToTable).map(filePath => path.resolve(filePath))
    )
  }
  return _managedDataFilesCache
}

const getStorageTables = () => {
  if (!_storageTablesCache) {
    _storageTablesCache = Object.values(getFileToTable())
  }
  return _storageTablesCache
}

const assertKnownStorageTable = (table) => {
  const normalized = String(table || '').trim()
  if (!/^[a-z0-9_]+$/i.test(normalized)) {
    throw new Error(`Unsafe table name: ${table}`)
  }
  if (!getStorageTables().includes(normalized)) {
    throw new Error(`Unknown table name: ${table}`)
  }
  return normalized
}

// For backward compatibility with code that uses these as constants
const FILE_TO_TABLE = new Proxy({}, {
  get(target, prop) {
    return getFileToTable()[prop]
  },
  ownKeys() {
    return Object.keys(getFileToTable())
  }
})

const MANAGED_DATA_FILES = new Set() // Placeholder, use getManagedDataFiles() function
const STORAGE_TABLES = [] // Placeholder, use getStorageTables() function

const isObjectLike = (value) => value && typeof value === 'object' && !Array.isArray(value)

const hasAnyData = (value) => {
  if (Array.isArray(value)) return value.length > 0
  if (isObjectLike(value)) return Object.keys(value).length > 0
  return Boolean(value)
}

const countDataEntries = (value) => {
  if (Array.isArray(value)) return value.length
  if (isObjectLike(value)) return Object.keys(value).length
  return value ? 1 : 0
}

const cloneData = (value) => {
  if (value === null || typeof value === 'undefined') return value
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }
}

const getRedisCacheKey = (table) => `${REDIS_CACHE_PREFIX}${table}`

const loadTableFromRedisCache = async (table) => {
  if (!redisService.isReady()) return undefined
  const cached = await redisService.get(getRedisCacheKey(table))
  // redisService.get returns null when key doesn't exist or on error.
  // We must return undefined in that case so loadAllData falls through
  // to the actual database query instead of using empty defaults.
  if (cached === null || cached === undefined) return undefined
  return cached
}

const writeTableToRedisCache = async (table, data) => {
  if (!redisService.isReady()) return false
  return await redisService.set(getRedisCacheKey(table), data)
}

const normalizeLegacyKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalizeLegacyKeys)
  }
  if (!isObjectLike(value)) return value

  const normalized = {}
  for (const [key, child] of Object.entries(value)) {
    const nextKey = key === 'Host' ? 'host' : key
    const nextVal = normalizeLegacyKeys(child)
    if (nextKey === 'host' && typeof normalized.host !== 'undefined') continue
    normalized[nextKey] = nextVal
  }
  return normalized
}

// DEPRECATED: JSON file loading removed. DB is the single source of truth.
const loadJsonFileDirect = (_file, defaultValue = {}) => {
  return defaultValue
}

const mergeMissingEntries = (currentValue, incomingValue) => {
  if (Array.isArray(currentValue) && Array.isArray(incomingValue)) {
    if (currentValue.length > 0) return { merged: currentValue, changed: false }
    return { merged: incomingValue, changed: incomingValue.length > 0 }
  }

  const current = isObjectLike(currentValue) ? currentValue : {}
  const incoming = isObjectLike(incomingValue) ? incomingValue : {}
  let changed = false
  const merged = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof merged[key] === 'undefined') {
      merged[key] = value
      changed = true
    }
  }
  return { merged, changed }
}

// DEPRECATED: JSON auto-migration removed. DB is the single source of truth.
// If you still have JSON files, use the migrate script to import them.
const autoMigrateJsonToStorage = async () => {
  // No-op: JSON files are no longer read or migrated at runtime
}

// JSON STORAGE IS DEPRECATED.
// 
// if you're still using JSON files, i'm sorry.
// i was sorry then too. but now im MORE sorry.
// 
// we tried to make JSON work. we really did. 
// but JSON + multiple server instances = DATA CORRUPTION
// and data corruption = CUSTOMERS LEAVING
// customers leaving = ME GETTING FIRED
// ME GETTING FIRED = BAD
// 
// so now we REQUIRE a database. MySQL, MariaDB, PostgreSQL, whatever.
// just NOT json. please. i BEG you.
// 
// if you try to use JSON after this change, the server will REFUSE to start.
// this is for your own good. you'll thank me later.
// (you won't. but that's okay.)

// Get storage reference from storageService (initialized by server.js)
// 
// this function is called whenever we need database access
// it gets the storage service that was set up during startup
// 
// if you're wondering why this is a function and not just a variable:
// because the storage service is initialized asynchronously
// and we need to make sure it's ready before we use it
// 
// also we throw if JSON is detected because AGAIN, JSON IS DEPRECATED
// we will NOT support JSON. stop asking. (nobody asked. im just frustrated.)
const refreshStorageRef = () => {
  storageService = getStorage()
  if (!storageService || storageService.type === 'json') {
    throw new Error('[DataService] JSON storage is deprecated. Please configure a database (MySQL/MariaDB, PostgreSQL, etc.) in config.json')
  }
  useStorage = true
  return storageService
}

// Initialize storage - called during server startup
// 
// this is where the magic happens
// we load config, connect to database, load all existing data into memory
// 
// the data loading is important because:
// 1. its faster to read from memory than database every time
// 2. we don't want to hammer the database with queries
// 3. honestly mostly reason 1 honestly
// 
// if this fails, the server won't start
// which is GOOD because trying to run with broken storage is a NIGHTMARE
const initStorage = async ({ forceReinit = false } = {}) => {
  try {
    // Config is already loaded by server.js, but call it again to be safe
    if (!config.config) {
      config.load()
    }
    if (forceReinit && resetStorageLayer) {
      await resetStorageLayer()
    }
    storageService = getStorage()
    
    // JSON DETECTION - DONT EVEN TRY
    // i mean it. don't. just don't.
    if (!storageService || storageService.type === 'json') {
      throw new Error('[DataService] JSON storage is deprecated. Please configure a database (MySQL/MariaDB, PostgreSQL, etc.) in config.json')
    }
    
    useStorage = true
    storageCache = {}
    
    console.log('[DataService] Using storage layer:', storageService.type)
    await loadAllData()
  } catch (err) {
    console.error('[DataService] Storage initialization error:', err.message)
    console.error('[DataService] Stack:', err.stack)
    throw err
  }
}

const isAsyncStorageBackend = (type = '') => {
  return type === 'mongodb' ||
    type === 'redis' ||
    type === 'mariadb' ||
    type === 'cockroachdb' ||
    type === 'mssql' ||
    type?.startsWith('mysql') ||
    type?.startsWith('postgres')
}

const isEmptyData = (data) => {
  if (data === null || data === undefined) return true
  if (Array.isArray(data)) return data.length === 0
  if (typeof data === 'object') return Object.keys(data).length === 0
  return false
}

/**
 * Load all data from the database into the in-memory cache.
 * 
 * Architecture: DB is the SINGLE SOURCE OF TRUTH.
 * - Redis is a write-through cache for fast reads only
 * - On startup, we ALWAYS load from DB to ensure consistency
 * - After loading from DB, we update the Redis cache
 * - Redis cache misses are expected and not a problem
 */
const loadAllData = async () => {
  if (!useStorage || !storageService) return
  
  for (const table of getStorageTables()) {
    // Skip large tables when we have a pool-based backend - they will be
    // queried on-demand instead of being loaded entirely into memory.
    if (LAZY_TABLES.has(table) && supportsDirectQuery()) {
      console.log(`[DataService] Skipping preload for large table: ${table} (will query on-demand)`)
      storageCache[table] = {} // keep a minimal cache for incremental updates
      continue
    }

    try {
      // ALWAYS load from DB - it is the single source of truth
      let loaded
      if (isAsyncStorageBackend(storageService.type)) {
        loaded = await storageService.load(table, {})
      } else {
        loaded = storageService.load(table, {})
      }
      
      storageCache[table] = cloneData(loaded ?? {})
      
      // Write to Redis as a cache layer (fire-and-forget, non-blocking)
      if (!isEmptyData(loaded)) {
        writeTableToRedisCache(table, loaded).catch(err => {
          console.warn(`[DataService] Failed to cache ${table} in Redis:`, err.message)
        })
      }
    } catch (err) {
      console.error(`[DataService] Error loading ${table}:`, err.message)
      storageCache[table] = {}
    }
  }
}

// Debounce/throttle for saves to prevent cascading saves
const saveDebounceTimers = new Map()
const SAVE_DEBOUNCE_MS = 100 // Wait 100ms before saving to batch multiple saves

const saveToStorage = async (table, data) => {
  if (!useStorage || !storageService) {
    console.error(`[DataService] Cannot save - no storage configured for table: ${table}`)
    return false
  }
  
  // Clear any existing debounce timer for this table
  if (saveDebounceTimers.has(table)) {
    clearTimeout(saveDebounceTimers.get(table))
  }
  
  // Set a new debounced save
  return new Promise((resolve) => {
    saveDebounceTimers.set(table, setTimeout(async () => {
      try {
        const payload = cloneData(data)
        let result
        if (isAsyncStorageBackend(storageService.type)) {
          result = await circuitBreakerManager.execute(`db:save:${table}`, async () => {
            return await storageService.save(table, payload)
          }, { failureThreshold: 3, resetTimeout: 15000 })
        } else {
          result = storageService.save(table, payload)
        }
        
        if (result) {
          // Update Redis cache (fire-and-forget, don't block on it)
          writeTableToRedisCache(table, payload).catch(err => {
            console.warn(`[DataService] Redis cache update failed for ${table}:`, err.message)
          })
        }
        console.log(`[DataService] Saved ${table}: ${Object.keys(payload || {}).length} records`)
        saveDebounceTimers.delete(table)
        resolve(result)
      } catch (err) {
        console.error(`[DataService] Error saving ${table}:`, err.message)
        saveDebounceTimers.delete(table)
        resolve(false)
      }
    }, SAVE_DEBOUNCE_MS))
  })
}

const loadData = (file, defaultValue = {}) => {
  if (!useStorage || !storageService) {
    throw new Error('[DataService] Database not configured. Please configure MySQL/MariaDB in config.json')
  }
  
  const table = getTableName(file)
  
  // Return from in-memory cache if populated with actual data.
  // For LAZY_TABLES (messages, dm_messages, reactions), the cache is {} by design
  // when skipped during preloading, indicating we should query on-demand.
  if (storageCache[table] !== undefined) {
    // If this is a lazy table and the cache is just {} (from skipping preload),
    // we need to query on-demand
    if (LAZY_TABLES.has(table) && Object.keys(storageCache[table]).length === 0) {
      // Query on-demand for lazy tables
      const result = loadFromIndividualTable(table, defaultValue)
      // Update cache with the result for future calls
      storageCache[table] = cloneData(result)
      return cloneData(result)
    }
    return cloneData(storageCache[table])
  }
  
  // For async backends, the cache should have been populated during loadAllData().
  // If we reach here, it means the table wasn't preloaded. Set default and log a warning.
  if (isAsyncStorageBackend(storageService.type)) {
    console.warn(`[DataService] Cache miss for table '${table}' on async backend. This should not happen - data should be preloaded.`)
    storageCache[table] = cloneData(defaultValue)
    return cloneData(defaultValue)
  }
  
  // Sync backends (SQLite) - load directly from DB
  const result = loadFromIndividualTable(table, defaultValue)
  storageCache[table] = cloneData(result)
  return cloneData(result)
}

/**
 * Load data by reference (no clone). Use ONLY for read-only access patterns
 * where the caller will NOT mutate the returned object. This avoids the
 * O(n) structuredClone overhead on large datasets.
 */
const loadDataRef = (file, defaultValue = {}) => {
  if (!useStorage || !storageService) {
    throw new Error('[DataService] Database not configured.')
  }
  const table = getTableName(file)
  if (storageCache[table] !== undefined) {
    return storageCache[table]
  }
  return defaultValue
}

const loadFreshData = async (file, defaultValue = {}) => {
  const table = getTableName(file)

  if (!useStorage || !storageService) {
    return loadData(file, defaultValue)
  }

  if (isAsyncStorageBackend(storageService.type)) {
    try {
      const loaded = await storageService.load(table, defaultValue)
      const normalized = cloneData(loaded ?? defaultValue)
      storageCache[table] = normalized
      return cloneData(normalized)
    } catch (err) {
      console.error(`[DataService] Error loading fresh ${table}:`, err.message)
      return cloneData(defaultValue)
    }
  }

  return loadData(file, defaultValue)
}

const isSqliteBackend = () => storageService?.type === 'sqlite' && storageService?.db
const isMysqlBackend = () => storageService?.type === 'mysql' && storageService?.pool
const isMariadbBackend = () => storageService?.type === 'mariadb' && storageService?.pool
const supportsIncrementalFriendStorage = () => useStorage && (isSqliteBackend() || isMysqlBackend() || isMariadbBackend())

const getSqlColumnNameSet = (rows = []) => new Set(
  (rows || []).map(row => row?.Field || row?.field || row?.COLUMN_NAME || row?.column_name || row).filter(Boolean)
)

const updateFriendsCache = (userId, friendId, shouldAdd) => {
  const table = 'friends'
  const friends = cloneData(storageCache[table] || {})
  if (!Array.isArray(friends[userId])) friends[userId] = []
  if (!Array.isArray(friends[friendId])) friends[friendId] = []

  if (shouldAdd) {
    if (!friends[userId].includes(friendId)) friends[userId].push(friendId)
    if (!friends[friendId].includes(userId)) friends[friendId].push(userId)
  } else {
    friends[userId] = friends[userId].filter(id => id !== friendId)
    friends[friendId] = friends[friendId].filter(id => id !== userId)
  }

  storageCache[table] = friends
  cacheDirty[table] = false
  return friends
}

const updateFriendRequestsCache = (mutator) => {
  const table = 'friend_requests'
  const requests = cloneData(storageCache[table] || { incoming: {}, outgoing: {} })
  if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
  if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
  mutator(requests)
  storageCache[table] = requests
  cacheDirty[table] = false
  return requests
}

const executeIncrementalStorageWrite = async ({ sqlite, mysql, mariadb }) => {
  if (isSqliteBackend()) {
    sqlite(storageService.db)
    return true
  }

  if (isMysqlBackend()) {
    const conn = await storageService.pool.getConnection()
    try {
      await mysql(conn)
      return true
    } finally {
      conn.release()
    }
  }

  if (isMariadbBackend()) {
    const conn = await storageService.pool.getConnection()
    try {
      await mariadb(conn)
      return true
    } finally {
      conn.release()
    }
  }

  return false
}

const addFriendRows = async (userId, friendId) => {
  if (!supportsIncrementalFriendStorage()) return false

  const createdAt = new Date().toISOString()
  await executeIncrementalStorageWrite({
    sqlite: (db) => {
      const columnRows = db.prepare(`PRAGMA table_info(friends)`).all()
      const availableColumns = getSqlColumnNameSet(columnRows.map(row => row?.name))
      const insertColumns = availableColumns.has('createdAt')
        ? ['userId', 'friendId', 'createdAt']
        : ['userId', 'friendId']
      const placeholders = insertColumns.map(() => '?').join(', ')
      const stmt = db.prepare(`INSERT OR IGNORE INTO friends (${insertColumns.join(', ')}) VALUES (${placeholders})`)
      const forward = insertColumns.includes('createdAt')
        ? [userId, friendId, createdAt]
        : [userId, friendId]
      const reverse = insertColumns.includes('createdAt')
        ? [friendId, userId, createdAt]
        : [friendId, userId]
      stmt.run(forward)
      stmt.run(reverse)
    },
    mysql: async (conn) => {
      const [columnRows] = await conn.query(`SHOW COLUMNS FROM friends`)
      const availableColumns = getSqlColumnNameSet(columnRows)
      const insertColumns = availableColumns.has('createdAt')
        ? ['userId', 'friendId', 'createdAt']
        : ['userId', 'friendId']
      const placeholders = `(${insertColumns.map(() => '?').join(', ')})`
      const values = insertColumns.includes('createdAt')
        ? [userId, friendId, createdAt, friendId, userId, createdAt]
        : [userId, friendId, friendId, userId]
      await conn.execute(
        `INSERT IGNORE INTO friends (${insertColumns.join(', ')}) VALUES ${placeholders}, ${placeholders}`,
        values
      )
    },
    mariadb: async (conn) => {
      const columnRows = await conn.query(`SHOW COLUMNS FROM friends`)
      const availableColumns = getSqlColumnNameSet(columnRows)
      const insertColumns = availableColumns.has('createdAt')
        ? ['userId', 'friendId', 'createdAt']
        : ['userId', 'friendId']
      const placeholders = `(${insertColumns.map(() => '?').join(', ')})`
      const values = insertColumns.includes('createdAt')
        ? [userId, friendId, createdAt, friendId, userId, createdAt]
        : [userId, friendId, friendId, userId]
      await conn.query(
        `INSERT IGNORE INTO friends (${insertColumns.join(', ')}) VALUES ${placeholders}, ${placeholders}`,
        values
      )
    }
  })

  const friends = updateFriendsCache(userId, friendId, true)
  await writeTableToRedisCache('friends', friends)
  return true
}

const removeFriendRows = async (userId, friendId) => {
  if (!supportsIncrementalFriendStorage()) return false

  await executeIncrementalStorageWrite({
    sqlite: (db) => {
      db.prepare('DELETE FROM friends WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)').run(userId, friendId, friendId, userId)
    },
    mysql: async (conn) => {
      await conn.execute(
        'DELETE FROM friends WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)',
        [userId, friendId, friendId, userId]
      )
    },
    mariadb: async (conn) => {
      await conn.query(
        'DELETE FROM friends WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)',
        [userId, friendId, friendId, userId]
      )
    }
  })

  const friends = updateFriendsCache(userId, friendId, false)
  await writeTableToRedisCache('friends', friends)
  return true
}

const insertFriendRequestRow = async (request) => {
  if (!supportsIncrementalFriendStorage()) return false

  const createdAt = request.createdAt || new Date().toISOString()
  await executeIncrementalStorageWrite({
    sqlite: (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO friend_requests
        (id, fromUserId, toUserId, createdAt)
        VALUES (?, ?, ?, ?)
      `).run(
        request.id,
        request.from,
        request.to,
        createdAt
      )
    },
    mysql: async (conn) => {
      await conn.execute(`
        INSERT INTO friend_requests
        (id, fromUserId, toUserId, createdAt)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          fromUserId = VALUES(fromUserId),
          toUserId = VALUES(toUserId),
          createdAt = VALUES(createdAt)
      `, [
        request.id,
        request.from,
        request.to,
        createdAt
      ])
    },
    mariadb: async (conn) => {
      await conn.query(`
        INSERT INTO friend_requests
        (id, fromUserId, toUserId, createdAt)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          fromUserId = VALUES(fromUserId),
          toUserId = VALUES(toUserId),
          createdAt = VALUES(createdAt)
      `, [
        request.id,
        request.from,
        request.to,
        createdAt
      ])
    }
  })

  const requests = updateFriendRequestsCache((state) => {
    if (!Array.isArray(state.incoming[request.to])) state.incoming[request.to] = []
    if (!Array.isArray(state.outgoing[request.from])) state.outgoing[request.from] = []
    state.incoming[request.to] = state.incoming[request.to].filter(r => r.id !== request.id)
    state.outgoing[request.from] = state.outgoing[request.from].filter(r => r.id !== request.id)
    state.incoming[request.to].push({ ...request })
    state.outgoing[request.from].push({ ...request })
  })
  await writeTableToRedisCache('friend_requests', requests)
  return true
}

const deleteFriendRequestRow = async (requestId) => {
  if (!supportsIncrementalFriendStorage()) return false

  await executeIncrementalStorageWrite({
    sqlite: (db) => {
      db.prepare('DELETE FROM friend_requests WHERE id = ?').run(requestId)
    },
    mysql: async (conn) => {
      await conn.execute('DELETE FROM friend_requests WHERE id = ?', [requestId])
    },
    mariadb: async (conn) => {
      await conn.query('DELETE FROM friend_requests WHERE id = ?', [requestId])
    }
  })

  const requests = updateFriendRequestsCache((state) => {
    Object.keys(state.incoming).forEach((userId) => {
      state.incoming[userId] = (state.incoming[userId] || []).filter(r => r.id !== requestId)
    })
    Object.keys(state.outgoing).forEach((userId) => {
      state.outgoing[userId] = (state.outgoing[userId] || []).filter(r => r.id !== requestId)
    })
  })
  await writeTableToRedisCache('friend_requests', requests)
  return true
}

// Load from individual table (after distribution) or fall back to storage_kv
// Load from the database directly via storageService.
// No JSON file or storage_kv fallbacks - DB is the single source of truth.
const loadFromIndividualTable = (table, defaultValue = {}) => {
  if (!storageService) {
    return defaultValue
  }
  
  try {
    table = assertKnownStorageTable(table)
    // All backends use storageService.load() which queries individual tables directly
    return storageService.load(table, defaultValue)
  } catch (err) {
    console.error(`[Data] Error loading ${table}:`, err.message)
    return defaultValue
  }
}

const saveData = async (file, data) => {
  if (!useStorage || !storageService) {
    throw new Error('[DataService] Database not configured. Cannot save data without a database backend.')
  }
  
  const table = getTableName(file)
  const payload = cloneData(data)
  const saved = await saveToStorage(table, payload)
  if (saved) {
    storageCache[table] = payload
    cacheDirty[table] = false
  } else {
    cacheDirty[table] = true
  }
  return saved
}

const getTableName = (file) => {
  return FILE_TO_TABLE[file] || file
}

export { supportsDirectQuery, directQuery, saveData }

export const migrateData = async (sourceType, targetConfig) => {
  const results = { success: true, tables: {}, errors: [] }
  
  try {
    for (const [file, tableName] of Object.entries({
      [FILES.users]: 'users',
      [FILES.friends]: 'friends',
      [FILES.friendRequests]: 'friend_requests',
      [FILES.bots]: 'bots',
      [FILES.categories]: 'categories',
      [FILES.e2eKeys]: 'e2e_keys',
      [FILES.servers]: 'servers',
      [FILES.channels]: 'channels',
      [FILES.messages]: 'messages',
      [FILES.serverInvites]: 'invites',
      [FILES.dms]: 'dms',
      [FILES.dmMessages]: 'dm_messages',
      [FILES.reactions]: 'reactions',
      [FILES.blocked]: 'blocked',
      [FILES.files]: 'files',
      [FILES.attachments]: 'attachments',
      [FILES.discovery]: 'discovery',
      [FILES.serverEvents]: 'server_events',
      [FILES.globalBans]: 'global_bans',
      [FILES.serverBans]: 'server_bans',
      [FILES.adminLogs]: 'admin_logs',
      [FILES.federation]: 'federation'
    })) {
      try {
        const data = loadData(file, {})
        results.tables[tableName] = Object.keys(data).length
      } catch (err) {
        results.errors.push(`${tableName}: ${err.message}`)
      }
    }
  } catch (err) {
    results.success = false
    results.errors.push(err.message)
  }
  
  return results
}

export const getStorageInfo = () => {
  return {
    type: useStorage ? (storageService?.type || 'unknown') : 'none',
    provider: storageService?.provider || 'none',
    usingStorage: useStorage
  }
}

export const reloadData = async () => {
  if (useStorage) {
    await loadAllData()
  }
}

export const reinitializeStorage = async () => {
  await initStorage({ forceReinit: true })
}

export const exportAllData = () => {
  const data = {}
  const fileToTable = FILE_TO_TABLE
  
  for (const [file, table] of Object.entries(fileToTable)) {
    try {
      data[table] = loadData(file, {})
    } catch (err) {
      console.error(`[Data] Error exporting ${table}:`, err.message)
      data[table] = {}
    }
  }
  
  return data
}

export const importAllData = async (data) => {
  const results = { success: true, tables: {}, errors: [] }
  const tableToFile = {
    users: FILES.users,
    friends: FILES.friends,
    friend_requests: FILES.friendRequests,
    bots: FILES.bots,
    categories: FILES.categories,
    e2e_keys: FILES.e2eKeys,
    servers: FILES.servers,
    channels: FILES.channels,
    messages: FILES.messages,
    invites: FILES.serverInvites,
    dms: FILES.dms,
    dm_messages: FILES.dmMessages,
    reactions: FILES.reactions,
    blocked: FILES.blocked,
    files: FILES.files,
    attachments: FILES.attachments,
    discovery: FILES.discovery,
    server_events: FILES.serverEvents,
    global_bans: FILES.globalBans,
    server_bans: FILES.serverBans,
    admin_logs: FILES.adminLogs,
    system_messages: FILES.systemMessages,
    e2e_true: FILES.e2eTrue,
    e2e_true_state: FILES.e2eTrue,
    pinned_messages: FILES.pinnedMessages,
    self_volts: FILES.selfVolts,
    federation: FILES.federation,
    server_start: FILES.serverStart,
    call_logs: FILES.callLogs
  }
  const handledTables = new Set(Object.keys(tableToFile))
  
  for (const [table, file] of Object.entries(tableToFile)) {
    try {
      if (data[table]) {
        const normalizedData = normalizeLegacyKeys(data[table])
        const persisted = await saveData(file, normalizedData)
        if (persisted === false) {
          throw new Error('Storage layer reported save failure')
        }
        results.tables[table] = Object.keys(normalizedData || {}).length
      } else {
        results.tables[table] = 0
      }
    } catch (err) {
      results.errors.push(`${table}: ${err.message}`)
    }
  }

  // Preserve any additional JSON-derived tables even when they are not yet
  // first-class files/routes, so "migrate everything" does not drop data.
  for (const [table, payload] of Object.entries(data || {})) {
    if (handledTables.has(table)) continue
    try {
      if (!useStorage) {
        results.tables[table] = countDataEntries(payload)
        continue
      }
      const normalizedData = normalizeLegacyKeys(payload ?? {})
      storageCache[table] = normalizedData
      await saveToStorage(table, normalizedData)
      results.tables[table] = countDataEntries(normalizedData)
    } catch (err) {
      results.errors.push(`${table}: ${err.message}`)
    }
  }

  if (results.errors.length > 0) {
    results.success = false
  }
  
  return results
}

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PRIVILEGED_USER_FIELDS = new Set(['adminRole', 'role', 'isAdmin', 'isModerator'])

const sanitizeUserMutation = (updates, { allowPrivilegeUpdates = false, allowCreatedAt = false } = {}) => {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return {}

  const sanitized = {}
  for (const [key, value] of Object.entries(updates)) {
    if (typeof key !== 'string') continue
    if (UNSAFE_OBJECT_KEYS.has(key)) continue
    if (key === 'id' || key === 'updatedAt') continue
    if (key === 'createdAt' && !allowCreatedAt) continue
    if (PRIVILEGED_USER_FIELDS.has(key) && !allowPrivilegeUpdates) continue
    sanitized[key] = value
  }

  return sanitized
}

const resolveStoredFlag = (value, fallback = 0) => {
  if (value === 1 || value === true || value === '1') return 1
  if (value === 0 || value === false || value === '0') return 0
  if (fallback === 1 || fallback === true || fallback === '1') return 1
  return 0
}

export const userService = {
  getUser(userId) {
    const users = loadDataRef(FILES.users, {})
    const raw = users[userId]
    if (!raw) return null

    // Shallow copy to avoid mutating the cache reference
    const user = { ...raw }

    if (typeof user.ageVerification === 'string') {
      try {
        user.ageVerification = JSON.parse(user.ageVerification)
      } catch {
        if (user.ageVerification === 'adult' || user.ageVerification === 'child') {
          user.ageVerification = {
            verified: true,
            category: user.ageVerification
          }
        }
      }
    }

    return {
      ...user,
      ageVerificationJurisdiction: getAgeVerificationJurisdictionCode(user, user.ageVerification),
      ageVerification: normalizeAgeVerification(user.ageVerification, user)
    }
  },

  async saveUser(userId, userData, options = {}) {
    const allowPrivilegeUpdates = options?.allowPrivilegeUpdates === true
    const safeUserData = sanitizeUserMutation(userData, { allowPrivilegeUpdates, allowCreatedAt: true })
    // Always read fresh from storage to avoid cluster cache race conditions
    // where multiple workers each have stale in-memory caches.
    const table = getTableName(FILES.users)
    const freshUsersResult = await loadFreshData(FILES.users, {})
    const freshUsers = isObjectLike(freshUsersResult) ? freshUsersResult : {}
    // Keep the in-memory cache aligned with the just-refreshed table snapshot.
    storageCache[table] = cloneData(freshUsers)
    const existingUser = freshUsers[userId]
    
    // CRITICAL: Preserve ALL existing user data, only override with explicitly provided fields
    const nextAdminRole = allowPrivilegeUpdates
      ? (safeUserData.adminRole ?? existingUser?.adminRole ?? null)
      : (existingUser?.adminRole ?? null)
    const nextIsAdmin = allowPrivilegeUpdates
      ? resolveStoredFlag(safeUserData.isAdmin, existingUser?.isAdmin)
      : resolveStoredFlag(existingUser?.isAdmin, 0)
    const nextIsModerator = allowPrivilegeUpdates
      ? resolveStoredFlag(safeUserData.isModerator, existingUser?.isModerator)
      : resolveStoredFlag(existingUser?.isModerator, 0)

    freshUsers[userId] = {
      ...existingUser,  // Start with ALL existing data
      ...safeUserData,  // Override with validated data
      id: userId,       // Always ensure ID is set
      // Privileged fields can only be changed by trusted internal callers.
      adminRole: nextAdminRole,
      isAdmin: nextIsAdmin,
      isModerator: nextIsModerator,
      // CRITICAL: Preserve birthDate - prefer existing over new
      birthDate: existingUser?.birthDate ?? safeUserData.birthDate ?? null,
      updatedAt: new Date().toISOString()
    }
    if (!freshUsers[userId].createdAt) {
      freshUsers[userId].createdAt = new Date().toISOString()
    }
    await saveData(FILES.users, freshUsers)
    return freshUsers[userId]
  },

  async updateProfile(userId, updates, options = {}) {
    const allowPrivilegeUpdates = options?.allowPrivilegeUpdates === true
    const safeUpdates = sanitizeUserMutation(updates, { allowPrivilegeUpdates })
    // Use atomic operation to prevent race conditions
    return transactionService.executeTransaction(async (connection) => {
      // Reload fresh data within transaction to prevent stale data issues
      const users = loadData(FILES.users, {})
      const existingUser = users[userId]
      
      if (!existingUser) {
        users[userId] = { id: userId, createdAt: new Date().toISOString() }
      }
      const baseUser = users[userId] || existingUser || { id: userId, createdAt: new Date().toISOString() }
      
      // CRITICAL: Preserve ALL existing user data, only override with explicitly provided fields
      const nextAdminRole = allowPrivilegeUpdates
        ? (safeUpdates.adminRole ?? baseUser?.adminRole ?? null)
        : (baseUser?.adminRole ?? null)
      const nextIsAdmin = allowPrivilegeUpdates
        ? resolveStoredFlag(safeUpdates.isAdmin, baseUser?.isAdmin)
        : resolveStoredFlag(baseUser?.isAdmin, 0)
      const nextIsModerator = allowPrivilegeUpdates
        ? resolveStoredFlag(safeUpdates.isModerator, baseUser?.isModerator)
        : resolveStoredFlag(baseUser?.isModerator, 0)

      const updatedUser = {
        ...baseUser,      // Start with ALL existing data
        ...safeUpdates,   // Override with validated data
        id: userId,       // Always ensure ID is set
        // Privileged fields can only be changed by trusted internal callers.
        adminRole: nextAdminRole,
        isAdmin: nextIsAdmin,
        isModerator: nextIsModerator,
        // CRITICAL: Preserve birthDate - prefer existing over new
        birthDate: baseUser?.birthDate ?? safeUpdates.birthDate ?? null,
        updatedAt: new Date().toISOString()
      }
      
      users[userId] = updatedUser
      await saveData(FILES.users, users)
      
      console.log(`[Transaction] Updated profile for user ${userId}`)
      return updatedUser
    }, { isolationLevel: 'READ COMMITTED' })
  },

  /**
   * Optimistic locking version of updateProfile for high-concurrency scenarios
   */
  async updateProfileOptimistic(userId, updates, maxRetries = 3, options = {}) {
    const allowPrivilegeUpdates = options?.allowPrivilegeUpdates === true
    const safeUpdates = sanitizeUserMutation(updates, { allowPrivilegeUpdates })
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Load current version with timestamp
        const users = loadData(FILES.users, {})
        const existingUser = users[userId]
        const currentVersion = existingUser?.updatedAt || new Date().toISOString()
        
        if (!existingUser) {
          users[userId] = { id: userId, createdAt: new Date().toISOString() }
        }
        const baseUser = users[userId] || existingUser || { id: userId, createdAt: new Date().toISOString() }
        
        // Create updated user with version check
        const now = new Date().toISOString()
        const nextAdminRole = allowPrivilegeUpdates
          ? (safeUpdates.adminRole ?? baseUser?.adminRole ?? null)
          : (baseUser?.adminRole ?? null)
        const nextIsAdmin = allowPrivilegeUpdates
          ? resolveStoredFlag(safeUpdates.isAdmin, baseUser?.isAdmin)
          : resolveStoredFlag(baseUser?.isAdmin, 0)
        const nextIsModerator = allowPrivilegeUpdates
          ? resolveStoredFlag(safeUpdates.isModerator, baseUser?.isModerator)
          : resolveStoredFlag(baseUser?.isModerator, 0)

        const updatedUser = {
          ...baseUser,
          ...safeUpdates,
          id: userId,
          // Privileged fields can only be changed by trusted internal callers.
          adminRole: nextAdminRole,
          isAdmin: nextIsAdmin,
          isModerator: nextIsModerator,
          birthDate: baseUser?.birthDate ?? safeUpdates.birthDate ?? null,
          updatedAt: now,
          version: currentVersion
        }
        
        // Attempt atomic update
        users[userId] = updatedUser
        await saveData(FILES.users, users)
        
        // Verify the update wasn't overwritten by checking timestamp
        const verifyUsers = loadData(FILES.users, {})
        if (verifyUsers[userId]?.updatedAt === now) {
          console.log(`[Optimistic] Updated profile for user ${userId} on attempt ${attempt}`)
          return updatedUser
        } else {
          throw new Error('Concurrent modification detected')
        }
        
      } catch (error) {
        if (attempt === maxRetries) {
          console.error(`[Optimistic] Failed to update profile for user ${userId} after ${maxRetries} attempts:`, error.message)
          throw error
        }
        
        // Wait before retry with exponential backoff
        const delay = Math.min(100 * Math.pow(2, attempt - 1), 1000)
        await new Promise(resolve => setTimeout(resolve, delay))
        console.warn(`[Optimistic] Retry attempt ${attempt + 1} for user ${userId} profile update`)
      }
    }
  },

  /**
   * Thread-safe profile update with distributed locking
   */
  async updateProfileSafe(userId, updates) {
    return lockService.withLock(`user_profile:${userId}`, async () => {
      return this.updateProfile(userId, updates)
    }, {
      ttlMs: 5000,
      timeoutMs: 3000,
      maxRetries: 3
    })
  },

  async setStatus(userId, status, customStatus = null) {
    const users = loadData(FILES.users, {})
    if (!users[userId]) {
      users[userId] = { id: userId, createdAt: new Date().toISOString() }
    }
    users[userId].status = status
    if (customStatus !== null) {
      users[userId].customStatus = customStatus
    }
    users[userId].updatedAt = new Date().toISOString()
    await saveData(FILES.users, users)
    return users[userId]
  },

  async setAgeVerification(userId, verification) {
    const users = loadData(FILES.users, {})
    const now = new Date()
    const existingUser = users[userId] || { id: userId, createdAt: now.toISOString() }
    const jurisdictionCode = getAgeVerificationJurisdictionCode(
      { ageVerificationJurisdiction: verification?.jurisdictionCode || existingUser.ageVerificationJurisdiction },
      verification
    )
    const jurisdiction = getAgeVerificationJurisdiction(jurisdictionCode)
    const category = verification?.category === 'child' ? 'child' : 'adult'
    const verified = typeof verification?.verified === 'boolean'
      ? verification.verified
      : true
    const selfDeclaredAdult = verification?.selfDeclaredAdult === true
    const expiresAt = verification?.expiresAt || (category === 'child'
      ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null)

    users[userId] = {
      ...existingUser,
      ageVerificationJurisdiction: jurisdiction.code,
      ageVerification: {
        verified,
        method: verification?.method,
        birthYear: verification?.birthYear || null,
        age: verification?.age || null,
        proofSummary: verification?.proofSummary || {},
        category,
        estimatedAge: verification?.estimatedAge || null,
        verifiedAt: verified ? (verification?.verifiedAt || now.toISOString()) : null,
        selfAttestedAt: selfDeclaredAdult ? (verification?.selfAttestedAt || now.toISOString()) : null,
        expiresAt,
        device: verification?.device || null,
        selfDeclaredAdult,
        source: verification?.source || (verified ? 'proof' : 'self_attestation'),
        jurisdictionCode: jurisdiction.code
      },
      updatedAt: now.toISOString()
    }

    await saveData(FILES.users, users)
    return this.getUser(userId)
  },

  async setAgeVerificationJurisdiction(userId, jurisdictionCode) {
    const users = loadData(FILES.users, {})
    const now = new Date().toISOString()
    const jurisdiction = getAgeVerificationJurisdiction(jurisdictionCode)
    const existingUser = users[userId] || { id: userId, createdAt: now }

    users[userId] = {
      ...existingUser,
      ageVerificationJurisdiction: jurisdiction.code,
      updatedAt: now
    }

    await saveData(FILES.users, users)
    return this.getUser(userId)
  },

  isAgeVerified(userId) {
    return this.getAgeVerificationStatus(userId).proofVerifiedAdult
  },

  hasAdultAccess(userId) {
    return this.getAgeVerificationStatus(userId).adultAccess
  },

  getAgeVerificationStatus(userId) {
    const profile = this.getUser(userId)
    if (!profile) return normalizeAgeVerification(null, {})
    return profile.ageVerification || normalizeAgeVerification(null, profile)
  },

  getAllUsers() {
    // Use loadDataRef to avoid O(n) clone, then build result with single pass
    const users = loadDataRef(FILES.users, {})
    const result = {}
    for (const [userId, user] of Object.entries(users)) {
      if (!user) continue
      const normalized = { ...user }
      // Inline age verification normalization (avoid calling getUser which re-clones)
      if (typeof normalized.ageVerification === 'string') {
        try {
          normalized.ageVerification = JSON.parse(normalized.ageVerification)
        } catch {
          if (normalized.ageVerification === 'adult' || normalized.ageVerification === 'child') {
            normalized.ageVerification = {
              verified: true,
              category: normalized.ageVerification
            }
          }
        }
      }
      result[userId] = normalized
    }
    return result
  }
}

export const friendService = {
  getFriends(userId) {
    if (supportsDirectQuery()) {
      const table = storageCache.friends
      if (table && typeof table === 'object') {
        const cachedFriends = table[userId]
        if (Array.isArray(cachedFriends)) {
          return [...cachedFriends]
        }
      }
    }

    const friends = loadDataRef(FILES.friends, {})
    const userFriends = friends?.[userId]
    if (Array.isArray(userFriends)) {
      return [...userFriends]
    }
    return []
  },

  async getFriendsFresh(userId) {
    const friends = await loadFreshData(FILES.friends, {})
    const userFriends = friends?.[userId]
    if (Array.isArray(userFriends)) {
      return [...userFriends]
    }
    return []
  },

  async addFriend(userId, friendId) {
    if (await addFriendRows(userId, friendId)) {
      return true
    }

    const friends = await loadFreshData(FILES.friends, {})
    if (!friends[userId]) friends[userId] = []
    if (!friends[friendId]) friends[friendId] = []
    
    if (!friends[userId].includes(friendId)) {
      friends[userId].push(friendId)
    }
    if (!friends[friendId].includes(userId)) {
      friends[friendId].push(userId)
    }
    
    await saveData(FILES.friends, friends)
    return true
  },

  async removeFriend(userId, friendId) {
    if (await removeFriendRows(userId, friendId)) {
      return true
    }

    const friends = await loadFreshData(FILES.friends, {})
    if (friends[userId]) {
      friends[userId] = friends[userId].filter(id => id !== friendId)
    }
    if (friends[friendId]) {
      friends[friendId] = friends[friendId].filter(id => id !== userId)
    }
    await saveData(FILES.friends, friends)
    return true
  },

  areFriends(userId1, userId2) {
    const friends = loadData(FILES.friends, {})
    const userFriends = friends[userId1]
    if (Array.isArray(userFriends)) {
      return userFriends.includes(userId2) || false
    }
    if (typeof userFriends === 'object' && userFriends !== null) {
      return !!userFriends[userId2] || false
    }
    return false
  },
  
  getAllFriends() {
    return loadData(FILES.friends, {})
  }
}

export const friendRequestService = {
  _hydrateRequests(userId, requests) {
    const incomingMap = requests?.incoming && typeof requests.incoming === 'object' ? requests.incoming : {}
    const outgoingMap = requests?.outgoing && typeof requests.outgoing === 'object' ? requests.outgoing : {}
    const hydrateRequest = (request, fallbackFrom, fallbackTo) => {
      const fromId = request?.from || fallbackFrom || null
      const toId = request?.to || fallbackTo || null
      const fromProfile = fromId ? userService.getUser(fromId) : null
      const toProfile = toId ? userService.getUser(toId) : null
      return {
        ...request,
        from: fromId,
        to: toId,
        fromUsername: request?.fromUsername || fromProfile?.customUsername || fromProfile?.username || null,
        toUsername: request?.toUsername || toProfile?.customUsername || toProfile?.username || null
      }
    }

    const incoming = (incomingMap[userId] || []).map(request => hydrateRequest(request, request?.from, userId))
    const outgoing = (outgoingMap[userId] || []).map(request => hydrateRequest(request, userId, request?.to))
    return {
      incoming,
      outgoing
    }
  },

  getRequests(userId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    return this._hydrateRequests(userId, requests)
  },

  async getRequestsFresh(userId) {
    const requests = await loadFreshData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    return this._hydrateRequests(userId, requests)
  },

  async sendRequest(fromUserId, toUserId, fromUsername, toUsername) {
    const requests = await loadFreshData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    if (!requests.incoming[toUserId]) requests.incoming[toUserId] = []
    if (!requests.outgoing[fromUserId]) requests.outgoing[fromUserId] = []
    
    const existingIncoming = requests.incoming[toUserId].find(r => r.from === fromUserId)
    if (existingIncoming) return { error: 'Request already sent' }

    const fromProfile = userService.getUser(fromUserId)
    const toProfile = userService.getUser(toUserId)
    const safeFromUsername = fromUsername || fromProfile?.customUsername || fromProfile?.username || null
    const safeToUsername = toUsername || toProfile?.customUsername || toProfile?.username || null
    
    const request = {
      id: `fr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      from: fromUserId,
      fromUsername: safeFromUsername,
      to: toUserId,
      toUsername: safeToUsername,
      createdAt: new Date().toISOString(),
      status: 'pending'
    }
    
    requests.incoming[toUserId].push(request)
    requests.outgoing[fromUserId].push({ ...request, to: toUserId, toUsername: safeToUsername })

    if (await insertFriendRequestRow(request)) {
      return request
    }

    await saveData(FILES.friendRequests, requests)
    return request
  },

  async acceptRequest(userId, requestId) {
    const requests = await loadFreshData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    const incoming = requests.incoming[userId] || []
    const request = incoming.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.incoming[userId] = incoming.filter(r => r.id !== requestId)
    if (requests.outgoing[request.from]) {
      requests.outgoing[request.from] = requests.outgoing[request.from].filter(r => r.id !== requestId)
    }

    if (!(await deleteFriendRequestRow(requestId))) {
      await saveData(FILES.friendRequests, requests)
    }
    await friendService.addFriend(userId, request.from)
    
    return { success: true, friendId: request.from }
  },

  async rejectRequest(userId, requestId) {
    const requests = await loadFreshData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    const incoming = requests.incoming[userId] || []
    const request = incoming.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.incoming[userId] = incoming.filter(r => r.id !== requestId)
    if (requests.outgoing[request.from]) {
      requests.outgoing[request.from] = requests.outgoing[request.from].filter(r => r.id !== requestId)
    }

    if (!(await deleteFriendRequestRow(requestId))) {
      await saveData(FILES.friendRequests, requests)
    }
    return { success: true }
  },

  async cancelRequest(userId, requestId) {
    const requests = await loadFreshData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    const outgoing = requests.outgoing[userId] || []
    const request = outgoing.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.outgoing[userId] = outgoing.filter(r => r.id !== requestId)
    if (requests.incoming[request.to]) {
      requests.incoming[request.to] = requests.incoming[request.to].filter(r => r.id !== requestId)
    }

    if (!(await deleteFriendRequestRow(requestId))) {
      await saveData(FILES.friendRequests, requests)
    }
    return { success: true }
  },
  
  getAllRequests() {
    return loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
  }
}

export const blockService = {
  async getBlocked(userId) {
    const blocked = loadData(FILES.blocked, {})
    return blocked[userId] || []
  },

  async blockUser(userId, blockedUserId) {
    const blocked = loadData(FILES.blocked, {})
    if (!blocked[userId]) blocked[userId] = []
    
    if (!blocked[userId].includes(blockedUserId)) {
      blocked[userId].push(blockedUserId)
    }
    
    await friendService.removeFriend(userId, blockedUserId)
    
    await saveData(FILES.blocked, blocked)
    return true
  },

  async unblockUser(userId, blockedUserId) {
    const blocked = loadData(FILES.blocked, {})
    if (blocked[userId]) {
      blocked[userId] = blocked[userId].filter(id => id !== blockedUserId)
    }
    await saveData(FILES.blocked, blocked)
    return true
  },

  isBlocked(userId, targetUserId) {
    const blocked = loadData(FILES.blocked, {})
    return blocked[userId]?.includes(targetUserId) || blocked[targetUserId]?.includes(userId) || false
  },
  
  getAllBlocked() {
    return loadData(FILES.blocked, {})
  }
}

export const dmService = {
  getConversations(userId) {
    const dms = loadData(FILES.dms, {})
    return dms[userId] || []
  },

  getConversationForUser(userId, conversationId) {
    const dms = loadData(FILES.dms, {})
    return (dms[userId] || []).find(c => c.id === conversationId) || null
  },

  async createGroupConversation(ownerId, participantIds = [], groupName = '') {
    const dms = loadData(FILES.dms, {})
    const uniqueParticipants = Array.from(new Set([ownerId, ...(participantIds || [])].filter(Boolean)))
    if (uniqueParticipants.length < 3) {
      throw new Error('Group DM requires at least 3 participants')
    }

    const conversationId = `dm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const now = new Date().toISOString()
    const participantKey = uniqueParticipants.slice().sort().join(':')
    const baseConversation = {
      id: conversationId,
      participantKey,
      participants: uniqueParticipants,
      isGroup: true,
      groupName: String(groupName || '').trim() || null,
      ownerId,
      createdAt: now,
      lastMessageAt: now
    }

    for (const uid of uniqueParticipants) {
      if (!dms[uid]) dms[uid] = []
      dms[uid].push({ ...baseConversation })
    }

    await saveData(FILES.dms, dms)
    return baseConversation
  },

  async getOrCreateConversation(userId1, userId2) {
    const dms = loadData(FILES.dms, {})
    
    const participantKey = [userId1, userId2].sort().join(':')
    
    if (!dms[userId1]) dms[userId1] = []
    if (!dms[userId2]) dms[userId2] = []
    
    let conv1 = dms[userId1].find(c => c.participantKey === participantKey)
    let conv2 = dms[userId2].find(c => c.participantKey === participantKey)
    
    if (!conv1 || !conv2) {
      const conversationId = `dm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      const now = new Date().toISOString()
      
      const newConv = {
        id: conversationId,
        participantKey,
        participants: [userId1, userId2],
        createdAt: now,
        lastMessageAt: now
      }
      
      if (!conv1) {
        dms[userId1].push({ ...newConv, recipientId: userId2 })
      }
      if (!conv2) {
        dms[userId2].push({ ...newConv, recipientId: userId1 })
      }
      
      await saveData(FILES.dms, dms)
      return newConv
    }
    
    return conv1
  },

  async updateLastMessage(conversationId, userId1, userId2) {
    // Try direct DB update first (avoids loading + re-saving entire DMs table)
    if (supportsDirectQuery()) {
      const now = new Date().toISOString()
      await directQuery(
        `UPDATE dms SET lastMessageAt = ? WHERE id = ?`,
        [now, conversationId]
      )
      // Also update in-memory cache if present
      const table = getTableName(FILES.dms)
      const dms = storageCache[table]
      if (dms) {
        const usersToCheck = (userId1 || userId2)
          ? [userId1, userId2].filter(Boolean)
          : Object.keys(dms)
        for (const uid of usersToCheck) {
          if (!Array.isArray(dms[uid])) continue
          const conv = dms[uid].find(c => c.id === conversationId)
          if (conv) conv.lastMessageAt = now
        }
      }
      return
    }

    // Fallback: single-pass iteration over all user keys
    const dms = loadData(FILES.dms, {})
    const now = new Date().toISOString()

    // Build the set of user keys to check. If both user IDs are provided,
    // only check those two. Otherwise scan all keys once.
    const keysToCheck = (userId1 || userId2)
      ? [...new Set([userId1, userId2].filter(Boolean))]
      : Object.keys(dms)

    for (const uid of keysToCheck) {
      if (!Array.isArray(dms[uid])) continue
      const conv = dms[uid].find(c => c.id === conversationId)
      if (conv) conv.lastMessageAt = now
    }

    await saveData(FILES.dms, dms)
  },
  
  getAllConversations() {
    return loadData(FILES.dms, {})
  }
}

export const dmMessageService = {
  getMessages(conversationId, limit = 50) {
    const messages = loadData(FILES.dmMessages, {})
    const convMessages = messages[conversationId] || []
    return convMessages.slice(-limit)
  },

  async getMessagesForConversation(conversationId, limit = 50, before = null) {
    if (supportsDirectQuery()) {
      try {
        let rows
        if (before) {
          const beforeRows = await directQuery(
            'SELECT `timestamp` FROM dm_messages WHERE id = ? LIMIT 1',
            [before]
          )
          if (beforeRows && beforeRows.length > 0) {
            const beforeTimestamp = beforeRows[0].timestamp
            rows = await directQuery(
              'SELECT * FROM dm_messages WHERE conversationId = ? AND `timestamp` < ? ORDER BY `timestamp` DESC LIMIT ?',
              [conversationId, beforeTimestamp, limit]
            )
          } else {
            rows = await directQuery(
              'SELECT * FROM dm_messages WHERE conversationId = ? ORDER BY `timestamp` DESC LIMIT ?',
              [conversationId, limit]
            )
          }
        } else {
          rows = await directQuery(
            'SELECT * FROM dm_messages WHERE conversationId = ? ORDER BY `timestamp` DESC LIMIT ?',
            [conversationId, limit]
          )
        }

        // directQuery returns null on error - fall through to fallback
        if (rows === null) {
          console.warn('[dmMessageService] directQuery returned null, falling through to fallback')
        } else if (rows.length > 0) {
          return rows.map(normalizeDmMessageRow).reverse()
        } else {
          return []
        }
      } catch (err) {
        console.error('[dmMessageService] Direct query getMessagesForConversation failed:', err.message)
      }
    }

    return this.getMessages(conversationId, limit)
  },

  async addMessage(conversationId, message) {
    if (!conversationId) {
      console.error('[dataService] addMessage called with invalid conversationId:', conversationId, 'message id:', message?.id)
      return null
    }
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) messages[conversationId] = []
    messages[conversationId].push(message)
    await saveData(FILES.dmMessages, messages)
    return message
  },

  async editMessage(conversationId, messageId, newContent) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) return null
    
    const msg = messages[conversationId].find(m => m.id === messageId)
    if (msg) {
      msg.content = newContent
      msg.edited = true
      msg.editedAt = new Date().toISOString()
      await saveData(FILES.dmMessages, messages)
    }
    return msg
  },

  async deleteMessage(conversationId, messageId) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) return false
    
    const idx = messages[conversationId].findIndex(m => m.id === messageId)
    if (idx >= 0) {
      messages[conversationId].splice(idx, 1)
      await saveData(FILES.dmMessages, messages)
      return true
    }
    return false
  },
  
  getAllMessages() {
    return loadData(FILES.dmMessages, {})
  }
}

// Maximum number of distinct emoji reactions per message (Discord parity)
const MAX_REACTIONS_PER_MESSAGE = 20

/**
 * Load reactions for a specific message directly from the DB.
 * Returns { emoji: [userId, ...], ... }
 */
const loadReactionsForMessage = async (messageId) => {
  if (supportsDirectQuery()) {
    try {
      const rows = await directQuery(
        'SELECT emoji, userIds FROM reactions WHERE messageId = ?',
        [messageId]
      )
      if (rows === null) {
        console.warn('[reactionService] directQuery returned null for loadReactionsForMessage')
      } else {
        const result = {}
        for (const row of rows) {
          if (!row.emoji) continue
          try {
            result[row.emoji] = typeof row.userIds === 'string' ? JSON.parse(row.userIds) : (row.userIds || [])
          } catch {
            result[row.emoji] = []
          }
        }
        return result
      }
    } catch (err) {
      console.error('[reactionService] loadReactionsForMessage directQuery failed:', err.message)
    }
  }
  // Fallback: load from in-memory cache / full table
  const reactions = loadData(FILES.reactions, {})
  return reactions[messageId] || {}
}

/**
 * Persist a single reaction row (upsert).
 * Uses direct DB query for SQL backends, falls back to full-table save.
 */
const saveReactionRow = async (messageId, emoji, userIds) => {
  const rowId = `${messageId}_${Buffer.from(emoji).toString('base64').slice(0, 40)}`
  if (supportsDirectQuery()) {
    try {
      // Use INSERT OR REPLACE for SQLite, ON DUPLICATE KEY UPDATE for MySQL/MariaDB
      const sql = isSqliteBackend()
        ? `INSERT OR REPLACE INTO reactions (id, messageId, emoji, userIds, createdAt) VALUES (?, ?, ?, ?, ?)`
        : `INSERT INTO reactions (id, messageId, emoji, userIds, createdAt) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE userIds = VALUES(userIds)`
      const result = await directQuery(
        sql,
        [rowId, messageId, emoji, JSON.stringify(userIds), new Date().toISOString()]
      )
      if (result !== null) return true
    } catch (err) {
      console.error('[reactionService] saveReactionRow directQuery failed:', err.message)
    }
  }
  // Fallback: full-table save
  const reactions = loadData(FILES.reactions, {})
  if (!reactions[messageId]) reactions[messageId] = {}
  reactions[messageId][emoji] = userIds
  await saveData(FILES.reactions, reactions)
  return true
}

/**
 * Delete a single reaction row when no users remain.
 */
const deleteReactionRow = async (messageId, emoji) => {
  const rowId = `${messageId}_${Buffer.from(emoji).toString('base64').slice(0, 40)}`
  if (supportsDirectQuery()) {
    try {
      const result = await directQuery(
        'DELETE FROM reactions WHERE id = ?',
        [rowId]
      )
      if (result !== null) return true
    } catch (err) {
      console.error('[reactionService] deleteReactionRow directQuery failed:', err.message)
    }
  }
  // Fallback: full-table save
  const reactions = loadData(FILES.reactions, {})
  if (reactions[messageId]) {
    delete reactions[messageId][emoji]
    if (Object.keys(reactions[messageId]).length === 0) {
      delete reactions[messageId]
    }
    await saveData(FILES.reactions, reactions)
  }
  return true
}

export const reactionService = {
  async getReactions(messageId) {
    return loadReactionsForMessage(messageId)
  },

  async addReaction(messageId, userId, emoji) {
    const reactions = await loadReactionsForMessage(messageId)

    // Enforce 20-reaction limit (distinct emojis per message)
    const isNewEmoji = !reactions[emoji]
    if (isNewEmoji && Object.keys(reactions).length >= MAX_REACTIONS_PER_MESSAGE) {
      // Return current reactions without adding
      return reactions
    }

    if (!reactions[emoji]) reactions[emoji] = []
    if (!reactions[emoji].includes(userId)) {
      reactions[emoji].push(userId)
    }

    await saveReactionRow(messageId, emoji, reactions[emoji])
    return reactions
  },

  async removeReaction(messageId, userId, emoji) {
    const reactions = await loadReactionsForMessage(messageId)
    if (!reactions[emoji]) return reactions

    reactions[emoji] = reactions[emoji].filter(id => id !== userId)
    if (reactions[emoji].length === 0) {
      delete reactions[emoji]
      await deleteReactionRow(messageId, emoji)
    } else {
      await saveReactionRow(messageId, emoji, reactions[emoji])
    }

    return reactions
  },

  async getAllReactions(messageIds) {
    // If messageIds provided, only load reactions for those messages (efficient)
    if (supportsDirectQuery()) {
      try {
        let rows
        if (messageIds && messageIds.length > 0) {
          // Query only for the specific message IDs
          const placeholders = messageIds.map(() => '?').join(',')
          rows = await directQuery(
            `SELECT messageId, emoji, userIds FROM reactions WHERE messageId IN (${placeholders})`,
            messageIds
          )
        } else {
          rows = await directQuery('SELECT messageId, emoji, userIds FROM reactions', [])
        }
        if (rows !== null) {
          const result = {}
          for (const row of rows) {
            if (!row.messageId || !row.emoji) continue
            if (!result[row.messageId]) result[row.messageId] = {}
            try {
              result[row.messageId][row.emoji] = typeof row.userIds === 'string'
                ? JSON.parse(row.userIds)
                : (row.userIds || [])
            } catch {
              result[row.messageId][row.emoji] = []
            }
          }
          return result
        }
      } catch (err) {
        console.error('[reactionService] getAllReactions directQuery failed:', err.message)
      }
    }
    return loadData(FILES.reactions, {})
  }
}

export const inviteService = {
  normalizeInviteList(value) {
    if (Array.isArray(value)) return value
    if (!value || typeof value !== 'object') return []
    return Object.values(value).filter(invite => invite && typeof invite === 'object')
  },

  async createInvite(serverId, creatorId, options = {}) {
    const invites = loadData(FILES.serverInvites, {})
    invites[serverId] = this.normalizeInviteList(invites[serverId])
    
    const code = Math.random().toString(36).substr(2, 8).toUpperCase()
    const invite = {
      code,
      serverId,
      createdBy: creatorId,
      uses: 0,
      maxUses: options.maxUses || 0,
      expiresAt: options.expiresAt || null,
      createdAt: new Date().toISOString()
    }
    
    invites[serverId].push(invite)
    await saveData(FILES.serverInvites, invites)
    return invite
  },

  getInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      const invite = this.normalizeInviteList(invites[serverId]).find(i => i.code === code)
      if (invite) return invite
    }
    return null
  },

  async useInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      invites[serverId] = this.normalizeInviteList(invites[serverId])
      const invite = invites[serverId].find(i => i.code === code)
      if (invite) {
        if (invite.maxUses && invite.uses >= invite.maxUses) {
          return { error: 'Invite expired' }
        }
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
          return { error: 'Invite expired' }
        }
        invite.uses++
        await saveData(FILES.serverInvites, invites)
        return { serverId: invite.serverId }
      }
    }
    return { error: 'Invite not found' }
  },

  async deleteInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      invites[serverId] = this.normalizeInviteList(invites[serverId])
      const idx = invites[serverId].findIndex(i => i.code === code)
      if (idx >= 0) {
        invites[serverId].splice(idx, 1)
        await saveData(FILES.serverInvites, invites)
        return true
      }
    }
    return false
  },

  getServerInvites(serverId) {
    const invites = loadData(FILES.serverInvites, {})
    return this.normalizeInviteList(invites[serverId])
  },
  
  getAllInvites() {
    return loadData(FILES.serverInvites, {})
  }
}

export const serverService = {
  getServer(serverId) {
    const servers = loadData(FILES.servers, {})
    // Handle both object format { serverId: serverData } and array format
    if (Array.isArray(servers)) {
      return servers.find(s => s.id === serverId) || null
    }
    return servers[serverId] || null
  },

  async getServerFresh(serverId) {
    const servers = await this.getAllServersFresh()
    if (Array.isArray(servers)) {
      return servers.find(s => s.id === serverId) || null
    }
    return servers?.[serverId] || null
  },

  async createServer(serverData) {
    const servers = loadData(FILES.servers, {})
    servers[serverData.id] = {
      ...serverData,
      createdAt: serverData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await saveData(FILES.servers, servers)
    return servers[serverData.id]
  },

  async updateServer(serverId, updates) {
    const servers = loadData(FILES.servers, {})
    if (!servers[serverId]) return null
    
    servers[serverId] = {
      ...servers[serverId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    await saveData(FILES.servers, servers)
    return servers[serverId]
  },

  async deleteServer(serverId) {
    const servers = loadData(FILES.servers, {})
    delete servers[serverId]
    await saveData(FILES.servers, servers)
    
    const channels = loadData(FILES.channels, {})
    const serverChannels = Object.keys(channels).filter(ch => channels[ch].serverId === serverId)
    serverChannels.forEach(chId => delete channels[chId])
    await saveData(FILES.channels, channels)
    
    return true
  },

  getAllServers() {
    return loadData(FILES.servers, {})
  },

  async getAllServersFresh() {
    return await loadFreshData(FILES.servers, {})
  },

  getAllCategoriesGrouped() {
    const categories = loadData(FILES.categories, {})
    const grouped = {}
    const values = Array.isArray(categories) ? categories : Object.values(categories || {})
    for (const category of values) {
      if (!category?.serverId) continue
      if (!grouped[category.serverId]) grouped[category.serverId] = []
      grouped[category.serverId].push(category)
    }
    return grouped
  },

  async getAllCategoriesGroupedFresh() {
    const categories = await loadFreshData(FILES.categories, {})
    const grouped = {}
    const values = Array.isArray(categories) ? categories : Object.values(categories || {})
    for (const category of values) {
      if (!category?.serverId) continue
      if (!grouped[category.serverId]) grouped[category.serverId] = []
      grouped[category.serverId].push(category)
    }
    return grouped
  },

  async createCategory(categoryData) {
    const categories = loadData(FILES.categories, {})
    categories[categoryData.id] = {
      ...categoryData,
      createdAt: categoryData.createdAt || new Date().toISOString()
    }
    await saveData(FILES.categories, categories)
    return categories[categoryData.id]
  },

  async updateCategory(categoryId, updates) {
    const categories = loadData(FILES.categories, {})
    if (!categories[categoryId]) return null

    categories[categoryId] = {
      ...categories[categoryId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    await saveData(FILES.categories, categories)
    return categories[categoryId]
  }
}

export const channelService = {
  /**
   * Detect whether channels.json uses the legacy format { serverId: [channels] }
   * or the flat format { channelId: channelData }.
   */
  _isLegacyFormat(channels) {
    const firstValue = Object.values(channels)[0]
    return Array.isArray(firstValue)
  },

  /**
   * Flatten legacy { serverId: [channels] } format into { channelId: channelData }
   */
  _flattenLegacy(channels) {
    const flat = {}
    for (const [serverId, channelList] of Object.entries(channels)) {
      if (Array.isArray(channelList)) {
        for (const ch of channelList) {
          if (ch && ch.id) {
            flat[ch.id] = { ...ch, serverId: ch.serverId || serverId }
          }
        }
      }
    }
    return flat
  },

  /**
   * Load channels and normalize to flat { channelId: channelData } format.
   */
  _loadFlat() {
    const raw = loadData(FILES.channels, {})
    if (Object.keys(raw).length === 0) return raw
    if (this._isLegacyFormat(raw)) {
      return this._flattenLegacy(raw)
    }
    return raw
  },

  _normalizeFlatFromRaw(raw = {}) {
    if (Object.keys(raw).length === 0) return raw
    if (this._isLegacyFormat(raw)) {
      return this._flattenLegacy(raw)
    }
    return raw
  },

  async _loadFlatFresh() {
    const raw = await loadFreshData(FILES.channels, {})
    return this._normalizeFlatFromRaw(raw)
  },

  getChannel(channelId) {
    const channels = this._loadFlat()
    return channels[channelId] || null
  },

  async createChannel(channelData) {
    const raw = loadData(FILES.channels, {})
    if (Object.keys(raw).length > 0 && this._isLegacyFormat(raw)) {
      // Legacy format: add to the server's array
      const serverId = channelData.serverId
      if (!raw[serverId]) raw[serverId] = []
      const existing = raw[serverId].findIndex(c => c.id === channelData.id)
      const newChannel = { ...channelData, createdAt: channelData.createdAt || new Date().toISOString() }
      if (existing >= 0) {
        raw[serverId][existing] = newChannel
      } else {
        raw[serverId].push(newChannel)
      }
      await saveData(FILES.channels, raw)
      return newChannel
    }
    // Flat format
    raw[channelData.id] = {
      ...channelData,
      createdAt: channelData.createdAt || new Date().toISOString()
    }
    await saveData(FILES.channels, raw)
    return raw[channelData.id]
  },

  async updateChannel(channelId, updates) {
    // Fast path: use a targeted UPDATE query instead of loading + saving all channels
    if (supportsDirectQuery()) {
      try {
        // Build SET clause dynamically from the updates object
        const ALLOWED_COLUMNS = ['name', 'topic', 'slowMode', 'nsfw', 'isDefault', 'categoryId', 'position', 'permissions', 'updatedAt', 'type']
        const setClauses = []
        const values = []
        for (const [key, value] of Object.entries(updates)) {
          if (!ALLOWED_COLUMNS.includes(key)) continue
          setClauses.push(`\`${key}\` = ?`)
          // Serialize objects/arrays to JSON
          if (value !== null && typeof value === 'object') {
            values.push(JSON.stringify(value))
          } else {
            values.push(value ?? null)
          }
        }
        if (setClauses.length === 0) {
          // Nothing to update - just return the current channel
          return this.getChannel(channelId)
        }
        values.push(channelId)
        const result = await directQuery(
          `UPDATE channels SET ${setClauses.join(', ')} WHERE id = ?`,
          values
        )
        if (result === null) {
          console.warn('[channelService.updateChannel] directQuery returned null, falling back to full save')
          // Fall through to full save below
        } else {
          // Update the in-memory cache so getChannel() returns fresh data
          const channelTable = 'channels'
          if (storageCache[channelTable]) {
            const existing = storageCache[channelTable][channelId]
            if (existing) {
              // Merge updates into cached channel, parsing JSON fields from updates
              const merged = { ...existing }
              for (const [key, value] of Object.entries(updates)) {
                merged[key] = value
              }
              storageCache[channelTable][channelId] = merged
            }
          }
          console.log(`[channelService.updateChannel] Updated channel ${channelId} in DB and cache`)
          return this.getChannel(channelId)
        }
      } catch (err) {
        console.warn('[channelService.updateChannel] directQuery failed, falling back:', err.message)
      }
    }

    // Fallback: load all channels, update one, save all back
    const raw = loadData(FILES.channels, {})
    if (Object.keys(raw).length > 0 && this._isLegacyFormat(raw)) {
      // Legacy format: find and update in the server arrays
      for (const [serverId, channelList] of Object.entries(raw)) {
        if (!Array.isArray(channelList)) continue
        const idx = channelList.findIndex(c => c.id === channelId)
        if (idx >= 0) {
          channelList[idx] = { ...channelList[idx], ...updates }
          await saveData(FILES.channels, raw)
          return channelList[idx]
        }
      }
      return null
    }
    // Flat format
    if (!raw[channelId]) return null
    raw[channelId] = { ...raw[channelId], ...updates }
    await saveData(FILES.channels, raw)
    return raw[channelId]
  },

  async deleteChannel(channelId) {
    if (supportsDirectQuery()) {
      await directQuery(`DELETE FROM channels WHERE id = ?`, [channelId])
    }
    const raw = loadData(FILES.channels, {})
    if (Object.keys(raw).length > 0 && this._isLegacyFormat(raw)) {
      // Legacy format: remove from the server arrays
      for (const [serverId, channelList] of Object.entries(raw)) {
        if (!Array.isArray(channelList)) continue
        const idx = channelList.findIndex(c => c.id === channelId)
        if (idx >= 0) {
          channelList.splice(idx, 1)
          await saveData(FILES.channels, raw)
          return true
        }
      }
      return true
    }
    // Flat format
    delete raw[channelId]
    await saveData(FILES.channels, raw)
    return true
  },

  getServerChannels(serverId) {
    const raw = loadData(FILES.channels, {})
    if (Object.keys(raw).length > 0 && this._isLegacyFormat(raw)) {
      // Legacy format: channels are stored as { serverId: [channels] }
      const channelList = raw[serverId]
      if (Array.isArray(channelList)) {
        return channelList.map(ch => ({ ...ch, serverId: ch.serverId || serverId }))
      }
      return []
    }
    // Flat format
    return Object.values(raw).filter(ch => ch.serverId === serverId)
  },
  
  getAllChannels() {
    return loadData(FILES.channels, {})
  },

  async getAllChannelsFresh() {
    return await loadFreshData(FILES.channels, {})
  },

  getAllChannelsGrouped() {
    const channels = this._normalizeFlatFromRaw(this.getAllChannels())
    const grouped = {}
    const values = Array.isArray(channels) ? channels : Object.values(channels || {})
    for (const channel of values) {
      if (!channel?.serverId) continue
      if (!grouped[channel.serverId]) grouped[channel.serverId] = []
      grouped[channel.serverId].push(channel)
    }
    return grouped
  },

  async getAllChannelsGroupedFresh() {
    const channels = this._normalizeFlatFromRaw(await this.getAllChannelsFresh())
    const grouped = {}
    const values = Array.isArray(channels) ? channels : Object.values(channels || {})
    for (const channel of values) {
      if (!channel?.serverId) continue
      if (!grouped[channel.serverId]) grouped[channel.serverId] = []
      grouped[channel.serverId].push(channel)
    }
    return grouped
  }
}

export const messageService = {
  async getMessage(messageId) {
    // Try direct DB query first (avoids loading entire messages table)
    if (supportsDirectQuery()) {
      try {
        const rows = await directQuery(
          `SELECT * FROM messages WHERE id = ? LIMIT 1`,
          [messageId]
        )
        // directQuery returns null on error - fall through to fallback
        if (rows === null) {
          console.warn('[messageService] directQuery returned null for getMessage, falling through to fallback')
        } else if (rows.length > 0) {
          return normalizeMessageRow(rows[0])
        } else {
          return null
        }
      } catch (err) {
        console.error('[messageService] Direct query getMessage failed:', err.message)
      }
    }
    // Fallback to cache
    const messages = loadData(FILES.messages, {})
    return messages[messageId] || null
  },

    async getChannelMessages(channelId, limit = 50, before = null) {
      const cacheKey = `messages:${channelId}:${limit}:${before || 'none'}`
      
      return globalCoalescer.coalesce(cacheKey, async () => {
        if (supportsDirectQuery()) {
          try {
            const timeColumn = await resolveMessageTimeColumn()
            const quotedTimeCol = '`' + timeColumn + '`'
            let rows
            if (before) {
              rows = await directQuery(
                `SELECT * FROM messages WHERE channelId = ? AND ${quotedTimeCol} < ? ORDER BY ${quotedTimeCol} DESC LIMIT ?`,
                [channelId, before, limit]
              )
            } else {
              rows = await directQuery(
                `SELECT * FROM messages WHERE channelId = ? ORDER BY ${quotedTimeCol} DESC LIMIT ?`,
                [channelId, limit]
              )
            }
            if (rows === null) {
              console.warn(`[messageService] directQuery returned null for channel ${channelId}`)
            } else if (rows.length > 0) {
              return rows.map(normalizeMessageRow).reverse()
            } else {
              return []
            }
          } catch (err) {
            console.error('[messageService] Direct query getChannelMessages failed:', err.message)
          }
        }
        const messages = loadData(FILES.messages, {})
        let channelMessages = Object.values(messages)
          .filter(m => m.channelId === channelId)
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        
        if (before) {
          channelMessages = channelMessages.filter(m => new Date(m.createdAt) < new Date(before))
        }
        
        return channelMessages.slice(-limit)
      })
    },

  async createMessage(messageData) {
    // Ensure userId and authorId are always synced
    const userIdentifier = messageData.userId || messageData.authorId || null
    const message = {
      ...messageData,
      userId: userIdentifier,
      authorId: userIdentifier,
      createdAt: messageData.createdAt || new Date().toISOString(),
      timestamp: messageData.timestamp || messageData.createdAt || new Date().toISOString()
    }
    
    // Try direct DB insert first for speed and reliability
    if (supportsDirectQuery()) {
      try {
        const result = await directQuery(
          `INSERT INTO messages (id, channelId, userId, authorId, content, type, \`timestamp\`, username, avatar, bot, encrypted, iv, epoch, edited, editedAt, replyTo, attachments, mentions, embeds, storage, ui)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE content = VALUES(content), edited = VALUES(edited), editedAt = VALUES(editedAt), ui = VALUES(ui)`,
          [
            message.id,
            message.channelId,
            userIdentifier,
            userIdentifier,
            message.content || null,
            message.type || 'message',
            message.timestamp,
            message.username || null,
            message.avatar || null,
            message.bot ? 1 : 0,
            message.encrypted ? 1 : 0,
            message.iv || null,
            message.epoch ?? null,
            message.edited ? 1 : 0,
            message.editedAt || null,
            message.replyTo ? (typeof message.replyTo === 'string' ? message.replyTo : JSON.stringify(message.replyTo)) : null,
            JSON.stringify(Array.isArray(message.attachments) ? message.attachments : []),
            JSON.stringify(Array.isArray(message.mentions) ? message.mentions : []),
            JSON.stringify(Array.isArray(message.embeds) ? message.embeds : []),
            message.storage ? JSON.stringify(message.storage) : null,
            message.ui ? JSON.stringify(message.ui) : null
          ]
        )
        if (result !== null) {
          // Update in-memory cache
          const table = getTableName(FILES.messages)
          if (!storageCache[table]) storageCache[table] = {}
          storageCache[table][message.id] = message
          return message
        }
      } catch (err) {
        console.error('[messageService] Direct insert createMessage failed:', err.message)
      }
    }
    
    // Fallback: update in-memory cache and persist via saveData
    const table = getTableName(FILES.messages)
    if (!storageCache[table]) storageCache[table] = {}
    storageCache[table][message.id] = message
    await saveData(FILES.messages, storageCache[table])
    return message
  },

  async editMessage(messageId, newContent) {
    // Try direct DB update first
    if (supportsDirectQuery()) {
      const editedAt = new Date().toISOString()
      const result = await directQuery(
        `UPDATE messages SET content = ?, edited = 1, editedAt = ? WHERE id = ?`,
        [newContent, editedAt, messageId]
      )
      if (result === null) {
        // directQuery failed (circuit breaker, connection error) - fall through to fallback
        console.warn('[messageService] directQuery returned null for editMessage, falling through to fallback')
      } else if (result.affectedRows > 0) {
        // Update cache if entry exists there
        const table = getTableName(FILES.messages)
        if (storageCache[table]?.[messageId]) {
          storageCache[table][messageId].content = newContent
          storageCache[table][messageId].edited = true
          storageCache[table][messageId].editedAt = editedAt
        }
        return { id: messageId, content: newContent, edited: true, editedAt }
      } else {
        // Query succeeded but no rows affected - message doesn't exist
        return null
      }
    }
    // Fallback
    const messages = loadData(FILES.messages, {})
    if (!messages[messageId]) return null
    
    messages[messageId].content = newContent
    messages[messageId].edited = true
    messages[messageId].editedAt = new Date().toISOString()
    await saveData(FILES.messages, messages)
    return messages[messageId]
  },

  async deleteMessage(messageId) {
    // Try direct DB delete first
    if (supportsDirectQuery()) {
      await directQuery(`DELETE FROM messages WHERE id = ?`, [messageId])
      // Remove from cache if present
      const table = getTableName(FILES.messages)
      if (storageCache[table]?.[messageId]) {
        delete storageCache[table][messageId]
      }
      return true
    }
    // Fallback
    const messages = loadData(FILES.messages, {})
    delete messages[messageId]
    await saveData(FILES.messages, messages)
    return true
  },

  async deleteMessagesByChannelIds(channelIds) {
    if (!channelIds || channelIds.length === 0) return
    const placeholders = channelIds.map(() => '?').join(', ')
    if (supportsDirectQuery()) {
      await directQuery(`DELETE FROM messages WHERE channelId IN (${placeholders})`, channelIds)
      const table = getTableName(FILES.messages)
      if (storageCache[table]) {
        for (const messageId of Object.keys(storageCache[table])) {
          const msg = storageCache[table][messageId]
          if (msg && channelIds.includes(msg.channelId)) {
            delete storageCache[table][messageId]
          }
        }
      }
      return
    }
    const messages = loadData(FILES.messages, {})
    const filtered = {}
    for (const [key, value] of Object.entries(messages)) {
      if (Array.isArray(value)) {
        filtered[key] = value.filter(m => !channelIds.includes(m.channelId))
      } else if (value?.channelId && !channelIds.includes(value.channelId)) {
        filtered[key] = value
      }
    }
    await saveData(FILES.messages, filtered)
  },

  async saveMessages(messagesByChannel) {
    const allMessages = []
    for (const [channelId, messages] of Object.entries(messagesByChannel)) {
      for (const msg of messages) {
        allMessages.push({ ...msg, channelId })
      }
    }

    if (!supportsDirectQuery()) {
      console.warn('[messageService] saveMessages: supportsDirectQuery is false, not saving to DB')
      return false
    }

    if (allMessages.length > 0) {
      try {
        for (const msg of allMessages) {
          const userIdentifier = msg.userId || msg.authorId || null
          const result = await directQuery(
            `INSERT INTO messages (id, channelId, userId, authorId, content, type, \`timestamp\`, username, avatar, bot, encrypted, iv, epoch, edited, editedAt, replyTo, attachments, mentions, embeds, storage, ui)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE content = VALUES(content), edited = VALUES(edited), editedAt = VALUES(editedAt), ui = VALUES(ui), attachments = VALUES(attachments), embeds = VALUES(embeds)`,
            [
              msg.id,
              msg.channelId,
              userIdentifier,
              userIdentifier,
              msg.content || null,
              msg.type || 'message',
              msg.timestamp,
              msg.username || null,
              msg.avatar || null,
              msg.bot ? 1 : 0,
              msg.encrypted ? 1 : 0,
              msg.iv || null,
              msg.epoch ?? null,
              msg.edited ? 1 : 0,
              msg.editedAt || null,
              msg.replyTo ? (typeof msg.replyTo === 'string' ? msg.replyTo : JSON.stringify(msg.replyTo)) : null,
              JSON.stringify(Array.isArray(msg.attachments) ? msg.attachments : []),
              JSON.stringify(Array.isArray(msg.mentions) ? msg.mentions : []),
              JSON.stringify(Array.isArray(msg.embeds) ? msg.embeds : []),
              msg.storage ? JSON.stringify(msg.storage) : null,
              msg.ui ? JSON.stringify(msg.ui) : null
            ]
          )
          if (result === null) {
            console.error('[messageService] Failed to insert message:', msg.id)
          }
        }
        console.log(`[messageService] Saved ${allMessages.length} messages to DB`)
        return true
      } catch (err) {
        console.error('[messageService] Bulk saveMessages failed:', err.message)
      }
    }
    return false
  },

  /**
   * Create a message with transaction support for data consistency
   */
  async createMessageAtomic(message, options = {}) {
    return transactionService.executeTransaction(async (connection) => {
      // Create the message within the transaction
      const createdMessage = await this.createMessage(message)
      
      // If this is a reply, ensure the parent message exists
      if (message.replyTo && typeof message.replyTo === 'string') {
        const parentMessage = await this.getMessage(message.replyTo)
        if (!parentMessage) {
          throw new Error('Parent message not found for reply')
        }
      }
      
      // Update channel last activity within transaction
      if (options.updateChannelActivity !== false) {
        await this.updateChannelActivity(message.channelId, message.timestamp)
      }
      
      // Log message creation for audit trail
      console.log(`[Transaction] Created message ${message.id} in channel ${message.channelId}`)
      
      return createdMessage
    }, { isolationLevel: 'READ COMMITTED' })
  },

  /**
   * Update channel last activity timestamp
   */
  async updateChannelActivity(channelId, timestamp) {
    if (supportsDirectQuery()) {
      try {
        await directQuery(
          'UPDATE channels SET updatedAt = ? WHERE id = ?',
          [timestamp, channelId]
        )
      } catch (err) {
        console.warn('[messageService] Failed to update channel activity:', err.message)
      }
    }
  },
  
  getAllMessages() {
    return loadData(FILES.messages, {})
  }
}

/**
 * Normalize a raw DB message row into the canonical format expected by the app.
 * Handles column aliasing (timestamp -> createdAt, userId -> authorId, etc.)
 */
const normalizeMessageRow = (row) => {
  if (!row || typeof row !== 'object') return row
  const msg = { ...row }
  // Alias mappings
  if (msg.timestamp !== undefined && msg.createdAt === undefined) msg.createdAt = msg.timestamp
  if (msg.createdAt !== undefined && msg.timestamp === undefined) msg.timestamp = msg.createdAt
  if (msg.userId !== undefined && msg.authorId === undefined) msg.authorId = msg.userId
  if (msg.authorId !== undefined && msg.userId === undefined) msg.userId = msg.authorId
  if (msg.mentions_json !== undefined && msg.mentions === undefined) msg.mentions = msg.mentions_json
  if (msg.storage_json !== undefined && msg.storage === undefined) msg.storage = msg.storage_json
  // Parse JSON fields
  for (const field of ['mentions', 'attachments', 'embeds', 'storage', 'ui']) {
    if (typeof msg[field] === 'string') {
      try { msg[field] = JSON.parse(msg[field]) } catch { /* keep string */ }
    }
  }
  return msg
}

const normalizeDmMessageRow = (row) => {
  if (!row || typeof row !== 'object') return row
  const msg = { ...row }
  for (const field of ['mentions_json', 'storage_json', 'replyTo', 'attachments', 'ui']) {
    if (typeof msg[field] === 'string') {
      try { msg[field] = JSON.parse(msg[field]) } catch { /* keep string */ }
    }
  }
  if (msg.mentions === undefined && msg.mentions_json !== undefined) msg.mentions = msg.mentions_json
  if (msg.storage === undefined && msg.storage_json !== undefined) msg.storage = msg.storage_json
  if (msg.timestamp === undefined && msg.createdAt !== undefined) msg.timestamp = msg.createdAt
  if (msg.createdAt === undefined && msg.timestamp !== undefined) msg.createdAt = msg.timestamp
  if (msg.replyTo === undefined) msg.replyTo = null
  if (!Array.isArray(msg.attachments)) msg.attachments = []
  if (!Array.isArray(msg.mentions)) msg.mentions = []
  msg.bot = msg.bot === true || msg.bot === 1 || msg.bot === '1'
  msg.encrypted = msg.encrypted === true || msg.encrypted === 1 || msg.encrypted === '1'
  msg.edited = msg.edited === true || msg.edited === 1 || msg.edited === '1'
  return msg
}

export const fileService = {
  async getFile(fileId) {
    const files = loadData(FILES.files, {})
    return files[fileId] || null
  },

  async saveFile(fileData) {
    const files = loadData(FILES.files, {})
    files[fileData.id] = {
      ...fileData,
      createdAt: fileData.createdAt || new Date().toISOString()
    }
    await saveData(FILES.files, files)
    return files[fileData.id]
  },

  async deleteFile(fileId) {
    const files = loadData(FILES.files, {})
    delete files[fileId]
    await saveData(FILES.files, files)
    return true
  },
  
  getAllFiles() {
    return loadData(FILES.files, {})
  }
}

export const attachmentService = {
  getMessageAttachments(messageId) {
    const attachments = loadData(FILES.attachments, {})
    return attachments[messageId] || []
  },

  async addAttachment(messageId, attachment) {
    const attachments = loadData(FILES.attachments, {})
    if (!attachments[messageId]) attachments[messageId] = []
    attachments[messageId].push(attachment)
    await saveData(FILES.attachments, attachments)
    return attachments[messageId]
  },

  async removeAttachment(messageId, attachmentId) {
    const attachments = loadData(FILES.attachments, {})
    if (!attachments[messageId]) return false
    
    attachments[messageId] = attachments[messageId].filter(a => a.id !== attachmentId)
    await saveData(FILES.attachments, attachments)
    return true
  },
  
  getAllAttachments() {
    return loadData(FILES.attachments, {})
  }
}

export const discoveryService = {
  _load() {
    const data = loadData(FILES.discovery, {})
    return this._parseDiscoveryData(data)
  },

  async _loadFresh() {
    // Try direct DB query first for fresh data
    if (supportsDirectQuery()) {
      try {
        const rows = await directQuery('SELECT * FROM discovery')
        if (rows && rows.length > 0) {
          const entries = rows.map(row => {
            const entry = { ...row }
            // Parse JSON fields if any
            for (const field of ['icon', 'description']) {
              if (typeof entry[field] === 'string') {
                try { entry[field] = JSON.parse(entry[field]) } catch { /* keep string */ }
              }
            }
            return entry
          })
          // Update cache so subsequent _load() calls see the data
          const table = getTableName(FILES.discovery)
          const cacheObj = {}
          for (const entry of entries) {
            if (entry.id) cacheObj[entry.id] = entry
          }
          storageCache[table] = cacheObj
          return this._parseDiscoveryData(cacheObj)
        }
      } catch (err) {
        console.error('[discoveryService] Direct query _loadFresh failed:', err.message)
      }
    }
    // Fall back to loadFreshData (async DB load)
    try {
      const freshData = await loadFreshData(FILES.discovery, {})
      return this._parseDiscoveryData(freshData)
    } catch {
      return this._load()
    }
  },

  _parseDiscoveryData(data) {
    if (Array.isArray(data)) {
      return {
        submissions: data.filter(entry => entry?.status !== 'approved'),
        approved: data.filter(entry => entry?.status === 'approved')
      }
    }

    if (data && typeof data === 'object' && Array.isArray(data.submissions) && Array.isArray(data.approved)) {
      return data
    }

    if (data && typeof data === 'object') {
      const flatEntries = Object.values(data).filter(entry => entry && typeof entry === 'object' && entry.serverId)
      if (flatEntries.length > 0) {
        return {
          submissions: flatEntries.filter(entry => entry?.status !== 'approved'),
          approved: flatEntries.filter(entry => entry?.status === 'approved')
        }
      }
    }

    return { submissions: [], approved: [] }
  },

  getDiscoveryEntry(serverId) {
    const data = this._load()
    return data.approved.find(s => s.serverId === serverId) || null
  },

  async addToDiscovery(serverId, entryData) {
    const data = this._load()
    const existing = data.approved.findIndex(s => s.serverId === serverId)
    const entry = {
      ...entryData,
      serverId,
      addedAt: new Date().toISOString()
    }
    if (existing >= 0) {
      data.approved[existing] = { ...data.approved[existing], ...entry }
    } else {
      data.approved.push(entry)
    }
    await saveData(FILES.discovery, data)
    return entry
  },

  async removeFromDiscovery(serverId) {
    const data = this._load()
    data.approved = data.approved.filter(s => s.serverId !== serverId)
    data.submissions = data.submissions.filter(s => s.serverId !== serverId)
    await saveData(FILES.discovery, data)
    return { success: true }
  },

  isInDiscovery(serverId) {
    const data = this._load()
    return data.approved.some(s => s.serverId === serverId)
  },

  getCategories() {
    const data = this._load()
    const cats = new Set()
    data.approved.forEach(s => { if (s.category) cats.add(s.category) })
    return [...cats].map(c => ({ id: c, name: c.charAt(0).toUpperCase() + c.slice(1) }))
  },

  async getApprovedServers(limit = 50, offset = 0, category = null, search = null) {
    let data = this._load()
    
    // If cache returned no approved entries, try loading fresh from DB
    if (data.approved.length === 0 && data.submissions.length === 0 && supportsDirectQuery()) {
      data = await this._loadFresh()
    }
    
    let list = data.approved.filter(s => !s.status || s.status === 'approved')

    const servers = loadData(FILES.servers, [])
    const serverMap = Array.isArray(servers) 
      ? servers.reduce((acc, s) => { acc[s.id] = s; return acc }, {})
      : servers

    list = list.map(entry => {
      const server = serverMap[entry.serverId]
      if (server) {
        return {
          ...entry,
          name: entry.name || server.name,
          icon: entry.icon || server.icon,
          description: entry.description || server.description,
          memberCount: server.members?.length || 0,
          // Guild tag — only include if server has one and it's not private
          guildTag: server.guildTagPrivate ? null : (server.guildTag || null),
          guildTagPrivate: server.guildTagPrivate === true
        }
      }
      return entry
    })

    if (category) {
      list = list.filter(s => s.category === category)
    }
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(s =>
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q))
      )
    }

    return {
      servers: list.slice(offset, offset + limit),
      total: list.length
    }
  },

  async submitServer(serverId, description, category, userId) {
    const data = this._load()
    const existing = data.submissions.find(s => s.serverId === serverId && s.status === 'pending')
    if (existing) {
      return { error: 'Server already has a pending submission' }
    }
    if (data.approved.some(s => s.serverId === serverId)) {
      return { error: 'Server is already in discovery' }
    }

    const servers = loadData(FILES.servers, [])
    const serverList = Array.isArray(servers) ? servers : Object.values(servers)
    const server = serverList.find(s => s.id === serverId)

    const submission = {
      id: `disc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      serverId,
      name: server?.name || 'Unknown',
      icon: server?.icon || '',
      description: description || '',
      category: category || 'community',
      memberCount: server?.members?.length || 0,
      submittedBy: userId,
      submittedAt: new Date().toISOString(),
      status: 'pending'
    }
    data.submissions.push(submission)
    await saveData(FILES.discovery, data)
    return submission
  },

  getPendingSubmissions() {
    const data = this._load()
    return data.submissions.filter(s => s.status === 'pending')
  },

  async approveSubmission(submissionId) {
    const data = this._load()
    const idx = data.submissions.findIndex(s => s.id === submissionId)
    if (idx === -1) return { error: 'Submission not found' }

    const submission = data.submissions[idx]
    submission.status = 'approved'
    submission.approvedAt = new Date().toISOString()
    data.submissions.splice(idx, 1)
    data.approved.push(submission)
    await saveData(FILES.discovery, data)
    return submission
  },

  async rejectSubmission(submissionId) {
    const data = this._load()
    const idx = data.submissions.findIndex(s => s.id === submissionId)
    if (idx === -1) return { error: 'Submission not found' }

    const submission = data.submissions[idx]
    submission.status = 'rejected'
    submission.rejectedAt = new Date().toISOString()
    data.submissions.splice(idx, 1)
    await saveData(FILES.discovery, data)
    return { success: true }
  },

  getDiscoveryList(category = null, limit = 50) {
    const data = this._load()
    let list = data.approved
    if (category) {
      list = list.filter(s => s.category === category)
    }
    return list.slice(0, limit)
  },

  getSubmissions() {
    return this._load()
  },

  getAllDiscovery() {
    return this._load()
  }
}

export const serverEventService = {
  _load() {
    const data = loadData(FILES.serverEvents, {})
    if (Array.isArray(data)) {
      return data.reduce((acc, event) => {
        if (event?.id) acc[event.id] = event
        return acc
      }, {})
    }
    if (data && typeof data === 'object') return data
    return {}
  },

  _sort(events = []) {
    return [...events].sort((a, b) => {
      const aTime = new Date(a.startAt || a.createdAt || 0).getTime()
      const bTime = new Date(b.startAt || b.createdAt || 0).getTime()
      return aTime - bTime
    })
  },

  getServerEvents(serverId) {
    const data = this._load()
    return this._sort(Object.values(data).filter(event => event?.serverId === serverId))
  },

  getUpcomingEvents(serverIds = [], limit = 20) {
    const allowed = new Set((serverIds || []).filter(Boolean))
    const now = Date.now()
    const data = Object.values(this._load()).filter(event => {
      if (!event?.serverId || !event?.startAt) return false
      if (allowed.size > 0 && !allowed.has(event.serverId)) return false
      return new Date(event.startAt).getTime() >= now
    })
    return this._sort(data).slice(0, limit)
  },

  getEvent(eventId) {
    return this._load()[eventId] || null
  },

  async createEvent(eventData) {
    const data = this._load()
    data[eventData.id] = {
      ...eventData,
      createdAt: eventData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await saveData(FILES.serverEvents, data)
    return data[eventData.id]
  },

  async updateEvent(eventId, updates) {
    const data = this._load()
    if (!data[eventId]) return null
    data[eventId] = {
      ...data[eventId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    await saveData(FILES.serverEvents, data)
    return data[eventId]
  },

  async deleteEvent(eventId) {
    const data = this._load()
    const existing = data[eventId] || null
    if (!existing) return null
    delete data[eventId]
    await saveData(FILES.serverEvents, data)
    return existing
  }
}

export const globalBanService = {
  isBanned(userId) {
    const bans = loadData(FILES.globalBans, {})
    return bans[userId] || null
  },

  async banUser(userId, banData) {
    const bans = loadData(FILES.globalBans, {})
    bans[userId] = {
      ...banData,
      userId,
      bannedAt: new Date().toISOString()
    }
    await saveData(FILES.globalBans, bans)
    return bans[userId]
  },

  async unbanUser(userId) {
    const bans = loadData(FILES.globalBans, {})
    delete bans[userId]
    await saveData(FILES.globalBans, bans)
    return true
  },
  
  getAllBans() {
    return loadData(FILES.globalBans, {})
  }
}

export const adminLogService = {
  async log(action, userId, targetId, details = {}) {
    const logs = loadData(FILES.adminLogs, {})
    const logId = `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    
    logs[logId] = {
      id: logId,
      action,
      userId,
      targetId,
      details,
      createdAt: new Date().toISOString()
    }
    await saveData(FILES.adminLogs, logs)
    return logs[logId]
  },

  getLogs(limit = 100) {
    const logs = loadData(FILES.adminLogs, {})
    return Object.values(logs)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit)
  },
  
  getAllLogs() {
    return loadData(FILES.adminLogs, {})
  }
}

export const serverBanService = {
  isServerBanned(serverId) {
    const bans = loadData(FILES.serverBans, {})
    return bans[serverId] || null
  },

  async banServer(serverId, reason, bannedBy) {
    const bans = loadData(FILES.serverBans, {})
    bans[serverId] = {
      serverId,
      reason,
      bannedBy,
      bannedAt: new Date().toISOString()
    }
    await saveData(FILES.serverBans, bans)
    return bans[serverId]
  },

  async unbanServer(serverId) {
    const bans = loadData(FILES.serverBans, {})
    delete bans[serverId]
    await saveData(FILES.serverBans, bans)
    return true
  },

  getAllServerBans() {
    return loadData(FILES.serverBans, {})
  }
}

export const adminService = {
  _isTruthyFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true'
  },

  getStats() {
    const users = loadData(FILES.users, {})
    const servers = loadData(FILES.servers, {})
    const channels = loadData(FILES.channels, {})
    const messages = loadData(FILES.messages, {})
    const dms = loadData(FILES.dms, {})
    const globalBans = loadData(FILES.globalBans, {})

    const countCollection = (value) => {
      if (!value) return 0
      if (Array.isArray(value)) return value.length
      if (typeof value !== 'object') return 0
      const vals = Object.values(value)
      if (vals.some(v => Array.isArray(v))) {
        return vals.reduce((sum, v) => sum + (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? 1 : 0)), 0)
      }
      return Object.keys(value).length
    }

    const countUniqueConversations = (dmsState) => {
      if (!dmsState || typeof dmsState !== 'object') return 0
      const seen = new Set()
      for (const list of Object.values(dmsState)) {
        if (!Array.isArray(list)) continue
        for (const convo of list) {
          if (convo?.id) seen.add(convo.id)
        }
      }
      if (seen.size > 0) return seen.size
      return Object.keys(dmsState).length
    }
    
    return {
      totalUsers: countCollection(users),
      totalServers: countCollection(servers),
      totalChannels: countCollection(channels),
      totalMessages: countCollection(messages),
      totalDms: countUniqueConversations(dms),
      totalBans: Object.keys(globalBans).length,
      timestamp: new Date().toISOString()
    }
  },

  isAdmin(userId) {
    const user = userService.getUser(userId)
    const role = user?.adminRole || user?.role
    return role === 'admin' || role === 'owner' || this._isTruthyFlag(user?.isAdmin)
  },

  isModerator(userId) {
    const user = userService.getUser(userId)
    const role = user?.adminRole || user?.role
    return role === 'admin' || role === 'owner' || role === 'moderator' || this._isTruthyFlag(user?.isAdmin) || this._isTruthyFlag(user?.isModerator)
  },

  getUserRole(userId) {
    const user = userService.getUser(userId)
    return user?.adminRole || user?.role || 'user'
  },

  setUserRole(userId, role) {
    return userService.updateProfile(userId, { adminRole: role }, { allowPrivilegeUpdates: true })
  },

  logAction(userId, action, targetId, details) {
    return adminLogService.log(action, userId, targetId, details)
  },

  getLogs(limit = 100) {
    return adminLogService.getLogs(limit)
  },

  getAllUsers() {
    return Object.values(userService.getAllUsers())
  },

  async resetUserPassword(userId) {
    const tempPassword = Math.random().toString(36).slice(-8)
    const user = userService.getUser(userId)
    if (!user) return { success: false, error: 'User not found' }

    const { default: bcrypt } = await import('bcrypt')
    const tempHash = bcrypt.hashSync(tempPassword, 10)
    await userService.updateProfile(userId, { passwordHash: tempHash })

    return { success: true, tempPassword }
  },

  async deleteUser(userId) {
    const users = loadData(FILES.users, {})
    delete users[userId]
    await saveData(FILES.users, users)
    
    const friends = loadData(FILES.friends, {})
    if (friends[userId]) {
      delete friends[userId]
      Object.keys(friends).forEach((uid) => {
        friends[uid] = friends[uid].filter(fId => fId !== userId)
      })
      await saveData(FILES.friends, friends)
    }
    
    return { success: true }
  }
}

// ---------------------------------------------------------------------------
// System Message Service
// System messages are sent by Voltage itself to users/admins.
// Categories: 'update' | 'account' | 'discovery' | 'announcement'
// Audience targeting: per-user id, role ('admin'|'owner'|'all'), or server-specific
// ---------------------------------------------------------------------------
export const systemMessageService = {
  /**
   * Deliver a system message to one or more users.
   * @param {object} opts
   * @param {string}   opts.category   'update'|'account'|'discovery'|'announcement'
   * @param {string}   opts.title
   * @param {string}   opts.body       Markdown supported
   * @param {string}   [opts.icon]     Lucide icon name hint for the client
   * @param {string}   [opts.severity] 'info'|'warning'|'error'|'success'
   * @param {string[]} opts.recipients Array of user IDs to receive this message
   * @param {string}   [opts.dedupeKey] If set, skip users who already have a message with this key
   * @param {object}   [opts.meta]     Extra data (e.g. version, releaseUrl)
   * @returns {object[]} Array of created message objects
   */
  async send(opts) {
    const { category, title, body, icon, severity = 'info', recipients, dedupeKey, meta } = opts
    const data = loadData(FILES.systemMessages, {})
    const created = []
    const now = new Date().toISOString()

    for (const userId of (recipients || [])) {
      if (!data[userId]) data[userId] = []

      // Deduplicate: skip if a message with this dedupeKey was already sent
      if (dedupeKey && data[userId].some(m => m.dedupeKey === dedupeKey)) continue

      const msg = {
        id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        category,
        title,
        body,
        icon: icon || null,
        severity,
        dedupeKey: dedupeKey || null,
        meta: meta || null,
        read: false,
        createdAt: now
      }
      data[userId].push(msg)
      created.push({ userId, ...msg })
    }

    await saveData(FILES.systemMessages, data)
    return created
  },

  /** Get all system messages for a user, newest first */
  getForUser(userId) {
    const data = loadData(FILES.systemMessages, {})
    const msgs = data[userId] || []
    return [...msgs].reverse()
  },

  /** Count unread system messages for a user */
  unreadCount(userId) {
    const data = loadData(FILES.systemMessages, {})
    return (data[userId] || []).filter(m => !m.read).length
  },

  /** Mark one message as read */
  async markRead(userId, messageId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return false
    const msg = data[userId].find(m => m.id === messageId)
    if (!msg) return false
    msg.read = true
    await saveData(FILES.systemMessages, data)
    return true
  },

  /** Mark all messages for a user as read */
  async markAllRead(userId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return
    data[userId].forEach(m => { m.read = true })
    await saveData(FILES.systemMessages, data)
  },

  /** Delete a system message */
  async delete(userId, messageId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return false
    const before = data[userId].length
    data[userId] = data[userId].filter(m => m.id !== messageId)
    await saveData(FILES.systemMessages, data)
    return data[userId].length < before
  },

  /** Delete all system messages for a user */
  async clearAll(userId) {
    const data = loadData(FILES.systemMessages, {})
    data[userId] = []
    await saveData(FILES.systemMessages, data)
  }
}

// ---------------------------------------------------------------------------
// Call Log Service
// Stores call history for DM conversations
// ---------------------------------------------------------------------------
export const callLogService = {
  /**
   * Log a call event
   * @param {object} opts
   * @param {string} opts.callId - Unique call identifier
   * @param {string} opts.conversationId - DM conversation ID
   * @param {string} opts.callerId - User who initiated the call
   * @param {string} opts.recipientId - User who received the call
   * @param {string} opts.type - 'audio' | 'video'
   * @param {string} opts.status - 'started' | 'ended' | 'missed' | 'declined' | 'failed'
   * @param {number} [opts.duration] - Duration in seconds (for ended calls)
   * @param {string} [opts.endedBy] - User who ended the call
   * @param {string} [opts.endedAt] - ISO timestamp when call ended
   */
  async logCall(opts) {
    const { callId, conversationId, callerId, recipientId, type, status, duration, endedBy, endedAt } = opts
    const logs = loadData(FILES.callLogs, {})
    
    const now = new Date().toISOString()
    
    if (!logs[conversationId]) logs[conversationId] = []
    
    const existingIndex = logs[conversationId].findIndex(l => l.callId === callId)
    
    const logEntry = {
      callId,
      conversationId,
      callerId,
      recipientId,
      type: type || 'audio',
      status,
      duration: duration || 0,
      startedAt: existingIndex >= 0 ? logs[conversationId][existingIndex].startedAt : now,
      endedAt: endedAt || (status === 'ended' || status === 'missed' || status === 'declined' ? now : null),
      endedBy: endedBy || null,
      updatedAt: now
    }
    
    if (existingIndex >= 0) {
      logs[conversationId][existingIndex] = logEntry
    } else {
      logs[conversationId].push(logEntry)
    }
    
    await saveData(FILES.callLogs, logs)
    return logEntry
  },

  /**
   * Get call logs for a conversation
   * @param {string} conversationId - DM conversation ID
   * @param {number} limit - Max number of logs to return
   */
  getCallLogs(conversationId, limit = 50) {
    const logs = loadData(FILES.callLogs, {})
    const convLogs = logs[conversationId] || []
    return convLogs
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, limit)
  },

  /**
   * Get call logs for a user (across all conversations)
   * @param {string} userId - User ID
   * @param {number} limit - Max number of logs to return
   */
  getCallLogsForUser(userId, limit = 50) {
    const logs = loadData(FILES.callLogs, {})
    const allLogs = []
    
    for (const convLogs of Object.values(logs)) {
      for (const call of convLogs) {
        if (call.callerId === userId || call.recipientId === userId) {
          allLogs.push(call)
        }
      }
    }
    
    return allLogs
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, limit)
  },

  /**
   * Get a specific call by ID
   */
  getCall(callId) {
    const logs = loadData(FILES.callLogs, {})
    for (const convLogs of Object.values(logs)) {
      const call = convLogs.find(l => l.callId === callId)
      if (call) return call
    }
    return null
  },

  /**
   * Update an existing call log
   */
  async updateCall(callId, updates) {
    const logs = loadData(FILES.callLogs, {})
    for (const convId of Object.keys(logs)) {
      const idx = logs[convId].findIndex(l => l.callId === callId)
      if (idx >= 0) {
        logs[convId][idx] = {
          ...logs[convId][idx],
          ...updates,
          updatedAt: new Date().toISOString()
        }
        await saveData(FILES.callLogs, logs)
        return logs[convId][idx]
      }
    }
    return null
  },

  /**
   * Get all call logs
   */
  getAllCallLogs() {
    return loadData(FILES.callLogs, {})
  }
}

// Note: Storage initialization is handled by server.js calling initStorageAndDistribute()
// Do not initialize here to avoid race conditions

export const initActivityTables = async () => {
  const pool = getDbPool()
  if (!pool) {
    console.warn('[Activity] No DB pool available — activity tables not initialized')
    return
  }
  
  // Use pool.query() — works with both mysql2 (returns [rows, fields]) and
  // mariadb (returns rows directly). We don't destructure the result so both
  // drivers work without special-casing.
  const run = (sql) => pool.query(sql)

  try {
    await run(`
      CREATE TABLE IF NOT EXISTS activity_apps (
        id VARCHAR(255) PRIMARY KEY,
        client_id VARCHAR(255) UNIQUE NOT NULL,
        client_secret VARCHAR(255) NOT NULL,
        owner_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        redirect_uris TEXT,
        scopes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_activity_apps_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    
    await run(`
      CREATE TABLE IF NOT EXISTS activity_public (
        id VARCHAR(255) PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        icon VARCHAR(100),
        category VARCHAR(100),
        launch_url TEXT,
        visibility VARCHAR(50) DEFAULT 'public',
        is_builtin_client TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_activity_public_owner (owner_id),
        INDEX idx_activity_public_visibility (visibility)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    
    await run(`
      CREATE TABLE IF NOT EXISTS activity_oauth_codes (
        code VARCHAR(255) PRIMARY KEY,
        client_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        scope TEXT,
        redirect_uri TEXT,
        context_type VARCHAR(50),
        context_id VARCHAR(255),
        session_id VARCHAR(255),
        app_id VARCHAR(255),
        expires_at BIGINT NOT NULL,
        INDEX idx_activity_codes_client (client_id),
        INDEX idx_activity_codes_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    
    await run(`
      CREATE TABLE IF NOT EXISTS activity_oauth_tokens (
        access_token VARCHAR(255) PRIMARY KEY,
        app_id VARCHAR(255) NOT NULL,
        client_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        scope TEXT,
        context_type VARCHAR(50),
        context_id VARCHAR(255),
        session_id VARCHAR(255),
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        INDEX idx_activity_tokens_app (app_id),
        INDEX idx_activity_tokens_client (client_id),
        INDEX idx_activity_tokens_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    
    await run(`
      CREATE TABLE IF NOT EXISTS activity_manifests (
        id VARCHAR(255) PRIMARY KEY,
        app_id VARCHAR(255) NOT NULL,
        owner_id VARCHAR(255) NOT NULL,
        manifest LONGTEXT NOT NULL,
        is_valid TINYINT(1) DEFAULT 1,
        validation_errors TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_activity_manifests_app (app_id),
        INDEX idx_activity_manifests_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    
    await run(`
      CREATE TABLE IF NOT EXISTS activity_oauth_refresh_tokens (
        refresh_token VARCHAR(255) PRIMARY KEY,
        app_id VARCHAR(255) NOT NULL,
        client_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,
        scope TEXT,
        context_type VARCHAR(50),
        context_id VARCHAR(255),
        session_id VARCHAR(255),
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        INDEX idx_activity_refresh_app (app_id),
        INDEX idx_activity_refresh_client (client_id),
        INDEX idx_activity_refresh_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    console.log('[Activity] Tables initialized successfully')
  } catch (err) {
    console.error('[Activity] Failed to initialize tables:', err.message)
    throw err
  }
}

export const moderationReportService = {
  _loadReports() {
    return loadData(FILES.reports, {})
  },

  async _saveReports(reports) {
    await saveData(FILES.reports, reports)
  },

  async create(data) {
    const reports = this._loadReports()
    const id = data.id || `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    reports[id] = {
      ...data,
      id,
      status: 'pending',
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actions: []
    }
    await this._saveReports(reports)
    return reports[id]
  },

  getById(id) {
    const reports = this._loadReports()
    return reports[id] || null
  },

  getByIdForReporter(id, reporterId) {
    const report = this.getById(id)
    if (!report) return null
    if (report.reporterId !== reporterId) return null
    return report
  },

  list({ status = null, limit = 100, offset = 0 }) {
    const reports = this._loadReports()
    let list = Object.values(reports)
    if (status) {
      // Normalize status aliases: 'open' maps to 'pending' (the internal status for new reports)
      const normalizedStatus = status === 'open' ? 'pending' : status
      list = list.filter(r => r.status === normalizedStatus || r.status === status)
    }
    return list
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(offset, offset + limit)
  },

  listByReporter(reporterId, { status = null, limit = 100, offset = 0 }) {
    const reports = this._loadReports()
    let list = Object.values(reports).filter(r => r.reporterId === reporterId)
    if (status) {
      // Normalize status aliases: 'open' maps to 'pending'
      const normalizedStatus = status === 'open' ? 'pending' : status
      list = list.filter(r => r.status === normalizedStatus || r.status === status)
    }
    return list
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(offset, offset + limit)
  },

  async resolve(id, { resolvedBy, status = 'resolved', resolution, note = null }) {
    const reports = this._loadReports()
    if (!reports[id]) return null
    // Accept either 'status' or 'resolution' parameter for the new status value
    const newStatus = status || resolution || 'resolved'
    reports[id].status = newStatus
    reports[id].resolvedBy = resolvedBy
    reports[id].resolvedAt = new Date().toISOString()
    reports[id].updatedAt = new Date().toISOString()
    if (note) reports[id].resolutionNote = note
    await this._saveReports(reports)
    return reports[id]
  },

  async appendAction(id, action) {
    const reports = this._loadReports()
    if (!reports[id]) return null
    if (!reports[id].actions) reports[id].actions = []
    reports[id].actions.push({
      ...action,
      createdAt: new Date().toISOString()
    })
    reports[id].updatedAt = new Date().toISOString()
    await this._saveReports(reports)
    return reports[id]
  },

  countRecentByReporter(reporterId, hours = 24) {
    const reports = this._loadReports()
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
    return Object.values(reports).filter(r => 
      r.reporterId === reporterId && r.createdAt >= cutoff
    ).length
  },

  findOpenDuplicateForReporter(reporterId, { contextType, channelId = null, conversationId = null, accusedUserId = null, targetUserId = null, reportType = null, serverId = null, messageId = null }) {
    const reports = this._loadReports()
    return Object.values(reports).find(r => {
      if (r.reporterId !== reporterId) return false
      if (r.status !== 'pending') return false
      if (r.contextType !== contextType) return false
      if (reportType && r.reportType !== reportType) return false
      // Match on the most specific available identifier
      if (messageId && r.clientMeta?.messageId === messageId) return true
      if (channelId && r.channelId === channelId && accusedUserId && r.accusedUserId === accusedUserId) return true
      if (conversationId && r.conversationId === conversationId) return true
      if (serverId && r.clientMeta?.serverId === serverId && !messageId) return true
      if (accusedUserId && r.accusedUserId === accusedUserId && contextType === 'user_profile') return true
      return false
    }) || null
  }
}

const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)

const getDbPool = () => {
  const storage = getStorage()
  return storage?.pool || null
}

const DEFAULT_ACTIVITIES = [
  { id: 'builtin:our-vids', key: 'our-vids', name: 'OurVids', description: 'Synchronized video watching with queue and voting.', category: 'Media', icon: 'video', participantCap: 64, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://our-vids' },
  { id: 'builtin:ready-check', key: 'ready-check', name: 'Ready Check', description: 'Fast ready confirmations for groups.', category: 'Utility', icon: 'check', participantCap: 128, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://ready-check' },
  { id: 'builtin:soundboard-cues', key: 'soundboard-cues', name: 'Soundboard Cues', description: 'Trigger and share reactive sound cues.', category: 'Music', icon: 'audio', participantCap: 64, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://soundboard-cues' },
  { id: 'builtin:sequencer', key: 'sequencer', name: 'Sequencer', description: 'Simple 8-step beat sequencer.', category: 'Music', icon: 'grid', participantCap: 32, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://sequencer' },
  { id: 'builtin:colabcreate', key: 'colabcreate', name: 'ColabCreate', description: 'Full collaborative DAW.', category: 'Music', icon: 'daw', participantCap: 16, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://colabcreate' },
  { id: 'builtin:sketch-duel', key: 'sketch-duel', name: 'Sketch Duel', description: 'Fast timed doodle battles.', category: 'Creative', icon: 'sketch', participantCap: 8, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://sketch-duel' },
  { id: 'builtin:collaborative-drawing', key: 'collaborative-drawing', name: 'Drawing Board', description: 'Real-time collaborative drawing.', category: 'Creative', icon: 'draw', participantCap: 16, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://collaborative-drawing' },
  { id: 'builtin:pixel-art', key: 'pixel-art', name: 'Pixel Art Board', description: 'Shared pixel canvas.', category: 'Creative', icon: 'pixels', participantCap: 32, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://pixel-art' },
  { id: 'builtin:poker-night', key: 'poker-night', name: 'Poker Night', description: 'Texas Hold\'em poker with friends.', category: 'Games', icon: 'poker', participantCap: 8, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://poker-night' },
  { id: 'builtin:chess-arena', key: 'chess-arena', name: 'Chess Arena', description: 'Multiplayer chess.', category: 'Games', icon: 'board', participantCap: 16, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://chess-arena' },
  { id: 'builtin:tic-tac-toe', key: 'tic-tac-toe', name: 'Tic Tac Toe', description: 'Classic multiplayer grid duel.', category: 'Games', icon: 'tic-tac-toe', participantCap: 8, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://tic-tac-toe' },
  { id: 'builtin:connect-four', key: 'connect-four', name: 'Connect Four', description: 'Drop-disc strategy game.', category: 'Games', icon: 'connect-four', participantCap: 8, isBuiltinClient: true, oauthRequired: false, launchUrl: 'builtin://connect-four' }
]

// Helper: normalise rows returned by either mysql2 (returns [rows,fields] tuple)
// or mariadb (returns rows array directly). Both are now covered.
const dbRows = (result) => {
  if (!result) return []
  // mysql2: result is [rowsArray, fieldsArray]
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  // mariadb: result is the rows array directly
  if (Array.isArray(result)) return result
  return []
}

// Helper: normalise DML result (INSERT/UPDATE/DELETE) from either driver.
// mysql2 returns [OkPacket, fields]; mariadb returns OkPacket directly.
const dbResult = (result) => {
  if (!result) return { affectedRows: 0 }
  if (Array.isArray(result)) return result[0] || { affectedRows: 0 }
  return result
}

export const activityAppService = {
  _mapRow(row) {
    return {
      id: row.id,
      clientId: row.client_id,
      clientSecret: row.client_secret,
      ownerId: row.owner_id,
      name: row.name,
      description: row.description,
      redirectUris: row.redirect_uris ? JSON.parse(row.redirect_uris) : [],
      scopes: row.scopes ? JSON.parse(row.scopes) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  },

  async listByUser(userId) {
    const pool = getDbPool()
    if (!pool) return []
    try {
      const raw = await pool.query('SELECT * FROM activity_apps WHERE owner_id = ?', [userId])
      const rows = dbRows(raw)
      return rows.map(r => this._mapRow(r))
    } catch (err) {
      console.error('[Activity] listByUser error:', err.message)
      return []
    }
  },

  async getById(appId) {
    const pool = getDbPool()
    if (!pool) return null
    try {
      const raw = await pool.query('SELECT * FROM activity_apps WHERE id = ?', [appId])
      const rows = dbRows(raw)
      if (!rows[0]) return null
      return this._mapRow(rows[0])
    } catch (err) {
      console.error('[Activity] getById error:', err.message)
      return null
    }
  },

  async getByClientId(clientId) {
    const pool = getDbPool()
    if (!pool) return null
    try {
      const raw = await pool.query('SELECT * FROM activity_apps WHERE client_id = ?', [clientId])
      const rows = dbRows(raw)
      if (!rows[0]) return null
      return this._mapRow(rows[0])
    } catch (err) {
      console.error('[Activity] getByClientId error:', err.message)
      return null
    }
  },

  async create(ownerId, data) {
    const pool = getDbPool()
    if (!pool) return null
    const appId = generateId()
    const clientId = generateId()
    const clientSecret = generateId() + generateId()
    const name = data.name || 'My Activity'
    const description = data.description || ''
    const redirectUris = data.redirectUris || []
    const scopes = data.scopes || ['activities:read', 'activities:join']
    try {
      await pool.query(
        `INSERT INTO activity_apps (id, client_id, client_secret, owner_id, name, description, redirect_uris, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [appId, clientId, clientSecret, ownerId, name, description, JSON.stringify(redirectUris), JSON.stringify(scopes)]
      )
      console.log(`[Activity] Created app ${appId} for owner ${ownerId}`)
      return { id: appId, clientId, clientSecret, ownerId, name, description, redirectUris, scopes }
    } catch (err) {
      console.error('[Activity] create error:', err.message)
      return null
    }
  },

  async rotateSecret(ownerId, appId) {
    const pool = getDbPool()
    if (!pool) return null
    const newSecret = generateId() + generateId()
    try {
      const raw = await pool.query(
        'UPDATE activity_apps SET client_secret = ? WHERE id = ? AND owner_id = ?',
        [newSecret, appId, ownerId]
      )
      return dbResult(raw).affectedRows > 0 ? { clientSecret: newSecret } : null
    } catch (err) {
      console.error('[Activity] rotateSecret error:', err.message)
      return null
    }
  },

  async update(ownerId, appId, data) {
    const pool = getDbPool()
    if (!pool) return null
    try {
      const fields = []
      const values = []
      if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name) }
      if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
      if (data.redirectUris !== undefined) { fields.push('redirect_uris = ?'); values.push(JSON.stringify(data.redirectUris)) }
      if (data.scopes !== undefined) { fields.push('scopes = ?'); values.push(JSON.stringify(data.scopes)) }
      if (fields.length === 0) return this.getById(appId)
      values.push(appId, ownerId)
      const raw = await pool.query(
        `UPDATE activity_apps SET ${fields.join(', ')} WHERE id = ? AND owner_id = ?`,
        values
      )
      return dbResult(raw).affectedRows > 0 ? this.getById(appId) : null
    } catch (err) {
      console.error('[Activity] update error:', err.message)
      return null
    }
  },

  async delete(ownerId, appId) {
    const pool = getDbPool()
    if (!pool) return false
    try {
      const raw = await pool.query(
        'DELETE FROM activity_apps WHERE id = ? AND owner_id = ?',
        [appId, ownerId]
      )
      return dbResult(raw).affectedRows > 0
    } catch (err) {
      console.error('[Activity] delete error:', err.message)
      return false
    }
  }
}

export const activityPublicService = {
  _mapRow(row) {
    return {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      category: row.category,
      launchUrl: row.launch_url,
      visibility: row.visibility,
      isBuiltinClient: Boolean(row.is_builtin_client),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  },

  async listAll() {
    const pool = getDbPool()
    if (!pool) return []
    try {
      const raw = await pool.query('SELECT * FROM activity_public WHERE visibility = ?', ['public'])
      return dbRows(raw).map(r => this._mapRow(r))
    } catch (err) {
      console.error('[Activity] listAll error:', err.message)
      return []
    }
  },

  async getById(activityId) {
    const pool = getDbPool()
    if (!pool) return null
    try {
      const raw = await pool.query('SELECT * FROM activity_public WHERE id = ?', [activityId])
      const rows = dbRows(raw)
      if (!rows[0]) return null
      return this._mapRow(rows[0])
    } catch (err) {
      console.error('[Activity] getById error:', err.message)
      return null
    }
  },

  async create(ownerId, data) {
    const pool = getDbPool()
    if (!pool) return null
    const activityId = generateId()
    const name = data.name || 'My Activity'
    const description = data.description || ''
    const icon = data.icon || 'puzzle'
    const category = data.category || 'Games'
    const launchUrl = data.launchUrl || ''
    try {
      await pool.query(
        `INSERT INTO activity_public (id, owner_id, name, description, icon, category, launch_url, visibility, is_builtin_client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [activityId, ownerId, name, description, icon, category, launchUrl, 'public', 0]
      )
      return { id: activityId, ownerId, name, description, icon, category, launchUrl, visibility: 'public', isBuiltinClient: false }
    } catch (err) {
      console.error('[Activity] create public error:', err.message)
      return null
    }
  },

  async delete(ownerId, activityId) {
    const pool = getDbPool()
    if (!pool) return false
    try {
      const raw = await pool.query(
        'DELETE FROM activity_public WHERE id = ? AND owner_id = ?',
        [activityId, ownerId]
      )
      return dbResult(raw).affectedRows > 0
    } catch (err) {
      console.error('[Activity] delete public error:', err.message)
      return false
    }
  }
}

export const activityOAuthService = {
  async createAuthorizationCode({ clientId, userId, scope, redirectUri, contextType, contextId, sessionId, appId }) {
    const pool = getDbPool()
    if (!pool) return null
    const code = generateId() + generateId()
    const expiresAt = Date.now() + 10 * 60 * 1000
    try {
      await pool.query(
        `INSERT INTO activity_oauth_codes (code, client_id, user_id, scope, redirect_uri, context_type, context_id, session_id, app_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [code, clientId, userId, scope, redirectUri, contextType, contextId, sessionId, appId, expiresAt]
      )
      return code
    } catch (err) {
      console.error('[Activity] createAuthorizationCode error:', err.message)
      return null
    }
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
    const pool = getDbPool()
    if (!pool) return { error: 'server_error' }
    try {
      const codeRows = dbRows(await pool.query('SELECT * FROM activity_oauth_codes WHERE code = ?', [code]))
      const codeData = codeRows[0]
      if (!codeData) return { error: 'invalid_code' }
      if (Date.now() > Number(codeData.expires_at)) {
        await pool.query('DELETE FROM activity_oauth_codes WHERE code = ?', [code])
        return { error: 'code_expired' }
      }
      if (codeData.client_id !== clientId) return { error: 'invalid_client' }
      if (codeData.redirect_uri !== redirectUri) return { error: 'invalid_redirect_uri' }

      const app = await activityAppService.getByClientId(clientId)
      if (!app || app.clientSecret !== clientSecret) return { error: 'invalid_client' }

      await pool.query('DELETE FROM activity_oauth_codes WHERE code = ?', [code])

      const accessToken = generateId() + generateId() + generateId()
      const refreshToken = generateId() + generateId() + generateId()
      const now = Date.now()
      const expiresAt = now + 24 * 60 * 60 * 1000

      await pool.query(
        `INSERT INTO activity_oauth_tokens (access_token, app_id, client_id, user_id, scope, context_type, context_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accessToken, app.id, clientId, codeData.user_id, codeData.scope, codeData.context_type, codeData.context_id, codeData.session_id, now, expiresAt]
      )

      return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 86400,
        scope: codeData.scope
      }
    } catch (err) {
      console.error('[Activity] exchangeCode error:', err.message)
      return { error: 'server_error' }
    }
  },

  async introspectAccessToken(accessToken) {
    const pool = getDbPool()
    if (!pool) return { active: false }
    try {
      const rows = dbRows(await pool.query('SELECT * FROM activity_oauth_tokens WHERE access_token = ?', [accessToken]))
      const tokenData = rows[0]
      if (!tokenData) return { active: false }
      if (Date.now() > Number(tokenData.expires_at)) {
        await pool.query('DELETE FROM activity_oauth_tokens WHERE access_token = ?', [accessToken])
        return { active: false }
      }
      return {
        active: true,
        app_id: tokenData.app_id,
        client_id: tokenData.client_id,
        user_id: tokenData.user_id,
        scope: tokenData.scope,
        context_type: tokenData.context_type,
        context_id: tokenData.context_id,
        session_id: tokenData.session_id,
        exp: Math.floor(Number(tokenData.expires_at) / 1000)
      }
    } catch (err) {
      console.error('[Activity] introspectAccessToken error:', err.message)
      return { active: false }
    }
  }
}

const VALID_MANIFEST_FIELDS = ['id', 'name', 'description', 'version', 'icon', 'developer', 'launch', 'features', 'permissions', 'scopes', 'capabilities']
const VALID_FEATURES = ['p2p', 'state-sync', 'voice', 'camera', 'screen-share', 'file-share']
const VALID_SCOPES = ['activities:read', 'activities:write', 'activities:state:read', 'activities:state:write', 'activities:join', 'activities:p2p', 'activities:voice', 'activities:presence']

const validateManifest = (manifest) => {
  const errors = []
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] }
  }
  if (!manifest.id || typeof manifest.id !== 'string') {
    errors.push('Manifest must have an id string')
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('Manifest must have a name string')
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('Manifest must have a version string')
  }
  if (!manifest.launch || typeof manifest.launch !== 'object') {
    errors.push('Manifest must have a launch object')
  } else {
    if (!manifest.launch.url) {
      errors.push('Manifest launch must have a url')
    }
  }
  if (manifest.features && Array.isArray(manifest.features)) {
    for (const feature of manifest.features) {
      if (!VALID_FEATURES.includes(feature)) {
        errors.push(`Invalid feature: ${feature}`)
      }
    }
  }
  if (manifest.scopes && Array.isArray(manifest.scopes)) {
    for (const scope of manifest.scopes) {
      if (!VALID_SCOPES.includes(scope)) {
        errors.push(`Invalid scope: ${scope}`)
      }
    }
  }
  for (const key of Object.keys(manifest)) {
    if (!VALID_MANIFEST_FIELDS.includes(key)) {
      errors.push(`Unknown field: ${key}`)
    }
  }
  return { valid: errors.length === 0, errors }
}

export const activityManifestService = {
  _mapRow(row) {
    return {
      id: row.id,
      appId: row.app_id,
      ownerId: row.owner_id,
      manifest: row.manifest,
      isValid: !!row.is_valid,
      validationErrors: row.validation_errors ? JSON.parse(row.validation_errors) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  },

  async create(appId, ownerId, manifest) {
    const pool = getDbPool()
    if (!pool) return null
    const validation = validateManifest(manifest)
    const manifestId = manifest.id || generateId()
    try {
      await pool.query(
        `INSERT INTO activity_manifests (id, app_id, owner_id, manifest, is_valid, validation_errors) VALUES (?, ?, ?, ?, ?, ?)`,
        [manifestId, appId, ownerId, JSON.stringify(manifest), validation.valid ? 1 : 0, validation.valid ? null : JSON.stringify(validation.errors)]
      )
      return { id: manifestId, appId, manifest, isValid: validation.valid, validationErrors: validation.errors }
    } catch (err) {
      console.error('[Activity] manifest create error:', err.message)
      return null
    }
  },

  async getByAppId(appId) {
    const pool = getDbPool()
    if (!pool) return null
    try {
      const rows = dbRows(await pool.query('SELECT * FROM activity_manifests WHERE app_id = ?', [appId]))
      if (!rows[0]) return null
      return this._mapRow(rows[0])
    } catch (err) {
      console.error('[Activity] manifest getByAppId error:', err.message)
      return null
    }
  },

  async update(appId, ownerId, manifest) {
    const pool = getDbPool()
    if (!pool) return null
    const validation = validateManifest(manifest)
    try {
      const raw = await pool.query(
        `UPDATE activity_manifests SET manifest = ?, is_valid = ?, validation_errors = ?, updated_at = CURRENT_TIMESTAMP WHERE app_id = ? AND owner_id = ?`,
        [JSON.stringify(manifest), validation.valid ? 1 : 0, validation.valid ? null : JSON.stringify(validation.errors), appId, ownerId]
      )
      return dbResult(raw).affectedRows > 0 ? { id: manifest.id || generateId(), appId, manifest, isValid: validation.valid, validationErrors: validation.errors } : null
    } catch (err) {
      console.error('[Activity] manifest update error:', err.message)
      return null
    }
  },

  async delete(appId, ownerId) {
    const pool = getDbPool()
    if (!pool) return false
    try {
      const raw = await pool.query('DELETE FROM activity_manifests WHERE app_id = ? AND owner_id = ?', [appId, ownerId])
      return dbResult(raw).affectedRows > 0
    } catch (err) {
      console.error('[Activity] manifest delete error:', err.message)
      return false
    }
  },

  async listByUser(userId) {
    const pool = getDbPool()
    if (!pool) return []
    try {
      const rows = dbRows(await pool.query('SELECT * FROM activity_manifests WHERE owner_id = ?', [userId]))
      return rows.map(r => this._mapRow(r))
    } catch (err) {
      console.error('[Activity] manifest listByUser error:', err.message)
      return []
    }
  },

  validate(manifest) {
    return validateManifest(manifest)
  }
}

export const activityRefreshTokenService = {
  async create(data) {
    const pool = getDbPool()
    if (!pool) return null
    const refreshToken = generateId() + generateId()
    const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000)
    try {
      await pool.query(
        `INSERT INTO activity_oauth_refresh_tokens (refresh_token, app_id, client_id, user_id, scope, context_type, context_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [refreshToken, data.appId, data.clientId, data.userId, data.scope || '', data.contextType || null, data.contextId || null, data.sessionId || null, Date.now(), expiresAt]
      )
      return { refreshToken, expiresAt }
    } catch (err) {
      console.error('[Activity] refresh token create error:', err.message)
      return null
    }
  },

  async use(refreshToken) {
    const pool = getDbPool()
    if (!pool) return null
    try {
      const rows = dbRows(await pool.query('SELECT * FROM activity_oauth_refresh_tokens WHERE refresh_token = ?', [refreshToken]))
      const tokenData = rows[0]
      if (!tokenData) return { error: 'invalid_grant' }
      if (Date.now() > Number(tokenData.expires_at)) {
        await pool.query('DELETE FROM activity_oauth_refresh_tokens WHERE refresh_token = ?', [refreshToken])
        return { error: 'invalid_grant' }
      }
      await pool.query('DELETE FROM activity_oauth_refresh_tokens WHERE refresh_token = ?', [refreshToken])
      return {
        appId: tokenData.app_id,
        clientId: tokenData.client_id,
        userId: tokenData.user_id,
        scope: tokenData.scope,
        contextType: tokenData.context_type,
        contextId: tokenData.context_id,
        sessionId: tokenData.session_id
      }
    } catch (err) {
      console.error('[Activity] refresh token use error:', err.message)
      return null
    }
  },

  async revoke(userId, refreshToken) {
    const pool = getDbPool()
    if (!pool) return false
    try {
      const raw = await pool.query('DELETE FROM activity_oauth_refresh_tokens WHERE refresh_token = ? AND user_id = ?', [refreshToken, userId])
      return dbResult(raw).affectedRows > 0
    } catch (err) {
      console.error('[Activity] refresh token revoke error:', err.message)
      return false
    }
  },

  async revokeAll(userId, appId) {
    const pool = getDbPool()
    if (!pool) return false
    try {
      if (appId) {
        await pool.query('DELETE FROM activity_oauth_refresh_tokens WHERE user_id = ? AND app_id = ?', [userId, appId])
      } else {
        await pool.query('DELETE FROM activity_oauth_refresh_tokens WHERE user_id = ?', [userId])
      }
      return true
    } catch (err) {
      console.error('[Activity] refresh token revokeAll error:', err.message)
      return false
    }
  }
}

export const activityService = {
  async listCatalog() {
    const publicActivities = await activityPublicService.listAll()
    return [...DEFAULT_ACTIVITIES, ...publicActivities]
  },

  async listPublicActivities() {
    return activityPublicService.listAll()
  },

  async listMyApps(userId) {
    return activityAppService.listByUser(userId)
  },

  async createApp(userId, data) {
    return activityAppService.create(userId, data)
  },

  async rotateClientSecret(userId, appId) {
    return activityAppService.rotateSecret(userId, appId)
  },

  async createPublicActivity(userId, data) {
    return activityPublicService.create(userId, data)
  },

  async deletePublicActivity(userId, activityId) {
    return activityPublicService.delete(userId, activityId)
  },

  async getAppByClientId(clientId) {
    return activityAppService.getByClientId(clientId)
  },

  async getAppById(appId) {
    return activityAppService.getById(appId)
  },

  async updateApp(userId, appId, data) {
    const existing = await activityAppService.getById(appId)
    if (!existing || existing.ownerId !== userId) return null
    return activityAppService.update(userId, appId, data)
  },

  async deleteApp(userId, appId) {
    const existing = await activityAppService.getById(appId)
    if (!existing || existing.ownerId !== userId) return false
    await activityAppService.delete(userId, appId)
    await activityManifestService.delete(appId, userId)
    return true
  },

  async createManifest(appId, userId, manifest) {
    const existing = await activityAppService.getById(appId)
    if (!existing || existing.ownerId !== userId) return null
    return activityManifestService.create(appId, userId, manifest)
  },

  async getManifest(appId) {
    return activityManifestService.getByAppId(appId)
  },

  async updateManifest(appId, userId, manifest) {
    const existing = await activityAppService.getById(appId)
    if (!existing || existing.ownerId !== userId) return null
    return activityManifestService.update(appId, userId, manifest)
  },

  async deleteManifest(appId, userId) {
    const existing = await activityAppService.getById(appId)
    if (!existing || existing.ownerId !== userId) return false
    return activityManifestService.delete(appId, userId)
  },

  async validateManifest(manifest) {
    return activityManifestService.validate(manifest)
  },

  async listManifestsByUser(userId) {
    return activityManifestService.listByUser(userId)
  },

  async createAuthorizationCode(data) {
    return activityOAuthService.createAuthorizationCode(data)
  },

  async exchangeAuthorizationCode(data) {
    const result = await activityOAuthService.exchangeCode(data)
    if (result?.access_token) {
      await activityRefreshTokenService.create({
        appId: result.app_id,
        clientId: data.clientId,
        userId: result.user_id,
        scope: result.scope
      })
    }
    return result
  },

  async refreshAccessToken(refreshToken, clientId, clientSecret) {
    const tokenData = await activityRefreshTokenService.use(refreshToken)
    if (tokenData?.error) return tokenData
    if (tokenData.clientId !== clientId) return { error: 'invalid_grant' }
    const app = await activityAppService.getByClientId(clientId)
    if (!app || app.clientSecret !== clientSecret) return { error: 'invalid_client' }
    const accessToken = generateId() + generateId()
    const expiresAt = Date.now() + (3600 * 1000)
    try {
      const pool = getDbPool()
      await pool.execute(
        `INSERT INTO activity_oauth_tokens (access_token, app_id, client_id, user_id, scope, context_type, context_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accessToken, app.id, clientId, tokenData.userId, tokenData.scope, tokenData.contextType, tokenData.contextId, tokenData.sessionId, Date.now(), expiresAt]
      )
      await activityRefreshTokenService.create({
        appId: app.id,
        clientId,
        userId: tokenData.userId,
        scope: tokenData.scope,
        contextType: tokenData.contextType,
        contextId: tokenData.contextId,
        sessionId: tokenData.sessionId
      })
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: tokenData.refreshToken,
        scope: tokenData.scope
      }
    } catch (err) {
      console.error('[Activity] refresh token error:', err.message)
      return { error: 'server_error' }
    }
  },

  async revokeToken(token, userId) {
    if (!token || !userId) return { error: 'invalid_request' }
    const pool = getDbPool()
    if (!pool) return { error: 'server_error' }
    try {
      const [result] = await pool.execute('DELETE FROM activity_oauth_tokens WHERE access_token = ? AND user_id = ?', [token, userId])
      await activityRefreshTokenService.revokeAll(userId)
      return { success: result.affectedRows > 0 }
    } catch (err) {
      console.error('[Activity] revoke token error:', err.message)
      return { error: 'server_error' }
    }
  },

  async introspectAccessToken(token) {
    return activityOAuthService.introspectAccessToken(token)
  },

  getAvailableScopes() {
    return VALID_SCOPES
  }
}

export default {
  initStorage,
  initActivityTables,
  userService,
  serverService,
  channelService,
  messageService,
  dmService,
  inviteService,
  getStorageInfo,
  FILES
}
