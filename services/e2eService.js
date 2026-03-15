import * as crypto from './cryptoService.js'
import { supportsDirectQuery, directQuery, FILES } from './dataService.js'

const E2E_FILE = FILES.e2eKeys

let e2eCache = { servers: {} }
let cacheLoaded = false

const ensureCacheLoaded = async () => {
  if (!cacheLoaded) {
    if (supportsDirectQuery()) {
      try {
        const rows = await directQuery('SELECT * FROM e2e_keys')
        if (rows && rows.length > 0) {
          const servers = {}
          for (const row of rows) {
            servers[row.id] = JSON.parse(row.data || '{}')
          }
          e2eCache.servers = servers
        }
      } catch (err) {
        console.error('[E2E] Error loading from DB:', err.message)
      }
    }
    cacheLoaded = true
  }
}

const loadData = (defaultValue = {}) => {
  if (!cacheLoaded) {
    ensureCacheLoaded().catch(err => console.error('[E2E] Failed to load cache:', err))
    return { ...defaultValue, servers: {} }
  }
  return { ...e2eCache }
}

const saveData = async (data) => {
  e2eCache = { ...data }
  if (supportsDirectQuery()) {
    try {
      for (const [serverId, serverData] of Object.entries(data.servers || {})) {
        await directQuery(
          'INSERT OR REPLACE INTO e2e_keys (id, data, updatedAt) VALUES (?, ?, ?)',
          [serverId, JSON.stringify(serverData), new Date().toISOString()]
        )
      }
      console.log('[E2E] Saved to database')
      return true
    } catch (err) {
      console.error('[E2E] Error saving to DB:', err.message)
      return false
    }
  }
  return false
}

export const e2eService = {
  async ensureLoaded() {
    if (!cacheLoaded) {
      await ensureCacheLoaded()
    }
  },

  getServerKeys(serverId) {
    if (!cacheLoaded) {
      ensureCacheLoaded().catch(err => console.error('[E2E] Failed to load cache:', err))
    }
    const data = loadData()
    return data.servers?.[serverId] || null
  },

  async createServerKeys(serverId) {
    const data = loadData()
    
    const symmetricKey = crypto.generateSymmetricKey()
    const keyId = crypto.generateKeyIdentifier()
    
    if (!data.servers) data.servers = {}
    data.servers[serverId] = {
      keyId,
      symmetricKey: symmetricKey.toString('base64'),
      enabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      memberKeys: {}
    }
    
    await saveData(data)
    return data.servers[serverId]
  },

  getOrCreateServerKeys(serverId) {
    let keys = this.getServerKeys(serverId)
    if (!keys) {
      keys = this.createServerKeys(serverId)
    }
    return keys
  },

  async enableServerEncryption(serverId) {
    const data = loadData()
    if (!data.servers?.[serverId]) {
      return this.createServerKeys(serverId)
    }
    
    data.servers[serverId].enabled = true
    data.servers[serverId].updatedAt = new Date().toISOString()
    await saveData(data)
    return data.servers[serverId]
  },

  async disableServerEncryption(serverId) {
    const data = loadData()
    if (!data.servers?.[serverId]) {
      return null
    }
    
    data.servers[serverId].enabled = false
    data.servers[serverId].updatedAt = new Date().toISOString()
    await saveData(data)
    return data.servers[serverId]
  },

  getSymmetricKey(serverId) {
    const keys = this.getServerKeys(serverId)
    if (!keys) return null
    return keys.symmetricKey ? Buffer.from(keys.symmetricKey, 'base64') : null
  },

  isEncryptionEnabled(serverId) {
    const keys = this.getServerKeys(serverId)
    return keys?.enabled || false
  },

  getMemberEncryptedKeys(serverId) {
    const keys = this.getServerKeys(serverId)
    return keys?.memberKeys || {}
  },

  async setMemberEncryptedKey(serverId, userId, encryptedKey) {
    const data = loadData()
    
    if (!data.servers?.[serverId]) {
      const symmetricKey = crypto.generateSymmetricKey()
      const keyId = crypto.generateKeyIdentifier()
      if (!data.servers) data.servers = {}
      data.servers[serverId] = {
        keyId,
        symmetricKey: symmetricKey.toString('base64'),
        enabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        memberKeys: {}
      }
    }
    
    if (!data.servers[serverId].memberKeys) {
      data.servers[serverId].memberKeys = {}
    }
    
    data.servers[serverId].memberKeys[userId] = {
      encryptedKey,
      timestamp: new Date().toISOString()
    }
    
    await saveData(data)
    return true
  },

  async removeMemberKey(serverId, userId) {
    const data = loadData()
    if (data.servers?.[serverId]?.memberKeys?.[userId]) {
      delete data.servers[serverId].memberKeys[userId]
      await saveData(data)
    }
    return true
  },

  async rotateServerKey(serverId) {
    const data = loadData()
    if (!data.servers?.[serverId]) {
      return this.createServerKeys(serverId)
    }
    
    const newSymmetricKey = crypto.generateSymmetricKey()
    const newKeyId = crypto.generateKeyIdentifier()
    
    data.servers[serverId].symmetricKey = newSymmetricKey.toString('base64')
    data.servers[serverId].keyId = newKeyId
    data.servers[serverId].updatedAt = new Date().toISOString()
    data.servers[serverId].memberKeys = {}
    
    await saveData(data)
    return data.servers[serverId]
  },

  async deleteServerKeys(serverId) {
    const data = loadData()
    if (data.servers?.[serverId]) {
      delete data.servers[serverId]
      await saveData(data)
    }
    return true
  }
}

export const dmE2eService = {
  getDmKeys(conversationId) {
    const data = loadData()
    return data.dms?.[conversationId] || null
  },

  async createDmKeys(conversationId) {
    const data = loadData()
    
    if (!data.dms) data.dms = {}
    
    const symmetricKey = crypto.generateSymmetricKey()
    const keyId = crypto.generateKeyIdentifier()
    
    data.dms[conversationId] = {
      keyId,
      symmetricKey: symmetricKey.toString('base64'),
      enabled: false,
      participants: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    await saveData(data)
    return data.dms[conversationId]
  },

  getOrCreateDmKeys(conversationId) {
    let keys = this.getDmKeys(conversationId)
    if (!keys) {
      keys = this.createDmKeys(conversationId)
    }
    return keys
  },

  async enableDmEncryption(conversationId) {
    const data = loadData()
    
    if (!data.dms?.[conversationId]) {
      return this.createDmKeys(conversationId)
    }
    
    data.dms[conversationId].enabled = true
    data.dms[conversationId].updatedAt = new Date().toISOString()
    await saveData(data)
    return data.dms[conversationId]
  },

  async disableDmEncryption(conversationId) {
    const data = loadData()
    if (!data.dms?.[conversationId]) {
      return null
    }
    
    data.dms[conversationId].enabled = false
    data.dms[conversationId].updatedAt = new Date().toISOString()
    await saveData(data)
    return data.dms[conversationId]
  },

  isDmEncryptionEnabled(conversationId) {
    const keys = this.getDmKeys(conversationId)
    return keys?.enabled || false
  },

  getDmSymmetricKey(conversationId) {
    const keys = this.getDmKeys(conversationId)
    if (!keys) return null
    return keys.symmetricKey ? Buffer.from(keys.symmetricKey, 'base64') : null
  },

  async setParticipantEncryptedKey(conversationId, userId, encryptedKey) {
    const data = loadData()
    
    if (!data.dms?.[conversationId]) {
      if (!data.dms) data.dms = {}
      const symmetricKey = crypto.generateSymmetricKey()
      const keyId = crypto.generateKeyIdentifier()
      data.dms[conversationId] = {
        keyId,
        symmetricKey: symmetricKey.toString('base64'),
        enabled: false,
        participants: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
    
    if (!data.dms[conversationId].participants) {
      data.dms[conversationId].participants = {}
    }
    
    data.dms[conversationId].participants[userId] = {
      encryptedKey,
      timestamp: new Date().toISOString()
    }
    
    await saveData(data)
    return true
  },

  getParticipantKeys(conversationId) {
    const keys = this.getDmKeys(conversationId)
    return keys?.participants || {}
  },

  async rotateDmKey(conversationId) {
    const data = loadData()
    if (!data.dms?.[conversationId]) {
      return this.createDmKeys(conversationId)
    }
    
    const newSymmetricKey = crypto.generateSymmetricKey()
    const newKeyId = crypto.generateKeyIdentifier()
    
    data.dms[conversationId].symmetricKey = newSymmetricKey.toString('base64')
    data.dms[conversationId].keyId = newKeyId
    data.dms[conversationId].updatedAt = new Date().toISOString()
    data.dms[conversationId].participants = {}
    
    await saveData(data)
    return data.dms[conversationId]
  },

  async deleteDmKeys(conversationId) {
    const data = loadData()
    if (data.dms?.[conversationId]) {
      delete data.dms[conversationId]
      await saveData(data)
    }
    return true
  }
}

export const userKeyService = {
  getUserKeys(userId) {
    const data = loadData()
    return data.users?.[userId] || null
  },

  async saveUserKeys(userId, keys) {
    const data = loadData()
    
    if (!data.users) data.users = {}
    
    data.users[userId] = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      keyId: crypto.generateKeyIdentifier(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    
    await saveData(data)
    return data.users[userId]
  },

  async updateUserKeys(userId, updates) {
    const data = loadData()
    if (!data.users?.[userId]) {
      return null
    }
    
    data.users[userId] = {
      ...data.users[userId],
      ...updates,
      updatedAt: new Date().toISOString()
    }
    
    await saveData(data)
    return data.users[userId]
  },

  async deleteUserKeys(userId) {
    const data = loadData()
    if (data.users?.[userId]) {
      delete data.users[userId]
      await saveData(data)
    }
    return true
  },

  getUserPublicKey(userId) {
    const keys = this.getUserKeys(userId)
    return keys?.publicKey || null
  }
}
