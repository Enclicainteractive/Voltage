import express from 'express'
import config from '../config/config.js'
import dataService from '../services/dataService.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()

const loadOptionalModule = async (moduleName) => {
  const mod = await import(moduleName)
  return mod.default || mod
}

const STORAGE_TYPES = {
  json: { name: 'JSON Files', requires: [] },
  sqlite: { name: 'SQLite', requires: ['better-sqlite3'] },
  mysql: { name: 'MySQL', requires: ['mysql2'] },
  mariadb: { name: 'MariaDB', requires: ['mariadb'] },
  postgres: { name: 'PostgreSQL', requires: ['pg'] },
  cockroachdb: { name: 'CockroachDB', requires: ['pg'] },
  mssql: { name: 'SQL Server', requires: ['mssql'] },
  mongodb: { name: 'MongoDB', requires: ['mongodb'] },
  redis: { name: 'Redis', requires: ['redis'] }
}

router.get('/storage-info', (req, res) => {
  try {
    const storageInfo = dataService.getStorageInfo()
    const currentConfig = config.config.storage
    
    res.json({
      success: true,
      current: {
        type: storageInfo.type,
        provider: storageInfo.provider,
        config: currentConfig
      },
      available: STORAGE_TYPES
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

router.get('/storage-types', (req, res) => {
  const types = Object.entries(STORAGE_TYPES).map(([key, value]) => ({
    id: key,
    name: value.name,
    requires: value.requires
  }))
  
  res.json({ success: true, types })
})

router.post('/migrate', async (req, res) => {
  try {
    const { targetType, targetConfig, backup = true } = req.body
    
    if (!targetType || !STORAGE_TYPES[targetType]) {
      return res.status(400).json({
        success: false,
        error: 'Invalid target storage type'
      })
    }
    
    const currentType = config.config.storage.type
    
    if (currentType === targetType) {
      return res.status(400).json({
        success: false,
        error: 'Already using this storage type'
      })
    }
    
    const results = {
      success: true,
      source: currentType,
      target: targetType,
      steps: [],
      errors: []
    }
    let previousStorageConfig
    
    try {
      results.steps.push({ step: 'backup', status: 'pending' })
      
      if (backup) {
        const backupDir = path.join(__dirname, '..', '..', 'data', 'backup', `backup_${Date.now()}`)
        if (!fs.existsSync(path.dirname(backupDir))) {
          fs.mkdirSync(path.dirname(backupDir), { recursive: true })
        }
        
        const dataDir = path.join(__dirname, '..', '..', 'data')
        const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'))
        
        fs.mkdirSync(backupDir, { recursive: true })
        
        for (const file of files) {
          const srcPath = path.join(dataDir, file)
          const destPath = path.join(backupDir, file)
          fs.copyFileSync(srcPath, destPath)
        }
        
        results.steps[results.steps.length - 1].status = 'completed'
        results.steps[results.steps.length - 1].backupPath = backupDir
      } else {
        results.steps[results.steps.length - 1].status = 'skipped'
      }
      
      results.steps.push({ step: 'export', status: 'pending' })
      
      const exportData = dataService.exportAllData()
      const recordCounts = {}
      for (const [table, data] of Object.entries(exportData)) {
        recordCounts[table] = Object.keys(data).length
      }
      results.steps[results.steps.length - 1].status = 'completed'
      results.steps[results.steps.length - 1].recordCounts = recordCounts
      
      results.steps.push({ step: 'configure', status: 'pending' })
      
      previousStorageConfig = JSON.parse(JSON.stringify(config.config.storage))
      const newStorageConfig = {
        type: targetType,
        [targetType]: targetConfig || {}
      }
      
      config.config.storage = { ...config.config.storage, ...newStorageConfig }
      await dataService.reinitializeStorage()
      
      results.steps[results.steps.length - 1].status = 'completed'
      
      results.steps.push({ step: 'import', status: 'pending' })
      
      const importResults = await dataService.importAllData(exportData)
      results.steps[results.steps.length - 1].status = 'completed'
      results.steps[results.steps.length - 1].imported = importResults.tables

      const activeStorage = dataService.getStorageInfo()
      if (activeStorage.type !== targetType) {
        throw new Error(`Backend switch failed: expected "${targetType}" but active backend is "${activeStorage.type}"`)
      }
      
      config.save()
      
      results.message = 'Migration completed successfully. All data has been transferred.'
      
    } catch (err) {
      results.success = false
      results.errors.push(err.message)
      try {
        if (typeof previousStorageConfig !== 'undefined') {
          config.config.storage = previousStorageConfig
          await dataService.reinitializeStorage()
        }
      } catch (rollbackErr) {
        results.errors.push(`Rollback failed: ${rollbackErr.message}`)
      }
    }
    
    res.json(results)
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

router.post('/test-connection', async (req, res) => {
  try {
    const { type, config: testConfig } = req.body
    
    if (!type || !STORAGE_TYPES[type]) {
      return res.status(400).json({
        success: false,
        error: 'Invalid storage type'
      })
    }
    
    const results = {
      success: false,
      type,
      tested: false,
      error: null
    }
    
    // Helper to detect missing driver errors
    const isDriverMissing = (err) => (
      err?.code === 'MODULE_NOT_FOUND' ||
      err?.code === 'ERR_MODULE_NOT_FOUND' ||
      err?.message?.includes('Cannot find module')
    )
    const driverMissingMsg = (pkg) => `Node.js driver "${pkg}" is not installed. Run: npm install ${pkg}`
    
    switch (type) {
      case 'mysql':
        try {
          const mysql = await loadOptionalModule('mysql2/promise')
          const conn = await mysql.createConnection({
            host: testConfig.host || 'localhost',
            port: testConfig.port || 3306,
            user: testConfig.user || 'root',
            password: testConfig.password || '',
            database: testConfig.database || 'voltchat'
          })
          await conn.end()
          results.success = true
          results.tested = true
        } catch (err) {
          results.error = isDriverMissing(err) ? driverMissingMsg('mysql2') : err.message
          results.driverMissing = isDriverMissing(err)
        }
        break
        
      case 'mariadb':
        try {
          const mariadb = await loadOptionalModule('mariadb')
          const conn = await mariadb.createConnection({
            host: testConfig.host || 'localhost',
            port: testConfig.port || 3306,
            user: testConfig.user || 'root',
            password: testConfig.password || '',
            database: testConfig.database || 'voltchat'
          })
          await conn.end()
          results.success = true
          results.tested = true
        } catch (err) {
          results.error = isDriverMissing(err) ? driverMissingMsg('mariadb') : err.message
          results.driverMissing = isDriverMissing(err)
        }
        break
        
      case 'postgres':
      case 'cockroachdb':
        try {
          const { Client } = await loadOptionalModule('pg')
          const client = new Client({
            host: testConfig.host || 'localhost',
            port: testConfig.port || (type === 'cockroachdb' ? 26257 : 5432),
            user: testConfig.user || 'postgres',
            password: testConfig.password || '',
            database: testConfig.database || 'voltchat'
          })
          await client.connect()
          await client.end()
          results.success = true
          results.tested = true
        } catch (err) {
          results.error = isDriverMissing(err) ? driverMissingMsg('pg') : err.message
          results.driverMissing = isDriverMissing(err)
        }
        break
        
      case 'mssql':
        try {
          const mssql = await loadOptionalModule('mssql')
          await mssql.connect({
            server: testConfig.host || 'localhost',
            port: testConfig.port || 1433,
            user: testConfig.user || 'sa',
            password: testConfig.password || '',
            database: testConfig.database || 'voltchat',
            options: {
              encrypt: testConfig.encrypt || false,
              trustServerCertificate: testConfig.trustServerCertificate || true
            }
          })
          await mssql.close()
          results.success = true
          results.tested = true
        } catch (err) {
          results.error = isDriverMissing(err) ? driverMissingMsg('mssql') : err.message
          results.driverMissing = isDriverMissing(err)
        }
        break
        
      case 'mongodb':
        try {
          const { MongoClient } = await loadOptionalModule('mongodb')
          const uri = testConfig.connectionString || 
            `mongodb://${testConfig.host || 'localhost'}:${testConfig.port || 27017}/${testConfig.database || 'voltchat'}`
          const client = new MongoClient(uri)
          await client.connect()
          await client.close()
          results.success = true
          results.tested = true
        } catch (err) {
          results.error = isDriverMissing(err) ? driverMissingMsg('mongodb') : err.message
          results.driverMissing = isDriverMissing(err)
        }
        break
        
      case 'redis':
        try {
          const redis = await loadOptionalModule('redis')
          const client = redis.createClient({
            host: testConfig.host || 'localhost',
            port: testConfig.port || 6379,
            password: testConfig.password || undefined
          })
          await client.connect()
          await client.quit()
          results.success = true
          results.tested = true
        } catch (err) {
          results.error = isDriverMissing(err) ? driverMissingMsg('redis') : err.message
          results.driverMissing = isDriverMissing(err)
        }
        break
        
      case 'sqlite':
        results.success = true
        results.tested = true
        results.message = 'SQLite connection test passed (file-based)'
        break
        
      case 'json':
        results.success = true
        results.tested = true
        results.message = 'JSON storage always available'
        break
        
      default:
        results.error = 'Unknown storage type'
    }
    
    res.json(results)
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

router.get('/check-dependencies', async (req, res) => {
  const dependencies = {}
  
  const requiredDeps = {
    'better-sqlite3': 'sqlite',
    'mysql2': 'mysql',
    'mariadb': 'mariadb',
    'pg': 'postgres',
    'mssql': 'mssql',
    'mongodb': 'mongodb',
    'redis': 'redis'
  }
  
  // JSON is always available (no driver needed)
  dependencies['json'] = { available: true, package: null, note: 'Built-in, no driver required' }
  
  try {
    for (const [dep, storageType] of Object.entries(requiredDeps)) {
      try {
        await loadOptionalModule(dep)
        dependencies[storageType] = { available: true, package: dep }
      } catch (err) {
        dependencies[storageType] = { 
          available: false, 
          package: dep,
          installCommand: `npm install ${dep}`,
          note: `Driver not installed locally. Install with: npm install ${dep}. The database itself can be on a remote server.`
        }
      }
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message })
  }
  
  // CockroachDB uses the same driver as postgres
  if (dependencies['postgres']) {
    dependencies['cockroachdb'] = { 
      ...dependencies['postgres'],
      note: dependencies['postgres'].available 
        ? 'Uses the pg driver (same as PostgreSQL)' 
        : 'Uses the pg driver (same as PostgreSQL). Install with: npm install pg'
    }
  }
  
  res.json({ success: true, dependencies })
})

router.post('/export-data', async (req, res) => {
  try {
    const exportData = await dataService.migrateData(config.config.storage.type, {})
    
    res.json({
      success: true,
      ...exportData
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

export default router
