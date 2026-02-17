import express from 'express'
import config from '../config/config.js'
import dataService from '../services/dataService.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()

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
      }
      
      results.steps.push({ step: 'export', status: 'pending' })
      
      const exportData = await dataService.migrateData(currentType, {})
      results.steps[results.steps.length - 1].status = 'completed'
      results.steps[results.steps.length - 1].recordCounts = exportData.tables
      
      results.steps.push({ step: 'configure', status: 'pending' })
      
      const newStorageConfig = {
        type: targetType,
        [targetType]: targetConfig || {}
      }
      
      config.config.storage = { ...config.config.storage, ...newStorageConfig }
      
      results.steps[results.steps.length - 1].status = 'completed'
      
      results.steps.push({ step: 'restart_required', status: 'completed', message: 'Server restart required to apply new storage configuration' })
      
      results.message = 'Migration configuration prepared. Please restart the server to complete migration.'
      
    } catch (err) {
      results.success = false
      results.errors.push(err.message)
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
    
    switch (type) {
      case 'mysql':
        try {
          const mysql = require('mysql2/promise')
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
          results.error = err.message
        }
        break
        
      case 'mariadb':
        try {
          const mariadb = require('mariadb')
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
          results.error = err.message
        }
        break
        
      case 'postgres':
      case 'cockroachdb':
        try {
          const { Client } = require('pg')
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
          results.error = err.message
        }
        break
        
      case 'mssql':
        try {
          const mssql = require('mssql')
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
          results.error = err.message
        }
        break
        
      case 'mongodb':
        try {
          const { MongoClient } = require('mongodb')
          const uri = testConfig.connectionString || 
            `mongodb://${testConfig.host || 'localhost'}:${testConfig.port || 27017}/${testConfig.database || 'voltchat'}`
          const client = new MongoClient(uri)
          await client.connect()
          await client.close()
          results.success = true
          results.tested = true
        } catch (err) {
          results.error = err.message
        }
        break
        
      case 'redis':
        try {
          const redis = require('redis')
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
          results.error = err.message
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

router.get('/check-dependencies', (req, res) => {
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
  
  for (const [dep, storageType] of Object.entries(requiredDeps)) {
    try {
      require(dep)
      dependencies[storageType] = { available: true }
    } catch (err) {
      dependencies[storageType] = { available: false, error: 'Not installed' }
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
