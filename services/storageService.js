import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let db = null
let storage = null

const TABLES = [
  'users',
  'friends',
  'friend_requests',
  'servers',
  'channels',
  'messages',
  'server_members',
  'invites',
  'dms',
  'dm_messages',
  'reactions',
  'blocked',
  'files',
  'attachments',
  'discovery',
  'global_bans',
  'server_bans',
  'admin_logs',
  'moderation_reports'
]

const getAllowedStorageTableNames = () => {
  const schemaTables = typeof TABLE_SCHEMAS === 'object' && TABLE_SCHEMAS
    ? Object.keys(TABLE_SCHEMAS)
    : []
  return new Set([...TABLES, ...schemaTables, 'storage_kv'])
}

const assertSafeTableName = (tableName) => {
  const normalized = String(tableName || '').trim()
  if (!/^[a-z0-9_]+$/i.test(normalized)) {
    throw new Error(`Unsafe table name: ${tableName}`)
  }
  if (!getAllowedStorageTableNames().has(normalized)) {
    throw new Error(`Unknown table name: ${tableName}`)
  }
  return normalized
}

const normalizeFriendRequestRow = (row = {}) => {
  const from = row.fromUserId || row.from || null
  const to = row.toUserId || row.to || null
  return {
    id: row.id,
    from,
    to,
    fromUsername: row.fromUsername || null,
    toUsername: row.toUsername || null,
    createdAt: row.createdAt || null,
    status: row.status || null,
    respondedAt: row.respondedAt || null
  }
}

const isPendingFriendRequest = (status) => {
  if (status === null || status === undefined) return true
  const normalized = String(status).trim().toLowerCase()
  return normalized === '' || normalized === 'pending'
}

const buildFriendRequestsStateFromRows = (rows = []) => {
  const result = { incoming: {}, outgoing: {} }
  const incomingSeen = new Set()
  const outgoingSeen = new Set()

  for (const row of rows) {
    const req = normalizeFriendRequestRow(row)
    if (!req.id || !req.from || !req.to) continue
    if (!isPendingFriendRequest(req.status)) continue

    const direction = row.direction || null
    const inKey = `${req.to}:${req.id}`
    const outKey = `${req.from}:${req.id}`

    if (direction === 'incoming' || !direction) {
      if (!result.incoming[req.to]) result.incoming[req.to] = []
      if (!incomingSeen.has(inKey)) {
        result.incoming[req.to].push(req)
        incomingSeen.add(inKey)
      }
    }

    if (direction === 'outgoing' || !direction) {
      if (!result.outgoing[req.from]) result.outgoing[req.from] = []
      if (!outgoingSeen.has(outKey)) {
        result.outgoing[req.from].push(req)
        outgoingSeen.add(outKey)
      }
    }
  }

  return result
}

const safeJsonParse = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const extractColumnMeta = (column) => {
  const actual = column?.Field || column?.field || column?.COLUMN_NAME || column?.column_name || column
  const type = String(column?.Type || column?.type || column?.DATA_TYPE || column?.data_type || '').trim()
  const typeLower = type.toLowerCase()
  const maxLengthMatch = typeLower.match(/\((\d+)\)/)
  return {
    actual,
    normalized: normalizeColumnToken(actual),
    type,
    typeLower,
    maxLength: maxLengthMatch ? Number(maxLengthMatch[1]) : null
  }
}

const formatSqlDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  const ss = String(date.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

const normalizeSqlValue = (value, columnMeta = null) => {
  if (value === undefined || value === null) return null

  const typeLower = columnMeta?.typeLower || ''
  if (typeLower.includes('date') || typeLower.includes('time')) {
    if (typeof value === 'string' || value instanceof Date) {
      return formatSqlDateTime(value)
    }
  }

  if (typeLower.includes('tinyint(1)') || typeLower === 'boolean' || typeLower === 'bool') {
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase()
      if (lowered === 'true') return 1
      if (lowered === 'false') return 0
    }
  }

  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (typeLower.includes('char') || typeLower.includes('text')) {
      return String(value)
    }
    return value
  }

  let normalized = value
  if (typeof normalized === 'object') {
    normalized = JSON.stringify(normalized)
  }

  if (typeof normalized !== 'string') {
    normalized = String(normalized)
  }

  if (columnMeta?.maxLength && !typeLower.includes('text') && !typeLower.includes('blob') && normalized.length > columnMeta.maxLength) {
    normalized = normalized.slice(0, columnMeta.maxLength)
  }

  return normalized
}

const normalizeColumnToken = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase()

const hasMeaningfulValue = (value) => {
  if (value === null || value === undefined) return false
  const normalized = String(value).trim()
  return normalized !== '' && normalized !== '0' && normalized.toLowerCase() !== 'null'
}

const toSnakeCase = (value) => String(value || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[\s-]+/g, '_')
  .toLowerCase()

const mapActualColumnsByNormalized = (columns = []) => {
  const byNormalized = new Map()
  for (const column of columns) {
    const meta = extractColumnMeta(column)
    if (meta.actual && meta.normalized && !byNormalized.has(meta.normalized)) {
      byNormalized.set(meta.normalized, meta)
    }
  }
  return byNormalized
}

const getAvailableColumnSet = (columns = []) => new Set(
  (columns || []).map(column => column?.Field || column?.field || column?.COLUMN_NAME || column?.column_name || column).filter(Boolean)
)

const TABLE_COLUMN_ALIASES = {
  users: {
    birthDate: ['birth_date'],
    ageVerificationJurisdiction: ['age_verification_jurisdiction']
  },
  messages: {
    authorId: ['userId'],
    userId: ['authorId'],
    createdAt: ['timestamp'],
    timestamp: ['createdAt'],
    mentions: ['mentions_json'],
    storage: ['storage_json']
  }
}

const getAliasCandidates = (table, canonicalName) => {
  const aliases = TABLE_COLUMN_ALIASES[table]?.[canonicalName] || []
  return [canonicalName, toSnakeCase(canonicalName), ...aliases]
}

const getActualColumnName = (canonicalName, availableColumns = new Map(), table = null) => {
  if (!canonicalName) return null
  const candidates = getAliasCandidates(table, canonicalName)
  for (const candidate of candidates) {
    const meta = availableColumns.get(normalizeColumnToken(candidate))
    if (meta?.actual) return meta.actual
  }
  return null
}

const getActualColumnMeta = (canonicalName, availableColumns = new Map(), table = null) => {
  if (!canonicalName) return null
  const candidates = getAliasCandidates(table, canonicalName)
  for (const candidate of candidates) {
    const meta = availableColumns.get(normalizeColumnToken(candidate))
    if (meta?.actual) return meta
  }
  return null
}

const getRecordValueForColumn = (record = {}, canonicalName, actualName = null, table = null) => {
  if (!record || typeof record !== 'object') return undefined
  const candidates = [
    ...getAliasCandidates(table, canonicalName),
    actualName,
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(record, candidate)) {
      return record[candidate]
    }
  }

  const normalizedCandidates = new Set(candidates.map(normalizeColumnToken))
  for (const [key, value] of Object.entries(record)) {
    if (normalizedCandidates.has(normalizeColumnToken(key))) {
      return value
    }
  }

  return undefined
}

const mapRowToCanonicalColumns = (row = {}, schemaColumns = [], table = null) => {
  const canonicalByNormalized = new Map(schemaColumns.map(column => [normalizeColumnToken(column), column]))
  const aliases = TABLE_COLUMN_ALIASES[table] || {}
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const normalized = normalizeColumnToken(alias)
      if (!canonicalByNormalized.has(normalized)) {
        canonicalByNormalized.set(normalized, canonical)
      }
    }
  }
  const mapped = {}

  for (const [key, value] of Object.entries(row || {})) {
    const canonicalKey = canonicalByNormalized.get(normalizeColumnToken(key)) || key
    mapped[canonicalKey] = value
  }

  return mapped
}

const normalizeLoadedRecord = (table, record = {}) => {
  if (!record || typeof record !== 'object') return record

  if (table === 'users') {
    if (hasMeaningfulValue(record.birth_date) && !hasMeaningfulValue(record.birthDate)) {
      record.birthDate = record.birth_date
    } else if (hasMeaningfulValue(record.birthDate) && !hasMeaningfulValue(record.birth_date)) {
      record.birth_date = record.birthDate
    }
    if (hasMeaningfulValue(record.age_verification_jurisdiction) && !hasMeaningfulValue(record.ageVerificationJurisdiction)) {
      record.ageVerificationJurisdiction = record.age_verification_jurisdiction
    } else if (hasMeaningfulValue(record.ageVerificationJurisdiction) && !hasMeaningfulValue(record.age_verification_jurisdiction)) {
      record.age_verification_jurisdiction = record.ageVerificationJurisdiction
    }
  }

  if (table === 'messages') {
    if (record.userId === undefined && record.authorId !== undefined) record.userId = record.authorId
    if (record.authorId === undefined && record.userId !== undefined) record.authorId = record.userId
    if (record.createdAt === undefined && record.timestamp !== undefined) record.createdAt = record.timestamp
    if (record.timestamp === undefined && record.createdAt !== undefined) record.timestamp = record.createdAt
    if (record.mentions === undefined && record.mentions_json !== undefined) record.mentions = record.mentions_json
    if (record.storage === undefined && record.storage_json !== undefined) record.storage = record.storage_json
  }

  return record
}

const normalizeDmConversationRow = (row = {}) => {
  const parsedParticipants = safeJsonParse(row.participants_json, [])
  let participants = Array.isArray(parsedParticipants) ? parsedParticipants.filter(Boolean) : []
  if (participants.length === 0 && typeof row.participantKey === 'string' && row.participantKey.includes(':')) {
    participants = row.participantKey.split(':').filter(Boolean)
  }
  if (participants.length === 0) {
    participants = [row.ownerId, row.recipientId].filter(Boolean)
  }
  participants = Array.from(new Set(participants))

  const isGroup = row.isGroup === true || row.isGroup === 1 || row.isGroup === '1'
  return {
    id: row.id,
    participantKey: row.participantKey || participants.slice().sort().join(':'),
    participants,
    createdAt: row.createdAt || null,
    lastMessageAt: row.lastMessageAt || row.createdAt || null,
    isGroup,
    groupName: row.groupName || null,
    ownerId: row.ownerId || null,
    recipientId: row.recipientId || null
  }
}

const buildDmsStateFromRows = (rows = []) => {
  const result = {}
  const seen = new Set()
  for (const row of rows) {
    const conversation = normalizeDmConversationRow(row)
    if (!conversation.id) continue
    const participants = Array.isArray(conversation.participants) ? conversation.participants : []
    if (participants.length === 0) continue

    for (const userId of participants) {
      if (!result[userId]) result[userId] = []
      const key = `${userId}:${conversation.id}`
      if (seen.has(key)) continue
      const other = participants.find(p => p !== userId) || null
      result[userId].push({
        ...conversation,
        recipientId: conversation.isGroup ? null : (conversation.recipientId && conversation.recipientId !== userId ? conversation.recipientId : other)
      })
      seen.add(key)
    }
  }
  return result
}

const normalizeDmMessageRow = (row = {}) => {
  const mentions = safeJsonParse(row.mentions_json, row.mentions_json || [])
  const storage = safeJsonParse(row.storage_json, row.storage_json || null)
  const replyTo = safeJsonParse(row.replyTo, row.replyTo || null)
  const attachments = safeJsonParse(row.attachments, row.attachments || [])
  return {
    id: row.id,
    conversationId: row.conversationId || null,
    userId: row.userId || null,
    username: row.username || null,
    avatar: row.avatar || null,
    content: row.content || '',
    bot: row.bot === true || row.bot === 1 || row.bot === '1',
    encrypted: row.encrypted === true || row.encrypted === 1 || row.encrypted === '1',
    iv: row.iv || null,
    epoch: row.epoch || null,
    timestamp: row.timestamp || row.createdAt || null,
    mentions: Array.isArray(mentions) ? mentions : [],
    storage,
    edited: row.edited === true || row.edited === 1 || row.edited === '1',
    editedAt: row.editedAt || null,
    replyTo,
    attachments: Array.isArray(attachments) ? attachments : [],
    keyVersion: row.keyVersion || null,
    createdAt: row.createdAt || row.timestamp || null
  }
}

const buildDmMessagesStateFromRows = (rows = []) => {
  const result = {}
  for (const row of rows) {
    const message = normalizeDmMessageRow(row)
    if (!message.id || !message.conversationId) continue
    if (!result[message.conversationId]) result[message.conversationId] = []
    result[message.conversationId].push(message)
  }
  for (const list of Object.values(result)) {
    list.sort((a, b) => {
      const at = new Date(a.timestamp || a.createdAt || 0).getTime()
      const bt = new Date(b.timestamp || b.createdAt || 0).getTime()
      return at - bt
    })
  }
  return result
}

const initJsonStorage = () => {
  const storageConfig = config.config.storage
  const dataDir = storageConfig.json?.dataDir || path.join(__dirname, '..', 'data')
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  
  return {
    type: 'json',
    provider: 'json',
    dataDir,
    files: {
      users: path.join(dataDir, 'users.json'),
      friends: path.join(dataDir, 'friends.json'),
      friendRequests: path.join(dataDir, 'friend-requests.json'),
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
      moderationReports: path.join(dataDir, 'moderation-reports.json')
    },
    load(file, defaultValue = {}) {
      try {
        if (fs.existsSync(file)) {
          return JSON.parse(fs.readFileSync(file, 'utf8'))
        }
      } catch (err) {
        console.error(`[Data] Error loading ${file}:`, err.message)
      }
      return defaultValue
    },
    save(file, data) {
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2))
        return true
      } catch (err) {
        console.error(`[Data] Error saving ${file}:`, err.message)
        return false
      }
    }
  }
}

const initSqliteStorage = () => {
  let Database
  try {
    Database = require('better-sqlite3')
  } catch (err) {
    console.error('[Storage] better-sqlite3 not available. Install it with: npm install better-sqlite3')
    throw new Error('better-sqlite3 is required for SQLite storage. Install with: npm install better-sqlite3')
  }
  
  const storageConfig = config.config.storage
  const dbPath = storageConfig.sqlite?.dbPath || path.join(__dirname, '..', '..', 'data', 'voltage.db')
  const dbDir = path.dirname(dbPath)
  
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }
  
  db = new Database(dbPath)
  
  // Create storage_kv table for migration compatibility (will be dropped after distribution)
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_kv (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      displayName TEXT,
      email TEXT,
      passwordHash TEXT,
      authProvider TEXT,
      avatar TEXT,
      banner TEXT,
      bio TEXT,
      customStatus TEXT,
      status TEXT DEFAULT 'offline',
      socialLinks TEXT,
      ageVerification TEXT,
      ageVerificationJurisdiction TEXT,
      host TEXT,
      createdAt TEXT,
      updatedAt TEXT,
      customUsername TEXT,
      avatarHost TEXT,
      adminRole TEXT,
      proofSummary TEXT,
      device TEXT,
      isAdmin INTEGER DEFAULT 0,
      isModerator INTEGER DEFAULT 0,
      profileTheme TEXT,
      profileBackground TEXT,
      profileAccentColor TEXT,
      profileFont TEXT,
      profileAnimation TEXT,
      profileBackgroundType TEXT,
      profileBackgroundOpacity INTEGER DEFAULT 100,
      birthDate TEXT
    );
    
    CREATE TABLE IF NOT EXISTS friends (
      userId TEXT NOT NULL,
      friendId TEXT NOT NULL,
      createdAt TEXT,
      PRIMARY KEY (userId, friendId)
    );
    
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      fromUserId TEXT NOT NULL,
      toUserId TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      banner TEXT,
      ownerId TEXT NOT NULL,
      createdAt TEXT,
      updatedAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      serverId TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      isDefault INTEGER DEFAULT 0,
      topic TEXT,
      slowMode INTEGER DEFAULT 0,
      nsfw INTEGER DEFAULT 0,
      categoryId TEXT,
      position INTEGER,
      createdAt TEXT,
      updatedAt TEXT,
      permissions TEXT
    );
    
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channelId TEXT NOT NULL,
      authorId TEXT NOT NULL,
      content TEXT,
      type TEXT DEFAULT 'text',
      createdAt TEXT,
      updatedAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS server_members (
      serverId TEXT NOT NULL,
      userId TEXT NOT NULL,
      roles TEXT,
      joinedAt TEXT,
      PRIMARY KEY (serverId, userId)
    );
    
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      serverId TEXT NOT NULL,
      inviterId TEXT,
      uses INTEGER DEFAULT 0,
      maxUses INTEGER,
      expiresAt TEXT,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS dms (
      id TEXT PRIMARY KEY,
      type TEXT DEFAULT 'direct',
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT,
      userId TEXT,
      username TEXT,
      avatar TEXT,
      content TEXT,
      bot INTEGER DEFAULT 0,
      encrypted INTEGER DEFAULT 0,
      iv TEXT,
      epoch TEXT,
      timestamp TEXT,
      mentions_json TEXT,
      storage_json TEXT,
      edited INTEGER DEFAULT 0,
      editedAt TEXT,
      replyTo TEXT,
      attachments TEXT,
      keyVersion TEXT,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      messageId TEXT NOT NULL,
      userId TEXT NOT NULL,
      emoji TEXT,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS blocked (
      userId TEXT NOT NULL,
      blockedUserId TEXT NOT NULL,
      createdAt TEXT,
      PRIMARY KEY (userId, blockedUserId)
    );
    
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      filename TEXT,
      mimetype TEXT,
      size INTEGER,
      path TEXT,
      uploadedBy TEXT,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      messageId TEXT,
      fileId TEXT,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS discovery (
      id TEXT PRIMARY KEY,
      serverId TEXT NOT NULL,
      name TEXT,
      description TEXT,
      category TEXT,
      tags TEXT,
      language TEXT,
      approved INTEGER DEFAULT 0,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS global_bans (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      reason TEXT,
      bannedBy TEXT,
      expiresAt TEXT,
      createdAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS server_bans (
      serverId TEXT PRIMARY KEY,
      reason TEXT,
      bannedBy TEXT,
      bannedAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS admin_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      userId TEXT,
      targetId TEXT,
      details TEXT,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS pinned_messages (
      id TEXT PRIMARY KEY,
      channelId TEXT NOT NULL,
      userId TEXT,
      username TEXT,
      avatar TEXT,
      content TEXT,
      timestamp TEXT,
      pinnedAt TEXT,
      pinnedBy TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pinned_messages_channelId ON pinned_messages (channelId);
  `)
  
  console.log('[Storage] SQLite initialized:', dbPath)
  
  return {
    type: 'sqlite',
    provider: 'sqlite',
    db,
    load(table, defaultValue = {}) {
      const safeTable = assertSafeTableName(table)
      try {
        // First, try to load from individual table (after distribution)
        const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(safeTable)
        if (tableCheck) {
          const rows = db.prepare(`SELECT * FROM ${safeTable}`).all()
          const result = {}
          for (const row of rows) {
            const id = row.id || row.code || row.serverId || row.userId
            if (id) {
              // Parse JSON fields back to objects
              const parsed = {}
              for (const [key, value] of Object.entries(row)) {
                if (key === 'id' || key === 'code' || key === 'serverId' || key === 'userId') {
                  parsed[key] = value
                } else if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
                  try {
                    parsed[key] = JSON.parse(value)
                  } catch {
                    parsed[key] = value
                  }
                } else {
                  parsed[key] = value
                }
              }
              result[id] = parsed
            }
          }
          if (Object.keys(result).length > 0) {
            return result
          }
        }

        // Fall back to storage_kv if it exists (for migration)
        try {
          const kvStmt = db.prepare('SELECT data FROM storage_kv WHERE id = ?')
          const kvRow = kvStmt.get(safeTable)
          if (kvRow?.data) {
            try {
              return JSON.parse(kvRow.data)
            } catch {
              return defaultValue
            }
          }
        } catch {
          // storage_kv doesn't exist, that's fine
        }

        return defaultValue
      } catch (err) {
        console.error(`[Storage] Error loading ${table}:`, err.message)
        return defaultValue
      }
    },
     save(table, data) {
       const safeTable = assertSafeTableName(table)
       try {
         // Check if individual table exists
         const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(safeTable)
         
           if (tableCheck) {
           // Save to individual table
           const schema = TABLE_SCHEMAS[safeTable]
           const columns = schema?.columns || ['id', 'data']

           // Flatten nested data for channels and categories (serverId-keyed arrays)
           let processedData = data
           if (typeof data === 'object' && data !== null && (safeTable === 'channels' || safeTable === 'categories')) {
             const sampleVal = Object.values(data)[0]
             if (Array.isArray(sampleVal)) {
               processedData = {}
               for (const [parentKey, items] of Object.entries(data)) {
                 if (Array.isArray(items)) {
                   for (const item of items) {
                     if (item && typeof item === 'object' && item.id) {
                       // Ensure serverId is present for channels/categories
                       if (!item.serverId) {
                         item.serverId = parentKey
                       }
                       processedData[item.id] = item
                     }
                   }
                 }
               }
             }
           }
           
           if (typeof processedData === 'object' && processedData !== null) {
             if (schema?.dataFormat === 'messages') {
                const availableColumns = new Set(columns)
                for (const [channelId, messages] of Object.entries(processedData)) {
                  if (!Array.isArray(messages)) continue
                  for (const msg of messages) {
                    if (!msg || typeof msg !== 'object' || !msg.id) continue
                    try {
                      // Resolve the user identifier - userId and authorId must always be the same
                      const userIdentifier = msg.userId || msg.authorId || null
                      const record = {
                        id: msg.id,
                        channelId: msg.channelId || channelId,
                        userId: userIdentifier,
                        authorId: userIdentifier,
                        content: msg.content || null,
                        type: msg.type || 'message',
                        createdAt: msg.createdAt || msg.timestamp || null,
                        updatedAt: msg.updatedAt || null,
                        mentions: JSON.stringify(Array.isArray(msg.mentions) ? msg.mentions : []),
                        attachments: JSON.stringify(Array.isArray(msg.attachments) ? msg.attachments : []),
                        embeds: JSON.stringify(Array.isArray(msg.embeds) ? msg.embeds : []),
                        replyTo: msg.replyTo ? JSON.stringify(msg.replyTo) : null,
                        edited: msg.edited ? 1 : 0,
                        editedAt: msg.editedAt || null,
                        username: msg.username || null,
                        avatar: msg.avatar || null,
                        storage: msg.storage ? JSON.stringify(msg.storage) : null,
                        encrypted: msg.encrypted ? 1 : 0,
                        iv: msg.iv || null,
                        epoch: msg.epoch ?? null,
                        bot: msg.bot ? 1 : 0,
                        timestamp: msg.timestamp || msg.createdAt || null
                      }
                     const values = columns.map(col => availableColumns.has(col) ? normalizeSqlValue(record[col]) : null)
                     insertStmt.run(values)
                   } catch (err) {
                     console.error(`[Storage] Error inserting message into ${safeTable}:`, err.message)
                   }
                 }
               }
               return true
             }

             const placeholders = columns.map(() => '?').join(', ')
             const insertStmt = db.prepare(`INSERT INTO ${safeTable} (${columns.join(', ')}) VALUES (${placeholders})`)
             
             for (const [key, value] of Object.entries(processedData)) {
               try {
                 const record = typeof value === 'object' ? { id: key, ...value } : { id: key, data: value }
                 const values = columns.map(col => normalizeSqlValue(record[col]))
                 insertStmt.run(values)
               } catch (err) {
                 console.error(`[Storage] Error inserting record into ${safeTable}:`, err.message)
               }
             }
           }
           return true
         }
         
         // Fall back to storage_kv for tables without individual schemas
         try {
           const upsert = db.prepare(`
             INSERT INTO storage_kv (id, data) VALUES (?, ?)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data
           `)
           upsert.run(safeTable, JSON.stringify(data ?? {}))
           return true
         } catch {
           // storage_kv might not exist after distribution, create it temporarily
           db.exec(`CREATE TABLE IF NOT EXISTS storage_kv (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
           const upsert = db.prepare(`
             INSERT INTO storage_kv (id, data) VALUES (?, ?)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data
           `)
           upsert.run(safeTable, JSON.stringify(data ?? {}))
           return true
         }
       } catch (err) {
         console.error(`[Storage] Error saving ${safeTable}:`, err.message)
         return false
       }
     }
  }
}

const initMysqlStorage = () => {
  let pool
  try {
    const mysql = require('mysql2/promise')
    const storageConfig = config.config.storage.mysql
    
    pool = mysql.createPool({
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 3306,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'root',
      password: storageConfig.password || '',
      connectionLimit: storageConfig.connectionLimit || 10,
      charset: storageConfig.charset || 'utf8mb4',
      waitForConnections: true,
      queueLimit: 0
    })
    
    const createTables = async () => {
      const conn = await pool.getConnection()
      try {
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS storage_kv (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT NOT NULL,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)

        await conn.execute(`
          CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            displayName VARCHAR(255),
            email VARCHAR(255),
            passwordHash VARCHAR(255),
            authProvider VARCHAR(50),
            avatar TEXT,
            banner TEXT,
            bio TEXT,
            customStatus TEXT,
            status VARCHAR(50) DEFAULT 'offline',
            socialLinks TEXT,
            ageVerification TEXT,
            ageVerificationJurisdiction TEXT,
            host VARCHAR(255),
            createdAt TEXT,
            updatedAt TEXT,
            customUsername VARCHAR(255),
            avatarHost VARCHAR(255),
            adminRole VARCHAR(50),
            proofSummary TEXT,
            device VARCHAR(50),
            isAdmin INT DEFAULT 0,
            isModerator INT DEFAULT 0,
            profileTheme LONGTEXT,
            profileBackground TEXT,
            profileAccentColor VARCHAR(20),
            profileFont VARCHAR(50),
            profileAnimation VARCHAR(20),
            profileBackgroundType VARCHAR(20),
            profileBackgroundOpacity INT DEFAULT 100,
            birthDate VARCHAR(20)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS friends (
            userId VARCHAR(255) NOT NULL,
            friendId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            PRIMARY KEY (userId, friendId),
            INDEX idx_friendId (friendId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS friend_requests (
            id VARCHAR(255) PRIMARY KEY,
            fromUserId VARCHAR(255) NOT NULL,
            toUserId VARCHAR(255) NOT NULL,
            status VARCHAR(50) DEFAULT 'pending',
            createdAt TEXT,
            INDEX idx_fromUserId (fromUserId),
            INDEX idx_toUserId (toUserId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS servers (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            icon TEXT,
            banner TEXT,
            ownerId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            updatedAt TEXT,
            INDEX idx_ownerId (ownerId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS channels (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            type VARCHAR(50) DEFAULT 'text',
            isDefault TINYINT DEFAULT 0,
            topic TEXT,
            slowMode INT DEFAULT 0,
            nsfw TINYINT DEFAULT 0,
            categoryId VARCHAR(255),
            position INTEGER,
            createdAt TEXT,
            updatedAt TEXT,
            permissions LONGTEXT,
            INDEX idx_serverId (serverId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(255) PRIMARY KEY,
            channelId VARCHAR(255) NOT NULL,
            authorId VARCHAR(255) NOT NULL,
            content TEXT,
            type VARCHAR(50) DEFAULT 'text',
            createdAt TEXT,
            updatedAt TEXT,
            mentions TEXT,
            attachments TEXT,
            embeds TEXT,
            replyTo TEXT,
            edited TINYINT DEFAULT 0,
            editedAt TEXT,
            username TEXT,
            avatar TEXT,
            storage TEXT,
            encrypted TINYINT DEFAULT 0,
            iv TEXT,
            epoch INT DEFAULT 0,
            bot TINYINT DEFAULT 0,
            ui TEXT,
            timestamp TEXT,
            INDEX idx_channelId (channelId),
            INDEX idx_authorId (authorId),
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS server_members (
            serverId VARCHAR(255) NOT NULL,
            userId VARCHAR(255) NOT NULL,
            roles TEXT,
            joinedAt TEXT,
            PRIMARY KEY (serverId, userId),
            INDEX idx_userId (userId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS invites (
            code VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            inviterId VARCHAR(255),
            uses INTEGER DEFAULT 0,
            maxUses INTEGER,
            expiresAt TEXT,
            createdAt TEXT,
            INDEX idx_serverId (serverId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS dms (
            id VARCHAR(255) PRIMARY KEY,
            createdAt TEXT,
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS dm_messages (
            id VARCHAR(255) PRIMARY KEY,
            conversationId VARCHAR(255),
            userId VARCHAR(255),
            username VARCHAR(255),
            avatar TEXT,
            content TEXT,
            bot BOOLEAN DEFAULT FALSE,
            encrypted BOOLEAN DEFAULT FALSE,
            iv VARCHAR(255),
            epoch VARCHAR(255),
            timestamp TEXT,
            mentions_json TEXT,
            storage_json TEXT,
            edited BOOLEAN DEFAULT FALSE,
            editedAt TEXT,
            replyTo TEXT,
            attachments TEXT,
            keyVersion VARCHAR(255),
            createdAt TEXT,
            INDEX idx_conversationId (conversationId),
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS reactions (
            id VARCHAR(255) PRIMARY KEY,
            messageId VARCHAR(255) NOT NULL,
            userId VARCHAR(255) NOT NULL,
            emoji VARCHAR(255) NOT NULL,
            createdAt TEXT,
            INDEX idx_messageId (messageId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS blocked (
            id VARCHAR(255) PRIMARY KEY,
            userId VARCHAR(255) NOT NULL,
            blockedUserId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            INDEX idx_userId (userId),
            INDEX idx_blockedUserId (blockedUserId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS files (
            id VARCHAR(255) PRIMARY KEY,
            filename VARCHAR(255) NOT NULL,
            originalName VARCHAR(255),
            mimetype VARCHAR(255),
            size BIGINT,
            path TEXT,
            url TEXT,
            uploaderId VARCHAR(255),
            createdAt TEXT
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS attachments (
            id VARCHAR(255) PRIMARY KEY,
            messageId VARCHAR(255) NOT NULL,
            fileId VARCHAR(255) NOT NULL,
            INDEX idx_messageId (messageId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS discovery (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            description TEXT,
            category VARCHAR(100),
            tags TEXT,
            memberCount INTEGER DEFAULT 0,
            INDEX idx_serverId (serverId),
            INDEX idx_category (category)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS global_bans (
            id VARCHAR(255) PRIMARY KEY,
            userId VARCHAR(255) NOT NULL,
            reason TEXT,
            bannedBy VARCHAR(255),
            expiresAt TEXT,
            createdAt TEXT,
            INDEX idx_userId (userId)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS admin_logs (
            id VARCHAR(255) PRIMARY KEY,
            action VARCHAR(100) NOT NULL,
            userId VARCHAR(255),
            targetId VARCHAR(255),
            details TEXT,
            createdAt TEXT,
            INDEX idx_userId (userId),
            INDEX idx_createdAt (createdAt)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `)
        
        console.log('[Storage] MySQL tables initialized')
      } finally {
        conn.release()
      }
    }

    const ready = createTables().catch(err => {
      console.error('[Storage] Error creating MySQL tables:', err.message)
    })
    
    console.log('[Storage] MySQL pool created')
    
    return {
      type: 'mysql',
      provider: 'mysql',
      pool,
      load: async (table, defaultValue = {}) => {
        const safeTable = assertSafeTableName(table)
        try {
          await ready
          
          const schema = TABLE_SCHEMAS[safeTable]
          
          // First, try to load from individual table
          try {
            const [rows] = await pool.execute(`SELECT * FROM ${safeTable}`)
            if (rows.length > 0) {
              // Handle special data formats
              if (schema?.dataFormat === 'friends_list') {
                // Friends: { userId: [friendId1, friendId2, ...] }
                const result = {}
                for (const row of rows) {
                  if (row.userId && row.friendId) {
                    if (!result[row.userId]) {
                      result[row.userId] = []
                    }
                    result[row.userId].push(row.friendId)
                  }
                }
                return result
              }
              
              if (schema?.dataFormat === 'nested_array') {
                // Blocked: { userId: [blockedUserId1, blockedUserId2, ...] }
                const result = {}
                for (const row of rows) {
                  if (row.userId && row.blockedUserId) {
                    if (!result[row.userId]) {
                      result[row.userId] = []
                    }
                    result[row.userId].push(row.blockedUserId)
                  }
                }
                return result
              }
              
              if (schema?.dataFormat === 'friend_requests') {
                return buildFriendRequestsStateFromRows(rows)
              }

              if (schema?.dataFormat === 'dm_conversations') {
                return buildDmsStateFromRows(rows)
              }

              if (schema?.dataFormat === 'dm_messages') {
                return buildDmMessagesStateFromRows(rows)
              }

              if (safeTable === 'discovery') {
                // Discovery: { submissions: [...], approved: [...] }
                const result = { submissions: [], approved: [] }
                for (const row of rows) {
                  const entry = {
                    serverId: row.serverId,
                    name: row.name,
                    icon: row.icon,
                    description: row.description,
                    category: row.category,
                    memberCount: row.memberCount,
                    submittedBy: row.submittedBy,
                    submittedAt: row.submittedAt,
                    status: row.status,
                    approvedAt: row.approvedAt
                  }
                  if (row.status === 'approved') {
                    result.approved.push(entry)
                  } else {
                    result.submissions.push(entry)
                  }
                }
                return result
              }
              
              if (schema?.dataFormat === 'reactions') {
                // Reactions: { messageId: { emoji: [userIds] } }
                const result = {}
                for (const row of rows) {
                  if (row.messageId && row.emoji) {
                    if (!result[row.messageId]) {
                      result[row.messageId] = {}
                    }
                    try {
                      result[row.messageId][row.emoji] = typeof row.userIds === 'string' ? JSON.parse(row.userIds) : row.userIds
                    } catch {
                      result[row.messageId][row.emoji] = []
                    }
                  }
                }
                return result
              }
              
              if (schema?.dataFormat === 'json_blob') {
                // JSON blob: { id: { ...data }, ... }
                const result = {}
                for (const row of rows) {
                  if (row.id && row.data) {
                    try {
                      result[row.id] = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
                    } catch {
                      result[row.id] = row.data
                    }
                  }
                }
                return result
              }
              
              if (schema?.dataFormat === 'array') {
                // Array format: [{ ...record }, ...]
                return rows.map(row => {
                  const parsed = {}
                  for (const [key, value] of Object.entries(row)) {
                    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
                      try {
                        parsed[key] = JSON.parse(value)
                      } catch {
                        parsed[key] = value
                      }
                    } else {
                      parsed[key] = value
                    }
                  }
                  return parsed
                })
              }
              
              // Default object format
              const result = {}
              for (const row of rows) {
                const id = row.id || row.code || row.serverId || row.userId
                if (id) {
                  const parsed = {}
                  for (const [key, value] of Object.entries(row)) {
                    if (key === 'id' || key === 'code' || key === 'serverId' || key === 'userId') {
                      parsed[key] = value
                    } else if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
                      try {
                        parsed[key] = JSON.parse(value)
                      } catch {
                        parsed[key] = value
                      }
                    } else {
                      parsed[key] = value
                    }
                  }
                  result[id] = parsed
                }
              }
              if (Object.keys(result).length > 0) {
                return result
              }
            }
          } catch (tableErr) {
            // Table doesn't exist, fall through to storage_kv
          }

          // Fall back to storage_kv if it exists (for migration)
          try {
            const [kvRows] = await pool.execute('SELECT data FROM storage_kv WHERE id = ? LIMIT 1', [safeTable])
            if (Array.isArray(kvRows) && kvRows[0]?.data) {
              try {
                return JSON.parse(kvRows[0].data)
              } catch {
                return defaultValue
              }
            }
          } catch (kvErr) {
            // storage_kv doesn't exist
          }

          return defaultValue
        } catch (err) {
          console.error(`[Storage] Error loading ${safeTable}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        const safeTable = assertSafeTableName(table)
        try {
          await ready
          const conn = await pool.getConnection()
          try {
            // Check if individual table exists
            const [tables] = await conn.query(`SHOW TABLES LIKE ?`, [safeTable])
            
            if (tables.length > 0) {
              // Save to individual table
              const schema = TABLE_SCHEMAS[safeTable]
              const columns = schema?.columns || ['id', 'data']
              
              if (typeof data === 'object' && data !== null) {
                // Flatten nested data for channels and categories (serverId-keyed arrays)
                let processedData = data
                if (safeTable === 'channels' || safeTable === 'categories') {
                  const sampleVal = Object.values(data)[0]
                  if (Array.isArray(sampleVal)) {
                    processedData = {}
                    for (const [parentKey, items] of Object.entries(data)) {
                      if (Array.isArray(items)) {
                        for (const item of items) {
                          if (item && typeof item === 'object' && item.id) {
                            if (!item.serverId) {
                              item.serverId = parentKey
                            }
                            processedData[item.id] = item
                          }
                        }
                      }
                    }
                  }
                }

                if (schema?.dataFormat === 'friends_list') {
                  await conn.execute(`DELETE FROM ${safeTable}`)
                  for (const [userId, friendIds] of Object.entries(data)) {
                    if (!Array.isArray(friendIds)) continue
                    for (const friendId of friendIds) {
                      await conn.execute(
                        `INSERT INTO ${safeTable} (userId, friendId, createdAt) VALUES (?, ?, ?)`,
                        [userId, friendId, new Date().toISOString()]
                      )
                    }
                  }
                  return true
                }

                if (schema?.dataFormat === 'friend_requests') {
                  await conn.execute(`DELETE FROM ${safeTable}`)
                  const [columnRows] = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                  const availableColumns = new Set((columnRows || []).map(col => col.Field))
                  const seen = new Set()
                  const addRow = async (request, directionHint = null) => {
                    const req = normalizeFriendRequestRow(request)
                    if (!req.id || !req.from || !req.to) return
                    if (seen.has(req.id)) return
                    seen.add(req.id)

                    const record = {
                      id: req.id,
                      fromUserId: req.from,
                      toUserId: req.to,
                      fromUsername: req.fromUsername,
                      toUsername: req.toUsername,
                      createdAt: req.createdAt,
                      status: req.status,
                      respondedAt: req.respondedAt,
                      direction: directionHint || null
                    }
                    const insertColumns = Object.keys(record).filter(col => availableColumns.has(col))
                    const insertValues = insertColumns.map(col => record[col] ?? null)
                    if (insertColumns.length === 0) return
                    const placeholders = insertColumns.map(() => '?').join(', ')
                    await conn.execute(
                      `INSERT INTO ${safeTable} (${insertColumns.join(', ')}) VALUES (${placeholders})`,
                      insertValues
                    )
                  }

                  const incoming = data.incoming && typeof data.incoming === 'object' ? data.incoming : {}
                  const outgoing = data.outgoing && typeof data.outgoing === 'object' ? data.outgoing : {}

                  for (const requests of Object.values(incoming)) {
                    if (!Array.isArray(requests)) continue
                    for (const req of requests) {
                      await addRow(req, 'incoming')
                    }
                  }
                  for (const requests of Object.values(outgoing)) {
                    if (!Array.isArray(requests)) continue
                    for (const req of requests) {
                      await addRow(req, 'outgoing')
                    }
                  }
                  return true
                }

                if (schema?.dataFormat === 'dm_conversations') {
                  await conn.execute(`DELETE FROM ${safeTable}`)
                  const [columnRows] = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                  const availableColumns = new Set((columnRows || []).map(col => col.Field))
                  const byConversation = new Map()

                  for (const conversations of Object.values(data)) {
                    if (!Array.isArray(conversations)) continue
                    for (const conv of conversations) {
                      if (!conv || typeof conv !== 'object' || !conv.id) continue
                      if (!byConversation.has(conv.id)) {
                        byConversation.set(conv.id, conv)
                      }
                    }
                  }

                  for (const conv of byConversation.values()) {
                    let participants = Array.isArray(conv.participants) ? conv.participants.filter(Boolean) : []
                    if (participants.length === 0 && typeof conv.participantKey === 'string') {
                      participants = conv.participantKey.split(':').filter(Boolean)
                    }
                    participants = Array.from(new Set(participants))
                    const record = {
                      id: conv.id,
                      participantKey: conv.participantKey || participants.slice().sort().join(':'),
                      participants_json: JSON.stringify(participants),
                      createdAt: conv.createdAt || null,
                      lastMessageAt: conv.lastMessageAt || conv.createdAt || null,
                      isGroup: conv.isGroup ? 1 : 0,
                      groupName: conv.groupName || null,
                      ownerId: conv.ownerId || null,
                      recipientId: conv.recipientId || (participants.length === 2 ? participants[1] : null)
                    }
                    const insertColumns = Object.keys(record).filter(col => availableColumns.has(col))
                    if (insertColumns.length === 0) continue
                    const insertValues = insertColumns.map(col => record[col] ?? null)
                    const placeholders = insertColumns.map(() => '?').join(', ')
                    await conn.execute(
                      `INSERT INTO ${safeTable} (${insertColumns.join(', ')}) VALUES (${placeholders})`,
                      insertValues
                    )
                  }
                  return true
                }

                 if (schema?.dataFormat === 'messages') {
                   await conn.execute(`DELETE FROM ${safeTable}`)
                   const [columnRows] = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                   const availableColumns = mapActualColumnsByNormalized(columnRows || [])
                   let hadInsertError = false
                   for (const [channelId, messages] of Object.entries(data)) {
                     if (!Array.isArray(messages)) continue
                     for (const msg of messages) {
                       if (!msg || typeof msg !== 'object' || !msg.id) continue
                       try {
                         // Resolve the user identifier - userId and authorId must always be the same
                         const userIdentifier = msg.userId || msg.authorId || null
                         const record = {
                           id: msg.id,
                           channelId: msg.channelId || channelId,
                           userId: userIdentifier,
                           authorId: userIdentifier,
                           content: msg.content || null,
                           type: msg.type || 'message',
                           createdAt: msg.createdAt || msg.timestamp || null,
                           updatedAt: msg.updatedAt || null,
                           mentions: JSON.stringify(Array.isArray(msg.mentions) ? msg.mentions : []),
                           attachments: JSON.stringify(Array.isArray(msg.attachments) ? msg.attachments : []),
                           embeds: JSON.stringify(Array.isArray(msg.embeds) ? msg.embeds : []),
                           replyTo: msg.replyTo ? JSON.stringify(msg.replyTo) : null,
                           edited: msg.edited ? 1 : 0,
                           editedAt: msg.editedAt || null,
                           username: msg.username || null,
                           avatar: msg.avatar || null,
                           storage: msg.storage ? JSON.stringify(msg.storage) : null,
                           encrypted: msg.encrypted ? 1 : 0,
                           iv: msg.iv || null,
                           epoch: msg.epoch ?? null,
                           bot: msg.bot ? 1 : 0,
                           timestamp: msg.timestamp || msg.createdAt || null
                         }
                        const insertColumns = Object.keys(record)
                          .map((col) => {
                            const meta = getActualColumnMeta(col, availableColumns, safeTable)
                            return meta ? { canonical: col, actual: meta.actual, meta } : null
                          })
                          .filter(Boolean)
                          .filter((col, index, arr) => arr.findIndex(c => c.actual === col.actual) === index)
                        if (insertColumns.length === 0) continue
                        const insertValues = insertColumns.map(({ canonical, meta }) => normalizeSqlValue(record[canonical], meta))
                        const placeholders = insertColumns.map(() => '?').join(', ')
                        await conn.execute(
                          `INSERT INTO ${safeTable} (${insertColumns.map(({ actual }) => actual).join(', ')}) VALUES (${placeholders})`,
                          insertValues
                        )
                      } catch (err) {
                        hadInsertError = true
                        console.error(`[Storage] Error inserting record into ${safeTable}:`, err.message, 'key:', msg.id)
                      }
                    }
                  }
                  return !hadInsertError
                }

                if (schema?.dataFormat === 'dm_messages') {
                  await conn.execute(`DELETE FROM ${safeTable}`)
                  const [columnRows] = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                  const availableColumns = new Set((columnRows || []).map(col => col.Field))
                  for (const [conversationId, messages] of Object.entries(data)) {
                    if (!Array.isArray(messages)) continue
                    for (const msg of messages) {
                      if (!msg || typeof msg !== 'object' || !msg.id) continue
                      const record = {
                        id: msg.id,
                        conversationId: msg.conversationId || conversationId,
                        userId: msg.userId || null,
                        username: msg.username || null,
                        avatar: msg.avatar || null,
                        content: msg.content || null,
                        bot: msg.bot ? 1 : 0,
                        encrypted: msg.encrypted ? 1 : 0,
                        iv: msg.iv || null,
                        epoch: msg.epoch || null,
                        timestamp: msg.timestamp || msg.createdAt || null,
                        mentions_json: JSON.stringify(Array.isArray(msg.mentions) ? msg.mentions : []),
                        storage_json: msg.storage ? JSON.stringify(msg.storage) : null,
                        edited: msg.edited ? 1 : 0,
                        editedAt: msg.editedAt || null,
                        replyTo: msg.replyTo ? JSON.stringify(msg.replyTo) : null,
                        attachments: JSON.stringify(Array.isArray(msg.attachments) ? msg.attachments : []),
                        keyVersion: msg.keyVersion || null,
                        createdAt: msg.createdAt || msg.timestamp || null
                      }
                      const insertColumns = Object.keys(record).filter(col => availableColumns.has(col))
                      if (insertColumns.length === 0) continue
                      const insertValues = insertColumns.map(col => record[col] ?? null)
                      const placeholders = insertColumns.map(() => '?').join(', ')
                      await conn.execute(
                        `INSERT INTO ${safeTable} (${insertColumns.join(', ')}) VALUES (${placeholders})`,
                        insertValues
                      )
                    }
                  }
                  return true
                }

                const [columnRows] = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                const availableColumns = mapActualColumnsByNormalized(columnRows || [])
                const actualPrimaryKey = getActualColumnName(schema?.primaryKey || 'id', availableColumns, safeTable)
                const mappedColumns = columns
                  .map((column) => {
                    const meta = getActualColumnMeta(column, availableColumns, safeTable)
                    return meta ? { canonical: column, actual: meta.actual, meta } : null
                  })
                  .filter(Boolean)
                  .filter((col, index, arr) => arr.findIndex(c => c.actual === col.actual) === index)
                const placeholders = mappedColumns.map(() => '?').join(', ')
                const updateSet = mappedColumns
                  .filter(({ actual }) => actual !== actualPrimaryKey)
                  .map(({ actual }) => `${actual} = VALUES(${actual})`)
                  .join(', ')
                const insertSql = `INSERT INTO ${safeTable} (${mappedColumns.map(({ actual }) => actual).join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateSet || `${actualPrimaryKey || mappedColumns[0].actual} = ${actualPrimaryKey || mappedColumns[0].actual}`}`
                
                let hadInsertError = false
                for (const [key, value] of Object.entries(processedData)) {
                  try {
                    const record = typeof value === 'object' ? { id: key, ...value } : { id: key, data: value }
                    const values = mappedColumns.map(({ canonical, actual, meta }) => normalizeSqlValue(getRecordValueForColumn(record, canonical, actual, safeTable), meta))
                    await conn.execute(insertSql, values)
                  } catch (err) {
                    hadInsertError = true
                    console.error(`[Storage] Error inserting record into ${safeTable}:`, err.message)
                  }
                }
                if (hadInsertError) return false
              }
              return true
            }
            
            // Fall back to storage_kv for tables without individual schemas
            try {
              await conn.execute(
                `INSERT INTO storage_kv (id, data) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE data = VALUES(data)`,
                [safeTable, JSON.stringify(data ?? {})]
              )
              return true
            } catch (kvErr) {
              // storage_kv might not exist, create it temporarily
              await conn.execute(`CREATE TABLE IF NOT EXISTS storage_kv (id VARCHAR(255) PRIMARY KEY, data LONGTEXT NOT NULL, updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`)
              await conn.execute(
                `INSERT INTO storage_kv (id, data) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE data = VALUES(data)`,
                [table, JSON.stringify(data ?? {})]
              )
              return true
            }
          } finally {
            conn.release()
          }
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await pool.end()
      }
    }
  } catch (err) {
    console.error('[Storage] MySQL not available:', err.message)
    throw new Error('MySQL not available. Install mysql2 with: npm install mysql2')
  }
}

const initMariadbStorage = () => {
  let pool
  try {
    const mariadb = require('mariadb')
    const storageConfig = config.config.storage.mariadb
    
    pool = mariadb.createPool({
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 3306,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'root',
      password: storageConfig.password || '',
      connectionLimit: storageConfig.connectionLimit || 10,
      charset: storageConfig.charset || 'utf8mb4'
    })
    
    const createTables = async () => {
      const conn = await pool.getConnection()
      try {
        await conn.query(`
          CREATE TABLE IF NOT EXISTS storage_kv (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT NOT NULL,
            updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `)

        await conn.query(`
          CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            displayName VARCHAR(255),
            email VARCHAR(255),
            passwordHash VARCHAR(255),
            authProvider VARCHAR(50),
            avatar TEXT,
            banner TEXT,
            bio TEXT,
            customStatus TEXT,
            status TEXT DEFAULT 'offline',
            socialLinks TEXT,
            ageVerification TEXT,
            host VARCHAR(255),
            createdAt TEXT,
            updatedAt TEXT,
            customUsername TEXT,
            avatarHost TEXT,
            adminRole TEXT,
            proofSummary TEXT,
            device TEXT,
            isAdmin INT DEFAULT 0,
            isModerator INT DEFAULT 0,
            profileTheme LONGTEXT,
            profileBackground TEXT,
            profileAccentColor VARCHAR(20),
            profileFont VARCHAR(50),
            profileAnimation VARCHAR(20),
            profileBackgroundType VARCHAR(20),
            profileBackgroundOpacity INT DEFAULT 100,
            birthDate VARCHAR(20)
          )
        `        )
        
        // Fix existing tables with wrong column types or missing columns
        try {
          await conn.query(`ALTER TABLE users MODIFY COLUMN ageVerification TEXT`)
        } catch {
          // Column might already be correct or table doesn't exist yet
        }
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN isAdmin INT DEFAULT 0`)
        } catch {
          // Column might already exist
        }
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN isModerator INT DEFAULT 0`)
        } catch {
          // Column might already exist
        }
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN customUsername TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN avatarHost TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN adminRole TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN proofSummary TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN device TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileTheme LONGTEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileBackground TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileAccentColor VARCHAR(20)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileFont VARCHAR(50)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileAnimation VARCHAR(20)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileBackgroundType VARCHAR(20)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileBackgroundOpacity INT DEFAULT 100`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN birthDate VARCHAR(20)`)
        } catch {}

        try {
          await conn.query(`ALTER TABLE users ADD COLUMN guildTag VARCHAR(10)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN guildTagServerId VARCHAR(50)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileCSS LONGTEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileTemplate VARCHAR(50)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN bannerEffect VARCHAR(50)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN profileLayout VARCHAR(50)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN badgeStyle VARCHAR(50)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN clientCSS LONGTEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE users ADD COLUMN clientCSSEnabled TINYINT DEFAULT 0`)
        } catch {}

        try {
          await conn.query(`ALTER TABLE friends ADD COLUMN createdAt TEXT`)
        } catch {}

        try {
          await conn.query(`ALTER TABLE users ADD COLUMN ageVerificationJurisdiction TEXT`)
        } catch {}

        try {
          await conn.query(`ALTER TABLE users MODIFY COLUMN birthDate VARCHAR(20) NULL DEFAULT NULL`)
        } catch {}

        try {
          await conn.query(`ALTER TABLE users MODIFY COLUMN birth_date VARCHAR(20) NULL DEFAULT NULL`)
        } catch {}

        try {
          await conn.query(`
            UPDATE users
            SET birthDate = birth_date
            WHERE (birthDate IS NULL OR birthDate = '' OR birthDate = '0')
              AND birth_date IS NOT NULL
              AND birth_date <> ''
              AND birth_date <> '0'
          `)
        } catch {}

        try {
          await conn.query(`
            UPDATE users
            SET birth_date = birthDate
            WHERE (birth_date IS NULL OR birth_date = '' OR birth_date = '0')
              AND birthDate IS NOT NULL
              AND birthDate <> ''
              AND birthDate <> '0'
          `)
        } catch {}

        try {
          await conn.query(`
            UPDATE users
            SET ageVerificationJurisdiction = age_verification_jurisdiction
            WHERE (ageVerificationJurisdiction IS NULL OR ageVerificationJurisdiction = '')
              AND age_verification_jurisdiction IS NOT NULL
              AND age_verification_jurisdiction <> ''
          `)
        } catch {}

        try {
          await conn.query(`
            UPDATE users
            SET age_verification_jurisdiction = ageVerificationJurisdiction
            WHERE (age_verification_jurisdiction IS NULL OR age_verification_jurisdiction = '')
              AND ageVerificationJurisdiction IS NOT NULL
              AND ageVerificationJurisdiction <> ''
          `)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE users MODIFY COLUMN status TEXT DEFAULT 'offline'`)
        } catch {}
        
        // Fix messages table - add missing columns
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN mentions TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN attachments TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN embeds TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN replyTo TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN edited TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN editedAt TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN username TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN avatar TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN storage TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN encrypted TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN iv TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN epoch INT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN bot TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN ui TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE messages ADD COLUMN timestamp TEXT`)
        } catch {}
        
        // Fix servers table
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN themeColor VARCHAR(20)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN bannerUrl TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN backgroundUrl TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN bannerPosition VARCHAR(50)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN roles LONGTEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN members LONGTEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN bans LONGTEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN emojis LONGTEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN automod TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN guildTag VARCHAR(10)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN guildTagPrivate TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE servers ADD COLUMN defaultChannelId VARCHAR(255)`)
        } catch {}

        // Fix channels table - add missing columns
        try {
          await conn.query(`ALTER TABLE channels ADD COLUMN isDefault TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE channels ADD COLUMN slowMode INT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE channels ADD COLUMN nsfw TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE channels ADD COLUMN categoryId VARCHAR(255)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE channels ADD COLUMN updatedAt TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE channels ADD COLUMN permissions LONGTEXT`)
        } catch {}
        
        // Fix dms table
        try {
          await conn.query(`ALTER TABLE dms ADD COLUMN participantKey VARCHAR(255)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE dms ADD COLUMN participants_json LONGTEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE dms ADD COLUMN lastMessageAt TEXT`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE dms ADD COLUMN isGroup TINYINT DEFAULT 0`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE dms ADD COLUMN groupName VARCHAR(255)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE dms ADD COLUMN ownerId VARCHAR(255)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE dms ADD COLUMN recipientId VARCHAR(255)`)
        } catch {}
        
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN conversationId VARCHAR(255)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN userId VARCHAR(255)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN username VARCHAR(255)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN avatar TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN bot TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN ui TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN encrypted TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN iv VARCHAR(255)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN epoch VARCHAR(255)`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN timestamp TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN mentions_json TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN storage_json TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN edited TINYINT DEFAULT 0`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN editedAt TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN replyTo TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN attachments TEXT`)
        } catch {}
        try {
          await conn.query(`ALTER TABLE dm_messages ADD COLUMN keyVersion VARCHAR(255)`)
        } catch {}
        
        try {
          await conn.query(`CREATE TABLE IF NOT EXISTS e2e_true_state (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT,
            updatedAt TEXT
          )`)
        } catch {
          // Table might already exist, check if id column exists
          try {
            await conn.query(`ALTER TABLE e2e_true_state ADD COLUMN id VARCHAR(255) PRIMARY KEY`)
          } catch {}
        }
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS servers (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            icon TEXT,
            banner TEXT,
            ownerId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            updatedAt TEXT,
            themeColor VARCHAR(20),
            bannerUrl TEXT,
            backgroundUrl TEXT,
            bannerPosition VARCHAR(50),
            roles LONGTEXT,
            members LONGTEXT,
            bans LONGTEXT,
            emojis LONGTEXT,
            automod TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS channels (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            type VARCHAR(50) DEFAULT 'text',
            topic TEXT,
            position INTEGER,
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS friends (
            userId VARCHAR(255) NOT NULL,
            friendId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            PRIMARY KEY (userId, friendId)
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS friend_requests (
            id VARCHAR(255) PRIMARY KEY,
            fromUserId VARCHAR(255) NOT NULL,
            toUserId VARCHAR(255) NOT NULL,
            fromUsername VARCHAR(255),
            toUsername VARCHAR(255),
            createdAt TEXT,
            direction VARCHAR(50)
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS dms (
            id VARCHAR(255) PRIMARY KEY,
            participantKey VARCHAR(255) NOT NULL,
            participants_json LONGTEXT NOT NULL,
            createdAt TEXT,
            lastMessageAt TEXT,
            isGroup TINYINT DEFAULT 0,
            groupName VARCHAR(255),
            ownerId VARCHAR(255),
            recipientId VARCHAR(255)
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS dm_messages (
            id VARCHAR(255) PRIMARY KEY,
            conversationId VARCHAR(255),
            userId VARCHAR(255),
            username VARCHAR(255),
            avatar TEXT,
            content TEXT,
            bot TINYINT DEFAULT 0,
            encrypted TINYINT DEFAULT 0,
            iv VARCHAR(255),
            epoch VARCHAR(255),
            timestamp TEXT,
            mentions_json TEXT,
            storage_json TEXT,
            edited TINYINT DEFAULT 0,
            editedAt TEXT,
            replyTo TEXT,
            attachments TEXT,
            keyVersion VARCHAR(255),
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS reactions (
            id VARCHAR(255) PRIMARY KEY,
            messageId VARCHAR(255) NOT NULL,
            emoji VARCHAR(255),
            userIds TEXT,
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS blocked (
            userId VARCHAR(255) NOT NULL,
            blockedUserId VARCHAR(255) NOT NULL,
            createdAt TEXT,
            PRIMARY KEY (userId, blockedUserId)
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS invites (
            code VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            createdBy VARCHAR(255),
            uses INTEGER DEFAULT 0,
            maxUses INTEGER,
            expiresAt TEXT,
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS discovery (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255),
            name VARCHAR(255),
            icon TEXT,
            description TEXT,
            category VARCHAR(255),
            memberCount INTEGER DEFAULT 0,
            submittedBy VARCHAR(255),
            submittedAt TEXT,
            status VARCHAR(50),
            approvedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS categories (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            position INTEGER,
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS bots (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            avatar TEXT,
            ownerId VARCHAR(255) NOT NULL,
            token TEXT,
            tokenHash VARCHAR(255),
            prefix VARCHAR(50),
            permissions_json LONGTEXT,
            servers_json LONGTEXT,
            intents_json LONGTEXT,
            commands_json LONGTEXT,
            status VARCHAR(50),
            public TINYINT DEFAULT 0,
            webhookUrl TEXT,
            webhookSecret TEXT,
            customStatus TEXT,
            createdAt TEXT,
            updatedAt TEXT,
            lastActive TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS e2e_keys (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT,
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS system_messages (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT,
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS self_volts (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT,
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS federation (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT,
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS server_start (
            id VARCHAR(255) PRIMARY KEY,
            data LONGTEXT,
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS files (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255),
            type VARCHAR(255),
            mimetype VARCHAR(255),
            size INTEGER,
            url TEXT,
            filename VARCHAR(255),
            uploadedAt TEXT,
            uploadedBy VARCHAR(255),
            path TEXT,
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS attachments (
            id VARCHAR(255) PRIMARY KEY,
            messageId VARCHAR(255),
            fileId VARCHAR(255),
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS global_bans (
            id VARCHAR(255) PRIMARY KEY,
            userId VARCHAR(255) NOT NULL,
            reason TEXT,
            bannedBy VARCHAR(255),
            expiresAt TEXT,
            createdAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS server_bans (
            id VARCHAR(255) PRIMARY KEY,
            serverId VARCHAR(255) NOT NULL,
            userId VARCHAR(255) NOT NULL,
            reason TEXT,
            bannedBy VARCHAR(255),
            bannedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS admin_logs (
            id VARCHAR(255) PRIMARY KEY,
            adminId VARCHAR(255) NOT NULL,
            action VARCHAR(100) NOT NULL,
            targetId VARCHAR(255),
            details LONGTEXT,
            timestamp TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS pinned_messages (
            id VARCHAR(255) PRIMARY KEY,
            channelId VARCHAR(255),
            userId VARCHAR(255),
            username VARCHAR(255),
            avatar TEXT,
            content TEXT,
            timestamp TEXT,
            pinnedAt TEXT,
            pinnedBy VARCHAR(255)
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS call_logs (
            callId VARCHAR(255) PRIMARY KEY,
            conversationId VARCHAR(255) NOT NULL,
            callerId VARCHAR(255) NOT NULL,
            recipientId VARCHAR(255) NOT NULL,
            type VARCHAR(20) NOT NULL,
            status VARCHAR(20) NOT NULL,
            duration INT DEFAULT 0,
            startedAt TEXT,
            endedAt TEXT,
            endedBy VARCHAR(255),
            updatedAt TEXT
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS activity_apps (
            id VARCHAR(255) PRIMARY KEY,
            client_id VARCHAR(255) NOT NULL,
            client_secret VARCHAR(255) NOT NULL,
            owner_id VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            redirect_uris TEXT,
            scopes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `)
        
        await conn.query(`
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
            expires_at BIGINT NOT NULL
          )
        `)
        
        await conn.query(`
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
            expires_at BIGINT NOT NULL
          )
        `)
        
        await conn.query(`
          CREATE TABLE IF NOT EXISTS activity_public (
            id VARCHAR(255) PRIMARY KEY,
            owner_id VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            icon VARCHAR(100),
            category VARCHAR(100),
            launch_url TEXT,
            visibility VARCHAR(50) DEFAULT 'public',
            is_builtin_client TINYINT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `)
        
        console.log('[Storage] MariaDB tables initialized')
      } finally {
        conn.release()
      }
    }

    const ready = createTables().catch(err => {
      console.error('[Storage] Error creating MariaDB tables:', err.message)
    })
    
    console.log('[Storage] MariaDB pool created')
    
    return {
      type: 'mariadb',
      provider: 'mariadb',
      pool,
      load: async (table, defaultValue = {}) => {
        const safeTable = assertSafeTableName(table)
        try {
          await ready
          const schema = TABLE_SCHEMAS[safeTable]
          
          // First, try to load from individual table
          try {
            const rows = await pool.query(`SELECT * FROM ${safeTable}`)
            if (rows.length > 0) {
              if (schema?.dataFormat === 'friends_list') {
                const result = {}
                for (const row of rows) {
                  if (row.userId && row.friendId) {
                    if (!result[row.userId]) result[row.userId] = []
                    result[row.userId].push(row.friendId)
                  }
                }
                return result
              }

              if (schema?.dataFormat === 'nested_array') {
                const result = {}
                for (const row of rows) {
                  if (row.userId && row.blockedUserId) {
                    if (!result[row.userId]) result[row.userId] = []
                    result[row.userId].push(row.blockedUserId)
                  }
                }
                return result
              }

              if (schema?.dataFormat === 'friend_requests') {
                return buildFriendRequestsStateFromRows(rows)
              }

              if (schema?.dataFormat === 'dm_conversations') {
                return buildDmsStateFromRows(rows)
              }

              if (schema?.dataFormat === 'dm_messages') {
                return buildDmMessagesStateFromRows(rows)
              }

              if (schema?.dataFormat === 'reactions') {
                const result = {}
                for (const row of rows) {
                  if (row.messageId && row.emoji) {
                    if (!result[row.messageId]) result[row.messageId] = {}
                    try {
                      result[row.messageId][row.emoji] = typeof row.userIds === 'string' ? JSON.parse(row.userIds) : row.userIds
                    } catch {
                      result[row.messageId][row.emoji] = []
                    }
                  }
                }
                return result
              }

              const result = {}
              for (const rawRow of rows) {
                const row = mapRowToCanonicalColumns(rawRow, schema?.columns || [], table)
                // Handle all possible ID column names
                const id = row.id || row.code || row.serverId || row.userId || row.callId || row.participantKey || row.access_token
                if (id) {
                  const parsed = {}
                  for (const [key, value] of Object.entries(row)) {
                    // Skip ID columns in the data object
                    if (['id', 'code', 'serverId', 'userId', 'callId', 'participantKey', 'access_token'].includes(key)) {
                      parsed[key] = value
                    } else if (
                      // Check for _json suffix columns
                      key.endsWith('_json') ||
                      // Known JSON columns
                      key === 'roles' || key === 'members' || key === 'bans' || key === 'emojis' ||
                      key === 'permissions' || key === 'permissions_json' || key === 'servers_json' || key === 'intents_json' || key === 'commands_json' ||
                      key === 'participants_json' || key === 'mentions_json' || key === 'storage_json' ||
                      key === 'redirect_uris' || key === 'scopes' ||
                      // Auto-detect JSON strings
                      (typeof value === 'string' && (value.startsWith('{') || value.startsWith('[')))
                    ) {
                      try {
                        parsed[key] = JSON.parse(value)
                      } catch {
                        parsed[key] = value
                      }
                    } else {
                      parsed[key] = value
                    }
                  }
                  result[id] = normalizeLoadedRecord(safeTable, parsed)
                }
              }
              if (Object.keys(result).length > 0) {
                console.log(`[Storage] Loaded ${safeTable}: ${Object.keys(result).length} records`)
                return result
              }
            }
          } catch (tableErr) {
            // Table doesn't exist, fall through to storage_kv
          }

          // Fall back to storage_kv if it exists (for migration)
          try {
            const kvRows = await pool.query('SELECT data FROM storage_kv WHERE id = ? LIMIT 1', [safeTable])
            if (Array.isArray(kvRows) && kvRows[0]?.data) {
              try {
                return JSON.parse(kvRows[0].data)
              } catch {
                return defaultValue
              }
            }
          } catch (kvErr) {
            // storage_kv doesn't exist
          }

          return defaultValue
        } catch (err) {
          console.error(`[Storage] Error loading ${safeTable}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        const safeTable = assertSafeTableName(table)
        try {
          await ready
          const conn = await pool.getConnection()
          try {
            // Check if individual table exists
            const tables = await conn.query(`SHOW TABLES LIKE ?`, [safeTable])
            
            if (tables.length > 0) {
              // Save to individual table
              const schema = TABLE_SCHEMAS[safeTable]
              const columns = schema?.columns || ['id', 'data']
              const primaryKey = schema?.primaryKey
              
               if (typeof data === 'object' && data !== null) {
                 if (schema?.dataFormat === 'friends_list') {
                    const columnRows = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                    const availableColumns = getAvailableColumnSet(columnRows)
                    const insertColumns = availableColumns.has('createdAt')
                      ? ['userId', 'friendId', 'createdAt']
                      : ['userId', 'friendId']
                    const placeholders = insertColumns.map(() => '?').join(', ')

                    // Collect all valid pairs for the new state
                    const newPairs = new Set()
                    const rows = []
                    for (const [userId, friendIds] of Object.entries(data)) {
                      if (!Array.isArray(friendIds)) continue
                      for (const friendId of friendIds) {
                        const pairKey = `${userId}:${friendId}`
                        if (newPairs.has(pairKey)) continue
                        newPairs.add(pairKey)
                        rows.push(insertColumns.includes('createdAt')
                          ? [userId, friendId, new Date().toISOString()]
                          : [userId, friendId])
                      }
                    }

                    // Use a transaction: upsert all rows then delete stale ones
                    await conn.beginTransaction()
                    try {
                      for (const values of rows) {
                        await conn.query(
                          `INSERT IGNORE INTO ${safeTable} (${insertColumns.join(', ')}) VALUES (${placeholders})`,
                          values
                        )
                      }
                      // Remove rows that are no longer in the data
                      if (newPairs.size > 0) {
                        const existing = await conn.query(`SELECT userId, friendId FROM ${safeTable}`)
                        for (const row of existing) {
                          if (!newPairs.has(`${row.userId}:${row.friendId}`)) {
                            await conn.query(`DELETE FROM ${safeTable} WHERE userId = ? AND friendId = ?`, [row.userId, row.friendId])
                          }
                        }
                      } else {
                        await conn.query(`DELETE FROM ${safeTable}`)
                      }
                      await conn.commit()
                    } catch (txErr) {
                      await conn.rollback()
                      throw txErr
                    }
                    return true
                  }

                 if (schema?.dataFormat === 'friend_requests') {
                    const columnRows = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                    const availableColumns = new Set((columnRows || []).map(col => col.Field))
                    const seen = new Set()

                    const addRow = async (request, directionHint = null) => {
                      const req = normalizeFriendRequestRow(request)
                      if (!req.id || !req.from || !req.to) return
                      if (seen.has(req.id)) return
                      seen.add(req.id)

                      const record = {
                        id: req.id,
                        fromUserId: req.from,
                        toUserId: req.to,
                        fromUsername: req.fromUsername,
                        toUsername: req.toUsername,
                        createdAt: req.createdAt,
                        status: req.status,
                        respondedAt: req.respondedAt,
                        direction: directionHint || null
                      }
                      const insertColumns = Object.keys(record).filter(col => availableColumns.has(col))
                      const insertValues = insertColumns.map(col => record[col] ?? null)
                      if (insertColumns.length === 0) return
                      const placeholders = insertColumns.map(() => '?').join(', ')
                      const updateSet = insertColumns
                        .filter(col => col !== 'id')
                        .map(col => `${col} = VALUES(${col})`)
                        .join(', ')
                      await conn.query(
                        `INSERT INTO ${safeTable} (${insertColumns.join(', ')}) VALUES (${placeholders})${updateSet ? ` ON DUPLICATE KEY UPDATE ${updateSet}` : ''}`,
                        insertValues
                      )
                    }

                    const incoming = data.incoming && typeof data.incoming === 'object' ? data.incoming : {}
                    const outgoing = data.outgoing && typeof data.outgoing === 'object' ? data.outgoing : {}

                    await conn.beginTransaction()
                    try {
                      for (const requests of Object.values(incoming)) {
                        if (!Array.isArray(requests)) continue
                        for (const req of requests) {
                          await addRow(req, 'incoming')
                        }
                      }
                      for (const requests of Object.values(outgoing)) {
                        if (!Array.isArray(requests)) continue
                        for (const req of requests) {
                          await addRow(req, 'outgoing')
                        }
                      }
                      // Remove stale requests that no longer exist in data
                      if (seen.size > 0) {
                        const existingRows = await conn.query(`SELECT id FROM ${safeTable}`)
                        for (const row of existingRows) {
                          if (!seen.has(row.id)) {
                            await conn.query(`DELETE FROM ${safeTable} WHERE id = ?`, [row.id])
                          }
                        }
                      }
                      await conn.commit()
                    } catch (txErr) {
                      await conn.rollback()
                      throw txErr
                    }
                    return true
                  }

                  if (schema?.dataFormat === 'dm_conversations') {
                   const columnRows = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                   const availableColumns = new Set((columnRows || []).map(col => col.Field))
                   const byConversation = new Map()

                   for (const conversations of Object.values(data)) {
                     if (!Array.isArray(conversations)) continue
                     for (const conv of conversations) {
                       if (!conv || typeof conv !== 'object' || !conv.id) continue
                       if (!byConversation.has(conv.id)) {
                         byConversation.set(conv.id, conv)
                       }
                     }
                   }

                   for (const conv of byConversation.values()) {
                     let participants = Array.isArray(conv.participants) ? conv.participants.filter(Boolean) : []
                     if (participants.length === 0 && typeof conv.participantKey === 'string') {
                       participants = conv.participantKey.split(':').filter(Boolean)
                     }
                     participants = Array.from(new Set(participants))
                     const record = {
                       id: conv.id,
                       participantKey: conv.participantKey || participants.slice().sort().join(':'),
                       participants_json: JSON.stringify(participants),
                       createdAt: conv.createdAt || null,
                       lastMessageAt: conv.lastMessageAt || conv.createdAt || null,
                       isGroup: conv.isGroup ? 1 : 0,
                       groupName: conv.groupName || null,
                       ownerId: conv.ownerId || null,
                       recipientId: conv.recipientId || (participants.length === 2 ? participants[1] : null)
                     }
                     const insertColumns = Object.keys(record).filter(col => availableColumns.has(col))
                     if (insertColumns.length === 0) continue
                     const insertValues = insertColumns.map(col => record[col] ?? null)
                      const placeholders = insertColumns.map(() => '?').join(', ')
                      const updateSet = insertColumns
                        .filter(col => col !== 'id')
                        .map(col => `${col} = VALUES(${col})`)
                        .join(', ')
                      await conn.query(
                        `INSERT INTO ${safeTable} (${insertColumns.join(', ')}) VALUES (${placeholders})${updateSet ? ` ON DUPLICATE KEY UPDATE ${updateSet}` : ''}`,
                        insertValues
                      )
                    }
                    // Remove conversations that are no longer in the data
                    if (byConversation.size > 0) {
                      const existingRows = await conn.query(`SELECT id FROM ${safeTable}`)
                      for (const row of existingRows) {
                        if (!byConversation.has(row.id)) {
                          await conn.query(`DELETE FROM ${safeTable} WHERE id = ?`, [row.id])
                        }
                      }
                    }
                    return true
                  }

                  if (schema?.dataFormat === 'messages') {
                    const columnRows = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                    const availableColumns = mapActualColumnsByNormalized(columnRows || [])
                    let hadInsertError = false
                    for (const [channelId, messages] of Object.entries(data)) {
                      if (!Array.isArray(messages)) continue
                      for (const msg of messages) {
                        if (!msg || typeof msg !== 'object' || !msg.id) continue
                        try {
                          // Resolve the user identifier - userId and authorId must always be the same
                          const userIdentifier = msg.userId || msg.authorId || null
                          const record = {
                            id: msg.id,
                            channelId: msg.channelId || channelId,
                            userId: userIdentifier,
                            authorId: userIdentifier,
                            content: msg.content || null,
                            type: msg.type || 'message',
                            createdAt: msg.createdAt || msg.timestamp || null,
                            updatedAt: msg.updatedAt || null,
                            mentions: JSON.stringify(Array.isArray(msg.mentions) ? msg.mentions : []),
                            attachments: JSON.stringify(Array.isArray(msg.attachments) ? msg.attachments : []),
                            embeds: JSON.stringify(Array.isArray(msg.embeds) ? msg.embeds : []),
                            replyTo: msg.replyTo ? JSON.stringify(msg.replyTo) : null,
                            edited: msg.edited ? 1 : 0,
                            editedAt: msg.editedAt || null,
                            username: msg.username || null,
                            avatar: msg.avatar || null,
                            storage: msg.storage ? JSON.stringify(msg.storage) : null,
                            encrypted: msg.encrypted ? 1 : 0,
                            iv: msg.iv || null,
                            epoch: msg.epoch ?? null,
                            bot: msg.bot ? 1 : 0,
                            timestamp: msg.timestamp || msg.createdAt || null
                          }
                          const insertColumns = Object.keys(record)
                            .map((col) => {
                              const meta = getActualColumnMeta(col, availableColumns, safeTable)
                              return meta ? { canonical: col, actual: meta.actual, meta } : null
                            })
                            .filter(Boolean)
                            .filter((col, index, arr) => arr.findIndex(c => c.actual === col.actual) === index)
                          if (insertColumns.length === 0) continue
                          const insertValues = insertColumns.map(({ canonical, meta }) => normalizeSqlValue(record[canonical], meta))
                          const placeholders = insertColumns.map(() => '?').join(', ')
                          const updateSet = insertColumns
                            .filter(({ actual }) => actual !== 'id')
                            .map(({ actual }) => `${actual} = VALUES(${actual})`)
                            .join(', ')
                          await conn.query(
                            `INSERT INTO ${safeTable} (${insertColumns.map(({ actual }) => actual).join(', ')}) VALUES (${placeholders})${updateSet ? ` ON DUPLICATE KEY UPDATE ${updateSet}` : ''}`,
                            insertValues
                          )
                        } catch (err) {
                          hadInsertError = true
                          console.error(`[Storage] Error inserting record into ${safeTable}:`, err.message, 'key:', msg.id)
                        }
                      }
                    }
                    return !hadInsertError
                  }

                  if (schema?.dataFormat === 'dm_messages') {
                    const columnRows = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                    const availableColumns = new Set((columnRows || []).map(col => col.Field))
                    const seenIds = new Set()
                    for (const [conversationId, messages] of Object.entries(data)) {
                      if (!Array.isArray(messages)) continue
                      for (const msg of messages) {
                        if (!msg || typeof msg !== 'object' || !msg.id) continue
                        seenIds.add(msg.id)
                        const record = {
                          id: msg.id,
                          conversationId: msg.conversationId || conversationId,
                          userId: msg.userId || null,
                          username: msg.username || null,
                          avatar: msg.avatar || null,
                          content: msg.content || null,
                          bot: msg.bot ? 1 : 0,
                          encrypted: msg.encrypted ? 1 : 0,
                          iv: msg.iv || null,
                          epoch: msg.epoch || null,
                          timestamp: msg.timestamp || msg.createdAt || null,
                          mentions_json: JSON.stringify(Array.isArray(msg.mentions) ? msg.mentions : []),
                          storage_json: msg.storage ? JSON.stringify(msg.storage) : null,
                          edited: msg.edited ? 1 : 0,
                          editedAt: msg.editedAt || null,
                          replyTo: msg.replyTo ? JSON.stringify(msg.replyTo) : null,
                          attachments: JSON.stringify(Array.isArray(msg.attachments) ? msg.attachments : []),
                          keyVersion: msg.keyVersion || null,
                          createdAt: msg.createdAt || msg.timestamp || null
                        }
                        const insertColumns = Object.keys(record).filter(col => availableColumns.has(col))
                        if (insertColumns.length === 0) continue
                        const insertValues = insertColumns.map(col => record[col] ?? null)
                        const placeholders = insertColumns.map(() => '?').join(', ')
                        const updateSet = insertColumns
                          .filter(col => col !== 'id')
                          .map(col => `${col} = VALUES(${col})`)
                          .join(', ')
                        await conn.query(
                          `INSERT INTO ${safeTable} (${insertColumns.join(', ')}) VALUES (${placeholders})${updateSet ? ` ON DUPLICATE KEY UPDATE ${updateSet}` : ''}`,
                          insertValues
                        )
                      }
                    }
                    return true
                  }

                 // Flatten nested data for channels and categories (serverId-keyed arrays)
                 let processedData = data
                 if ((safeTable === 'channels' || safeTable === 'categories') && typeof data === 'object' && data !== null) {
                   const sampleVal = Object.values(data)[0]
                   if (Array.isArray(sampleVal)) {
                     processedData = {}
                     for (const [parentKey, items] of Object.entries(data)) {
                       if (Array.isArray(items)) {
                         for (const item of items) {
                           if (item && typeof item === 'object' && item.id) {
                             if (!item.serverId) {
                               item.serverId = parentKey
                             }
                             processedData[item.id] = item
                           }
                         }
                       }
                     }
                   }
                 }

                 const columnRows = await conn.query(`SHOW COLUMNS FROM ${safeTable}`)
                 const availableColumns = mapActualColumnsByNormalized(columnRows || [])
                 const actualPrimaryKey = getActualColumnName(primaryKey || 'id', availableColumns, safeTable)
                 const mappedColumns = columns
                    .map((column) => {
                      const meta = getActualColumnMeta(column, availableColumns, safeTable)
                      return meta ? { canonical: column, actual: meta.actual, meta } : null
                    })
                    .filter(Boolean)
                    .filter((col, index, arr) => arr.findIndex(c => c.actual === col.actual) === index)

                 if (mappedColumns.length === 0) {
                   console.warn(`[Storage] No compatible columns found for ${safeTable}, skipping save`)
                   return false
                 }

                 const placeholders = mappedColumns.map(() => '?').join(', ')
                 const updateSet = mappedColumns
                   .filter(({ actual }) => actual !== actualPrimaryKey)
                   .map(({ actual }) => `${actual} = VALUES(${actual})`)
                   .join(', ')
                 const insertSql = `INSERT INTO ${safeTable} (${mappedColumns.map(({ actual }) => actual).join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateSet || `${actualPrimaryKey || mappedColumns[0].actual} = ${actualPrimaryKey || mappedColumns[0].actual}`}`
                 
                 let hadInsertError = false
                 for (const [key, value] of Object.entries(processedData)) {
                   try {
                     // Build record based on the table's columns
                     const record = { }
                     
                     // Set the primary key
                     if (primaryKey === 'id' || !primaryKey) {
                       record.id = key
                     } else if (primaryKey === 'code') {
                       record.code = key
                     } else if (primaryKey === 'userId') {
                       record.userId = key
                     } else if (primaryKey === 'callId') {
                       record.callId = key
                     } else if (primaryKey === 'participantKey') {
                       record.participantKey = key
                     }
                     
                     // Add all other fields from the value
                     if (value && typeof value === 'object') {
                       for (const [field, fieldValue] of Object.entries(value)) {
                         record[field] = fieldValue
                       }
                     } else {
                       record.data = value
                     }
                     
                     const values = mappedColumns.map(({ canonical, actual, meta }) => normalizeSqlValue(getRecordValueForColumn(record, canonical, actual, safeTable), meta))
                     await conn.query(insertSql, values)
                   } catch (err) {
                     hadInsertError = true
                     console.error(`[Storage] Error inserting record into ${safeTable}:`, err.message, 'key:', key)
                   }
                 }
                 if (hadInsertError) return false
               }
               return true
             }

            // Fall back to storage_kv for tables without individual schemas
            try {
              await conn.query(
                `INSERT INTO storage_kv (id, data) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE data = VALUES(data)`,
                [table, JSON.stringify(data ?? {})]
              )
              return true
            } catch (kvErr) {
              // storage_kv might not exist, create it temporarily
              await conn.query(`CREATE TABLE IF NOT EXISTS storage_kv (id VARCHAR(255) PRIMARY KEY, data LONGTEXT NOT NULL, updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`)
              await conn.query(
                `INSERT INTO storage_kv (id, data) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE data = VALUES(data)`,
                [table, JSON.stringify(data ?? {})]
              )
              return true
            }
          } catch (err) {
            console.error(`[Storage] Error saving ${table}:`, err.message)
            return false
          } finally {
            conn.release()
          }
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await pool.end()
      }
    }
  } catch (err) {
    console.error('[Storage] MariaDB not available:', err.message)
    throw new Error('MariaDB not available. Install mariadb with: npm install mariadb')
  }
}

const initPostgresStorage = () => {
  let pool
  try {
    const { Pool } = require('pg')
    const storageConfig = config.config.storage.postgres
    
    const connectionConfig = {
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 5432,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'postgres',
      password: storageConfig.password || '',
      max: storageConfig.connectionLimit || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    }
    
    if (storageConfig.connectionString) {
      connectionConfig.connectionString = storageConfig.connectionString
    }
    
    if (storageConfig.ssl) {
      connectionConfig.ssl = { rejectUnauthorized: false }
    }
    
    pool = new Pool(connectionConfig)
    
    const createTables = async () => {
      const client = await pool.connect()
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            username VARCHAR(255) NOT NULL,
            "displayName" VARCHAR(255),
            email VARCHAR(255),
            "passwordHash" VARCHAR(255),
            "authProvider" VARCHAR(50),
            avatar TEXT,
            banner TEXT,
            bio TEXT,
            "customStatus" TEXT,
            status VARCHAR(50) DEFAULT 'offline',
            "socialLinks" TEXT,
            "ageVerification" VARCHAR(50),
            host VARCHAR(255),
            "createdAt" TEXT,
            "updatedAt" TEXT
          )
        `)
        
        await client.query(`
          CREATE TABLE IF NOT EXISTS servers (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            icon TEXT,
            banner TEXT,
            "ownerId" VARCHAR(255) NOT NULL,
            "createdAt" TEXT,
            "updatedAt" TEXT
          )
        `)
        
        await client.query(`
          CREATE TABLE IF NOT EXISTS channels (
            id VARCHAR(255) PRIMARY KEY,
            "serverId" VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            type VARCHAR(50) DEFAULT 'text',
            topic TEXT,
            position INTEGER,
            "createdAt" TEXT
          )
        `)
        
        await client.query(`
          CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(255) PRIMARY KEY,
            "channelId" VARCHAR(255) NOT NULL,
            "authorId" VARCHAR(255) NOT NULL,
            content TEXT,
            type VARCHAR(50) DEFAULT 'text',
            "createdAt" TEXT,
            "updatedAt" TEXT
          )
        `)
        
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_messages_channelId ON messages("channelId")
        `)
        
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_channels_serverId ON channels("serverId")
        `)
        
        console.log('[Storage] PostgreSQL tables initialized')
      } finally {
        client.release()
      }
    }
    
    createTables().catch(err => {
      console.error('[Storage] Error creating PostgreSQL tables:', err.message)
    })
    
    console.log('[Storage] PostgreSQL pool created')
    
    return {
      type: 'postgres',
      provider: 'postgres',
      pool,
      load: async (table, defaultValue = {}) => {
        table = assertSafeTableName(table)
        try {
          const res = await pool.query(`SELECT * FROM ${table}`)
          const result = {}
          res.rows.forEach(row => {
            try {
              result[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              result[row.id] = row
            }
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        table = assertSafeTableName(table)
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          for (const [id, row] of Object.entries(data)) {
            await client.query(
              `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
              [id, JSON.stringify(row)]
            )
          }
          await client.query('COMMIT')
          return true
        } catch (err) {
          await client.query('ROLLBACK')
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        } finally {
          client.release()
        }
      },
      close: async () => {
        await pool.end()
      }
    }
  } catch (err) {
    console.error('[Storage] PostgreSQL not available:', err.message)
    throw new Error('PostgreSQL not available. Install pg with: npm install pg')
  }
}

const initCockroachdbStorage = () => {
  let client
  try {
    const { Client } = require('pg')
    const storageConfig = config.config.storage.cockroachdb
    
    const connectionConfig = {
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 26257,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'root',
      password: storageConfig.password || '',
      ssl: storageConfig.ssl ? { rejectUnauthorized: false } : false
    }
    
    if (storageConfig.connectionString) {
      connectionConfig.connectionString = storageConfig.connectionString
    }
    
    client = new Client(connectionConfig)
    
    const createTables = async () => {
      await client.connect()
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY,
          username VARCHAR(255) NOT NULL,
          "displayName" VARCHAR(255),
          email VARCHAR(255),
          "passwordHash" VARCHAR(255),
          "authProvider" VARCHAR(50),
          avatar TEXT,
          banner TEXT,
          bio TEXT,
          "customStatus" TEXT,
          status VARCHAR(50) DEFAULT 'offline',
          "socialLinks" TEXT,
          "ageVerification" VARCHAR(50),
          host VARCHAR(255),
          "createdAt" TIMESTAMP,
          "updatedAt" TIMESTAMP
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS servers (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          icon TEXT,
          banner TEXT,
          "ownerId" VARCHAR(255) NOT NULL,
          "createdAt" TIMESTAMP,
          "updatedAt" TIMESTAMP
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS channels (
          id VARCHAR(255) PRIMARY KEY,
          "serverId" VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          type VARCHAR(50) DEFAULT 'text',
          topic TEXT,
          position INTEGER,
          "createdAt" TIMESTAMP
        )
      `)
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id VARCHAR(255) PRIMARY KEY,
          "channelId" VARCHAR(255) NOT NULL,
          "authorId" VARCHAR(255) NOT NULL,
          content TEXT,
          type VARCHAR(50) DEFAULT 'text',
          "createdAt" TIMESTAMP,
          "updatedAt" TIMESTAMP
        )
      `)
      
      console.log('[Storage] CockroachDB tables initialized')
    }
    
    createTables().catch(err => {
      console.error('[Storage] Error creating CockroachDB tables:', err.message)
    })
    
    console.log('[Storage] CockroachDB client created')
    
    return {
      type: 'cockroachdb',
      provider: 'cockroachdb',
      client,
      load: async (table, defaultValue = {}) => {
        table = assertSafeTableName(table)
        try {
          const res = await client.query(`SELECT * FROM ${table}`)
          const result = {}
          res.rows.forEach(row => {
            try {
              result[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              result[row.id] = row
            }
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        table = assertSafeTableName(table)
        try {
          await client.query('BEGIN')
          for (const [id, row] of Object.entries(data)) {
            await client.query(
              `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
              [id, JSON.stringify(row)]
            )
          }
          await client.query('COMMIT')
          return true
        } catch (err) {
          await client.query('ROLLBACK')
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await client.end()
      }
    }
  } catch (err) {
    console.error('[Storage] CockroachDB not available:', err.message)
    throw new Error('CockroachDB not available. Install pg with: npm install pg')
  }
}

const initMssqlStorage = () => {
  let pool
  try {
    const mssql = require('mssql')
    const storageConfig = config.config.storage.mssql
    
    const config = {
      server: storageConfig.host || 'localhost',
      port: storageConfig.port || 1433,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'sa',
      password: storageConfig.password || '',
      options: {
        encrypt: storageConfig.encrypt || false,
        trustServerCertificate: storageConfig.trustServerCertificate || true
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    }
    
    const createTables = async () => {
      await pool.connect()
      
      const request = pool.request()
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
        CREATE TABLE users (
          id NVARCHAR(255) PRIMARY KEY,
          username NVARCHAR(255) NOT NULL,
          displayName NVARCHAR(255),
          email NVARCHAR(255),
          passwordHash NVARCHAR(255),
          authProvider NVARCHAR(50),
          avatar NVARCHAR(MAX),
          banner NVARCHAR(MAX),
          bio NVARCHAR(MAX),
          customStatus NVARCHAR(MAX),
          status NVARCHAR(50) DEFAULT 'offline',
          socialLinks NVARCHAR(MAX),
          ageVerification NVARCHAR(50),
          host NVARCHAR(255),
          createdAt NVARCHAR(255),
          updatedAt NVARCHAR(255)
        )
      `)
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='servers' AND xtype='U')
        CREATE TABLE servers (
          id NVARCHAR(255) PRIMARY KEY,
          name NVARCHAR(255) NOT NULL,
          description NVARCHAR(MAX),
          icon NVARCHAR(MAX),
          banner NVARCHAR(MAX),
          ownerId NVARCHAR(255) NOT NULL,
          createdAt NVARCHAR(255),
          updatedAt NVARCHAR(255)
        )
      `)
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='channels' AND xtype='U')
        CREATE TABLE channels (
          id NVARCHAR(255) PRIMARY KEY,
          serverId NVARCHAR(255) NOT NULL,
          name NVARCHAR(255) NOT NULL,
          type NVARCHAR(50) DEFAULT 'text',
          topic NVARCHAR(MAX),
          position INT,
          createdAt NVARCHAR(255)
        )
      `)
      
      await request.query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='messages' AND xtype='U')
        CREATE TABLE messages (
          id NVARCHAR(255) PRIMARY KEY,
          channelId NVARCHAR(255) NOT NULL,
          authorId NVARCHAR(255) NOT NULL,
          content NVARCHAR(MAX),
          type NVARCHAR(50) DEFAULT 'text',
          createdAt NVARCHAR(255),
          updatedAt NVARCHAR(255)
        )
      `)
      
      console.log('[Storage] MSSQL tables initialized')
    }
    
    mssql.connect(config).then(p => {
      pool = p
      createTables().catch(err => {
        console.error('[Storage] Error creating MSSQL tables:', err.message)
      })
      console.log('[Storage] MSSQL pool created')
    }).catch(err => {
      console.error('[Storage] MSSQL connection error:', err.message)
    })
    
    return {
      type: 'mssql',
      provider: 'mssql',
      pool,
      load: async (table, defaultValue = {}) => {
        table = assertSafeTableName(table)
        try {
          if (!pool) await mssql.connect(config)
          const result = await pool.request().query(`SELECT * FROM ${table}`)
          const res = {}
          result.recordset.forEach(row => {
            try {
              res[row.id] = JSON.parse(row.data || '{}')
            } catch {
              delete row.data
              res[row.id] = row
            }
          })
          return res
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        table = assertSafeTableName(table)
        try {
          if (!pool) await mssql.connect(config)
          const transaction = new mssql.Transaction(pool)
          await transaction.begin()
          try {
            for (const [id, row] of Object.entries(data)) {
              await transaction.request()
                .input('id', mssql.VarChar, id)
                .input('data', mssql.VarChar, JSON.stringify(row))
                .query(`MERGE INTO ${table} AS target USING (SELECT @id as id, @data as data) AS source ON target.id = source.id WHEN MATCHED THEN UPDATE SET data = source.data WHEN NOT MATCHED THEN INSERT (id, data) VALUES (source.id, source.data);`)
            }
            await transaction.commit()
            return true
          } catch (err) {
            await transaction.rollback()
            throw err
          }
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await mssql.close()
      }
    }
  } catch (err) {
    console.error('[Storage] MSSQL not available:', err.message)
    throw new Error('MSSQL not available. Install mssql with: npm install mssql')
  }
}

const initMongodbStorage = () => {
  let client
  let database
  try {
    const { MongoClient } = require('mongodb')
    const storageConfig = config.config.storage.mongodb
    
    let connectionUri
    if (storageConfig.connectionString) {
      connectionUri = storageConfig.connectionString
    } else {
      const auth = storageConfig.user && storageConfig.password 
        ? `${storageConfig.user}:${encodeURIComponent(storageConfig.password)}@`
        : ''
      const authSource = storageConfig.authSource ? `?authSource=${storageConfig.authSource}` : ''
      connectionUri = `mongodb://${auth}${storageConfig.host || 'localhost'}:${storageConfig.port || 27017}/${storageConfig.database || 'voltchat'}${authSource}`
    }
    
    client = new MongoClient(connectionUri)
    
    const createCollections = async () => {
      await client.connect()
      database = client.db(storageConfig.database || 'voltchat')
      
      await database.createCollection('users').catch(() => {})
      await database.createCollection('servers').catch(() => {})
      await database.createCollection('channels').catch(() => {})
      await database.createCollection('messages').catch(() => {})
      await database.createCollection('friends').catch(() => {})
      await database.createCollection('friend_requests').catch(() => {})
      await database.createCollection('dms').catch(() => {})
      await database.createCollection('dm_messages').catch(() => {})
      await database.createCollection('reactions').catch(() => {})
      await database.createCollection('blocked').catch(() => {})
      await database.createCollection('files').catch(() => {})
      await database.createCollection('attachments').catch(() => {})
      await database.createCollection('discovery').catch(() => {})
      await database.createCollection('global_bans').catch(() => {})
      await database.createCollection('admin_logs').catch(() => {})
      
      await database.collection('messages').createIndex({ channelId: 1, createdAt: -1 }).catch(() => {})
      await database.collection('channels').createIndex({ serverId: 1 }).catch(() => {})
      await database.collection('servers').createIndex({ ownerId: 1 }).catch(() => {})
      
      console.log('[Storage] MongoDB collections initialized')
    }
    
    createCollections().catch(err => {
      console.error('[Storage] Error creating MongoDB collections:', err.message)
    })
    
    console.log('[Storage] MongoDB client created')
    
    return {
      type: 'mongodb',
      provider: 'mongodb',
      client,
      db: database,
      load: async (table, defaultValue = {}) => {
        table = assertSafeTableName(table)
        try {
          if (!database) await createCollections()
          const collection = database.collection(table)
          const cursor = collection.find({})
          const result = {}
          await cursor.forEach(doc => {
            result[doc._id] = doc.data || doc
            if (result[doc._id]._id) delete result[doc._id]._id
          })
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        table = assertSafeTableName(table)
        try {
          if (!database) await createCollections()
          const collection = database.collection(table)
          const bulkOps = []
          for (const [id, row] of Object.entries(data)) {
            bulkOps.push({
              replaceOne: {
                filter: { _id: id },
                replacement: { _id: id, data: row },
                upsert: true
              }
            })
          }
          if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps)
          }
          return true
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await client.close()
      }
    }
  } catch (err) {
    console.error('[Storage] MongoDB not available:', err.message)
    throw new Error('MongoDB not available. Install mongodb with: npm install mongodb')
  }
}

const initRedisStorage = () => {
  let redisClient
  try {
    const redis = require('redis')
    const storageConfig = config.config.storage.redis
    
    const redisConfig = {
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 6379,
      password: storageConfig.password || undefined,
      db: storageConfig.db || 0
    }
    
    redisClient = redis.createClient(redisConfig)
    
    redisClient.on('error', err => {
      console.error('[Storage] Redis error:', err.message)
    })
    
    redisClient.connect().then(() => {
      console.log('[Storage] Redis client connected')
    }).catch(err => {
      console.error('[Storage] Redis connection error:', err.message)
    })
    
    const prefix = storageConfig.keyPrefix || 'voltchat:'
    
    return {
      type: 'redis',
      provider: 'redis',
      client: redisClient,
      load: async (table, defaultValue = {}) => {
        table = assertSafeTableName(table)
        try {
          const keys = await redisClient.keys(`${prefix}${table}:*`)
          const result = {}
          for (const key of keys) {
            const id = key.replace(`${prefix}${table}:`, '')
            const data = await redisClient.get(key)
            try {
              result[id] = JSON.parse(data)
            } catch {
              result[id] = data
            }
          }
          return result
        } catch (err) {
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        table = assertSafeTableName(table)
        try {
          const pipeline = redisClient.multi()
          for (const [id, row] of Object.entries(data)) {
            pipeline.set(`${prefix}${table}:${id}`, JSON.stringify(row))
          }
          await pipeline.exec()
          return true
        } catch (err) {
          console.error(`[Storage] Error saving ${table}:`, err.message)
          return false
        }
      },
      close: async () => {
        await redisClient.quit()
      }
    }
  } catch (err) {
    console.error('[Storage] Redis not available:', err.message)
    throw new Error('Redis not available. Install redis with: npm install redis')
  }
}

export const initStorage = () => {
  if (storage) return storage
  
  const storageType = config.config.storage?.type || 'json'
  
  // JSON is deprecated and blocked - must use a proper database
  if (storageType === 'json') {
    console.error('==============================================')
    console.error('[Storage] ERROR: JSON storage is DEPRECATED and BLOCKED!')
    console.error('[Storage] You must configure a proper database in your config.')
    console.error('[Storage] Supported databases: sqlite, mysql, mariadb, postgres, cockroachdb, mssql, mongodb, redis')
    console.error('')
    console.error('[Storage] Example config.json:')
    console.error('{')
    console.error('  "storage": {')
    console.error('    "type": "sqlite",')
    console.error('    "sqlite": {')
    console.error('      "dbPath": "./data/voltage.db"')
    console.error('    }')
    console.error('  }')
    console.error('}')
    console.error('==============================================')
    throw new Error('JSON storage is deprecated. Configure a proper database (sqlite, mysql, postgres, etc.) to continue.')
  }
  
  switch (storageType) {
    case 'sqlite':
      try {
        storage = initSqliteStorage()
      } catch (err) {
        console.error('[Storage] SQLite init failed:', err.message)
        throw err
      }
      break
      
    case 'mysql':
      try {
        storage = initMysqlStorage()
      } catch (err) {
        console.error('[Storage] MySQL init failed:', err.message)
        throw err
      }
      break
      
    case 'mariadb':
      try {
        storage = initMariadbStorage()
      } catch (err) {
        console.error('[Storage] MariaDB init failed:', err.message)
        throw err
      }
      break
      
    case 'postgres':
      try {
        storage = initPostgresStorage()
      } catch (err) {
        console.error('[Storage] PostgreSQL init failed:', err.message)
        throw err
      }
      break
      
    case 'cockroachdb':
      try {
        storage = initCockroachdbStorage()
      } catch (err) {
        console.error('[Storage] CockroachDB init failed:', err.message)
        throw err
      }
      break
      
    case 'mssql':
      try {
        storage = initMssqlStorage()
      } catch (err) {
        console.error('[Storage] MSSQL init failed:', err.message)
        throw err
      }
      break
      
    case 'mongodb':
      try {
        storage = initMongodbStorage()
      } catch (err) {
        console.error('[Storage] MongoDB init failed:', err.message)
        throw err
      }
      break
      
    case 'redis':
      try {
        storage = initRedisStorage()
      } catch (err) {
        console.error('[Storage] Redis init failed:', err.message)
        throw err
      }
      break
      
    default:
      console.error(`[Storage] Unknown storage type: ${storageType}`)
      throw new Error(`Unknown storage type: ${storageType}. Supported: sqlite, mysql, mariadb, postgres, cockroachdb, mssql, mongodb, redis`)
  }
  
  console.log(`[Storage] Initialized: ${storage.type}`)
  return storage
}

/**
 * Initialize storage and auto-distribute from storage_kv if needed
 * This should be called at startup
 */
export const initStorageAndDistribute = async () => {
  console.log('[Storage] initStorageAndDistribute called')
  
  initStorage()
  
  if (!storage) {
    console.error('[Storage] Failed to initialize storage')
    return storage
  }
  
  console.log('[Storage] Storage initialized, type:', storage.type)
  
  // Auto-distribute from storage_kv for database backends
  if (storage.type !== 'json') {
    try {
      console.log('[Storage] Checking for storage_kv table...')
      const hasKvTable = await checkStorageKvExists()
      console.log('[Storage] storage_kv exists with data:', hasKvTable)
      
      if (hasKvTable) {
        console.log('[Storage] Found storage_kv table, distributing to individual tables...')
        const results = await distributeFromStorageKv()
        if (results.success) {
          console.log('[Storage] Successfully distributed data from storage_kv')
          console.log('[Storage] Distribution results:', JSON.stringify(results.distributed, null, 2))
        } else {
          console.error('[Storage] Distribution had errors:', results.errors)
        }
      } else {
        console.log('[Storage] No storage_kv data to distribute')
      }
    } catch (err) {
      console.error('[Storage] Error checking/distributing storage_kv:', err.message)
      console.error('[Storage] Stack:', err.stack)
    }
  }
  
  return storage
}

/**
 * Check if storage_kv table exists AND has data
 * Returns false if table doesn't exist or is empty
 */
const checkStorageKvExists = async () => {
  if (!storage) return false
  
  try {
    if (storage.type === 'sqlite') {
      const result = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='storage_kv'`).get()
      if (!result) return false
      
      // Check if table has any data
      const countResult = db.prepare(`SELECT COUNT(*) as count FROM storage_kv`).get()
      return countResult && countResult.count > 0
    } else if (storage.type === 'mysql' || storage.type === 'mariadb') {
      const [rows] = await storage.pool.query(`SHOW TABLES LIKE 'storage_kv'`)
      if (rows.length === 0) return false
      
      // Check if table has any data
      const [countRows] = await storage.pool.query(`SELECT COUNT(*) as count FROM storage_kv`)
      return countRows && countRows[0] && countRows[0].count > 0
    }
  } catch (err) {
    // Ignore errors - table doesn't exist or query failed
  }
  
  return false
}

export const resetStorage = async () => {
  if (!storage) {
    db = null
    return
  }

  try {
    if (typeof storage.close === 'function') {
      await storage.close()
    } else if (db && typeof db.close === 'function') {
      db.close()
    }
  } catch (err) {
    console.error('[Storage] Error closing active storage:', err.message)
  } finally {
    storage = null
    db = null
  }
}

export const getStorage = () => {
  if (!storage) {
    initStorage()
  }
  return storage
}

// Table schema definitions for proper database distribution
const TABLE_SCHEMAS = {
  users: {
    primaryKey: 'id',
    columns: ['id', 'username', 'displayName', 'email', 'passwordHash', 'authProvider', 'avatar', 'banner', 'bio', 'customStatus', 'status', 'socialLinks', 'ageVerification', 'ageVerificationJurisdiction', 'host', 'createdAt', 'updatedAt', 'customUsername', 'avatarHost', 'adminRole', 'proofSummary', 'device', 'isAdmin', 'isModerator', 'profileTheme', 'profileBackground', 'profileAccentColor', 'profileFont', 'profileAnimation', 'profileBackgroundType', 'profileBackgroundOpacity', 'birthDate', 'guildTag', 'guildTagServerId', 'profileCSS', 'profileTemplate', 'bannerEffect', 'profileLayout', 'badgeStyle', 'clientCSS', 'clientCSSEnabled'],
    dataFormat: 'object'
  },
  servers: {
    primaryKey: 'id',
    columns: ['id', 'name', 'description', 'icon', 'banner', 'ownerId', 'createdAt', 'updatedAt', 'themeColor', 'bannerUrl', 'backgroundUrl', 'bannerPosition', 'roles', 'members', 'bans', 'emojis', 'automod', 'guildTag', 'guildTagPrivate'],
    dataFormat: 'object'
  },
  channels: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'name', 'type', 'isDefault', 'topic', 'slowMode', 'nsfw', 'categoryId', 'position', 'createdAt', 'updatedAt', 'permissions'],
    dataFormat: 'object'
  },
  messages: {
    primaryKey: 'id',
    columns: ['id', 'channelId', 'userId', 'authorId', 'content', 'type', 'createdAt', 'updatedAt', 'mentions', 'attachments', 'embeds', 'replyTo', 'edited', 'editedAt', 'username', 'avatar', 'storage', 'encrypted', 'iv', 'epoch', 'bot', 'timestamp'],
    dataFormat: 'messages'
  },
  friends: {
    primaryKey: 'userId',
    columns: ['userId', 'friendId', 'createdAt'],
    dataFormat: 'friends_list'
  },
  friend_requests: {
    primaryKey: 'id',
    columns: ['id', 'fromUserId', 'toUserId', 'fromUsername', 'toUsername', 'createdAt', 'status', 'respondedAt', 'direction'],
    dataFormat: 'friend_requests'
  },
  dms: {
    primaryKey: 'id',
    columns: ['id', 'participantKey', 'participants_json', 'createdAt', 'lastMessageAt', 'isGroup', 'groupName', 'ownerId', 'recipientId'],
    dataFormat: 'dm_conversations'
  },
  dm_messages: {
    primaryKey: 'id',
    columns: ['id', 'conversationId', 'userId', 'username', 'avatar', 'content', 'bot', 'encrypted', 'iv', 'epoch', 'timestamp', 'mentions_json', 'storage_json', 'edited', 'editedAt', 'replyTo', 'attachments', 'keyVersion', 'createdAt'],
    dataFormat: 'dm_messages'
  },
  reactions: {
    primaryKey: 'id',
    columns: ['id', 'messageId', 'emoji', 'userIds', 'createdAt'],
    dataFormat: 'reactions'
  },
  blocked: {
    primaryKey: 'userId',
    columns: ['userId', 'blockedUserId', 'createdAt'],
    dataFormat: 'nested_array'
  },
  files: {
    primaryKey: 'id',
    columns: ['id', 'name', 'type', 'mimetype', 'size', 'sizeBytes', 'url', 'filename', 'uploadedAt', 'uploadedBy', 'path', 'createdAt'],
    dataFormat: 'object'
  },
  attachments: {
    primaryKey: 'id',
    columns: ['id', 'messageId', 'fileId', 'createdAt'],
    dataFormat: 'object'
  },
  discovery: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'name', 'icon', 'description', 'category', 'memberCount', 'submittedBy', 'submittedAt', 'status', 'approvedAt'],
    dataFormat: 'object'
  },
  global_bans: {
    primaryKey: 'id',
    columns: ['id', 'userId', 'reason', 'bannedBy', 'expiresAt', 'createdAt'],
    dataFormat: 'object'
  },
  server_bans: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'userId', 'reason', 'bannedBy', 'bannedAt'],
    dataFormat: 'object'
  },
  admin_logs: {
    primaryKey: 'id',
    columns: ['id', 'adminId', 'action', 'targetId', 'details', 'timestamp'],
    dataFormat: 'array'
  },
  invites: {
    primaryKey: 'code',
    columns: ['code', 'serverId', 'createdBy', 'uses', 'maxUses', 'expiresAt', 'createdAt'],
    dataFormat: 'object'
  },
  pinned_messages: {
    primaryKey: 'id',
    columns: ['id', 'channelId', 'userId', 'username', 'avatar', 'content', 'timestamp', 'pinnedAt', 'pinnedBy'],
    dataFormat: 'object'
  },
  categories: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'name', 'position', 'createdAt'],
    dataFormat: 'object'
  },
  call_logs: {
    primaryKey: 'callId',
    columns: ['callId', 'conversationId', 'callerId', 'recipientId', 'type', 'status', 'duration', 'startedAt', 'endedAt', 'endedBy', 'updatedAt'],
    dataFormat: 'object'
  },
  bots: {
    primaryKey: 'id',
    columns: ['id', 'name', 'description', 'avatar', 'ownerId', 'token', 'tokenHash', 'prefix', 'permissions_json', 'servers_json', 'intents_json', 'commands_json', 'status', 'public', 'webhookUrl', 'webhookSecret', 'customStatus', 'createdAt', 'updatedAt', 'lastActive'],
    dataFormat: 'object'
  },
  e2e_keys: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  e2e_true_state: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  system_messages: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  self_volts: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  federation: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  server_start: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  activity_apps: { primaryKey: 'id', columns: ['id', 'client_id', 'client_secret', 'owner_id', 'name', 'description', 'redirect_uris', 'scopes', 'created_at', 'updated_at'], dataFormat: 'object' },
  activity_oauth_codes: { primaryKey: 'code', columns: ['code', 'client_id', 'user_id', 'scope', 'redirect_uri', 'context_type', 'context_id', 'session_id', 'app_id', 'expires_at'], dataFormat: 'object' },
  activity_oauth_tokens: { primaryKey: 'access_token', columns: ['access_token', 'app_id', 'client_id', 'user_id', 'scope', 'context_type', 'context_id', 'session_id', 'created_at', 'expires_at'], dataFormat: 'object' },
  activity_public: { primaryKey: 'id', columns: ['id', 'owner_id', 'name', 'description', 'icon', 'category', 'launch_url', 'visibility', 'is_builtin_client', 'created_at', 'updated_at'], dataFormat: 'object' },
  moderation_reports: {
    primaryKey: 'id',
    columns: ['id', 'reporterId', 'contextType', 'contextId', 'accusedUserId', 'reason', 'status', 'createdAt', 'updatedAt', 'resolvedBy', 'resolvedAt', 'actions'],
    dataFormat: 'object'
  }
}

/**
 * Distribute data from storage_kv to individual tables
 * This function moves data from the generic storage_kv table to proper individual tables
 */
export const distributeFromStorageKv = async () => {
  if (!storage) {
    console.error('[Storage] No storage initialized')
    return { success: false, error: 'No storage initialized' }
  }

  const results = {
    success: true,
    distributed: {},
    errors: [],
    deleted: false
  }

  try {
    // Only works for database backends that have storage_kv
    if (storage.type === 'json') {
      results.message = 'JSON storage does not use storage_kv - no distribution needed'
      return results
    }

    console.log('[Storage] Starting distribution from storage_kv to individual tables...')

    // Read all data from storage_kv
    let kvData = {}
    
    if (storage.type === 'sqlite') {
      try {
        const stmt = db.prepare('SELECT id, data FROM storage_kv')
        const rows = stmt.all()
        for (const row of rows) {
          try {
            kvData[row.id] = JSON.parse(row.data)
          } catch {
            kvData[row.id] = row.data
          }
        }
      } catch (err) {
        console.error('[Storage] Error reading storage_kv:', err.message)
        results.errors.push(`Failed to read storage_kv: ${err.message}`)
        results.success = false
        return results
      }
    } else if (storage.type === 'mysql' || storage.type === 'mariadb') {
      try {
        const [rows] = await storage.pool.execute('SELECT id, data FROM storage_kv')
        for (const row of rows) {
          try {
            kvData[row.id] = JSON.parse(row.data)
          } catch {
            kvData[row.id] = row.data
          }
        }
      } catch (err) {
        console.error('[Storage] Error reading storage_kv:', err.message)
        results.errors.push(`Failed to read storage_kv: ${err.message}`)
        results.success = false
        return results
      }
    } else {
      results.message = `Distribution not implemented for ${storage.type} - data remains in storage_kv`
      return results
    }

    console.log(`[Storage] Found ${Object.keys(kvData).length} tables in storage_kv`)

    // Distribute each table's data
    for (const [tableName, tableData] of Object.entries(kvData)) {
      if (!tableData || (typeof tableData === 'object' && Object.keys(tableData).length === 0)) {
        results.distributed[tableName] = { count: 0, status: 'empty' }
        continue
      }

      try {
        const count = await distributeTableToIndividual(tableName, tableData, storage)
        results.distributed[tableName] = { count, status: 'success' }
        console.log(`[Storage] Distributed ${tableName}: ${count} records`)
      } catch (err) {
        results.distributed[tableName] = { count: 0, status: 'error', error: err.message }
        results.errors.push(`${tableName}: ${err.message}`)
        console.error(`[Storage] Error distributing ${tableName}:`, err.message)
      }
    }

    // After successful distribution, delete storage_kv
    if (results.errors.length === 0) {
      try {
        if (storage.type === 'sqlite') {
          db.exec('DROP TABLE IF EXISTS storage_kv')
        } else if (storage.type === 'mysql' || storage.type === 'mariadb') {
          await storage.pool.query('DROP TABLE IF EXISTS storage_kv')
        }
        results.deleted = true
        console.log('[Storage] Deleted storage_kv table after successful distribution')
      } catch (err) {
        results.errors.push(`Failed to delete storage_kv: ${err.message}`)
        console.error('[Storage] Error deleting storage_kv:', err.message)
      }
    }

    results.message = 'Distribution completed'
  } catch (err) {
    results.success = false
    results.errors.push(err.message)
    console.error('[Storage] Distribution error:', err.message)
  }

  return results
}

/**
 * Distribute a single table's data to individual records
 * Handles various data formats from storage_kv
 */
const distributeTableToIndividual = async (tableName, tableData, storage) => {
  tableName = assertSafeTableName(tableName)
  const schema = TABLE_SCHEMAS[tableName]
  const dataFormat = schema?.dataFormat || 'object'
  let count = 0

  console.log(`[Storage] Processing ${tableName} with format: ${dataFormat}`)

  // Parse records based on data format
  let records = []

  switch (dataFormat) {
    case 'array':
      // Data is already an array: [{ ...record }, ...]
      if (Array.isArray(tableData)) {
        records = tableData
      }
      break

    case 'object':
      // Data is an object with IDs as keys: { id: { ...record }, ... }
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [key, value] of Object.entries(tableData)) {
          if (typeof value === 'object' && value !== null) {
            records.push({ id: key, ...value })
          } else {
            records.push({ id: key, data: value })
          }
        }
      }
      break

    case 'nested_array':
      // Data is nested: { parentKey: [{ ...record }, ...], ... }
      // Used for: channels (by serverId), messages (by channelId), dms (by userId), etc.
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [parentKey, items] of Object.entries(tableData)) {
          if (Array.isArray(items)) {
            for (const item of items) {
              if (typeof item === 'object' && item !== null) {
                records.push({ ...item })
              }
            }
          } else if (typeof items === 'object' && items !== null) {
            // Handle case where it might be an object with IDs
            for (const [itemKey, itemValue] of Object.entries(items)) {
              if (typeof itemValue === 'object' && itemValue !== null) {
                records.push({ id: itemKey, ...itemValue })
              }
            }
          }
        }
      }
      break

    case 'nested_object':
      // Data is deeply nested: { category: { key: [...], ... }, ... }
      // Used for: friend_requests, discovery, reactions
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [category, items] of Object.entries(tableData)) {
          if (Array.isArray(items)) {
            // { category: [item1, item2, ...] }
            for (const item of items) {
              if (typeof item === 'object' && item !== null) {
                records.push({ ...item, category })
              } else if (typeof item === 'string') {
                // Simple array of IDs
                records.push({ id: item, category })
              }
            }
          } else if (typeof items === 'object' && items !== null) {
            // { category: { key: [...], ... } }
            for (const [subKey, subItems] of Object.entries(items)) {
              if (Array.isArray(subItems)) {
                for (const item of subItems) {
                  if (typeof item === 'object' && item !== null) {
                    records.push({ ...item, subKey, category })
                  } else if (typeof item === 'string') {
                    records.push({ id: item, subKey, category })
                  }
                }
              } else if (typeof subItems === 'object' && subItems !== null) {
                // Even deeper nesting
                for (const [deepKey, deepValue] of Object.entries(subItems)) {
                  if (typeof deepValue === 'object' && deepValue !== null) {
                    records.push({ id: deepKey, ...deepValue, subKey, category })
                  }
                }
              }
            }
          }
        }
      }
      break

    case 'friends_list':
      // Friends: { userId: [friendId1, friendId2, ...] }
      // Convert to individual friend records
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [userId, friendIds] of Object.entries(tableData)) {
          if (Array.isArray(friendIds)) {
            for (const friendId of friendIds) {
              records.push({ userId, friendId, createdAt: new Date().toISOString() })
            }
          }
        }
      }
      break

    case 'friend_requests':
      // Friend requests: { incoming: { userId: [...] }, outgoing: { userId: [...] } }
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        // Process incoming requests
        if (tableData.incoming && typeof tableData.incoming === 'object') {
          for (const [userId, requests] of Object.entries(tableData.incoming)) {
            if (Array.isArray(requests)) {
              for (const req of requests) {
                if (typeof req === 'object' && req.id) {
                  records.push({ ...req, direction: 'incoming' })
                }
              }
            }
          }
        }
        // Process outgoing requests
        if (tableData.outgoing && typeof tableData.outgoing === 'object') {
          for (const [userId, requests] of Object.entries(tableData.outgoing)) {
            if (Array.isArray(requests)) {
              for (const req of requests) {
                if (typeof req === 'object' && req.id) {
                  records.push({ ...req, direction: 'outgoing' })
                }
              }
            }
          }
        }
      }
      break

    case 'reactions':
      // Reactions: { messageId: { emoji: [userIds] } }
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [messageId, emojiData] of Object.entries(tableData)) {
          if (typeof emojiData === 'object' && emojiData !== null) {
            for (const [emoji, userIds] of Object.entries(emojiData)) {
              if (Array.isArray(userIds)) {
                // Create a single record per message-emoji combo with all users
                records.push({
                  id: `${messageId}_${emoji}`,
                  messageId,
                  emoji,
                  userIds: JSON.stringify(userIds),
                  createdAt: new Date().toISOString()
                })
              }
            }
          }
        }
      }
      break

    case 'discovery':
      // Discovery: { submissions: [...], approved: [...] }
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        // Process submissions
        if (Array.isArray(tableData.submissions)) {
          for (const item of tableData.submissions) {
            if (typeof item === 'object' && item.id) {
              records.push({ ...item, status: 'pending' })
            }
          }
        }
        // Process approved
        if (Array.isArray(tableData.approved)) {
          for (const item of tableData.approved) {
            if (typeof item === 'object' && item.id) {
              records.push({ ...item, status: 'approved' })
            }
          }
        }
      }
      break

    case 'pinned_messages':
      // Pinned messages: { channelId: [pinnedMsgs] }
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [channelId, pinnedMsgs] of Object.entries(tableData)) {
          if (Array.isArray(pinnedMsgs)) {
            for (const msg of pinnedMsgs) {
              if (typeof msg === 'object' && msg.id) {
                records.push({ ...msg, channelId })
              }
            }
          }
        }
      }
      break

    case 'messages':
      // Messages: { channelId: [{ ...messageData }] }
      // Messages can have many formats: embeds, mentions, attachments, replies, etc.
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [channelId, messages] of Object.entries(tableData)) {
          if (Array.isArray(messages)) {
            for (const msg of messages) {
              if (typeof msg === 'object' && msg.id) {
                records.push({ ...msg, channelId })
              }
            }
          } else if (typeof messages === 'object' && messages !== null) {
            // Handle case where it's an object with message IDs
            for (const [msgId, msgValue] of Object.entries(messages)) {
              if (typeof msgValue === 'object' && msgValue !== null) {
                records.push({ id: msgId, channelId, ...msgValue })
              }
            }
          }
        }
      }
      break

    case 'dm_conversations':
      // DMs: { userId: [{ ...conversationData }] }
      // Normalize to one row per conversation id.
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        const byConversation = new Map()
        for (const conversations of Object.values(tableData)) {
          if (!Array.isArray(conversations)) continue
          for (const conv of conversations) {
            if (typeof conv === 'object' && conv !== null && conv.id && !byConversation.has(conv.id)) {
              byConversation.set(conv.id, conv)
            }
          }
        }
        for (const conv of byConversation.values()) {
          let participants = Array.isArray(conv.participants) ? conv.participants.filter(Boolean) : []
          if (participants.length === 0 && typeof conv.participantKey === 'string') {
            participants = conv.participantKey.split(':').filter(Boolean)
          }
          participants = Array.from(new Set(participants))
          records.push({
            id: conv.id,
            participantKey: conv.participantKey || participants.slice().sort().join(':'),
            participants_json: JSON.stringify(participants),
            createdAt: conv.createdAt || null,
            lastMessageAt: conv.lastMessageAt || conv.createdAt || null,
            isGroup: conv.isGroup ? 1 : 0,
            groupName: conv.groupName || null,
            ownerId: conv.ownerId || null,
            recipientId: conv.recipientId || (participants.length === 2 ? participants[1] : null)
          })
        }
      }
      break

    case 'dm_messages':
      // DM messages: { conversationId: [{ ...messageData }] }
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [conversationId, messages] of Object.entries(tableData)) {
          if (!Array.isArray(messages)) continue
          for (const msg of messages) {
            if (typeof msg === 'object' && msg !== null && msg.id) {
              records.push({
                id: msg.id,
                conversationId: msg.conversationId || conversationId,
                userId: msg.userId || null,
                username: msg.username || null,
                avatar: msg.avatar || null,
                content: msg.content || null,
                bot: msg.bot ? 1 : 0,
                encrypted: msg.encrypted ? 1 : 0,
                iv: msg.iv || null,
                epoch: msg.epoch || null,
                timestamp: msg.timestamp || msg.createdAt || null,
                mentions_json: JSON.stringify(Array.isArray(msg.mentions) ? msg.mentions : []),
                storage_json: msg.storage ? JSON.stringify(msg.storage) : null,
                edited: msg.edited ? 1 : 0,
                editedAt: msg.editedAt || null,
                replyTo: msg.replyTo ? JSON.stringify(msg.replyTo) : null,
                attachments: JSON.stringify(Array.isArray(msg.attachments) ? msg.attachments : []),
                keyVersion: msg.keyVersion || null,
                createdAt: msg.createdAt || msg.timestamp || null
              })
            }
          }
        }
      }
      break

    case 'categories':
      // Categories: { serverId: [categories] }
      if (typeof tableData === 'object' && !Array.isArray(tableData)) {
        for (const [serverId, categories] of Object.entries(tableData)) {
          if (Array.isArray(categories)) {
            for (const cat of categories) {
              if (typeof cat === 'object' && cat.id) {
                records.push({ ...cat, serverId })
              }
            }
          }
        }
      }
      break

    case 'server_bans':
      // Server bans are embedded in servers data, extract them
      // This is handled separately when processing servers
      if (Array.isArray(tableData)) {
        for (const server of tableData) {
          if (server.bans && Array.isArray(server.bans)) {
            for (const ban of server.bans) {
              records.push({
                id: `${server.id}_${ban.userId}`,
                serverId: server.id,
                userId: ban.userId,
                reason: ban.reason,
                bannedBy: ban.bannedBy,
                bannedAt: ban.bannedAt
              })
            }
          }
        }
      }
      break

    case 'json_blob':
      // Store entire data as a single JSON blob
      // Used for: e2e_keys, bots, etc.
      records = [{ id: tableName, data: JSON.stringify(tableData) }]
      break

    default:
      // Fallback to object format
      if (Array.isArray(tableData)) {
        records = tableData
      } else if (typeof tableData === 'object') {
        for (const [key, value] of Object.entries(tableData)) {
          if (typeof value === 'object' && value !== null) {
            records.push({ id: key, ...value })
          } else {
            records.push({ id: key, data: value })
          }
        }
      }
  }

  if (records.length === 0) {
    console.log(`[Storage] No records to insert for ${tableName}`)
    return 0
  }

  console.log(`[Storage] Prepared ${records.length} records for ${tableName}`)

  const primaryKey = schema?.primaryKey || 'id'
  
  if (storage.type === 'sqlite') {
    // Check if table exists
    const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName)
    if (!tableCheck) {
      // Create table if it doesn't exist
      const columns = schema?.columns || ['id', 'data']
      const columnDefs = columns.map(col => {
        if (col === 'id' || col === schema?.primaryKey) {
          return `${col} TEXT PRIMARY KEY`
        }
        return `${col} TEXT`
      }).join(', ')
      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs})`)
    }

    // Get existing IDs to avoid duplicates
    const existingIds = new Set()
    try {
      const existingRows = db.prepare(`SELECT ${primaryKey} FROM ${tableName}`).all()
      for (const row of existingRows) {
        if (row[primaryKey]) existingIds.add(row[primaryKey])
      }
    } catch {
      // Table might be empty or have different structure
    }

    // Insert records (only new ones)
    const columns = schema?.columns || ['id', 'data']
    const placeholders = columns.map(() => '?').join(', ')
    const insertStmt = db.prepare(`INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`)

    for (const record of records) {
      const recordId = record[primaryKey] || record.id
      if (recordId && existingIds.has(recordId)) {
        // Record already exists, skip it
        continue
      }
      try {
        const values = columns.map(col => normalizeSqlValue(record[col]))
        insertStmt.run(values)
        count++
      } catch (err) {
        console.error(`[Storage] Error inserting record into ${tableName}:`, err.message)
      }
    }
    
    if (count > 0) {
      console.log(`[Storage] ${tableName}: inserted ${count} new records, skipped ${records.length - count} existing`)
    } else {
      console.log(`[Storage] ${tableName}: all ${records.length} records already exist, skipped`)
    }
  } else if (storage.type === 'mysql' || storage.type === 'mariadb') {
    const conn = await storage.pool.getConnection()
    try {
      // Check if table exists
      const [tables] = await conn.query(`SHOW TABLES LIKE ?`, [tableName])
      if (tables.length === 0) {
        // Create table if it doesn't exist
        const columns = schema?.columns || ['id', 'data']
        const columnDefs = columns.map(col => {
          if (col === 'id' || col === schema?.primaryKey) {
            return `${col} VARCHAR(255) PRIMARY KEY`
          }
          return `${col} TEXT`
        }).join(', ')
        await conn.query(`CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs})`)
      }

      // Get existing IDs to avoid duplicates
      const existingIds = new Set()
      try {
        const [existingRows] = await conn.query(`SELECT ${primaryKey} FROM ${tableName}`)
        for (const row of existingRows) {
          if (row[primaryKey]) existingIds.add(row[primaryKey])
        }
      } catch {
        // Table might be empty or have different structure
      }

      // Insert records (only new ones)
      const columns = schema?.columns || ['id', 'data']
      const placeholders = columns.map(() => '?').join(', ')
      const updateSet = columns.filter(c => c !== 'id' && c !== schema?.primaryKey).map(c => `${c} = VALUES(${c})`).join(', ')
      const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateSet || 'id = id'}`

      for (const record of records) {
        const recordId = record[primaryKey] || record.id
        if (recordId && existingIds.has(recordId)) {
          // Record already exists, skip it
          continue
        }
        try {
          const values = columns.map(col => normalizeSqlValue(record[col]))
          await conn.query(insertSql, values)
          count++
        } catch (err) {
          console.error(`[Storage] Error inserting record into ${tableName}:`, err.message)
        }
      }
      
      if (count > 0) {
        console.log(`[Storage] ${tableName}: inserted ${count} new records, skipped ${records.length - count} existing`)
      } else {
        console.log(`[Storage] ${tableName}: all ${records.length} records already exist, skipped`)
      }
    } finally {
      conn.release()
    }
  }

  return count
}

export const FILES = {
  users: 'users',
  friends: 'friends',
  friendRequests: 'friend_requests',
  servers: 'servers',
  channels: 'channels',
  messages: 'messages',
  serverMembers: 'server_members',
  invites: 'invites',
  dms: 'dms',
  dmMessages: 'dm_messages',
  reactions: 'reactions',
  blocked: 'blocked',
  files: 'files',
  attachments: 'attachments',
  discovery: 'discovery',
  globalBans: 'global_bans',
  serverBans: 'server_bans',
  adminLogs: 'admin_logs',
  moderationReports: 'moderation_reports'
}

export const getServers = () => {
  const store = getStorage()
  return store ? store.load('servers', {}) : {}
}

export const setServers = (servers) => {
  const store = getStorage()
  return store ? store.save('servers', servers) : false
}

export const getAllChannels = () => {
  const store = getStorage()
  return store ? store.load('channels', {}) : {}
}

export const setAllChannels = (channels) => {
  const store = getStorage()
  return store ? store.save('channels', channels) : false
}

export const getAllCategories = () => {
  const store = getStorage()
  return store ? store.load('categories', {}) : {}
}

export const setAllCategories = (categories) => {
  const store = getStorage()
  return store ? store.save('categories', categories) : false
}

export default {
  initStorage,
  initStorageAndDistribute,
  resetStorage,
  getStorage,
  distributeFromStorageKv,
  checkStorageKvExists,
  TABLE_SCHEMAS,
  FILES,
  getServers,
  setServers,
  getAllChannels,
  setAllChannels,
  getAllCategories,
  setAllCategories
}
