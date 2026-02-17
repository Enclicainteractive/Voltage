import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import userRoutes from './routes/userRoutes.js'
import serverRoutes from './routes/serverRoutes.js'
import channelRoutes from './routes/channelRoutes.js'
import messageRoutes from './routes/messageRoutes.js'
import dmRoutes from './routes/dmRoutes.js'
import authProxyRoutes from './routes/authProxyRoutes.js'
import uploadRoutes from './routes/uploadRoutes.js'
import inviteRoutes from './routes/inviteRoutes.js'
import discoveryRoutes from './routes/discoveryRoutes.js'
import adminRoutes from './routes/adminRoutes.js'
import e2eRoutes from './routes/e2eRoutes.js'
import selfVoltRoutes from './routes/selfVoltRoutes.js'
import authRoutes from './routes/authRoutes.js'
import pushRoutes from './routes/pushRoutes.js'
import adminConfigRoutes from './routes/adminConfigRoutes.js'
import migrationRoutes from './routes/migrationRoutes.js'
import { authenticateSocket } from './middleware/authMiddleware.js'
import { setupSocketHandlers } from './services/socketService.js'
import config from './config/config.js'
import { initStorage } from './services/storageService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config()
config.load()
initStorage()

const app = express()
const httpServer = createServer(app)

const serverUrl = config.getServerUrl()
const corsOrigin = process.env.NODE_ENV === 'production' 
  ? serverUrl 
  : ['http://localhost:3000', 'http://127.0.0.1:3000']

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    credentials: true
  }
})

app.use(cors({
  origin: corsOrigin,
  credentials: true
}))
app.use(express.json())

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// Additional CORS headers for file serving
app.use('/api/upload/file', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET')
  res.header('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})

app.use('/api/auth/proxy', authProxyRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/user', userRoutes)
app.use('/api/servers', serverRoutes)
app.use('/api/channels', channelRoutes)
app.use('/api/messages', messageRoutes)
app.use('/api/dms', dmRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/invites', inviteRoutes)
app.use('/api/discovery', discoveryRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/admin/config', adminConfigRoutes)
app.use('/api/e2e', e2eRoutes)
app.use('/api/self-volt', selfVoltRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/migration', migrationRoutes)

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    server: config.config.server.name,
    version: config.config.server.version,
    mode: config.config.server.mode,
    url: config.getServerUrl()
  })
})

io.use(authenticateSocket)

setupSocketHandlers(io)

export { io }

const PORT = process.env.PORT || config.config.server.port || 5000

httpServer.listen(PORT, () => {
  const serverName = config.config.server.name || 'Volt'
  const mode = config.config.server.mode || 'mainline'
  const storage = config.config.storage
  
  console.log('')
  console.log('═'.repeat(50))
  console.log(`⚡ ${serverName} Server v${config.config.server.version || '1.0.0'}`)
  console.log('═'.repeat(50))
  console.log(`📍 Mode:         ${mode}`)
  console.log(`🌍 Host:         ${config.getHost()}`)
  console.log(`🔗 URL:          ${config.getServerUrl()}`)
  console.log(`📂 Port:         ${PORT}`)
  console.log('')
  console.log('💾 Storage:')
  console.log(`   Type:         ${storage.type}`)
  if (storage.type === 'json') {
    console.log(`   Data Dir:     ${storage.json?.dataDir || './data'}`)
  } else if (storage.type === 'sqlite') {
    console.log(`   DB Path:      ${storage.sqlite?.dbPath || './data/voltage.db'}`)
  } else if (storage.type === 'mysql') {
    console.log(`   Host:         ${config.config.storage.mysql?.host || 'localhost'}:${config.config.storage.mysql?.port || 3306}`)
    console.log(`   Database:     ${config.config.storage.mysql?.database || 'voltchat'}`)
  } else if (storage.type === 'mariadb') {
    console.log(`   Host:         ${config.config.storage.mariadb?.host || 'localhost'}:${config.config.storage.mariadb?.port || 3306}`)
    console.log(`   Database:     ${config.config.storage.mariadb?.database || 'voltchat'}`)
  } else if (storage.type === 'postgres') {
    console.log(`   Host:         ${config.config.storage.postgres?.host || 'localhost'}:${config.config.storage.postgres?.port || 5432}`)
    console.log(`   Database:     ${config.config.storage.postgres?.database || 'voltchat'}`)
  } else if (storage.type === 'cockroachdb') {
    console.log(`   Host:         ${config.config.storage.cockroachdb?.host || 'localhost'}:${config.config.storage.cockroachdb?.port || 26257}`)
    console.log(`   Database:     ${config.config.storage.cockroachdb?.database || 'voltchat'}`)
  } else if (storage.type === 'mssql') {
    console.log(`   Host:         ${config.config.storage.mssql?.host || 'localhost'}:${config.config.storage.mssql?.port || 1433}`)
    console.log(`   Database:     ${config.config.storage.mssql?.database || 'voltchat'}`)
  } else if (storage.type === 'mongodb') {
    console.log(`   Host:         ${config.config.storage.mongodb?.host || 'localhost'}:${config.config.storage.mongodb?.port || 27017}`)
    console.log(`   Database:     ${config.config.storage.mongodb?.database || 'voltchat'}`)
  } else if (storage.type === 'redis') {
    console.log(`   Host:         ${config.config.storage.redis?.host || 'localhost'}:${config.config.storage.redis?.port || 6379}`)
    console.log(`   DB:           ${config.config.storage.redis?.db || 0}`)
  }
  console.log('')
  console.log('🔐 Auth:')
  console.log(`   Local:        ${config.isLocalAuthEnabled() ? '✓ Enabled' : '✗ Disabled'}`)
  console.log(`   Registration: ${config.config.auth?.local?.allowRegistration ? '✓ Allowed' : '✗ Closed'}`)
  console.log(`   OAuth:        ${config.isOAuthEnabled() ? '✓ Enabled' : '✗ Disabled'}`)
  if (config.isOAuthEnabled()) {
    console.log(`   Provider:     ${config.config.auth?.oauth?.provider || 'enclica'}`)
  }
  console.log('')
  console.log('☁️ CDN:')
  console.log(`   Enabled:      ${config.isCdnEnabled() ? '✓ Yes' : '✗ No'}`)
  if (config.isCdnEnabled()) {
    console.log(`   Provider:     ${config.config.cdn?.provider || 'local'}`)
  }
  console.log('')
  console.log('🌐 Federation:')
  console.log(`   Enabled:      ${config.config.federation?.enabled ? '✓ Yes' : '✗ No'}`)
  if (config.config.federation?.enabled) {
    console.log(`   Server Name:  ${config.config.federation.serverName || 'N/A'}`)
  }
  console.log('═'.repeat(50))
  console.log('')
})
