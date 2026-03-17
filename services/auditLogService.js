import dataService, { FILES } from './dataService.js'

const loadData = (file, defaultValue) => {
  const data = dataService.getStorageData?.(file) 
  if (data !== undefined) return data
  
  // Fallback: try direct FILES access
  const fs = require('fs')
  const path = require('path')
  const dataDir = path.join(__dirname, '..', 'data')
  const filePath = path.join(dataDir, `${file}.json`)
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    }
  } catch (err) {
    console.error(`[AuditLog] Error loading ${file}:`, err.message)
  }
  return defaultValue
}

const saveData = (file, data) => {
  const fs = require('fs')
  const path = require('path')
  const dataDir = path.join(__dirname, '..', 'data')
  const filePath = path.join(dataDir, `${file}.json`)
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    console.error(`[AuditLog] Error saving ${file}:`, err.message)
    return false
  }
}

// Audit action types
export const AUDIT_ACTIONS = {
  // Server actions
  SERVER_CREATE: 'server.create',
  SERVER_UPDATE: 'server.update',
  SERVER_DELETE: 'server.delete',
  SERVER_ICON_CHANGE: 'server.icon_change',
  SERVER_BANNER_CHANGE: 'server.banner_change',
  SERVER_NAME_CHANGE: 'server.name_change',
  
  // Channel actions
  CHANNEL_CREATE: 'channel.create',
  CHANNEL_UPDATE: 'channel.update',
  CHANNEL_DELETE: 'channel.delete',
  
  // Member actions
  MEMBER_JOIN: 'member.join',
  MEMBER_LEAVE: 'member.leave',
  MEMBER_KICK: 'member.kick',
  MEMBER_BAN: 'member.ban',
  MEMBER_UNBAN: 'member.unban',
  MEMBER_ROLE_CHANGE: 'member.role_change',
  
  // Message actions
  MESSAGE_DELETE: 'message.delete',
  MESSAGE_BULK_DELETE: 'message.bulk_delete',
  MESSAGE_EDIT: 'message.edit',
  
  // Role actions
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',
  
  // Invites
  INVITE_CREATE: 'invite.create',
  INVITE_DELETE: 'invite.delete',
  INVITE_USE: 'invite.use',
  
  // Automod
  AUTOMOD_CONFIG_UPDATE: 'automod.config_update',
  AUTOMOD_WARN: 'automod.warn',
  AUTOMOD_WARN_CLEAR: 'automod.warn_clear',
  AUTOMOD_ACTION: 'automod.action',
  
  // Admin actions
  ADMIN_USER_BAN: 'admin.user_ban',
  ADMIN_USER_UNBAN: 'admin.user_unban',
  ADMIN_USER_ROLE_CHANGE: 'admin.user_role_change',
  
  // Discovery
  DISCOVERY_SUBMIT: 'discovery.submit',
  DISCOVERY_APPROVE: 'discovery.approve',
  DISCOVERY_REJECT: 'discovery.reject',
  
  // Bot actions
  BOT_ADD: 'bot.add',
  BOT_REMOVE: 'bot.remove',
  BOT_UPDATE: 'bot.update'
}

const getLogs = () => {
  return loadData(FILES.adminLogs, [])
}

const saveLogs = (logs) => {
  return saveData(FILES.adminLogs, logs)
}

export const auditLogService = {
  /**
   * Log an audit event
   * @param {Object} options - Log options
   * @param {string} options.serverId - Server ID
   * @param {string} options.action - Action type
   * @param {string} options.actorId - User who performed the action
   * @param {string} [options.actorName] - Actor's username
   * @param {string} [options.targetId] - Target user/entity ID
   * @param {string} [options.reason] - Reason for the action
   * @param {Object} [options.details] - Additional details
   */
  async log({ serverId, action, actorId, actorName, targetId, reason, details = {} }) {
    const logs = getLogs()
    
    const entry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      serverId,
      action,
      actorId,
      actorName: actorName || null,
      targetId: targetId || null,
      reason: reason || null,
      details,
      timestamp: new Date().toISOString()
    }
    
    // Keep only last 10000 logs per server to prevent file bloat
    const serverLogs = logs.filter(l => l.serverId === serverId)
    if (serverLogs.length >= 10000) {
      // Remove oldest logs for this server
      const sortedLogs = serverLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      const toRemove = new Set(sortedLogs.slice(0, serverLogs.length - 9999).map(l => l.id))
      const remainingLogs = logs.filter(l => !toRemove.has(l.id))
      remainingLogs.push(entry)
      saveLogs(remainingLogs)
    } else {
      logs.push(entry)
      saveLogs(logs)
    }
    
    return entry
  },
  
  /**
   * Get audit logs for a server
   * @param {string} serverId - Server ID
   * @param {Object} options - Query options
   * @param {string} [options.action] - Filter by action type
   * @param {string} [options.actorId] - Filter by actor
   * @param {string} [options.targetId] - Filter by target
   * @param {number} [options.limit=100] - Max results
   * @param {number} [options.offset=0] - Offset for pagination
   */
  getLogs(serverId, { action, actorId, targetId, limit = 100, offset = 0 } = {}) {
    let logs = getLogs().filter(l => l.serverId === serverId)
    
    if (action) {
      logs = logs.filter(l => l.action === action)
    }
    if (actorId) {
      logs = logs.filter(l => l.actorId === actorId)
    }
    if (targetId) {
      logs = logs.filter(l => l.targetId === targetId)
    }
    
    // Sort by timestamp descending (newest first)
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    
    return logs.slice(offset, offset + limit)
  },
  
  /**
   * Get total count of audit logs for a server
   * @param {string} serverId - Server ID
   * @param {Object} options - Query options
   */
  getLogCount(serverId, { action, actorId, targetId } = {}) {
    let logs = getLogs().filter(l => l.serverId === serverId)
    
    if (action) {
      logs = logs.filter(l => l.action === action)
    }
    if (actorId) {
      logs = logs.filter(l => l.actorId === actorId)
    }
    if (targetId) {
      logs = logs.filter(l => l.targetId === targetId)
    }
    
    return logs.length
  },
  
  /**
   * Clear all audit logs for a server
   * @param {string} serverId - Server ID
   */
  clearLogs(serverId) {
    const logs = getLogs().filter(l => l.serverId !== serverId)
    saveLogs(logs)
    return true
  }
}

export default auditLogService
