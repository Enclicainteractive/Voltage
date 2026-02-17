import express from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { selfVoltService } from '../services/selfVoltService.js'
import config from '../config/config.js'

const getAvatarUrl = (userId) => {
  const imageServerUrl = config.getImageServerUrl()
  return `${imageServerUrl}/api/images/users/${userId}/profile`
}

const router = express.Router()

router.get('/', authenticateToken, (req, res) => {
  const volts = selfVoltService.getAllVoltServers()
  res.json(volts)
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
  
  res.json({
    id: volt.id,
    name: volt.name,
    host: volt.host,
    url: volt.url,
    status: volt.status,
    lastPing: volt.lastPing,
    serverCount: volt.servers?.length || 0,
    features: volt.features
  })
})

router.get('/:voltId', authenticateToken, (req, res) => {
  const volt = selfVoltService.getVoltServer(req.params.voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
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
  
  if (volt.ownerId !== req.user.id) {
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
  
  if (volt.ownerId !== req.user.id) {
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
  
  if (volt.ownerId !== req.user.id) {
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
  
  if (volt.ownerId !== req.user.id) {
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
      avatar: getAvatarUrl(req.user.id),
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
  
  res.json(volt.servers || [])
})

router.post('/:voltId/servers', authenticateToken, async (req, res) => {
  const { voltId } = req.params
  const volt = selfVoltService.getVoltServer(voltId)
  
  if (!volt) {
    return res.status(404).json({ error: 'Self-Volt server not found' })
  }
  
  if (volt.ownerId !== req.user.id) {
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
  
  if (volt.ownerId !== req.user.id) {
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
  
  const apiKey = crypto.randomBytes(32).toString('hex')
  const keyId = `sv_${Date.now()}`
  
  selfVoltService.generateApiKey(req.user.id, {
    keyId,
    apiKey,
    voltId,
    permissions: permissions || ['servers:read', 'users:read'],
    expiresAt
  })
  
  res.json({
    keyId,
    apiKey,
    permissions: permissions || ['servers:read', 'users:read'],
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
  
  const validated = selfVoltService.validateApiKey(apiKey)
  
  if (!validated) {
    return res.status(401).json({ valid: false, error: 'Invalid or expired API key' })
  }
  
  if (requiredPermissions?.length) {
    const hasPermission = requiredPermissions.every(p => 
      validated.permissions?.includes(p)
    )
    
    if (!hasPermission) {
      return res.status(403).json({ valid: false, error: 'Insufficient permissions' })
    }
  }
  
  res.json({ 
    valid: true, 
    userId: validated.userId,
    voltId: validated.voltId,
    permissions: validated.permissions
  })
})

export default router
