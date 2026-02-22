import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { installJsonCompat } from './services/jsonCompatService.js'

//reminder to self make this not look assssssssss.
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
import federationRoutes, { setupFederationRoutes } from './routes/federationRoutes.js'
import botRoutes from './routes/botRoutes.js'
import e2eTrueRoutes from './routes/e2eTrueRoutes.js'
import systemRoutes from './routes/systemRoutes.js'


import { authenticateSocket } from './middleware/authMiddleware.js'
import { setupSocketHandlers } from './services/socketService.js'
import { startSystemScheduler } from './services/systemMessageScheduler.js'
import config from './config/config.js'
import { initStorageAndDistribute } from './services/storageService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

dotenv.config()
config.load()

// Initialize storage and migrate from storage_kv if needed
await initStorageAndDistribute()
installJsonCompat()

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
app.use('/api/federation', federationRoutes)
app.use('/api/bots', botRoutes)
app.use('/api/e2e-true', e2eTrueRoutes)
app.use('/api/system', systemRoutes)

// Category routes at /api/categories
import fs from 'fs'
const DATA_DIR = path.join(__dirname, 'data')
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json')

const loadData = (file, defaultValue = []) => {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (err) {
    console.error(`[Data] Error loading ${file}:`, err.message)
  }
  return defaultValue
}

const saveData = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error(`[Data] Error saving ${file}:`, err.message)
  }
}

const getAllCategories = () => loadData(CATEGORIES_FILE, {})
const setAllCategories = (categories) => saveData(CATEGORIES_FILE, categories)

app.put('/api/categories/:categoryId', (req, res) => {
  const allCategories = getAllCategories()
  let foundCategory = null
  let serverId = null

  for (const [sid, categories] of Object.entries(allCategories)) {
    const idx = categories.findIndex(c => c.id === req.params.categoryId)
    if (idx !== -1) {
      foundCategory = categories[idx]
      serverId = sid
      break
    }
  }

  if (!foundCategory) {
    return res.status(404).json({ error: 'Category not found' })
  }

  for (const categories of Object.values(allCategories)) {
    const idx = categories.findIndex(c => c.id === req.params.categoryId)
    if (idx !== -1) {
      categories[idx] = { ...categories[idx], ...req.body, updatedAt: new Date().toISOString() }
      setAllCategories(allCategories)

      io.to(`server:${serverId}`).emit('category:updated', categories[idx])
      console.log(`[API] Updated category ${req.params.categoryId}`)
      return res.json(categories[idx])
    }
  }
})

app.delete('/api/categories/:categoryId', (req, res) => {
  if (req.params.categoryId === 'uncategorized') {
    return res.status(400).json({ error: 'Cannot delete uncategorized pseudo-category' })
  }

  const allCategories = getAllCategories()
  let serverId = null

  for (const [sid, categories] of Object.entries(allCategories)) {
    const idx = categories.findIndex(c => c.id === req.params.categoryId)
    if (idx !== -1) {
      serverId = sid
      break
    }
  }

  if (!serverId) {
    return res.status(404).json({ error: 'Category not found' })
  }

  allCategories[serverId] = allCategories[serverId].filter(c => c.id !== req.params.categoryId)
  setAllCategories(allCategories)

  io.to(`server:${serverId}`).emit('category:deleted', { categoryId: req.params.categoryId, serverId })

  console.log(`[API] Deleted category ${req.params.categoryId}`)
  res.json({ success: true })
})

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
           server: config.config.server.name,
           version: config.config.server.version,
           mode: config.config.server.mode,
           url: config.getServerUrl(),
           features: {
             federation: config.config.federation?.enabled || false,
             bots: config.config.features?.bots || false,
             e2eTrueEncryption: config.config.features?.e2eTrueEncryption || false,
             e2eEncryption: config.config.features?.e2eEncryption || false
           }
  })
})

io.use(authenticateSocket)

setupSocketHandlers(io)
setupFederationRoutes(io)
startSystemScheduler(io)

export { io }

const PORT = process.env.PORT || config.config.server.port || 5000

// ─── ANSI color/style helpers ───────────────────────────────────────────────
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',

  // foreground
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
  cyan:    '\x1b[96m',
  yellow:  '\x1b[93m',
  green:   '\x1b[92m',
  red:     '\x1b[91m',
  magenta: '\x1b[95m',
  blue:    '\x1b[94m',

  // background
  bgBlack: '\x1b[40m',
}

const enabled = (v) => v
? `${c.bold}${c.green}yes${c.reset}`
: `${c.dim}${c.gray}no${c.reset}`

const label = (text) => `${c.dim}${c.gray}${text.padEnd(15)}${c.reset}`
const val   = (text) => `${c.white}${text}${c.reset}`
const section = (text) => `${c.bold}${c.cyan}  ${text}${c.reset}`
const line  = (lbl, v) => `  ${label(lbl)} ${v}`

function printBanner(serverName, version, mode, storage, PORT) {

  //i hope this works >~< please render correctly.........
  const LOGO = `
  ${c.bold}${c.cyan}
  ___      ___  ________  ___   _________  ________  ________  _______
  |\\  \\    /  /|/\\   __  \\|\\  \\ |\\___   ___\\\\   __  \\|\\   ____\\|\\  ___ \\
  \\ \\  \\  /  / /\\ \\  \\|\\  \\ \\  \\\\|___ \\  \\_\\ \\  \\|\\  \\ \\  \\___|\\ \\   __/|
  \\ \\  \\/  / /  \\ \\  \\\\\\  \\ \\  \\    \\ \\  \\ \\ \\   __  \\ \\  \\  __\\ \\  \\_|/__
  \\ \\    / /    \\ \\  \\\\\\  \\ \\  \\____\\ \\  \\ \\ \\  \\ \\  \\ \\  \\|\\  \\ \\  \\_|\\ \\
  \\ \\__/ /      \\ \\_______\\ \\_______\\ \\__\\ \\ \\__\\ \\__\\ \\_______\\ \\_______\\
  \\|__|/        \\|_______|\\|_______|\\|__|  \\|__|\\|__|\\|_______|\\|_______|
  ${c.reset}`

  const DIVIDER   = `${c.dim}${c.gray}  ${'─'.repeat(60)}${c.reset}`
  const DIVIDER_S = `${c.dim}${c.gray}  ${'─'.repeat(60)}${c.reset}`

  console.log(LOGO)
  console.log(`  ${c.bold}${c.white}${serverName}${c.reset}  ${c.dim}${c.gray}v${version}${c.reset}   ${c.yellow}${mode}${c.reset}`)
  console.log()
  console.log(DIVIDER)
  console.log()

  // Server
  console.log(section('Server'))
  console.log(line('Host',    val(config.getHost())))
  console.log(line('URL',     `${c.cyan}${config.getServerUrl()}${c.reset}`))
  console.log(line('Port',    val(PORT)))
  console.log()

  // Storage
  console.log(section('Storage'))
  console.log(line('Type', val(storage.type)))


  /*
   *
   *
   * UWU IF ELSE CHAINS
   *
   *
   */
  if (storage.type === 'json') {
    console.log(line('Data dir', val(storage.json?.dataDir || './data')))
  } else if (storage.type === 'sqlite') {
    console.log(line('DB path', val(storage.sqlite?.dbPath || './data/voltage.db')))
  } else if (['mysql', 'mariadb'].includes(storage.type)) {
    const s = storage[storage.type]
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 3306}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (['postgres', 'cockroachdb'].includes(storage.type)) {
    const s = storage[storage.type]
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || (storage.type === 'postgres' ? 5432 : 26257)}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (storage.type === 'mssql') {
    const s = storage.mssql
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 1433}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (storage.type === 'mongodb') {
    const s = storage.mongodb
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 27017}`)))
    console.log(line('Database', val(s?.database || 'voltchat')))
  } else if (storage.type === 'redis') {
    const s = storage.redis
    console.log(line('Host', val(`${s?.host || 'localhost'}:${s?.port || 6379}`)))
    console.log(line('DB', val(s?.db ?? 0)))
  } //MESSY CODE NEED TO CLEANUP LATER
  console.log()

  // Auth lots of auth
  console.log(section('Auth'))
  console.log(line('Local',        enabled(config.isLocalAuthEnabled())))
  console.log(line('Registration', enabled(config.config.auth?.local?.allowRegistration)))
  console.log(line('OAuth',        enabled(config.isOAuthEnabled())))
  if (config.isOAuthEnabled()) {
    console.log(line('Provider', val(config.config.auth?.oauth?.provider || 'enclica')))
  }
  console.log()

  // CDN
  console.log(section('CDN'))
  console.log(line('Enabled', enabled(config.isCdnEnabled())))
  if (config.isCdnEnabled()) {
    console.log(line('Provider', val(config.config.cdn?.provider || 'local')))
  }
  console.log()

  // Federation
  console.log(section('Federation'))
  console.log(line('Enabled', enabled(config.config.federation?.enabled)))
  if (config.config.federation?.enabled) {
    console.log(line('Server name', val(config.config.federation.serverName || 'N/A')))
  }
  console.log()

  // Features
  console.log(section('Features'))
  console.log(line('Bots',     enabled(config.config.features?.bots)))
  console.log(line('True E2EE',enabled(config.config.features?.e2eTrueEncryption)))
  console.log(line('E2EE',     enabled(config.config.features?.e2eEncryption)))
  console.log()

  console.log(DIVIDER_S)
  console.log()
  console.log(`  ${c.dim}${c.gray}Ready.  Listening on port ${c.reset}${c.bold}${c.white}${PORT}${c.reset}`)
  console.log()
}

httpServer.listen(PORT, () => {
  const serverName = config.config.server.name || 'Volt'
  const version    = config.config.server.version || '1.0.0'
  const mode       = config.config.server.mode || 'mainline'
  const storage    = config.config.storage

  printBanner(serverName, version, mode, storage, PORT)
})
