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
  'admin_logs'
]

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
      adminLogs: path.join(dataDir, 'admin-logs.json')
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
      host TEXT,
      createdAt TEXT,
      updatedAt TEXT
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
      topic TEXT,
      position INTEGER,
      createdAt TEXT
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
      dmId TEXT NOT NULL,
      senderId TEXT NOT NULL,
      content TEXT,
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
  `)
  
  console.log('[Storage] SQLite initialized:', dbPath)
  
  return {
    type: 'sqlite',
    provider: 'sqlite',
    db,
    load(table, defaultValue = {}) {
      try {
        // First, try to load from individual table (after distribution)
        const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        if (tableCheck) {
          const rows = db.prepare(`SELECT * FROM ${table}`).all()
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
          const kvRow = kvStmt.get(table)
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
      try {
        // Check if individual table exists
        const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        
        if (tableCheck) {
          // Save to individual table
          const schema = TABLE_SCHEMAS[table]
          const columns = schema?.columns || ['id', 'data']
          
          // Clear existing data and insert new
          db.exec(`DELETE FROM ${table}`)
          
          if (typeof data === 'object' && data !== null) {
            const placeholders = columns.map(() => '?').join(', ')
            const insertStmt = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
            
            for (const [key, value] of Object.entries(data)) {
              try {
                const record = typeof value === 'object' ? { id: key, ...value } : { id: key, data: value }
                const values = columns.map(col => {
                  const val = record[col]
                  if (val === undefined || val === null) return null
                  if (typeof val === 'object') return JSON.stringify(val)
                  return String(val)
                })
                insertStmt.run(values)
              } catch (err) {
                console.error(`[Storage] Error inserting record into ${table}:`, err.message)
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
          upsert.run(table, JSON.stringify(data ?? {}))
          return true
        } catch {
          // storage_kv might not exist after distribution, create it temporarily
          db.exec(`CREATE TABLE IF NOT EXISTS storage_kv (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
          const upsert = db.prepare(`
            INSERT INTO storage_kv (id, data) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data
          `)
          upsert.run(table, JSON.stringify(data ?? {}))
          return true
        }
      } catch (err) {
        console.error(`[Storage] Error saving ${table}:`, err.message)
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
            host VARCHAR(255),
            createdAt TEXT,
            updatedAt TEXT
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
            topic TEXT,
            position INTEGER,
            createdAt TEXT,
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
            conversationId VARCHAR(255) NOT NULL,
            authorId VARCHAR(255) NOT NULL,
            content TEXT,
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
        try {
          await ready
          
          // First, try to load from individual table
          try {
            const [rows] = await pool.execute(`SELECT * FROM ${table}`)
            if (rows.length > 0) {
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
            const [kvRows] = await pool.execute('SELECT data FROM storage_kv WHERE id = ? LIMIT 1', [table])
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
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          await ready
          const conn = await pool.getConnection()
          try {
            // Check if individual table exists
            const [tables] = await conn.query(`SHOW TABLES LIKE ?`, [table])
            
            if (tables.length > 0) {
              // Save to individual table
              const schema = TABLE_SCHEMAS[table]
              const columns = schema?.columns || ['id', 'data']
              
              // Clear existing data and insert new
              await conn.execute(`DELETE FROM ${table}`)
              
              if (typeof data === 'object' && data !== null) {
                const placeholders = columns.map(() => '?').join(', ')
                const updateSet = columns.filter(c => c !== 'id' && c !== schema?.primaryKey).map(c => `${c} = VALUES(${c})`).join(', ')
                const insertSql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateSet || 'id = id'}`
                
                for (const [key, value] of Object.entries(data)) {
                  try {
                    const record = typeof value === 'object' ? { id: key, ...value } : { id: key, data: value }
                    const values = columns.map(col => {
                      const val = record[col]
                      if (val === undefined || val === null) return null
                      if (typeof val === 'object') return JSON.stringify(val)
                      return String(val)
                    })
                    await conn.execute(insertSql, values)
                  } catch (err) {
                    console.error(`[Storage] Error inserting record into ${table}:`, err.message)
                  }
                }
              }
              return true
            }
            
            // Fall back to storage_kv for tables without individual schemas
            try {
              await conn.execute(
                `INSERT INTO storage_kv (id, data) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE data = VALUES(data)`,
                [table, JSON.stringify(data ?? {})]
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
            status VARCHAR(50) DEFAULT 'offline',
            socialLinks TEXT,
            ageVerification TEXT,
            host VARCHAR(255),
            createdAt TEXT,
            updatedAt TEXT
          )
        `)
        
        // Fix existing tables with wrong column types
        try {
          await conn.query(`ALTER TABLE users MODIFY COLUMN ageVerification TEXT`)
        } catch {
          // Column might already be correct or table doesn't exist yet
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
            updatedAt TEXT
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
          CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(255) PRIMARY KEY,
            channelId VARCHAR(255) NOT NULL,
            authorId VARCHAR(255) NOT NULL,
            content TEXT,
            type VARCHAR(50) DEFAULT 'text',
            createdAt TEXT,
            updatedAt TEXT
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
        try {
          await ready
          
          // First, try to load from individual table
          try {
            const rows = await pool.query(`SELECT * FROM ${table}`)
            if (rows.length > 0) {
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
            const kvRows = await pool.query('SELECT data FROM storage_kv WHERE id = ? LIMIT 1', [table])
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
          console.error(`[Storage] Error loading ${table}:`, err.message)
          return defaultValue
        }
      },
      save: async (table, data) => {
        try {
          await ready
          const conn = await pool.getConnection()
          try {
            // Check if individual table exists
            const tables = await conn.query(`SHOW TABLES LIKE ?`, [table])
            
            if (tables.length > 0) {
              // Save to individual table
              const schema = TABLE_SCHEMAS[table]
              const columns = schema?.columns || ['id', 'data']
              
              // Clear existing data and insert new
              await conn.query(`DELETE FROM ${table}`)
              
              if (typeof data === 'object' && data !== null) {
                const placeholders = columns.map(() => '?').join(', ')
                const updateSet = columns.filter(c => c !== 'id' && c !== schema?.primaryKey).map(c => `${c} = VALUES(${c})`).join(', ')
                const insertSql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateSet || 'id = id'}`
                
                for (const [key, value] of Object.entries(data)) {
                  try {
                    const record = typeof value === 'object' ? { id: key, ...value } : { id: key, data: value }
                    const values = columns.map(col => {
                      const val = record[col]
                      if (val === undefined || val === null) return null
                      if (typeof val === 'object') return JSON.stringify(val)
                      return String(val)
                    })
                    await conn.query(insertSql, values)
                  } catch (err) {
                    console.error(`[Storage] Error inserting record into ${table}:`, err.message)
                  }
                }
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
  let client
  try {
    const { Client } = require('pg')
    const storageConfig = config.config.storage.postgres
    
    const connectionConfig = {
      host: storageConfig.host || 'localhost',
      port: storageConfig.port || 5432,
      database: storageConfig.database || 'voltchat',
      user: storageConfig.user || 'postgres',
      password: storageConfig.password || ''
    }
    
    if (storageConfig.connectionString) {
      connectionConfig.connectionString = storageConfig.connectionString
    }
    
    if (storageConfig.ssl) {
      connectionConfig.ssl = { rejectUnauthorized: false }
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
    }
    
    createTables().catch(err => {
      console.error('[Storage] Error creating PostgreSQL tables:', err.message)
    })
    
    console.log('[Storage] PostgreSQL client created')
    
    return {
      type: 'postgres',
      provider: 'postgres',
      client,
      load: async (table, defaultValue = {}) => {
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
    columns: ['id', 'username', 'displayName', 'email', 'passwordHash', 'authProvider', 'avatar', 'banner', 'bio', 'customStatus', 'status', 'socialLinks', 'ageVerification', 'host', 'createdAt', 'updatedAt'],
    dataFormat: 'object' // { userId: { ...userData } }
  },
  servers: {
    primaryKey: 'id',
    columns: ['id', 'name', 'description', 'icon', 'banner', 'ownerId', 'createdAt', 'updatedAt', 'themeColor', 'bannerUrl', 'roles', 'members', 'bans', 'emojis', 'backgroundUrl'],
    dataFormat: 'array' // [{ ...serverData }]
  },
  channels: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'name', 'type', 'topic', 'position', 'createdAt', 'isDefault', 'slowMode', 'nsfw', 'updatedAt', 'categoryId'],
    dataFormat: 'nested_array' // { serverId: [{ ...channelData }] }
  },
  messages: {
    primaryKey: 'id',
    columns: ['id', 'channelId', 'authorId', 'content', 'type', 'createdAt', 'updatedAt', 'mentions', 'attachments', 'embeds', 'replyTo', 'edited', 'editedAt', 'username', 'avatar', 'storage', 'encrypted', 'iv', 'epoch', 'bot', 'timestamp'],
    dataFormat: 'messages' // { channelId: [{ ...messageData }] }
  },
  friends: {
    primaryKey: null, // Composite key
    columns: ['userId', 'friendId', 'createdAt'],
    dataFormat: 'friends_list' // { userId: [friendId1, friendId2] }
  },
  friend_requests: {
    primaryKey: 'id',
    columns: ['id', 'fromUserId', 'toUserId', 'fromUsername', 'toUsername', 'createdAt', 'direction'],
    dataFormat: 'friend_requests' // { incoming: { userId: [...] }, outgoing: { userId: [...] } }
  },
  dms: {
    primaryKey: 'id',
    columns: ['id', 'type', 'createdAt', 'participants'],
    dataFormat: 'nested_array' // { userId: [{ ...dmData }] }
  },
  dm_messages: {
    primaryKey: 'id',
    columns: ['id', 'dmId', 'senderId', 'content', 'createdAt'],
    dataFormat: 'nested_array' // { dmId: [{ ...messageData }] }
  },
  reactions: {
    primaryKey: 'id',
    columns: ['id', 'messageId', 'emoji', 'userIds', 'createdAt'],
    dataFormat: 'reactions' // { messageId: { emoji: [userIds] } }
  },
  blocked: {
    primaryKey: null, // Composite key
    columns: ['userId', 'blockedUserId', 'createdAt'],
    dataFormat: 'nested_array' // { userId: [blockedId1, ...] }
  },
  files: {
    primaryKey: 'id',
    columns: ['id', 'name', 'type', 'mimetype', 'size', 'sizeBytes', 'url', 'filename', 'uploadedAt', 'uploadedBy', 'path', 'createdAt'],
    dataFormat: 'object' // { fileId: { ...fileData } }
  },
  attachments: {
    primaryKey: 'id',
    columns: ['id', 'messageId', 'fileId', 'createdAt'],
    dataFormat: 'object'
  },
  discovery: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'name', 'icon', 'description', 'category', 'memberCount', 'submittedBy', 'submittedAt', 'status', 'approvedAt'],
    dataFormat: 'discovery' // { submissions: [...], approved: [...] }
  },
  global_bans: {
    primaryKey: 'id',
    columns: ['id', 'userId', 'reason', 'bannedBy', 'expiresAt', 'createdAt'],
    dataFormat: 'object'
  },
  server_bans: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'userId', 'reason', 'bannedBy', 'bannedAt'],
    dataFormat: 'server_bans' // Embedded in servers, extracted
  },
  admin_logs: {
    primaryKey: 'id',
    columns: ['id', 'action', 'adminId', 'targetId', 'targetType', 'details', 'createdAt'],
    dataFormat: 'array' // [{ ...logData }]
  },
  invites: {
    primaryKey: 'code',
    columns: ['code', 'serverId', 'createdBy', 'uses', 'maxUses', 'expiresAt', 'createdAt'],
    dataFormat: 'nested_array' // { serverId: [{ ...inviteData }] }
  },
  server_members: {
    primaryKey: null, // Composite key
    columns: ['serverId', 'userId', 'roles', 'joinedAt'],
    dataFormat: 'object'
  },
  pinned_messages: {
    primaryKey: 'id',
    columns: ['id', 'channelId', 'userId', 'username', 'avatar', 'content', 'timestamp', 'pinnedAt', 'pinnedBy'],
    dataFormat: 'pinned_messages' // { channelId: [pinnedMsgs] }
  },
  categories: {
    primaryKey: 'id',
    columns: ['id', 'serverId', 'name', 'position', 'createdAt'],
    dataFormat: 'categories' // { serverId: [categories] }
  },
  call_logs: {
    primaryKey: 'id',
    columns: ['id', 'dmId', 'callId', 'participants', 'startedAt', 'endedAt', 'duration'],
    dataFormat: 'nested_array' // { dmId: [callLogs] }
  },
  // Additional tables that may be in storage_kv - stored as JSON blobs
  e2e_keys: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  e2e_true: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  system_messages: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  self_volts: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  federation: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  server_start: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' },
  bots: { primaryKey: 'id', columns: ['id', 'data'], dataFormat: 'json_blob' }
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
        const values = columns.map(col => {
          const val = record[col]
          if (val === undefined || val === null) return null
          if (typeof val === 'object') return JSON.stringify(val)
          return String(val)
        })
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
          const values = columns.map(col => {
            const val = record[col]
            if (val === undefined || val === null) return null
            if (typeof val === 'object') return JSON.stringify(val)
            return String(val)
          })
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
  adminLogs: 'admin_logs'
}

export default {
  initStorage,
  initStorageAndDistribute,
  resetStorage,
  getStorage,
  distributeFromStorageKv,
  checkStorageKvExists,
  TABLE_SCHEMAS,
  FILES
}
