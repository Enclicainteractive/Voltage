import { serverService } from './dataService.js'

// Default automod configuration
const DEFAULT_AUTOMOD_CONFIG = {
  enabled: false,
  testingMode: false,
  logChannelId: null,
  rules: {
    wordFilter: {
      enabled: false,
      words: [],
      action: 'delete', // 'delete', 'warn', 'mute'
      warnMessage: 'Your message contained a blocked word.'
    },
    spamProtection: {
      enabled: false,
      maxMessages: 5,
      timeWindow: 3000, // 3 seconds
      action: 'warn'
    },
    linkBlock: {
      enabled: false,
      action: 'delete',
      allowlist: [],
      warnMessage: 'Links are not allowed in this channel.'
    },
    mentionSpam: {
      enabled: false,
      maxMentions: 5,
      timeWindow: 10000, // 10 seconds
      action: 'warn'
    },
    capsFilter: {
      enabled: false,
      minLength: 10,
      minCapsPercent: 70,
      action: 'warn'
    },
    inviteBlock: {
      enabled: false,
      action: 'delete',
      warnMessage: 'Discord invites are not allowed.'
    },
    customRules: []
  },
  warnSettings: {
    maxWarnings: 3,
    action: 'kick', // 'kick', 'ban', 'mute'
    duration: null // for mute duration
  }
}

// Get automod config from server data
const getConfig = (serverId) => {
  const server = serverService.getServer(serverId)

  if (!server) {
    return { ...DEFAULT_AUTOMOD_CONFIG }
  }

  // Return existing config or default
  return server.automod || { ...DEFAULT_AUTOMOD_CONFIG }
}

// Save automod config to server data
const saveConfig = async (serverId, config) => {
  const server = serverService.getServer(serverId)

  if (!server) {
    return { error: 'Server not found' }
  }
  
  // Update server's automod config via updateServer
  await serverService.updateServer(serverId, {
    automod: config,
    updatedAt: new Date().toISOString()
  })
  
  return config
}

export const automodService = {
  /**
   * Get automod configuration for a server
   * @param {string} serverId - Server ID
   */
  async getAutomodConfig(serverId) {
    const config = getConfig(serverId)
    return config
  },
  
  /**
   * Update automod configuration
   * @param {string} serverId - Server ID
   * @param {Object} updates - Config updates
   * @param {string} userId - User making the change
   */
  async updateAutomodConfig(serverId, updates, userId) {
    const currentConfig = getConfig(serverId)
    
    // Deep merge updates
    const newConfig = {
      ...currentConfig,
      ...updates,
      rules: {
        ...currentConfig.rules,
        ...(updates.rules || {})
      },
      warnSettings: {
        ...currentConfig.warnSettings,
        ...(updates.warnSettings || {})
      }
    }
    
    // Handle nested rule objects
    if (updates.rules) {
      for (const [ruleName, ruleData] of Object.entries(updates.rules)) {
        if (ruleData && typeof ruleData === 'object' && !Array.isArray(ruleData)) {
          newConfig.rules[ruleName] = {
            ...currentConfig.rules[ruleName],
            ...ruleData
          }
        } else if (Array.isArray(ruleData)) {
          // Custom rules array
          newConfig.rules[ruleName] = ruleData
        }
      }
    }
    
    const result = await saveConfig(serverId, newConfig)
    
    if (result.error) {
      return result
    }
    
    return newConfig
  },
  
  /**
   * Check a message against automod rules
   * @param {string} serverId - Server ID
   * @param {Object} message - Message object
   * @returns {Object} - Result with action and details
   */
  async checkMessage(serverId, message) {
    const config = getConfig(serverId)
    
    if (!config.enabled) {
      return { allowed: true }
    }
    
    const { content, authorId, channelId } = message
    
    // Check exemptions
    // (Implementation would need to check if user/channel/role is exempted)
    
    const violations = []
    
    // Word filter
    if (config.rules.wordFilter?.enabled && config.rules.wordFilter.words?.length > 0) {
      const messageLower = content.toLowerCase()
      for (const word of config.rules.wordFilter.words) {
        if (messageLower.includes(word.toLowerCase())) {
          violations.push({
            rule: 'wordFilter',
            action: config.rules.wordFilter.action,
            message: config.rules.wordFilter.warnMessage
          })
          break
        }
      }
    }
    
    // Caps filter
    if (config.rules.capsFilter?.enabled && content.length >= config.rules.capsFilter.minLength) {
      const capsCount = (content.match(/[A-Z]/g) || []).length
      const capsPercent = (capsCount / content.length) * 100
      if (capsPercent >= config.rules.capsFilter.minCapsPercent) {
        violations.push({
          rule: 'capsFilter',
          action: config.rules.capsFilter.action,
          message: 'Please avoid excessive caps.'
        })
      }
    }
    
    // Mention spam
    if (config.rules.mentionSpam?.enabled) {
      const mentionCount = (content.match(/@/g) || []).length
      if (mentionCount > config.rules.mentionSpam.maxMentions) {
        violations.push({
          rule: 'mentionSpam',
          action: config.rules.mentionSpam.action,
          message: 'Too many mentions.'
        })
      }
    }
    
    // Link block
    if (config.rules.linkBlock?.enabled) {
      const urlRegex = /https?:\/\/[^\s]+/gi
      const urls = content.match(urlRegex)
      if (urls) {
        // Check allowlist
        const blocked = urls.filter(url => {
          const hostname = new URL(url).hostname
          return !config.rules.linkBlock.allowlist.some(domain => hostname.includes(domain))
        })
        if (blocked.length > 0) {
          violations.push({
            rule: 'linkBlock',
            action: config.rules.linkBlock.action,
            message: config.rules.linkBlock.warnMessage
          })
        }
      }
    }
    
    // Invite block
    if (config.rules.inviteBlock?.enabled) {
      const inviteRegex = /(discord\.gg|discordapp\.com\/invite)\/[a-zA-Z0-9]+/gi
      if (inviteRegex.test(content)) {
        violations.push({
          rule: 'inviteBlock',
          action: config.rules.inviteBlock.action,
          message: config.rules.inviteBlock.warnMessage
        })
      }
    }
    
    // Custom rules
    if (config.rules.customRules?.length > 0) {
      for (const rule of config.rules.customRules) {
        if (!rule.enabled) continue
        try {
          const regex = new RegExp(rule.pattern, 'gi')
          if (regex.test(content)) {
            violations.push({
              rule: 'customRules',
              customRuleId: rule.id,
              action: rule.action,
              message: rule.warnMessage
            })
          }
        } catch (err) {
          console.error(`[Automod] Invalid regex in custom rule ${rule.id}:`, err.message)
        }
      }
    }
    
    if (violations.length > 0) {
      return { 
        allowed: false, 
        violations,
        // Return the most severe action
        action: violations[0].action
      }
    }
    
    return { allowed: true }
  },
  
  /**
   * Get warnings for a user
   * @param {string} serverId - Server ID
   * @param {string} userId - User ID
   */
  async getWarnings(serverId, userId) {
    const config = getConfig(serverId)
    return config.warnings?.[userId] || []
  },
  
  /**
   * Add a warning to a user
   * @param {string} serverId - Server ID
   * @param {string} userId - User ID
   * @param {Object} warning - Warning details
   */
  async addWarning(serverId, userId, warning) {
    const config = getConfig(serverId)
    
    if (!config.warnings) {
      config.warnings = {}
    }
    
    if (!config.warnings[userId]) {
      config.warnings[userId] = []
    }
    
    const warningEntry = {
      id: `warn_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      reason: warning.reason || 'No reason provided',
      rule: warning.rule,
      issuedAt: new Date().toISOString(),
      issuedBy: warning.issuedBy
    }
    
    config.warnings[userId].push(warningEntry)
    
    // Check if max warnings reached
    const warnSettings = config.warnSettings || {}
    const maxWarnings = warnSettings.maxWarnings || 3
    const userWarnings = config.warnings[userId]
    
    if (userWarnings.length >= maxWarnings && warnSettings.action) {
      return {
        warningAdded: warningEntry,
        actionTriggered: warnSettings.action,
        action: 'max_warnings_reached'
      }
    }
    
    await saveConfig(serverId, config)
    
    return {
      warningAdded: warningEntry,
      actionTriggered: null
    }
  },
  
  /**
   * Clear warnings for a user
   * @param {string} serverId - Server ID
   * @param {string} userId - User ID
   */
  async clearWarnings(serverId, userId) {
    const config = getConfig(serverId)
    
    if (config.warnings && config.warnings[userId]) {
      delete config.warnings[userId]
      await saveConfig(serverId, config)
    }
    
    return { success: true }
  }
}

export default automodService
