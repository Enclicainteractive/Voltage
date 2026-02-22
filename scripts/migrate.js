import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import config from '../config/config.js'
import readline from 'readline'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')

const JSON_FILE_TO_TABLE = {
  'users.json': 'users',
  'friends.json': 'friends',
  'friend-requests.json': 'friend_requests',
  'dms.json': 'dms',
  'dm-messages.json': 'dm_messages',
  'servers.json': 'servers',
  'channels.json': 'channels',
  'messages.json': 'messages',
  'reactions.json': 'reactions',
  'server-invites.json': 'invites',
  'blocked.json': 'blocked',
  'files.json': 'files',
  'attachments.json': 'attachments',
  'discovery.json': 'discovery',
  'global-bans.json': 'global_bans',
  'admin-logs.json': 'admin_logs'
}
const JSON_FILES = Object.keys(JSON_FILE_TO_TABLE)
const TABLE_TO_JSON_FILE = Object.fromEntries(
  Object.entries(JSON_FILE_TO_TABLE).map(([file, table]) => [table, file])
)

const STORAGE_TYPES = {
  json: { name: 'JSON Files', color: '\x1b[34m' },
  sqlite: { name: 'SQLite', color: '\x1b[36m' },
  mysql: { name: 'MySQL', color: '\x1b[35m' },
  mariadb: { name: 'MariaDB', color: '\x1b[33m' },
  postgres: { name: 'PostgreSQL', color: '\x1b[32m' },
  cockroachdb: { name: 'CockroachDB', color: '\x1b[35m' },
  mssql: { name: 'SQL Server', color: '\x1b[31m' },
  mongodb: { name: 'MongoDB', color: '\x1b[32m' },
  redis: { name: 'Redis', color: '\x1b[31m' }
}

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const ask = (question) => new Promise(resolve => rl.question(question, resolve))

class MigrationManager {
  constructor() {
    this.data = null
  }

  log(message, type = 'info') {
    const colors = {
      info: '\x1b[36m',
      success: '\x1b[32m',
      warning: '\x1b[33m',
      error: '\x1b[31m',
      header: '\x1b[1;34m'
    }
    console.log(`${colors[type] || ''}${message}${RESET}`)
  }

  logHeader(text) {
    console.log(`\n${BOLD}${text}${RESET}`)
    console.log('='.repeat(text.length))
  }

  async loadJsonData(dataDir) {
    const data = {}
    for (const file of JSON_FILES) {
      const table = JSON_FILE_TO_TABLE[file] || file.replace('.json', '')
      const filePath = path.join(dataDir, file)
      try {
        if (fs.existsSync(filePath)) {
          data[table] = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        } else {
          data[table] = {}
        }
      } catch (e) {
        console.error(`Error loading ${file}: ${e.message}`)
        data[table] = {}
      }
    }
    return data
  }

  async saveJsonData(dataDir, data) {
    for (const [key, value] of Object.entries(data)) {
      const fileName = TABLE_TO_JSON_FILE[key] || `${key}.json`
      const filePath = path.join(dataDir, fileName)
      try {
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
      } catch (e) {
        console.error(`Error saving ${key}: ${e.message}`)
      }
    }
  }

  async createBackup(targetDir) {
    this.logHeader('Creating Backup')
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(targetDir, `backup-${timestamp}`)
    
    fs.mkdirSync(backupDir, { recursive: true })
    
    const currentType = config.config.storage?.type || 'json'
    this.log(`Current storage type: ${currentType}`)
    
    if (currentType === 'json') {
      const sourceDir = config.config.storage.json?.dataDir || DATA_DIR
      for (const file of JSON_FILES) {
        const sourcePath = path.join(sourceDir, file)
        if (fs.existsSync(sourcePath)) {
          fs.copyFileSync(sourcePath, path.join(backupDir, file))
          this.log(`  Backed up: ${file}`, 'success')
        }
      }
    } else if (currentType === 'sqlite') {
      const dbPath = config.config.storage.sqlite?.dbPath || path.join(DATA_DIR, 'voltage.db')
      if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, path.join(backupDir, 'voltage.db'))
        this.log('  Backed up: voltage.db', 'success')
      }
    }
    
    const configPath = path.join(__dirname, '..', 'config.json')
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, path.join(backupDir, 'config.json'))
      this.log('  Backed up: config.json', 'success')
    }
    
    this.log(`Backup created at: ${backupDir}`, 'success')
    return backupDir
  }

  async getSourceData() {
    const currentType = config.config.storage?.type || 'json'
    this.log(`Loading data from ${currentType}...`)
    
    if (currentType === 'json') {
      const dataDir = config.config.storage.json?.dataDir || DATA_DIR
      this.data = await this.loadJsonData(dataDir)
    } else if (currentType === 'sqlite') {
      let Database
      try {
        Database = require('better-sqlite3')
      } catch (e) {
        throw new Error('better-sqlite3 not installed')
      }
      
      const dbPath = config.config.storage.sqlite?.dbPath || path.join(DATA_DIR, 'voltage.db')
      const db = new Database(dbPath)
      
      this.data = {}
      const tables = [
        'users', 'friends', 'friend_requests', 'dms', 'dm_messages',
        'servers', 'channels', 'messages', 'reactions', 'invites',
        'blocked', 'files', 'attachments', 'discovery', 'global_bans', 'admin_logs'
      ]
      
      for (const table of tables) {
        try {
          const rows = db.prepare(`SELECT * FROM ${table}`).all()
          this.data[table] = {}
          for (const row of rows) {
            try {
              this.data[table][row.id] = JSON.parse(row.data)
            } catch {
              this.data[table][row.id] = row.data
            }
          }
          this.log(`  Loaded ${Object.keys(this.data[table]).length} records from ${table}`)
        } catch (e) {
          this.log(`  Table ${table} not found`, 'warning')
        }
      }
      
      db.close()
    } else {
      throw new Error(`Migration from ${currentType} not yet supported. Please export to JSON first.`)
    }
    
    let totalRecords = 0
    for (const key of Object.keys(this.data)) {
      totalRecords += Object.keys(this.data[key]).length
    }
    this.log(`Total records loaded: ${totalRecords}`, 'success')
  }

  async migrateToJson(targetDir) {
    this.logHeader('Migrating to JSON')
    
    fs.mkdirSync(targetDir, { recursive: true })
    
    const tableToFile = {
      users: 'users',
      friends: 'friends',
      friend_requests: 'friend-requests',
      dms: 'dms',
      dm_messages: 'dm-messages',
      servers: 'servers',
      channels: 'channels',
      messages: 'messages',
      reactions: 'reactions',
      invites: 'server-invites',
      blocked: 'blocked',
      files: 'files',
      attachments: 'attachments',
      discovery: 'discovery',
      global_bans: 'global-bans',
      admin_logs: 'admin-logs'
    }
    
    for (const [tableName, records] of Object.entries(this.data)) {
      const fileName = tableToFile[tableName] || tableName
      const filePath = path.join(targetDir, `${fileName}.json`)
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2))
      this.log(`  Saved ${Object.keys(records).length} records to ${fileName}.json`, 'success')
    }
    
    this.log('JSON migration complete!', 'success')
  }

  async migrateToSqlite(targetDbPath) {
    this.logHeader('Migrating to SQLite')
    
    let Database
    try {
      Database = require('better-sqlite3')
    } catch (e) {
      throw new Error('better-sqlite3 not installed. Run: npm install better-sqlite3')
    }
    
    const dbDir = path.dirname(targetDbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    
    const db = new Database(targetDbPath)
    
    const tables = [
      'users', 'friends', 'friend_requests', 'dms', 'dm_messages',
      'servers', 'channels', 'messages', 'reactions', 'invites',
      'blocked', 'files', 'attachments', 'discovery', 'global_bans', 'admin_logs'
    ]
    
    for (const table of tables) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT)`)
    }
    
    const insertStmt = {}
    for (const table of tables) {
      insertStmt[table] = db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)
    }
    
    for (const [tableName, records] of Object.entries(this.data)) {
      const table = tableName
      if (!insertStmt[table]) continue
      
      const transaction = db.transaction(() => {
        for (const [id, data] of Object.entries(records)) {
          insertStmt[table].run(id, JSON.stringify(data))
        }
      })
      transaction()
      
      this.log(`  Migrated ${Object.keys(records).length} records to ${table}`, 'success')
    }
    
    db.close()
    this.log('SQLite migration complete!', 'success')
  }

  async migrateToMysql(configObj) {
    this.logHeader('Migrating to MySQL')
    
    let mysql
    try {
      mysql = require('mysql2/promise')
    } catch (e) {
      throw new Error('mysql2 not installed. Run: npm install mysql2')
    }
    
    const pool = mysql.createPool({
      host: configObj.host,
      port: configObj.port || 3306,
      database: configObj.database,
      user: configObj.user,
      password: configObj.password,
      connectionLimit: configObj.connectionLimit || 10
    })
    
    const tables = Object.keys(this.data)
    
    for (const table of tables) {
      const conn = await pool.getConnection()
      try {
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS ${table} (
            id VARCHAR(255) PRIMARY KEY,
            data TEXT
          )
        `)
        
        await conn.execute(`DELETE FROM ${table}`)
        
        const records = this.data[table]
        for (const [id, data] of Object.entries(records)) {
          await conn.execute(
            `INSERT INTO ${table} (id, data) VALUES (?, ?)`,
            [id, JSON.stringify(data)]
          )
        }
        
        this.log(`  Migrated ${Object.keys(records).length} records to ${table}`, 'success')
      } finally {
        conn.release()
      }
    }
    
    await pool.end()
    this.log('MySQL migration complete!', 'success')
  }

  async migrateToPostgres(configObj) {
    this.logHeader('Migrating to PostgreSQL')
    
    let pg
    try {
      pg = require('pg')
    } catch (e) {
      throw new Error('pg not installed. Run: npm install pg')
    }
    
    const client = new pg.Client({
      host: configObj.host,
      port: configObj.port || 5432,
      database: configObj.database,
      user: configObj.user,
      password: configObj.password
    })
    
    await client.connect()
    
    const tables = Object.keys(this.data)
    
    for (const table of tables) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id VARCHAR(255) PRIMARY KEY,
          data TEXT
        )
      `)
      
      await client.query(`DELETE FROM ${table}`)
      
      const records = this.data[table]
      for (const [id, data] of Object.entries(records)) {
        await client.query(
          `INSERT INTO ${table} (id, data) VALUES ($1, $2)`,
          [id, JSON.stringify(data)]
        )
      }
      
      this.log(`  Migrated ${Object.keys(records).length} records to ${table}`, 'success')
    }
    
    await client.end()
    this.log('PostgreSQL migration complete!', 'success')
  }

  async migrateToMongodb(configObj) {
    this.logHeader('Migrating to MongoDB')
    
    let mongo
    try {
      mongo = require('mongodb')
    } catch (e) {
      throw new Error('mongodb not installed. Run: npm install mongodb')
    }
    
    const uri = configObj.connectionString || 
      `mongodb://${configObj.host}:${configObj.port || 27017}/${configObj.database}`
    
    const client = new mongo.MongoClient(uri)
    await client.connect()
    
    const db = client.db(configObj.database)
    
    const tables = Object.keys(this.data)
    
    for (const table of tables) {
      const collection = db.collection(table)
      await collection.deleteMany({})
      
      const records = this.data[table]
      const bulkOps = []
      
      for (const [id, data] of Object.entries(records)) {
        bulkOps.push({
          replaceOne: {
            filter: { _id: id },
            replacement: { _id: id, ...data },
            upsert: true
          }
        })
      }
      
      if (bulkOps.length > 0) {
        await collection.bulkWrite(bulkOps)
      }
      
      this.log(`  Migrated ${Object.keys(records).length} records to ${table}`, 'success')
    }
    
    await client.close()
    this.log('MongoDB migration complete!', 'success')
  }

  async migrateToRedis(configObj) {
    this.logHeader('Migrating to Redis')
    
    let redis
    try {
      redis = require('redis')
    } catch (e) {
      throw new Error('redis not installed. Run: npm install redis')
    }
    
    const client = redis.createClient({
      socket: {
        host: configObj.host,
        port: configObj.port || 6379
      },
      password: configObj.password || undefined
    })
    
    await client.connect()
    
    const prefix = configObj.keyPrefix || 'voltchat:'
    const tables = Object.keys(this.data)
    
    for (const table of tables) {
      const records = this.data[table]
      
      for (const [id, data] of Object.entries(records)) {
        await client.set(`${prefix}${table}:${id}`, JSON.stringify(data))
      }
      
      this.log(`  Migrated ${Object.keys(records).length} records to ${prefix}${table}:*`, 'success')
    }
    
    await client.quit()
    this.log('Redis migration complete!', 'success')
  }

  getStorageTypeConfig(type) {
    return config.config.storage?.[type] || {}
  }

  async showStatus() {
    this.logHeader('Storage Status')
    
    const currentType = config.config.storage?.type || 'json'
    const typeInfo = STORAGE_TYPES[currentType] || { name: currentType, color: '\x1b[33m' }
    
    console.log(`Current Storage: ${typeInfo.color}${typeInfo.name}${RESET}`)
    
    if (currentType === 'json') {
      const dataDir = config.config.storage.json?.dataDir || DATA_DIR
      console.log(`Data Directory: ${dataDir}`)
      
      let totalFiles = 0
      let totalRecords = 0
      
      for (const file of JSON_FILES) {
        const filePath = path.join(dataDir, file)
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
          totalFiles++
          totalRecords += Object.keys(data).length
        }
      }
      
      console.log(`Files: ${totalFiles}`)
      console.log(`Total Records: ${totalRecords}`)
      
    } else if (currentType === 'sqlite') {
      const dbPath = config.config.storage.sqlite?.dbPath || path.join(DATA_DIR, 'voltage.db')
      console.log(`Database: ${dbPath}`)
      
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath)
        console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`)
      }
    }
    
    console.log(`\nConfig Location: ${path.join(__dirname, '..', 'config.json')}`)
  }

  generateConfigJson(targetType, targetConfig) {
    const configObj = {
      storage: {
        type: targetType
      }
    }
    
    if (targetType !== 'json') {
      configObj.storage[targetType] = targetConfig
    } else {
      configObj.storage.json = { dataDir: './data' }
    }
    
    return JSON.stringify(configObj, null, 2)
  }

  async interactiveMigrate() {
    this.logHeader('VoltChat Database Migration')
    console.log(`
This tool will help you migrate your data between different database types.
A backup will be created automatically before migration.
    `)
    
    const currentType = config.config.storage?.type || 'json'
    console.log(`Current database: ${STORAGE_TYPES[currentType]?.name || currentType}\n`)
    
    this.logHeader('Available Database Types')
    const types = Object.entries(STORAGE_TYPES)
    types.forEach(([key, info], index) => {
      const marker = key === currentType ? ' [CURRENT]' : ''
      console.log(`  ${index + 1}. ${info.name}${marker}`)
    })
    
    let targetType
    while (true) {
      const answer = await ask('\nSelect target database (number): ')
      const index = parseInt(answer) - 1
      if (index >= 0 && index < types.length) {
        targetType = types[index][0]
        if (targetType === currentType) {
          this.log('Already using this database type. Please select a different one.', 'warning')
        } else {
          break
        }
      } else {
        this.log('Invalid selection. Please try again.', 'error')
      }
    }
    
    this.log(`\nSelected: ${STORAGE_TYPES[targetType].name}`, 'success')
    
    let targetConfig = {}
    
    if (targetType === 'json') {
      const dataDir = await ask('Enter data directory (default: ./data): ')
      targetConfig = { dataDir: dataDir || './data' }
    } else if (targetType === 'sqlite') {
      const dbPath = await ask('Enter database file path (default: ./data/voltage.db): ')
      targetConfig = { dbPath: dbPath || './data/voltage.db' }
    } else if (targetType === 'mysql' || targetType === 'mariadb') {
      console.log('\nMySQL/MariaDB Configuration:')
      targetConfig = {
        host: await ask('Host (default: localhost): ') || 'localhost',
        port: parseInt(await ask('Port (default: 3306): ')) || 3306,
        database: await ask('Database name: ') || 'voltchat',
        user: await ask('Username (default: root): ') || 'root',
        password: await ask('Password: ') || '',
        connectionLimit: parseInt(await ask('Connection limit (default: 10): ')) || 10
      }
    } else if (targetType === 'postgres' || targetType === 'cockroachdb') {
      console.log('\nPostgreSQL/CockroachDB Configuration:')
      targetConfig = {
        host: await ask('Host (default: localhost): ') || 'localhost',
        port: parseInt(await ask(`Port (default: ${targetType === 'cockroachdb' ? 26257 : 5432}): `)) || (targetType === 'cockroachdb' ? 26257 : 5432),
        database: await ask('Database name: ') || 'voltchat',
        user: await ask('Username (default: postgres): ') || 'postgres',
        password: await ask('Password: ') || '',
        ssl: (await ask('Use SSL? (y/N): ')).toLowerCase() === 'y'
      }
    } else if (targetType === 'mongodb') {
      console.log('\nMongoDB Configuration:')
      targetConfig = {
        host: await ask('Host (default: localhost): ') || 'localhost',
        port: parseInt(await ask('Port (default: 27017): ')) || 27017,
        database: await ask('Database name: ') || 'voltchat',
        user: await ask('Username (leave empty for no auth): ') || '',
        password: await ask('Password: ') || '',
        authSource: await ask('Auth source (default: admin): ') || 'admin'
      }
    } else if (targetType === 'redis') {
      console.log('\nRedis Configuration:')
      targetConfig = {
        host: await ask('Host (default: localhost): ') || 'localhost',
        port: parseInt(await ask('Port (default: 6379): ')) || 6379,
        password: await ask('Password (leave empty for no auth): ') || '',
        db: parseInt(await ask('Database number (default: 0): ')) || 0,
        keyPrefix: await ask('Key prefix (default: voltchat:): ') || 'voltchat:'
      }
    }
    
    console.log('\n')
    const confirm = await ask(`Migrate from ${STORAGE_TYPES[currentType].name} to ${STORAGE_TYPES[targetType].name}? (y/N): `)
    
    if (confirm.toLowerCase() !== 'y') {
      this.log('Migration cancelled.', 'warning')
      rl.close()
      return
    }
    
    try {
      await this.createBackup(path.dirname(DATA_DIR))
      
      await this.getSourceData()
      
      if (targetType === 'json') {
        await this.migrateToJson(targetConfig.dataDir)
      } else if (targetType === 'sqlite') {
        await this.migrateToSqlite(targetConfig.dbPath)
      } else if (targetType === 'mysql' || targetType === 'mariadb') {
        await this.migrateToMysql(targetConfig)
      } else if (targetType === 'postgres' || targetType === 'cockroachdb') {
        await this.migrateToPostgres(targetConfig)
      } else if (targetType === 'mongodb') {
        await this.migrateToMongodb(targetConfig)
      } else if (targetType === 'redis') {
        await this.migrateToRedis(targetConfig)
      }
      
      console.log('\n')
      this.logHeader('Migration Complete!')
      console.log('\nTo use the new database, update your config.json:')
      console.log(this.generateConfigJson(targetType, targetConfig))
      
    } catch (e) {
      this.log(`Migration failed: ${e.message}`, 'error')
      console.error(e)
    }
    
    rl.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  
  config.load()
  
  const migration = new MigrationManager()
  
  switch (command) {
    case 'interactive':
    case 'migrate':
      await migration.interactiveMigrate()
      break
      
    case 'status':
      await migration.showStatus()
      break
      
    case 'backup': {
      const targetDir = args[1] || path.dirname(DATA_DIR)
      await migration.createBackup(targetDir)
      break
    }
    
    case 'json-to-sqlite': {
      const sourceDir = args[1] || path.join(DATA_DIR)
      const targetDb = args[2] || path.join(DATA_DIR, 'voltage.db')
      await migration.createBackup(path.dirname(DATA_DIR))
      migration.data = await migration.loadJsonData(sourceDir)
      await migration.migrateToSqlite(targetDb)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('sqlite', { dbPath: targetDb }))
      break
    }
    
    case 'sqlite-to-json': {
      const sourceDb = args[1] || path.join(DATA_DIR, 'voltage.db')
      const targetDir = args[2] || path.join(DATA_DIR, 'json-migrated')
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToJson(targetDir)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('json', { dataDir: targetDir }))
      break
    }
    
    case 'to-json': {
      const targetDir = args[1] || path.join(DATA_DIR, 'json-export')
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToJson(targetDir)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('json', { dataDir: targetDir }))
      break
    }
    
    case 'to-sqlite': {
      const targetDb = args[1] || path.join(DATA_DIR, 'voltage.db')
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToSqlite(targetDb)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('sqlite', { dbPath: targetDb }))
      break
    }
    
    case 'to-mysql': {
      const configObj = {
        host: args[1] || 'localhost',
        port: parseInt(args[2]) || 3306,
        database: args[3] || 'voltchat',
        user: args[4] || 'root',
        password: args[5] || '',
        connectionLimit: 10
      }
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToMysql(configObj)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('mysql', configObj))
      break
    }

    case 'to-mariadb': {
      const configObj = {
        host: args[1] || 'localhost',
        port: parseInt(args[2]) || 3306,
        database: args[3] || 'voltchat',
        user: args[4] || 'root',
        password: args[5] || '',
        connectionLimit: 10
      }
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToMysql(configObj)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('mariadb', configObj))
      break
    }
    
    case 'to-postgres': {
      const configObj = {
        host: args[1] || 'localhost',
        port: parseInt(args[2]) || 5432,
        database: args[3] || 'voltchat',
        user: args[4] || 'postgres',
        password: args[5] || '',
        ssl: args[6] === 'true'
      }
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToPostgres(configObj)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('postgres', configObj))
      break
    }
    
    case 'to-mongodb': {
      const configObj = {
        host: args[1] || 'localhost',
        port: parseInt(args[2]) || 27017,
        database: args[3] || 'voltchat',
        user: args[4] || '',
        password: args[5] || ''
      }
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToMongodb(configObj)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('mongodb', configObj))
      break
    }
    
    case 'to-redis': {
      const configObj = {
        host: args[1] || 'localhost',
        port: parseInt(args[2]) || 6379,
        password: args[3] || '',
        db: parseInt(args[4]) || 0,
        keyPrefix: args[5] || 'voltchat:'
      }
      await migration.createBackup(path.dirname(DATA_DIR))
      await migration.getSourceData()
      await migration.migrateToRedis(configObj)
      console.log('\nConfig to use:')
      console.log(migration.generateConfigJson('redis', configObj))
      break
    }
    
    default: {
      console.log(`
${BOLD}VoltChat Database Migration Tool${RESET}
=====================================

${BOLD}Interactive Mode:${RESET}
  npm run migrate                    - Interactive migration wizard
  npm run migrate -- migrate         - Same as above

${BOLD}Status & Backup:${RESET}
  npm run migrate -- status          - Show current storage status
  npm run migrate -- backup [dir]    - Create a backup

${BOLD}Quick Migration Commands:${RESET}
  npm run migrate -- to-json [dir]       - Migrate to JSON files
  npm run migrate -- to-sqlite [path]   - Migrate to SQLite
  npm run migrate -- to-mysql            - Migrate to MySQL
  npm run migrate -- to-mariadb          - Migrate to MariaDB
  npm run migrate -- to-postgres        - Migrate to PostgreSQL
  npm run migrate -- to-mongodb         - Migrate to MongoDB
  npm run migrate -- to-redis           - Migrate to Redis

${BOLD}Legacy Commands:${RESET}
  npm run migrate -- json-to-sqlite [sourceDir] [targetDb]
  npm run migrate -- sqlite-to-json [sourceDb] [targetDir]

${BOLD}Examples:${RESET}
  npm run migrate                                    # Interactive wizard
  npm run migrate -- to-sqlite ./data/voltage.db    # Quick SQLite migration
  npm run migrate -- to-postgres localhost 5432 mydb myuser mypass

${BOLD}Note:${RESET} All migrations automatically create a backup first.
      `)
      break
    }
  }
}

main().catch(e => {
  console.error('Migration error:', e.message)
  process.exit(1)
})
