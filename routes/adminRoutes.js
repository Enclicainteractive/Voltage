import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { adminService, globalBanService, serverBanService, userService, discoveryService, serverService, FILES } from '../services/dataService.js'
import config from '../config/config.js'
import { getOnlineUsers } from '../services/socketService.js'
import { supportsDirectQuery, directQuery } from '../services/dataService.js'

const SELF_VOLT_FILE = FILES.selfVolts

let cachedServerStart = null
let cachedSelfVolts = null

const loadData = async (file, defaultValue = {}) => {
  if (file === FILES.serverStart) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM server_start LIMIT 1')
      cachedServerStart = rows?.[0] || defaultValue
      return cachedServerStart
    }
  }
  if (file === SELF_VOLT_FILE) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM self_volt')
      cachedSelfVolts = rows?.map(r => ({ id: r.id, ...JSON.parse(r.data || '{}') })) || defaultValue
      return cachedSelfVolts
    }
  }
  if (file === FILES.servers) {
    return serverService.getAllServers()
  }
  if (file === FILES.users) {
    return userService.getAllUsers()
  }
  if (file === FILES.messages) {
    return messageService.getAllMessages()
  }
  if (file === FILES.dmMessages) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM dm_messages')
      return rows || defaultValue
    }
  }
  if (file === FILES.files) {
    if (supportsDirectQuery()) {
      const rows = await directQuery('SELECT * FROM files')
      return rows || defaultValue
    }
  }
  return defaultValue
}

const saveData = async (file, data) => {
  if (file === FILES.serverStart) {
    if (supportsDirectQuery()) {
      await directQuery('DELETE FROM server_start')
      const keys = Object.keys(data)
      const values = Object.values(data)
      if (keys.length > 0) {
        await directQuery(`INSERT INTO server_start (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, values)
      }
      cachedServerStart = data
      console.log(`[Admin] Saved server_start`)
      return true
    }
    return false
  }
  if (file === SELF_VOLT_FILE) {
    if (supportsDirectQuery()) {
      await directQuery('DELETE FROM self_volt')
      for (const item of data) {
        await directQuery('INSERT INTO self_volt (id, data) VALUES (?, ?)', [item.id, JSON.stringify(item)])
      }
      cachedSelfVolts = data
      console.log(`[Admin] Saved self_volt`)
      return true
    }
    return false
  }
  return false
}

const router = express.Router()

const toIsoOrNull = (value) => {
  if (!value) return null
  const ts = new Date(value).getTime()
  if (Number.isNaN(ts)) return null
  return new Date(ts).toISOString()
}

const durationToMs = (value, unit) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  const unitMs = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000
  }
  const msPerUnit = unitMs[unit]
  if (!msPerUnit) return null
  return Math.round(n * msPerUnit)
}

const normalizePlatformState = (raw) => {
  if (!raw || typeof raw !== 'object') return {}
  // json_blob tables can come back as { server_start: { ...actualState } }
  if (raw.server_start && typeof raw.server_start === 'object') return raw.server_start
  return raw
}

const getPlatformState = () => normalizePlatformState(cachedServerStart || {})
const getPlatformStateAsync = async () => normalizePlatformState(await loadData(FILES.serverStart, {}))
const savePlatformState = async (state) => await saveData(FILES.serverStart, normalizePlatformState(state))
const getMaintenanceWindow = () => getPlatformState()?.maintenanceWindow || null

const computeMaintenanceStatus = (windowData) => {
  if (!windowData || !windowData.enabled) {
    return { enabled: false, active: false, scheduled: false, status: 'inactive', window: null }
  }
  const now = Date.now()
  const startAtMs = new Date(windowData.startAt || windowData.createdAt || Date.now()).getTime()
  const endAtMs = windowData.endAt ? new Date(windowData.endAt).getTime() : null

  if (endAtMs && now >= endAtMs) {
    return { enabled: false, active: false, scheduled: false, status: 'ended', window: windowData }
  }
  if (startAtMs > now) {
    return { enabled: true, active: false, scheduled: true, status: 'scheduled', window: windowData }
  }
  return { enabled: true, active: true, scheduled: false, status: 'active', window: windowData }
}

const requireAdmin = (req, res, next) => {
  if (!adminService.isAdmin(req.user.id)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

const requireModerator = (req, res, next) => {
  const adminUsers = config.config.security?.adminUsers || []
  const tokenUserId = req.user?.id || req.user?.userId || null
  const tokenUsername = req.user?.username || null
  const tokenRole = req.user?.adminRole
  const tokenIsAdmin = req.user?.isAdmin === true || req.user?.isAdmin === 1 || req.user?.isAdmin === '1' || req.user?.isAdmin === 'true'
  const tokenIsModerator = req.user?.isModerator === true || req.user?.isModerator === 1 || req.user?.isModerator === '1' || req.user?.isModerator === 'true'
  const servers = serverService.getAllServers()
  const serverArray = Array.isArray(servers) ? servers : Object.values(servers || {})
  const ownsAnyServer = tokenUserId ? serverArray.some(s => s?.ownerId === tokenUserId) : false
  const isConfiguredAdmin = (tokenUserId && adminUsers.includes(tokenUserId)) || (tokenUsername && adminUsers.includes(tokenUsername))
  if (!(isConfiguredAdmin || (tokenUserId && adminService.isModerator(tokenUserId)) || tokenIsAdmin || tokenIsModerator || tokenRole === 'admin' || tokenRole === 'owner' || tokenRole === 'moderator' || ownsAnyServer)) {
    return res.status(403).json({ error: 'Moderator access required' })
  }
  next()
}

router.get('/stats', authenticateToken, requireModerator, (req, res) => {
  const stats = adminService.getStats()
  res.json(stats)
})

router.get('/stats/online-users', authenticateToken, requireModerator, (req, res) => {
  const onlineUsers = getOnlineUsers().length
  res.json({
    onlineCount: onlineUsers,
    timestamp: new Date().toISOString()
  })
})

router.get('/online-users', authenticateToken, requireModerator, (req, res) => {
  res.json(getOnlineUsers())
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

router.put('/users/:userId/role', authenticateToken, requireAdmin, async (req, res) => {
  const { role } = req.body
  const user = await adminService.setUserRole(req.params.userId, role)
  
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

router.post('/users/:userId/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  const result = await adminService.resetUserPassword(req.params.userId)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  adminService.logAction(req.user.id, 'reset_password', req.params.userId, {})
  
  res.json(result)
})

router.delete('/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const result = await adminService.deleteUser(req.params.userId)
  
  if (result.error) {
    return res.status(404).json(result)
  }
  
  adminService.logAction(req.user.id, 'delete_user', req.params.userId, {})
  
  res.json(result)
})

// Age Verification Management
router.post('/users/:userId/age-verify', authenticateToken, requireModerator, async (req, res) => {
  const { category, method, age, birthYear, expiresInDays } = req.body
  const existingUser = userService.getUser(req.params.userId)
  
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
    device: 'admin_panel',
    source: 'admin_manual',
    jurisdictionCode: existingUser?.ageVerificationJurisdiction || existingUser?.ageVerification?.jurisdictionCode
  }
  
  const user = await userService.setAgeVerification(req.params.userId, verification)
  
  adminService.logAction(req.user.id, 'age_verify', req.params.userId, { category, method })
  
  res.json(user)
})

router.delete('/users/:userId/age-verification', authenticateToken, requireModerator, async (req, res) => {
  const users = loadData(FILES.users, {})
  
  if (users[req.params.userId]) {
    delete users[req.params.userId].ageVerification
    users[req.params.userId].updatedAt = new Date().toISOString()
    await saveData(FILES.users, users)
    
    adminService.logAction(req.user.id, 'remove_age_verify', req.params.userId, {})
    
    return res.json({ success: true })
  }
  
  res.json({ error: 'User not found' })
})

// User Status Management
router.put('/users/:userId/status', authenticateToken, requireModerator, async (req, res) => {
  const { status, customStatus } = req.body
  
  const user = await userService.setStatus(req.params.userId, status, customStatus)
  
  adminService.logAction(req.user.id, 'set_status', req.params.userId, { status, customStatus })
  
  res.json(user)
})

router.get('/servers', authenticateToken, requireModerator, (req, res) => {
  const { search, limit = 50, offset = 0 } = req.query
  const serversData = loadData(FILES.servers, {})
  const servers = Array.isArray(serversData) ? serversData : Object.values(serversData || {})
  
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

router.get('/maintenance', authenticateToken, async (req, res) => {
  const windowData = getMaintenanceWindow()
  const status = computeMaintenanceStatus(windowData)
  
  const discoveryData = await discoveryService.getApprovedServers(1000, 0)
  const pendingData = discoveryService.getPendingSubmissions()
  
  res.json({
    ...status,
    discovery: {
      approvedServers: discoveryData.total,
      pendingSubmissions: pendingData.length
    }
  })
})

router.put('/maintenance', authenticateToken, requireModerator, async (req, res) => {
  const {
    title,
    message,
    severity = 'warning',
    startAt,
    endAt,
    durationValue,
    durationUnit
  } = req.body || {}

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' })
  }

  const normalizedTitle = typeof title === 'string' && title.trim().length > 0
    ? title.trim().slice(0, 120)
    : 'Scheduled maintenance'
  const normalizedMessage = message.trim().slice(0, 1000)
  const normalizedSeverity = ['info', 'warning', 'critical'].includes(severity) ? severity : 'warning'
  const normalizedStartAt = toIsoOrNull(startAt) || new Date().toISOString()
  const explicitEndAt = toIsoOrNull(endAt)
  const durationMs = durationToMs(durationValue, durationUnit)
  const computedEndAt = explicitEndAt || (durationMs ? new Date(new Date(normalizedStartAt).getTime() + durationMs).toISOString() : null)

  const payload = {
    id: `mw_${Date.now()}`,
    enabled: true,
    title: normalizedTitle,
    message: normalizedMessage,
    severity: normalizedSeverity,
    startAt: normalizedStartAt,
    endAt: computedEndAt,
    durationValue: Number(durationValue) || null,
    durationUnit: durationUnit || null,
    durationMs: durationMs || null,
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  const platformState = await getPlatformStateAsync()
  await savePlatformState({
    ...platformState,
    maintenanceWindow: payload
  })
  adminService.logAction(req.user.id, 'set_maintenance_window', 'platform', {
    title: payload.title,
    startAt: payload.startAt,
    endAt: payload.endAt
  })
  res.json(computeMaintenanceStatus(payload))
})

router.delete('/maintenance', authenticateToken, requireModerator, async (req, res) => {
  const existing = getMaintenanceWindow()
  if (existing) {
    adminService.logAction(req.user.id, 'clear_maintenance_window', 'platform', {
      previousId: existing.id || null
    })
  }
  const platformState = await getPlatformStateAsync()
  await savePlatformState({
    ...platformState,
    maintenanceWindow: null
  })
  res.json({ success: true })
})

// Discovery Management
router.get('/discovery/pending', authenticateToken, requireModerator, (req, res) => {
  const submissions = discoveryService.getPendingSubmissions()
  res.json(submissions)
})

router.get('/discovery/approved', authenticateToken, requireModerator, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query
  const result = await discoveryService.getApprovedServers(parseInt(limit), parseInt(offset))
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
router.get('/platform/health', authenticateToken, requireModerator, async (req, res) => {
  const stats = adminService.getStats()
  
  // Get uptime info
  const platformState = await getPlatformStateAsync()
  const parsedStart = new Date(platformState.startTime || '').getTime()
  const fallbackStart = Date.now() - Math.round(process.uptime() * 1000)
  const startMs = Number.isFinite(parsedStart) ? parsedStart : fallbackStart
  const startTimeIso = new Date(startMs).toISOString()
  const uptimeMs = Math.max(0, Date.now() - startMs)
  const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60))
  const uptimeDays = Math.floor(uptimeHours / 24)
  
  // Get discovery stats
  const discoveryData = discoveryService.getSubmissions()
  
  // Get file storage usage
  const filesData = loadData(FILES.files, {})
  
  res.json({
    uptime: {
      startTime: startTimeIso,
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

router.get('/platform/activity', authenticateToken, requireModerator, async (req, res) => {
  // Get recent activity stats
  const messages = loadData(FILES.messages, {})
  const dmMessages = loadData(FILES.dmMessages, {})
  
  let totalMessages = 0
  let totalDMMessages = 0
  
  Object.values(messages || {}).forEach((entry) => {
    if (Array.isArray(entry)) {
      totalMessages += entry.length
    } else if (entry && typeof entry === 'object') {
      totalMessages += 1
    }
  })
  
  Object.values(dmMessages || {}).forEach((entry) => {
    if (Array.isArray(entry)) {
      totalDMMessages += entry.length
    } else if (entry && typeof entry === 'object') {
      totalDMMessages += 1
    }
  })
  
  const serversData = loadData(FILES.servers, {})
  const servers = Array.isArray(serversData) ? serversData : Object.values(serversData || {})
  const users = loadData(FILES.users, {})
  
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
const initialPlatformState = await getPlatformStateAsync()
if (!initialPlatformState?.startTime) {
  await saveData(FILES.serverStart, {
    ...initialPlatformState,
    startTime: new Date().toISOString()
  })
}

// Self-Volt Management

router.get('/self-volts', authenticateToken, requireModerator, async (req, res) => {
  const selfVolts = await loadData(SELF_VOLT_FILE, [])
  res.json(selfVolts)
})

router.get('/self-volts/:voltId', authenticateToken, requireModerator, async (req, res) => {
  const selfVolts = await loadData(SELF_VOLT_FILE, [])
  const volt = selfVolts.find(v => v.id === req.params.voltId)
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt not found' })
  }
  res.json(volt)
})

router.delete('/self-volts/:voltId', authenticateToken, requireModerator, async (req, res) => {
  let selfVolts = await loadData(SELF_VOLT_FILE, [])
  selfVolts = selfVolts.filter(v => v.id !== req.params.voltId)
  await saveData(SELF_VOLT_FILE, selfVolts)
  
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
