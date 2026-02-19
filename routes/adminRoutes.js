import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { adminService, globalBanService, serverBanService, userService, discoveryService, FILES } from '../services/dataService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')

const loadData = (file, defaultValue = {}) => {
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

const router = express.Router()

const requireAdmin = (req, res, next) => {
  if (!adminService.isAdmin(req.user.id)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

const requireModerator = (req, res, next) => {
  if (!adminService.isModerator(req.user.id)) {
    return res.status(403).json({ error: 'Moderator access required' })
  }
  next()
}

router.get('/stats', authenticateToken, requireModerator, (req, res) => {
  const stats = adminService.getStats()
  res.json(stats)
})

router.get('/users', authenticateToken, requireModerator, (req, res) => {
  const { search, role, limit = 50, offset = 0 } = req.query
  let users = adminService.getAllUsers()
  
  if (search) {
    const searchLower = search.toLowerCase()
    users = users.filter(u => 
      u.username?.toLowerCase().includes(searchLower) ||
      u.email?.toLowerCase().includes(searchLower)
    )
  }
  
  if (role) {
    users = users.filter(u => u.adminRole === role)
  }
  
  const total = users.length
  users = users.slice(parseInt(offset), parseInt(offset) + parseInt(limit))
  
  res.json({ users, total })
})

router.get('/users/:userId', authenticateToken, requireModerator, (req, res) => {
  const user = userService.getUser(req.params.userId)
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }
  
  const isBanned = globalBanService.isBanned(req.params.userId)
  const ban = globalBanService.getBan(req.params.userId)
  const adminRole = adminService.getUserRole(req.params.userId)
  
  res.json({ ...user, isBanned, ban, adminRole })
})

router.put('/users/:userId/role', authenticateToken, requireAdmin, (req, res) => {
  const { role } = req.body
  const user = adminService.setUserRole(req.params.userId, role)
  
  adminService.logAction(req.user.id, 'set_role', req.params.userId, { role })
  
  res.json(user)
})

router.post('/users/:userId/ban', authenticateToken, requireModerator, (req, res) => {
  const { reason, banType } = req.body
  
  if (globalBanService.isBanned(req.params.userId)) {
    return res.status(400).json({ error: 'User already banned' })
  }
  
  const ban = globalBanService.banUser(req.params.userId, reason, req.user.id, banType || 'permanent')
  
  adminService.logAction(req.user.id, 'ban_user', req.params.userId, { reason, banType })
  
  res.json(ban)
})

router.delete('/users/:userId/ban', authenticateToken, requireModerator, (req, res) => {
  if (!globalBanService.isBanned(req.params.userId)) {
    return res.status(400).json({ error: 'User not banned' })
  }
  
  globalBanService.unbanUser(req.params.userId)
  
  adminService.logAction(req.user.id, 'unban_user', req.params.userId, {})
  
  res.json({ success: true })
})

router.post('/users/:userId/reset-password', authenticateToken, requireAdmin, (req, res) => {
  const result = adminService.resetUserPassword(req.params.userId)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  adminService.logAction(req.user.id, 'reset_password', req.params.userId, {})
  
  res.json(result)
})

router.delete('/users/:userId', authenticateToken, requireAdmin, (req, res) => {
  const result = adminService.deleteUser(req.params.userId)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  adminService.logAction(req.user.id, 'delete_user', req.params.userId, {})
  
  res.json(result)
})

// Age Verification Management
router.post('/users/:userId/age-verify', authenticateToken, requireModerator, (req, res) => {
  const { category, method, age, birthYear, expiresInDays } = req.body
  
  const verification = {
    verified: true,
    method: method || 'admin_manual',
    category: category || 'adult',
    birthYear: birthYear || null,
    age: age || null,
    estimatedAge: age || null,
    verifiedAt: new Date().toISOString(),
    expiresAt: category === 'adult' ? null : 
      (expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null),
    device: 'admin_panel'
  }
  
  const user = userService.setAgeVerification(req.params.userId, verification)
  
  adminService.logAction(req.user.id, 'age_verify', req.params.userId, { category, method })
  
  res.json(user)
})

router.delete('/users/:userId/age-verification', authenticateToken, requireModerator, (req, res) => {
  const users = loadData(path.join(DATA_DIR, 'users.json'), {})
  
  if (users[req.params.userId]) {
    delete users[req.params.userId].ageVerification
    users[req.params.userId].updatedAt = new Date().toISOString()
    saveData(path.join(DATA_DIR, 'users.json'), users)
    
    adminService.logAction(req.user.id, 'remove_age_verify', req.params.userId, {})
    
    return res.json({ success: true })
  }
  
  res.json({ error: 'User not found' })
})

// User Status Management
router.put('/users/:userId/status', authenticateToken, requireModerator, (req, res) => {
  const { status, customStatus } = req.body
  
  const user = userService.setStatus(req.params.userId, status, customStatus)
  
  adminService.logAction(req.user.id, 'set_status', req.params.userId, { status, customStatus })
  
  res.json(user)
})

router.get('/servers', authenticateToken, requireModerator, (req, res) => {
  const { search, limit = 50, offset = 0 } = req.query
  const servers = loadData(path.join(DATA_DIR, 'servers.json'), [])
  
  let filtered = servers
  
  if (search) {
    const searchLower = search.toLowerCase()
    filtered = filtered.filter(s => s.name.toLowerCase().includes(searchLower))
  }
  
  const total = filtered.length
  filtered = filtered.slice(parseInt(offset), parseInt(offset) + parseInt(limit))
  
  const serversWithBanned = filtered.map(s => ({
    ...s,
    isBanned: serverBanService.isServerBanned(s.id)
  }))
  
  res.json({ servers: serversWithBanned, total })
})

router.post('/servers/:serverId/ban', authenticateToken, requireModerator, (req, res) => {
  const { reason } = req.body
  
  if (serverBanService.isServerBanned(req.params.serverId)) {
    return res.status(400).json({ error: 'Server already banned' })
  }
  
  const result = serverBanService.banServer(req.params.serverId, reason, req.user.id)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  adminService.logAction(req.user.id, 'ban_server', req.params.serverId, { reason })
  
  res.json(result)
})

router.delete('/servers/:serverId/ban', authenticateToken, requireModerator, (req, res) => {
  if (!serverBanService.isServerBanned(req.params.serverId)) {
    return res.status(400).json({ error: 'Server not banned' })
  }
  
  serverBanService.unbanServer(req.params.serverId)
  
  adminService.logAction(req.user.id, 'unban_server', req.params.serverId, {})
  
  res.json({ success: true })
})

router.get('/banned-users', authenticateToken, requireModerator, (req, res) => {
  const bans = globalBanService.getAllBans()
  res.json(bans)
})

router.get('/banned-servers', authenticateToken, requireModerator, (req, res) => {
  const bans = serverBanService.getAllServerBans()
  res.json(bans)
})

router.get('/logs', authenticateToken, requireModerator, (req, res) => {
  const { limit = 100 } = req.query
  const logs = adminService.getLogs(parseInt(limit))
  res.json(logs)
})

router.get('/my-role', authenticateToken, (req, res) => {
  const role = adminService.getUserRole(req.user.id)
  const isAdmin = adminService.isAdmin(req.user.id)
  const isModerator = adminService.isModerator(req.user.id)
  res.json({ role, isAdmin, isModerator })
})

// Discovery Management
router.get('/discovery/pending', authenticateToken, requireModerator, (req, res) => {
  const submissions = discoveryService.getPendingSubmissions()
  res.json(submissions)
})

router.get('/discovery/approved', authenticateToken, requireModerator, (req, res) => {
  const { limit = 50, offset = 0 } = req.query
  const result = discoveryService.getApprovedServers(parseInt(limit), parseInt(offset))
  res.json(result)
})

router.post('/discovery/approve/:submissionId', authenticateToken, requireModerator, (req, res) => {
  const result = discoveryService.approveSubmission(req.params.submissionId)
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  adminService.logAction(req.user.id, 'approve_discovery', req.params.submissionId, { serverName: result.name })
  res.json(result)
})

router.post('/discovery/reject/:submissionId', authenticateToken, requireModerator, (req, res) => {
  const result = discoveryService.rejectSubmission(req.params.submissionId)
  adminService.logAction(req.user.id, 'reject_discovery', req.params.submissionId, {})
  res.json(result)
})

router.delete('/discovery/remove/:serverId', authenticateToken, requireModerator, (req, res) => {
  const result = discoveryService.removeFromDiscovery(req.params.serverId)
  adminService.logAction(req.user.id, 'remove_discovery', req.params.serverId, {})
  res.json(result)
})

// Self-Volt / Platform Analytics
router.get('/platform/health', authenticateToken, requireModerator, (req, res) => {
  const stats = adminService.getStats()
  
  // Get uptime info
  const serverStartTime = loadData(path.join(DATA_DIR, 'server-start.json'), { startTime: new Date().toISOString() })
  const uptimeMs = Date.now() - new Date(serverStartTime.startTime).getTime()
  const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60))
  const uptimeDays = Math.floor(uptimeHours / 24)
  
  // Get discovery stats
  const discoveryData = discoveryService.getSubmissions()
  
  // Get file storage usage
  const filesData = loadData(FILES.files || path.join(DATA_DIR, 'files.json'), {})
  
  res.json({
    uptime: {
      startTime: serverStartTime.startTime,
      uptimeMs,
      uptimeHours,
      uptimeDays,
      formatted: `${uptimeDays}d ${uptimeHours % 24}h`
    },
    stats,
    discovery: {
      pendingSubmissions: discoveryData.submissions?.length || 0,
      approvedServers: discoveryData.approved?.length || 0
    },
    storage: {
      totalFiles: Object.keys(filesData).length
    }
  })
})

router.get('/platform/activity', authenticateToken, requireModerator, (req, res) => {
  // Get recent activity stats
  const messages = loadData(path.join(DATA_DIR, 'messages.json'), {})
  const dmMessages = loadData(path.join(DATA_DIR, 'dm-messages.json'), {})
  
  let totalMessages = 0
  let totalDMMessages = 0
  
  Object.values(messages).forEach(ch => {
    if (Array.isArray(ch)) totalMessages += ch.length
  })
  
  Object.values(dmMessages).forEach(ch => {
    if (Array.isArray(ch)) totalDMMessages += ch.length
  })
  
  const servers = loadData(path.join(DATA_DIR, 'servers.json'), [])
  const users = loadData(path.join(DATA_DIR, 'users.json'), {})
  
  res.json({
    totalMessages,
    totalDMMessages,
    totalServers: servers.length,
    totalUsers: Object.keys(users).length,
    averageMembersPerServer: servers.length > 0 ? 
      Math.round(servers.reduce((acc, s) => acc + (s.members?.length || 0), 0) / servers.length) : 0
  })
})

// Save server start time on load
const serverStartFile = path.join(DATA_DIR, 'server-start.json')
if (!fs.existsSync(serverStartFile)) {
  fs.writeFileSync(serverStartFile, JSON.stringify({ startTime: new Date().toISOString() }))
}

// Self-Volt Management
const SELF_VOLT_FILE = path.join(DATA_DIR, 'self-volts.json')

router.get('/self-volts', authenticateToken, requireModerator, (req, res) => {
  const selfVolts = loadData(SELF_VOLT_FILE, [])
  res.json(selfVolts)
})

router.get('/self-volts/:voltId', authenticateToken, requireModerator, (req, res) => {
  const selfVolts = loadData(SELF_VOLT_FILE, [])
  const volt = selfVolts.find(v => v.id === req.params.voltId)
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt not found' })
  }
  res.json(volt)
})

router.delete('/self-volts/:voltId', authenticateToken, requireModerator, (req, res) => {
  let selfVolts = loadData(SELF_VOLT_FILE, [])
  selfVolts = selfVolts.filter(v => v.id !== req.params.voltId)
  saveData(SELF_VOLT_FILE, selfVolts)
  
  adminService.logAction(req.user.id, 'delete_self_volt', req.params.voltId, {})
  res.json({ success: true })
})

router.post('/self-volts/:voltId/test', authenticateToken, requireModerator, async (req, res) => {
  const selfVolts = loadData(SELF_VOLT_FILE, [])
  const volt = selfVolts.find(v => v.id === req.params.voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt not found' })
  }
  
  try {
    const response = await fetch(`${volt.url}/api/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000)
    })
    
    if (response.ok) {
      const data = await response.json()
      res.json({ status: 'online', data })
    } else {
      res.json({ status: 'error', error: `HTTP ${response.status}` })
    }
  } catch (err) {
    res.json({ status: 'offline', error: err.message })
  }
})

export default router
