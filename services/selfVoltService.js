import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const SELF_VOLT_FILE = path.join(DATA_DIR, 'self-volts.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

const loadData = (defaultValue = {}) => {
  try {
    if (fs.existsSync(SELF_VOLT_FILE)) {
      return JSON.parse(fs.readFileSync(SELF_VOLT_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('[SelfVolt] Error loading data:', err.message)
  }
  return defaultValue
}

const saveData = (data) => {
  try {
    fs.writeFileSync(SELF_VOLT_FILE, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error('[SelfVolt] Error saving data:', err.message)
    return false
  }
}

export const selfVoltService = {
  getAllVoltServers() {
    const data = loadData()
    return data.volts || []
  },

  getVoltServer(voltId) {
    const volts = this.getAllVoltServers()
    return volts.find(v => v.id === voltId) || null
  },

  addVoltServer(voltData) {
    const data = loadData()
    
    if (!data.volts) data.volts = []
    
    const volt = {
      id: voltData.id || `volt_${Date.now()}`,
      name: voltData.name,
      url: voltData.url,
      host: voltData.host || new URL(voltData.url).host,
      ownerId: voltData.ownerId,
      ownerUsername: voltData.ownerUsername,
      ownerHost: voltData.ownerHost || config.getHost(),
      icon: voltData.icon || '',
      description: voltData.description || '',
      status: 'ERROR',
      lastPing: null,
      version: voltData.version || '1.0.0',
      features: voltData.features || {},
      servers: [],
      federationEnabled: voltData.federationEnabled || false,
      createdAt: new Date().toISOString()
    }
    
    data.volts.push(volt)
    saveData(data)
    console.log(`[SelfVolt] Registered: ${volt.name} (${volt.host})`)
    return volt
  },

  updateVoltServer(voltId, updates) {
    const data = loadData()
    if (!data.volts) return null
    
    const index = data.volts.findIndex(v => v.id === voltId)
    if (index === -1) return null
    
    if (updates.url) {
      updates.host = new URL(updates.url).host
    }
    
    data.volts[index] = { ...data.volts[index], ...updates }
    saveData(data)
    return data.volts[index]
  },

  removeVoltServer(voltId) {
    const data = loadData()
    if (!data.volts) return false
    
    data.volts = data.volts.filter(v => v.id !== voltId)
    saveData(data)
    return true
  },

  updateVoltStatus(voltId, status, extraData = {}) {
    return this.updateVoltServer(voltId, {
      status,
      lastPing: new Date().toISOString(),
      ...extraData
    })
  },

  getVoltByOwner(ownerId) {
    const volts = this.getAllVoltServers()
    return volts.filter(v => v.ownerId === ownerId)
  },

  getVoltByHost(host) {
    const volts = this.getAllVoltServers()
    return volts.find(v => v.host === host || v.url?.includes(host))
  },

  async registerWithMainline(voltUrl, apiKey) {
    try {
      const response = await fetch(`${voltUrl}/api/self-volt/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          name: config.config.server.name,
          url: config.getServerUrl(),
          host: config.getHost(),
          version: config.config.server.version,
          features: config.config.features,
          federationEnabled: config.config.federation?.enabled || false
        })
      })
      
      if (response.ok) {
        const data = await response.json()
        console.log(`[SelfVolt] Registered with mainline: ${voltUrl}`)
        return data
      }
      throw new Error(`HTTP ${response.status}`)
    } catch (err) {
      console.error('[SelfVolt] Registration failed:', err.message)
      throw err
    }
  },

  addServerToVolt(voltId, serverData) {
    const data = loadData()
    if (!data.volts) return null
    
    const voltIndex = data.volts.findIndex(v => v.id === voltId)
    if (voltIndex === -1) return null
    
    if (!data.volts[voltIndex].servers) {
      data.volts[voltIndex].servers = []
    }

    const existingServer = data.volts[voltIndex].servers.find(s => s.id === serverData.id)
    if (existingServer) {
      existingServer.name = serverData.name
      existingServer.icon = serverData.icon
      existingServer.memberCount = serverData.memberCount
      existingServer.updatedAt = new Date().toISOString()
    } else {
      const server = {
        id: serverData.id,
        name: serverData.name,
        icon: serverData.icon || '',
        memberCount: serverData.memberCount || 0,
        addedAt: new Date().toISOString()
      }
      data.volts[voltIndex].servers.push(server)
    }
    
    saveData(data)
    return serverData
  },

  removeServerFromVolt(voltId, serverId) {
    const data = loadData()
    if (!data.volts) return false
    
    const voltIndex = data.volts.findIndex(v => v.id === voltId)
    if (voltIndex === -1) return false
    
    if (data.volts[voltIndex].servers) {
      data.volts[voltIndex].servers = data.volts[voltIndex].servers.filter(s => s.id !== serverId)
    }
    
    saveData(data)
    return true
  },

  generateApiKey(userId, keyData) {
    const data = loadData()
    
    if (!data.apiKeys) data.apiKeys = {}
    if (!data.apiKeys[userId]) data.apiKeys[userId] = []
    
    const key = {
      keyId: keyData.keyId || `sv_${Date.now()}`,
      apiKey: keyData.apiKey || crypto.randomBytes(32).toString('hex'),
      voltId: keyData.voltId,
      permissions: keyData.permissions || ['servers:read', 'users:read'],
      expiresAt: keyData.expiresAt,
      createdAt: new Date().toISOString()
    }
    
    data.apiKeys[userId].push(key)
    saveData(data)
    return key
  },

  getApiKeys(userId) {
    const data = loadData()
    return data.apiKeys?.[userId] || []
  },

  deleteApiKey(userId, keyId) {
    const data = loadData()
    if (!data.apiKeys?.[userId]) return false
    
    data.apiKeys[userId] = data.apiKeys[userId].filter(k => k.keyId !== keyId)
    saveData(data)
    return true
  },

  validateApiKey(apiKey) {
    const data = loadData()
    if (!data.apiKeys) return null
    
    for (const userId in data.apiKeys) {
      const key = data.apiKeys[userId].find(k => k.apiKey === apiKey)
      if (key) {
        if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
          return null
        }
        return { userId, ...key }
      }
    }
    return null
  },

  createCrossHostInvite(voltId, serverId, channelId = null) {
    const volt = this.getVoltServer(voltId)
    if (!volt) return null

    const { createCrossHostInvite } = require('../utils/inviteEncoder.js')
    return createCrossHostInvite(
      serverId,
      channelId,
      volt.host
    )
  },

  async syncServersFromVolt(voltUrl, apiKey) {
    try {
      const response = await fetch(`${voltUrl}/api/servers`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      return await response.json()
    } catch (err) {
      console.error('[SelfVolt] Server sync failed:', err.message)
      throw err
    }
  }
}
