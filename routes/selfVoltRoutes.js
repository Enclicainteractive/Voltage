import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { adminService } from '../services/dataService.js'
import { selfVoltService } from '../services/selfVoltService.js'
import config from '../config/config.js'

const isExternalImage = (value) => typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value))

const getAvatarUrl = (userId) => {
  const safeUserId = String(userId || '')
  if (!safeUserId) return null
  const baseUrl = safeUserId.startsWith('u_')
    ? (config.getServerUrl() || config.getImageServerUrl())
    : config.getImageServerUrl()
  return `${baseUrl}/api/images/users/${encodeURIComponent(safeUserId)}/profile`
}

const resolveUserAvatar = (userId, profile = null) => {
  const explicit = profile?.imageUrl || profile?.imageurl || profile?.avatarUrl || profile?.avatarURL || profile?.avatar || null
  if (isExternalImage(explicit)) return explicit
  return getAvatarUrl(userId)
}

const isPlatformAdmin = (userId) => {
  try {
    return Boolean(adminService?.isAdmin?.(userId))
  } catch {
    return false
  }
}

const getUserId = (req) => req.user?.id || req.user?.userId || null
const VOLT_ID_PATTERN = /^[A-Za-z0-9:_-]+$/
const MAX_VOLT_ID_LENGTH = 128

const normalizeVoltId = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_VOLT_ID_LENGTH) return null
  if (!VOLT_ID_PATTERN.test(trimmed)) return null
  return trimmed
}

const canManageVolt = (volt, userId) => Boolean(
  volt && userId && (volt.ownerId === userId || isPlatformAdmin(userId))
)

const toVoltSummary = (volt) => ({
  id: volt.id,
  name: volt.name,
  host: volt.host,
  url: volt.url,
  status: volt.status,
  lastPing: volt.lastPing,
  serverCount: Array.isArray(volt.servers) ? volt.servers.length : 0,
  features: volt.features,
  federationEnabled: Boolean(volt.federationEnabled),
  version: volt.version,
  icon: volt.icon || '',
  description: volt.description || ''
})

const router = express.Router()

router.get('/', authenticateToken, (req, res) => {
  if (isPlatformAdmin(req.user.id)) {
    const volts = selfVoltService.getAllVoltServers()
    return res.json((Array.isArray(volts) ? volts : []).map(toVoltSummary))
  }
  const owned = selfVoltService.getVoltByOwner(req.user.id)
  return res.json((Array.isArray(owned) ? owned : []).map(toVoltSummary))
})

router.get('/my', authenticateToken, (req, res) => {
  const volts = selfVoltService.getVoltByOwner(req.user.id)
  res.json(volts)
})

router.get('/host/:host', authenticateToken, async (req, res) => {
  const volt = selfVoltService.getVoltByHost(req.params.host)
  
  if (!volt) {
    return res.status(404).json({ error: 'Server not found' })
  }

  if (!canManageVolt(volt, getUserId(req))) {
    // Hide object existence for unauthorized users to reduce host-based enumeration.
    return res.status(404).json({ error: 'Server not found' })
  }
  
  res.json(toVoltSummary(volt))
})

router.get('/:voltId', authenticateToken, (req, res) => {
  const volt = selfVoltService.getVoltServer(req.params.voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to view this server' })
  }

  res.json(volt)
})

router.post('/', authenticateToken, (req, res) => {
  const { name, url, icon, description, registerMainline, mainlineUrl, mainlineApiKey } = req.body
  
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required' })
  }
  
  let host
  try {
    host = new URL(url).host
  } catch {
    return res.status(400).json({ error: 'Invalid URL' })
  }
  
  const volt = selfVoltService.addVoltServer({
    name,
    url: url.replace(/\/$/, ''),
    host,
    ownerId: req.user.id,
    ownerUsername: req.user.username,
    ownerHost: req.user.host || config.getHost(),
    icon,
    description,
    version: '1.0.0',
    features: config.config.features,
    federationEnabled: config.config.federation?.enabled || false
  })
  
  if (registerMainline && mainlineUrl && mainlineApiKey) {
    selfVoltService.registerWithMainline(mainlineUrl, mainlineApiKey)
      .then(() => {
        selfVoltService.updateVoltServer(volt.id, { status: 'CONNECTED' })
      })
      .catch(err => {
        console.error('[SelfVolt] Mainline registration failed:', err.message)
      })
  }
  
  console.log(`[SelfVolt] Added: ${name} (${host}) by ${req.user.username}`)
  res.json(volt)
})

router.put('/:voltId', authenticateToken, (req, res) => {
  const { voltId } = req.params
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to modify this server' })
  }
  
  const { name, url, icon, description } = req.body
  const updates = {}
  
  if (name) updates.name = name
  if (url) {
    updates.url = url.replace(/\/$/, '')
    updates.host = new URL(updates.url).host
  }
  if (icon !== undefined) updates.icon = icon
  if (description !== undefined) updates.description = description
  
  const updated = selfVoltService.updateVoltServer(voltId, updates)
  
  res.json(updated)
})

router.delete('/:voltId', authenticateToken, (req, res) => {
  const { voltId } = req.params
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to delete this server' })
  }
  
  selfVoltService.removeVoltServer(voltId)
  console.log(`[SelfVolt] Removed: ${volt.name}`)
  res.json({ success: true })
})

router.post('/:voltId/test', authenticateToken, async (req, res) => {
  const { voltId } = req.params
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  try {
    const response = await fetch(`${volt.url}/api/health`)
    
    if (response.ok) {
      const data = await response.json()
      selfVoltService.updateVoltStatus(voltId, 'OK', {
        version: data.version,
        mode: data.mode
      })
      res.json({ status: 'OK', data })
    } else {
      selfVoltService.updateVoltStatus(voltId, 'ERROR')
      res.json({ status: 'ERROR', error: `HTTP ${response.status}` })
    }
  } catch (err) {
    selfVoltService.updateVoltStatus(voltId, 'ERROR')
    res.json({ status: 'ERROR', error: err.message })
  }
})

router.post('/:voltId/register-mainline', authenticateToken, async (req, res) => {
  const { voltId } = req.params
  const { mainlineUrl, apiKey } = req.body
  
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  try {
    await selfVoltService.registerWithMainline(mainlineUrl, apiKey)
    selfVoltService.updateVoltServer(voltId, { status: 'CONNECTED' })
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/ping', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(401).json({ error: 'No token provided' })
  }
  
  const token = authHeader.replace('Bearer ', '')
  
  try {
    const decoded = jwt.verify(token, config.config.security.jwtSecret)
    
    const volts = selfVoltService.getAllVoltServers()
    const volt = volts.find(v => v.ownerId === decoded.userId && v.url)
    
    if (volt) {
      selfVoltService.updateVoltStatus(volt.id, 'OK', {
        lastPing: new Date().toISOString()
      })
      res.json({ 
        success: true, 
        host: config.getHost(),
        version: config.config.server.version,
        mode: config.config.server.mode
      })
    } else {
      res.json({ success: false, error: 'Volt not registered' })
    }
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' })
  }
})

router.post('/auth', authenticateToken, (req, res) => {
  const { serverId } = req.body
  
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      host: req.user.host,
      imageUrl: req.user?.imageUrl || req.user?.imageurl || req.user?.avatarUrl || req.user?.avatarURL || (isExternalImage(req.user?.avatar) ? req.user.avatar : null),
      avatar: resolveUserAvatar(req.user.id, req.user),
      email: req.user.email
    },
    serverId,
    host: config.getHost()
  })
})

router.get('/:voltId/servers', authenticateToken, (req, res) => {
  const { voltId } = req.params
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized to view this server list' })
  }

  res.json(volt.servers || [])
})

router.post('/:voltId/servers', authenticateToken, async (req, res) => {
  const { voltId } = req.params
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  try {
    const response = await fetch(`${volt.url}/api/servers`)
    const servers = await response.json()
    
    let count = 0
    for (const server of servers) {
      selfVoltService.addServerToVolt(voltId, {
        id: server.id,
        name: server.name,
        icon: server.icon,
        memberCount: server.members?.length || 0
      })
      count++
    }
    
    res.json({ success: true, count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:voltId/invite', authenticateToken, (req, res) => {
  const { voltId } = req.params
  const { serverId, channelId } = req.body
  
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (!canManageVolt(volt, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const inviteCode = selfVoltService.createCrossHostInvite(voltId, serverId, channelId)
  
  if (!inviteCode) {
    return res.status(500).json({ error: 'Failed to create invite' })
  }
  
  res.json({
    code: inviteCode,
    url: `https://volt.gg/inv/${inviteCode}`,
    host: volt.host,
    serverId
  })
})

router.post('/generate-key', authenticateToken, (req, res) => {
  const { voltId, permissions, expiresAt } = req.body
  const userId = getUserId(req)
  const safeVoltId = normalizeVoltId(voltId)

  if (!safeVoltId) {
    return res.status(400).json({ error: 'Valid voltId is required' })
  }

  const volt = selfVoltService.getVoltServer(safeVoltId)
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  if (!canManageVolt(volt, userId)) {
    return res.status(403).json({ error: 'Not authorized to create keys for this server' })
  }

  if (permissions !== undefined && !Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions must be an array of strings' })
  }
  const normalizedPermissions = Array.isArray(permissions)
    ? permissions.filter(permission => typeof permission === 'string' && permission.trim().length > 0)
    : null
  if (Array.isArray(permissions) && normalizedPermissions.length !== permissions.length) {
    return res.status(400).json({ error: 'permissions must contain only non-empty strings' })
  }
  
  const apiKey = crypto.randomBytes(32).toString('hex')
  const keyId = `sv_${Date.now()}`
  
  selfVoltService.generateApiKey(userId, {
    keyId,
    apiKey,
    voltId: safeVoltId,
    permissions: normalizedPermissions || ['servers:read', 'users:read'],
    expiresAt
  })
  
  res.json({
    keyId,
    apiKey,
    permissions: normalizedPermissions || ['servers:read', 'users:read'],
    expiresAt,
    message: 'Store this API key securely - it will not be shown again'
  })
})

router.get('/my-keys', authenticateToken, (req, res) => {
  const keys = selfVoltService.getApiKeys(req.user.id)
  res.json(keys.map(k => ({ 
    keyId: k.keyId, 
    voltId: k.voltId, 
    permissions: k.permissions,
    expiresAt: k.expiresAt,
    createdAt: k.createdAt 
  })))
})

router.delete('/my-keys/:keyId', authenticateToken, (req, res) => {
  selfVoltService.deleteApiKey(req.user.id, req.params.keyId)
  res.json({ success: true })
})

router.post('/validate-key', (req, res) => {
  const { apiKey, requiredPermissions } = req.body
  
  if (!apiKey) {
    return res.status(400).json({ error: 'API key required' })
  }

  if (requiredPermissions !== undefined && !Array.isArray(requiredPermissions)) {
    return res.status(400).json({ error: 'requiredPermissions must be an array of permission strings' })
  }
  
  const validated = selfVoltService.validateApiKey(apiKey)
  
  if (!validated) {
    return res.status(401).json({ valid: false, error: 'Invalid or expired API key' })
  }
  
  if (Array.isArray(requiredPermissions) && requiredPermissions.length > 0) {
    const hasPermission = requiredPermissions.every(p => 
      validated.permissions?.includes(p)
    )
    
    if (!hasPermission) {
      return res.status(403).json({ valid: false, error: 'Insufficient permissions' })
    }
  }
  
  res.json({ 
    valid: true, 
    voltId: validated.voltId,
    permissions: validated.permissions,
    expiresAt: validated.expiresAt || null
  })
})

export default router
