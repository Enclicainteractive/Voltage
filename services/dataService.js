import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'
import { getStorage, resetStorage as resetStorageLayer } from './storageService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Use configured data directory, not hardcoded path
// IMPORTANT: This must be called AFTER config.load() to get correct path
let _dataDir = null
let _filesCache = null

const getDataDir = () => {
  if (_dataDir) return _dataDir
  config.load()
  _dataDir = config.config.storage?.json?.dataDir || path.join(__dirname, '..', '..', 'data')
  return _dataDir
}

// Only create directory if using JSON storage
const ensureDataDir = () => {
  config.load()
  if (config.config.storage?.type === 'json') {
    const dataDir = getDataDir()
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
  }
}

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
    globalBans: path.join(dataDir, 'global-bans.json'),
    serverBans: path.join(dataDir, 'server-bans.json'),
    adminLogs: path.join(dataDir, 'admin-logs.json'),
    systemMessages: path.join(dataDir, 'system-messages.json'),
    e2eTrue: path.join(dataDir, 'e2e-true.json'),
    pinnedMessages: path.join(dataDir, 'pinned-messages.json'),
    selfVolts: path.join(dataDir, 'self-volts.json'),
    federation: path.join(dataDir, 'federation.json'),
    serverStart: path.join(dataDir, 'server-start.json'),
    callLogs: path.join(dataDir, 'call-logs.json')
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
      [files.globalBans]: 'global_bans',
      [files.serverBans]: 'server_bans',
      [files.adminLogs]: 'admin_logs',
      [files.systemMessages]: 'system_messages',
      [files.e2eTrue]: 'e2e_true',
      [files.pinnedMessages]: 'pinned_messages',
      [files.selfVolts]: 'self_volts',
      [files.federation]: 'federation',
      [files.serverStart]: 'server_start',
      [files.callLogs]: 'call_logs'
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

const loadJsonFileDirect = (file, defaultValue = {}) => {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (err) {
    console.error(`[DataService] Auto-migrate read error (${path.basename(file)}):`, err.message)
  }
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

const autoMigrateJsonToStorage = async () => {
  if (!useStorage || !storageService) return

  let migratedTables = 0
  let migratedEntries = 0

  for (const [file, table] of Object.entries(getFileToTable())) {
    const jsonData = loadJsonFileDirect(file, {})
    if (!hasAnyData(jsonData)) continue

    const storageData = storageCache[table] ?? {}
    const { merged, changed } = mergeMissingEntries(storageData, jsonData)
    if (!changed) continue

    storageCache[table] = merged
    await saveToStorage(table, merged)
    migratedTables += 1
    migratedEntries += Array.isArray(merged) ? merged.length : Object.keys(merged || {}).length
  }

  if (migratedTables > 0) {
    console.log(`[DataService] Auto-migrated JSON -> ${storageService.type}: ${migratedTables} tables, ${migratedEntries} entries`)
  } else {
    console.log('[DataService] Auto-migrate: no JSON data changes detected')
  }
}

// Get storage reference from storageService (initialized by server.js)
const refreshStorageRef = () => {
  storageService = getStorage()
  useStorage = storageService && storageService.type !== 'json'
  return storageService
}

const initStorage = async ({ forceReinit = false } = {}) => {
  try {
    config.load()
    if (forceReinit && resetStorageLayer) {
      await resetStorageLayer()
    }
    // Get storage from storageService (already initialized by server.js)
    storageService = getStorage()
    useStorage = storageService && storageService.type !== 'json'
    storageCache = {}
    
    if (useStorage) {
      console.log('[DataService] Using storage layer:', storageService.type)
      await loadAllData()
      await autoMigrateJsonToStorage()
    } else {
      console.log('[DataService] Using file-based storage (deprecated - migrate to a database)')
    }
  } catch (err) {
    console.error('[DataService] Storage initialization error:', err.message)
    useStorage = false
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

const loadAllData = async () => {
  if (!useStorage || !storageService) return
  
  for (const table of getStorageTables()) {
    try {
      if (storageService.load) {
        if (isAsyncStorageBackend(storageService.type)) {
          storageCache[table] = await storageService.load(table, {})
        } else {
          storageCache[table] = storageService.load(table, {})
        }
      }
    } catch (err) {
      console.error(`[DataService] Error loading ${table}:`, err.message)
      storageCache[table] = {}
    }
  }
}

const saveToStorage = async (table, data) => {
  if (!useStorage || !storageService) return
  
  try {
    if (isAsyncStorageBackend(storageService.type)) {
      await storageService.save(table, data)
    } else {
      storageService.save(table, data)
    }
  } catch (err) {
    console.error(`[DataService] Error saving ${table}:`, err.message)
  }
}

const loadData = (file, defaultValue = {}) => {
  if (useStorage) {
    const table = getTableName(file)
    
    // Check cache first
    if (storageCache[table] !== undefined) {
      return storageCache[table]
    }
    
    // Try to load from individual table first (after distribution)
    // Fall back to storage_kv if individual table doesn't exist
    const result = loadFromIndividualTable(table, defaultValue)
    storageCache[table] = result
    return result
  }
  
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (err) {
    console.error(`[Data] Error loading ${file}:`, err.message)
  }
  return defaultValue
}

// Load from individual table (after distribution) or fall back to storage_kv
const loadFromIndividualTable = (table, defaultValue = {}) => {
  if (!storageService) {
    return defaultValue
  }
  
  try {
    // For SQLite, try individual table first
    if (storageService.type === 'sqlite' && storageService.db) {
      const db = storageService.db
      // Check if individual table exists
      const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
      if (tableCheck) {
        // Load from individual table
        const rows = db.prepare(`SELECT * FROM ${table}`).all()
        const result = {}
        for (const row of rows) {
          const id = row.id || row.code || row.serverId || Object.keys(row)[0]
          if (id) {
            // Parse JSON fields back
            const parsed = {}
            for (const [key, value] of Object.entries(row)) {
              if (key === 'id' || key === 'code' || key === 'serverId') continue
              try {
                parsed[key] = JSON.parse(value)
              } catch {
                parsed[key] = value
              }
            }
            result[id] = Object.keys(parsed).length > 0 ? parsed : row
          }
        }
        if (Object.keys(result).length > 0) {
          console.log(`[Data] Loaded ${table} from individual table (${Object.keys(result).length} records)`)
          return result
        }
      }
      
      // Fall back to storage_kv
      try {
        const kvStmt = db.prepare('SELECT data FROM storage_kv WHERE id = ?')
        const kvRow = kvStmt.get(table)
        if (kvRow?.data) {
          try {
            return JSON.parse(kvRow.data)
          } catch {
            return defaultValue
          }
        }
      } catch {
        // storage_kv might not exist after distribution
      }
    }
    
    // For MySQL/MariaDB, use storage service load which handles distribution automatically
    if ((storageService.type === 'mysql' || storageService.type === 'mariadb') && storageService.pool) {
      return storageService.load(table, defaultValue)
    }
    
    // Default: use storage service
    return storageService.load(table, defaultValue)
  } catch (err) {
    console.error(`[Data] Error loading ${table}:`, err.message)
    return defaultValue
  }
}

const saveData = (file, data) => {
  if (useStorage) {
    const table = getTableName(file)
    storageCache[table] = data
    return saveToStorage(table, data)
  }
  
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error(`[Data] Error saving ${file}:`, err.message)
    return false
  }
}

const getTableName = (file) => {
  return FILE_TO_TABLE[file] || file
}

export const isManagedDataFile = (filePath) => {
  if (!filePath || typeof filePath !== 'string') return false
  return getManagedDataFiles().has(path.resolve(filePath))
}

export const loadManagedDataByFile = (filePath, defaultValue = {}) => {
  const resolved = path.resolve(filePath)
  return loadData(resolved, defaultValue)
}

export const saveManagedDataByFile = async (filePath, data) => {
  const resolved = path.resolve(filePath)
  return saveData(resolved, data)
}

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
    type: useStorage ? (storageService?.type || 'json') : 'json',
    provider: storageService?.provider || 'json',
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
    global_bans: FILES.globalBans,
    server_bans: FILES.serverBans,
    admin_logs: FILES.adminLogs,
    system_messages: FILES.systemMessages,
    e2e_true: FILES.e2eTrue,
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

export const userService = {
  getUser(userId) {
    const users = loadData(FILES.users, {})
    return users[userId] || null
  },

  saveUser(userId, userData) {
    const users = loadData(FILES.users, {})
    users[userId] = {
      ...users[userId],
      ...userData,
      id: userId,
      updatedAt: new Date().toISOString()
    }
    if (!users[userId].createdAt) {
      users[userId].createdAt = new Date().toISOString()
    }
    saveData(FILES.users, users)
    return users[userId]
  },

  updateProfile(userId, updates) {
    const users = loadData(FILES.users, {})
    if (!users[userId]) {
      users[userId] = { id: userId, createdAt: new Date().toISOString() }
    }
    users[userId] = {
      ...users[userId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    saveData(FILES.users, users)
    return users[userId]
  },

  setStatus(userId, status, customStatus = null) {
    const users = loadData(FILES.users, {})
    if (!users[userId]) {
      users[userId] = { id: userId, createdAt: new Date().toISOString() }
    }
    users[userId].status = status
    if (customStatus !== null) {
      users[userId].customStatus = customStatus
    }
    users[userId].updatedAt = new Date().toISOString()
    saveData(FILES.users, users)
    return users[userId]
  },

  setAgeVerification(userId, verification) {
    const users = loadData(FILES.users, {})
    const now = new Date()
    const category = verification?.category === 'child' ? 'child' : 'adult'
    const expiresAt = category === 'adult'
      ? null
      : (verification?.expiresAt || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString())

    users[userId] = {
      ...(users[userId] || { id: userId, createdAt: now.toISOString() }),
      ageVerification: {
        verified: true,
        method: verification?.method,
        birthYear: verification?.birthYear || null,
        age: verification?.age || null,
        proofSummary: verification?.proofSummary || {},
        category,
        estimatedAge: verification?.estimatedAge || null,
        verifiedAt: verification?.verifiedAt || now.toISOString(),
        expiresAt,
        device: verification?.device || null
      },
      updatedAt: now.toISOString()
    }

    saveData(FILES.users, users)
    return users[userId]
  },

  isAgeVerified(userId) {
    const profile = this.getUser(userId)
    const verification = profile?.ageVerification
    if (!verification?.verified) return false
    if (verification.category !== 'adult') return false
    if (verification.expiresAt && new Date(verification.expiresAt) < new Date()) {
      return false
    }
    return true
  },

  getAllUsers() {
    return loadData(FILES.users, {})
  }
}

export const friendService = {
  getFriends(userId) {
    const friends = loadData(FILES.friends, {})
    return friends[userId] || []
  },

  addFriend(userId, friendId) {
    const friends = loadData(FILES.friends, {})
    if (!friends[userId]) friends[userId] = []
    if (!friends[friendId]) friends[friendId] = []
    
    if (!friends[userId].includes(friendId)) {
      friends[userId].push(friendId)
    }
    if (!friends[friendId].includes(userId)) {
      friends[friendId].push(userId)
    }
    
    saveData(FILES.friends, friends)
    return true
  },

  removeFriend(userId, friendId) {
    const friends = loadData(FILES.friends, {})
    if (friends[userId]) {
      friends[userId] = friends[userId].filter(id => id !== friendId)
    }
    if (friends[friendId]) {
      friends[friendId] = friends[friendId].filter(id => id !== userId)
    }
    saveData(FILES.friends, friends)
    return true
  },

  areFriends(userId1, userId2) {
    const friends = loadData(FILES.friends, {})
    return friends[userId1]?.includes(userId2) || false
  },
  
  getAllFriends() {
    return loadData(FILES.friends, {})
  }
}

export const friendRequestService = {
  getRequests(userId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
    const incomingMap = requests?.incoming && typeof requests.incoming === 'object' ? requests.incoming : {}
    const outgoingMap = requests?.outgoing && typeof requests.outgoing === 'object' ? requests.outgoing : {}
    return {
      incoming: incomingMap[userId] || [],
      outgoing: outgoingMap[userId] || []
    }
  },

  sendRequest(fromUserId, toUserId, fromUsername, toUsername) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    if (!requests.incoming[toUserId]) requests.incoming[toUserId] = []
    if (!requests.outgoing[fromUserId]) requests.outgoing[fromUserId] = []
    
    const existingIncoming = requests.incoming[toUserId].find(r => r.from === fromUserId)
    if (existingIncoming) return { error: 'Request already sent' }
    
    const request = {
      id: `fr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      from: fromUserId,
      fromUsername: fromUsername,
      to: toUserId,
      toUsername: toUsername,
      createdAt: new Date().toISOString()
    }
    
    requests.incoming[toUserId].push(request)
    requests.outgoing[fromUserId].push({ ...request, to: toUserId, toUsername: toUsername })
    
    saveData(FILES.friendRequests, requests)
    return request
  },

  acceptRequest(userId, requestId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    const incoming = requests.incoming[userId] || []
    const request = incoming.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.incoming[userId] = incoming.filter(r => r.id !== requestId)
    if (requests.outgoing[request.from]) {
      requests.outgoing[request.from] = requests.outgoing[request.from].filter(r => r.id !== requestId)
    }
    
    saveData(FILES.friendRequests, requests)
    friendService.addFriend(userId, request.from)
    
    return { success: true, friendId: request.from }
  },

  rejectRequest(userId, requestId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    const incoming = requests.incoming[userId] || []
    const request = incoming.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.incoming[userId] = incoming.filter(r => r.id !== requestId)
    if (requests.outgoing[request.from]) {
      requests.outgoing[request.from] = requests.outgoing[request.from].filter(r => r.id !== requestId)
    }
    
    saveData(FILES.friendRequests, requests)
    return { success: true }
  },

  cancelRequest(userId, requestId) {
    const requests = loadData(FILES.friendRequests, { incoming: {}, outgoing: {} }) || {}
    if (!requests.incoming || typeof requests.incoming !== 'object') requests.incoming = {}
    if (!requests.outgoing || typeof requests.outgoing !== 'object') requests.outgoing = {}
    
    const outgoing = requests.outgoing[userId] || []
    const request = outgoing.find(r => r.id === requestId)
    
    if (!request) return { error: 'Request not found' }
    
    requests.outgoing[userId] = outgoing.filter(r => r.id !== requestId)
    if (requests.incoming[request.to]) {
      requests.incoming[request.to] = requests.incoming[request.to].filter(r => r.id !== requestId)
    }
    
    saveData(FILES.friendRequests, requests)
    return { success: true }
  },
  
  getAllRequests() {
    return loadData(FILES.friendRequests, { incoming: {}, outgoing: {} })
  }
}

export const blockService = {
  getBlocked(userId) {
    const blocked = loadData(FILES.blocked, {})
    return blocked[userId] || []
  },

  blockUser(userId, blockedUserId) {
    const blocked = loadData(FILES.blocked, {})
    if (!blocked[userId]) blocked[userId] = []
    
    if (!blocked[userId].includes(blockedUserId)) {
      blocked[userId].push(blockedUserId)
    }
    
    friendService.removeFriend(userId, blockedUserId)
    
    saveData(FILES.blocked, blocked)
    return true
  },

  unblockUser(userId, blockedUserId) {
    const blocked = loadData(FILES.blocked, {})
    if (blocked[userId]) {
      blocked[userId] = blocked[userId].filter(id => id !== blockedUserId)
    }
    saveData(FILES.blocked, blocked)
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

  createGroupConversation(ownerId, participantIds = [], groupName = '') {
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

    saveData(FILES.dms, dms)
    return baseConversation
  },

  getOrCreateConversation(userId1, userId2) {
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
      
      saveData(FILES.dms, dms)
      return newConv
    }
    
    return conv1
  },

  updateLastMessage(conversationId, userId1, userId2) {
    const dms = loadData(FILES.dms, {})
    const now = new Date().toISOString()

    const touchedUsers = new Set()
    if (userId1) touchedUsers.add(userId1)
    if (userId2) touchedUsers.add(userId2)

    // For group DMs (or when user ids are missing), update every member copy.
    if (touchedUsers.size === 0) {
      Object.keys(dms).forEach(uid => touchedUsers.add(uid))
    }

    for (const uid of touchedUsers) {
      if (!dms[uid]) continue
      const conv = dms[uid].find(c => c.id === conversationId)
      if (conv) conv.lastMessageAt = now
    }

    // Final safety pass for any remaining participant copies.
    Object.keys(dms).forEach(uid => {
      const conv = dms[uid]?.find(c => c.id === conversationId)
      if (conv) conv.lastMessageAt = now
    })

    saveData(FILES.dms, dms)
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

  addMessage(conversationId, message) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) messages[conversationId] = []
    messages[conversationId].push(message)
    saveData(FILES.dmMessages, messages)
    return message
  },

  editMessage(conversationId, messageId, newContent) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) return null
    
    const msg = messages[conversationId].find(m => m.id === messageId)
    if (msg) {
      msg.content = newContent
      msg.edited = true
      msg.editedAt = new Date().toISOString()
      saveData(FILES.dmMessages, messages)
    }
    return msg
  },

  deleteMessage(conversationId, messageId) {
    const messages = loadData(FILES.dmMessages, {})
    if (!messages[conversationId]) return false
    
    const idx = messages[conversationId].findIndex(m => m.id === messageId)
    if (idx >= 0) {
      messages[conversationId].splice(idx, 1)
      saveData(FILES.dmMessages, messages)
      return true
    }
    return false
  },
  
  getAllMessages() {
    return loadData(FILES.dmMessages, {})
  }
}

export const reactionService = {
  getReactions(messageId) {
    const reactions = loadData(FILES.reactions, {})
    return reactions[messageId] || {}
  },

  addReaction(messageId, userId, emoji) {
    const reactions = loadData(FILES.reactions, {})
    if (!reactions[messageId]) reactions[messageId] = {}
    if (!reactions[messageId][emoji]) reactions[messageId][emoji] = []
    
    if (!reactions[messageId][emoji].includes(userId)) {
      reactions[messageId][emoji].push(userId)
    }
    
    saveData(FILES.reactions, reactions)
    return reactions[messageId]
  },

  removeReaction(messageId, userId, emoji) {
    const reactions = loadData(FILES.reactions, {})
    if (!reactions[messageId]?.[emoji]) return reactions[messageId] || {}
    
    reactions[messageId][emoji] = reactions[messageId][emoji].filter(id => id !== userId)
    if (reactions[messageId][emoji].length === 0) {
      delete reactions[messageId][emoji]
    }
    
    saveData(FILES.reactions, reactions)
    return reactions[messageId]
  },
  
  getAllReactions() {
    return loadData(FILES.reactions, {})
  }
}

export const inviteService = {
  createInvite(serverId, creatorId, options = {}) {
    const invites = loadData(FILES.serverInvites, {})
    if (!invites[serverId]) invites[serverId] = []
    
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
    saveData(FILES.serverInvites, invites)
    return invite
  },

  getInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      const invite = invites[serverId].find(i => i.code === code)
      if (invite) return invite
    }
    return null
  },

  useInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      const invite = invites[serverId].find(i => i.code === code)
      if (invite) {
        if (invite.maxUses && invite.uses >= invite.maxUses) {
          return { error: 'Invite expired' }
        }
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
          return { error: 'Invite expired' }
        }
        invite.uses++
        saveData(FILES.serverInvites, invites)
        return { serverId: invite.serverId }
      }
    }
    return { error: 'Invite not found' }
  },

  deleteInvite(code) {
    const invites = loadData(FILES.serverInvites, {})
    for (const serverId in invites) {
      const idx = invites[serverId].findIndex(i => i.code === code)
      if (idx >= 0) {
        invites[serverId].splice(idx, 1)
        saveData(FILES.serverInvites, invites)
        return true
      }
    }
    return false
  },

  getServerInvites(serverId) {
    const invites = loadData(FILES.serverInvites, {})
    return invites[serverId] || []
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

  createServer(serverData) {
    const servers = loadData(FILES.servers, {})
    servers[serverData.id] = {
      ...serverData,
      createdAt: serverData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    saveData(FILES.servers, servers)
    return servers[serverData.id]
  },

  updateServer(serverId, updates) {
    const servers = loadData(FILES.servers, {})
    if (!servers[serverId]) return null
    
    servers[serverId] = {
      ...servers[serverId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    saveData(FILES.servers, servers)
    return servers[serverId]
  },

  deleteServer(serverId) {
    const servers = loadData(FILES.servers, {})
    delete servers[serverId]
    saveData(FILES.servers, servers)
    
    const channels = loadData(FILES.channels, {})
    const serverChannels = Object.keys(channels).filter(ch => channels[ch].serverId === serverId)
    serverChannels.forEach(chId => delete channels[chId])
    saveData(FILES.channels, channels)
    
    return true
  },

  getAllServers() {
    return loadData(FILES.servers, {})
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

  getChannel(channelId) {
    const channels = this._loadFlat()
    return channels[channelId] || null
  },

  createChannel(channelData) {
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
      saveData(FILES.channels, raw)
      return newChannel
    }
    // Flat format
    raw[channelData.id] = {
      ...channelData,
      createdAt: channelData.createdAt || new Date().toISOString()
    }
    saveData(FILES.channels, raw)
    return raw[channelData.id]
  },

  updateChannel(channelId, updates) {
    const raw = loadData(FILES.channels, {})
    if (Object.keys(raw).length > 0 && this._isLegacyFormat(raw)) {
      // Legacy format: find and update in the server arrays
      for (const [serverId, channelList] of Object.entries(raw)) {
        if (!Array.isArray(channelList)) continue
        const idx = channelList.findIndex(c => c.id === channelId)
        if (idx >= 0) {
          channelList[idx] = { ...channelList[idx], ...updates }
          saveData(FILES.channels, raw)
          return channelList[idx]
        }
      }
      return null
    }
    // Flat format
    if (!raw[channelId]) return null
    raw[channelId] = { ...raw[channelId], ...updates }
    saveData(FILES.channels, raw)
    return raw[channelId]
  },

  deleteChannel(channelId) {
    const raw = loadData(FILES.channels, {})
    if (Object.keys(raw).length > 0 && this._isLegacyFormat(raw)) {
      // Legacy format: remove from the server arrays
      for (const [serverId, channelList] of Object.entries(raw)) {
        if (!Array.isArray(channelList)) continue
        const idx = channelList.findIndex(c => c.id === channelId)
        if (idx >= 0) {
          channelList.splice(idx, 1)
          saveData(FILES.channels, raw)
          return true
        }
      }
      return true
    }
    // Flat format
    delete raw[channelId]
    saveData(FILES.channels, raw)
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
  }
}

export const messageService = {
  getMessage(messageId) {
    const messages = loadData(FILES.messages, {})
    return messages[messageId] || null
  },

  getChannelMessages(channelId, limit = 50, before = null) {
    const messages = loadData(FILES.messages, {})
    let channelMessages = Object.values(messages)
      .filter(m => m.channelId === channelId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    
    if (before) {
      const beforeIndex = channelMessages.findIndex(m => m.id === before)
      if (beforeIndex > 0) {
        channelMessages = channelMessages.slice(0, beforeIndex)
      }
    }
    
    return channelMessages.slice(-limit)
  },

  createMessage(messageData) {
    const messages = loadData(FILES.messages, {})
    messages[messageData.id] = {
      ...messageData,
      createdAt: messageData.createdAt || new Date().toISOString()
    }
    saveData(FILES.messages, messages)
    return messages[messageData.id]
  },

  editMessage(messageId, newContent) {
    const messages = loadData(FILES.messages, {})
    if (!messages[messageId]) return null
    
    messages[messageId].content = newContent
    messages[messageId].edited = true
    messages[messageId].editedAt = new Date().toISOString()
    saveData(FILES.messages, messages)
    return messages[messageId]
  },

  deleteMessage(messageId) {
    const messages = loadData(FILES.messages, {})
    delete messages[messageId]
    saveData(FILES.messages, messages)
    return true
  },
  
  getAllMessages() {
    return loadData(FILES.messages, {})
  }
}

export const fileService = {
  getFile(fileId) {
    const files = loadData(FILES.files, {})
    return files[fileId] || null
  },

  saveFile(fileData) {
    const files = loadData(FILES.files, {})
    files[fileData.id] = {
      ...fileData,
      createdAt: fileData.createdAt || new Date().toISOString()
    }
    saveData(FILES.files, files)
    return files[fileData.id]
  },

  deleteFile(fileId) {
    const files = loadData(FILES.files, {})
    delete files[fileId]
    saveData(FILES.files, files)
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

  addAttachment(messageId, attachment) {
    const attachments = loadData(FILES.attachments, {})
    if (!attachments[messageId]) attachments[messageId] = []
    attachments[messageId].push(attachment)
    saveData(FILES.attachments, attachments)
    return attachments[messageId]
  },

  removeAttachment(messageId, attachmentId) {
    const attachments = loadData(FILES.attachments, {})
    if (!attachments[messageId]) return false
    
    attachments[messageId] = attachments[messageId].filter(a => a.id !== attachmentId)
    saveData(FILES.attachments, attachments)
    return true
  },
  
  getAllAttachments() {
    return loadData(FILES.attachments, {})
  }
}

export const discoveryService = {
  _load() {
    const data = loadData(FILES.discovery, {})
    if (!data.submissions) data.submissions = []
    if (!data.approved) data.approved = []
    return data
  },

  getDiscoveryEntry(serverId) {
    const data = this._load()
    return data.approved.find(s => s.serverId === serverId) || null
  },

  addToDiscovery(serverId, entryData) {
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
    saveData(FILES.discovery, data)
    return entry
  },

  removeFromDiscovery(serverId) {
    const data = this._load()
    data.approved = data.approved.filter(s => s.serverId !== serverId)
    data.submissions = data.submissions.filter(s => s.serverId !== serverId)
    saveData(FILES.discovery, data)
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

  getApprovedServers(limit = 50, offset = 0, category = null, search = null) {
    const data = this._load()
    let list = data.approved.filter(s => s.status === 'approved')

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

  submitServer(serverId, description, category, userId) {
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
    saveData(FILES.discovery, data)
    return submission
  },

  getPendingSubmissions() {
    const data = this._load()
    return data.submissions.filter(s => s.status === 'pending')
  },

  approveSubmission(submissionId) {
    const data = this._load()
    const idx = data.submissions.findIndex(s => s.id === submissionId)
    if (idx === -1) return { error: 'Submission not found' }

    const submission = data.submissions[idx]
    submission.status = 'approved'
    submission.approvedAt = new Date().toISOString()
    data.submissions.splice(idx, 1)
    data.approved.push(submission)
    saveData(FILES.discovery, data)
    return submission
  },

  rejectSubmission(submissionId) {
    const data = this._load()
    const idx = data.submissions.findIndex(s => s.id === submissionId)
    if (idx === -1) return { error: 'Submission not found' }

    const submission = data.submissions[idx]
    submission.status = 'rejected'
    submission.rejectedAt = new Date().toISOString()
    data.submissions.splice(idx, 1)
    saveData(FILES.discovery, data)
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

export const globalBanService = {
  isBanned(userId) {
    const bans = loadData(FILES.globalBans, {})
    return bans[userId] || null
  },

  banUser(userId, banData) {
    const bans = loadData(FILES.globalBans, {})
    bans[userId] = {
      ...banData,
      userId,
      bannedAt: new Date().toISOString()
    }
    saveData(FILES.globalBans, bans)
    return bans[userId]
  },

  unbanUser(userId) {
    const bans = loadData(FILES.globalBans, {})
    delete bans[userId]
    saveData(FILES.globalBans, bans)
    return true
  },
  
  getAllBans() {
    return loadData(FILES.globalBans, {})
  }
}

export const adminLogService = {
  log(action, userId, targetId, details = {}) {
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
    saveData(FILES.adminLogs, logs)
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

  banServer(serverId, reason, bannedBy) {
    const bans = loadData(FILES.serverBans, {})
    bans[serverId] = {
      serverId,
      reason,
      bannedBy,
      bannedAt: new Date().toISOString()
    }
    saveData(FILES.serverBans, bans)
    return bans[serverId]
  },

  unbanServer(serverId) {
    const bans = loadData(FILES.serverBans, {})
    delete bans[serverId]
    saveData(FILES.serverBans, bans)
    return true
  },

  getAllServerBans() {
    return loadData(FILES.serverBans, {})
  }
}

export const adminService = {
  getStats() {
    const users = loadData(FILES.users, {})
    const servers = loadData(FILES.servers, {})
    const channels = loadData(FILES.channels, {})
    const messages = loadData(FILES.messages, {})
    const dms = loadData(FILES.dms, {})
    const globalBans = loadData(FILES.globalBans, {})
    
    return {
      totalUsers: Object.keys(users).length,
      totalServers: Object.keys(servers).length,
      totalChannels: Object.keys(channels).length,
      totalMessages: Object.keys(messages).length,
      totalDms: Object.keys(dms).length,
      totalBans: Object.keys(globalBans).length,
      timestamp: new Date().toISOString()
    }
  },

  isAdmin(userId) {
    const user = userService.getUser(userId)
    const role = user?.adminRole || user?.role
    return role === 'admin' || role === 'owner' || user?.isAdmin === true
  },

  isModerator(userId) {
    const user = userService.getUser(userId)
    const role = user?.adminRole || user?.role
    return role === 'admin' || role === 'owner' || role === 'moderator' || user?.isAdmin === true || user?.isModerator === true
  },

  getUserRole(userId) {
    const user = userService.getUser(userId)
    return user?.adminRole || user?.role || 'user'
  },

  setUserRole(userId, role) {
    return userService.updateProfile(userId, { adminRole: role })
  },

  logAction(userId, action, targetId, details) {
    return adminLogService.log(action, userId, targetId, details)
  },

  getLogs(limit = 100) {
    return adminLogService.getLogs(limit)
  },

  getAllUsers() {
    const users = loadData(FILES.users, {})
    return Object.values(users)
  },

  resetUserPassword(userId) {
    const tempPassword = Math.random().toString(36).slice(-8)
    const user = userService.getUser(userId)
    if (!user) return { success: false, error: 'User not found' }
    
    import('bcrypt').then(({ default: bcrypt }) => {
      const tempHash = bcrypt.hashSync(tempPassword, 10)
      userService.updateProfile(userId, { passwordHash: tempHash })
    })
    
    return { success: true, tempPassword }
  },

  deleteUser(userId) {
    const users = loadData(FILES.users, {})
    delete users[userId]
    saveData(FILES.users, users)
    
    const friends = loadData(FILES.friends, {})
    if (friends[userId]) {
      delete friends[userId]
      Object.keys(friends).forEach((uid) => {
        friends[uid] = friends[uid].filter(fId => fId !== userId)
      })
      saveData(FILES.friends, friends)
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
  send(opts) {
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

    saveData(FILES.systemMessages, data)
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
  markRead(userId, messageId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return false
    const msg = data[userId].find(m => m.id === messageId)
    if (!msg) return false
    msg.read = true
    saveData(FILES.systemMessages, data)
    return true
  },

  /** Mark all messages for a user as read */
  markAllRead(userId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return
    data[userId].forEach(m => { m.read = true })
    saveData(FILES.systemMessages, data)
  },

  /** Delete a system message */
  delete(userId, messageId) {
    const data = loadData(FILES.systemMessages, {})
    if (!data[userId]) return false
    const before = data[userId].length
    data[userId] = data[userId].filter(m => m.id !== messageId)
    saveData(FILES.systemMessages, data)
    return data[userId].length < before
  },

  /** Delete all system messages for a user */
  clearAll(userId) {
    const data = loadData(FILES.systemMessages, {})
    data[userId] = []
    saveData(FILES.systemMessages, data)
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
  logCall(opts) {
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
    
    saveData(FILES.callLogs, logs)
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
  updateCall(callId, updates) {
    const logs = loadData(FILES.callLogs, {})
    for (const convId of Object.keys(logs)) {
      const idx = logs[convId].findIndex(l => l.callId === callId)
      if (idx >= 0) {
        logs[convId][idx] = {
          ...logs[convId][idx],
          ...updates,
          updatedAt: new Date().toISOString()
        }
        saveData(FILES.callLogs, logs)
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

export default {
  initStorage,
  FILES,
  migrateData,
  getStorageInfo,
  reloadData,
  reinitializeStorage,
  exportAllData,
  importAllData,
  userService,
  friendService,
  friendRequestService,
  blockService,
  dmService,
  dmMessageService,
  reactionService,
  inviteService,
  serverService,
  channelService,
  messageService,
  fileService,
  attachmentService,
  discoveryService,
  globalBanService,
  adminLogService,
  adminService,
  serverBanService,
  callLogService
}
