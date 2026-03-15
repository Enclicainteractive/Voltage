import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import automodService from '../services/automodService.js'
import { serverService } from '../services/dataService.js'
import { auditLogService, AUDIT_ACTIONS } from '../services/auditLogService.js'
import { io } from '../server.js'

const router = express.Router()

// Helper to check if user can manage automod
const canManageAutomod = (server, userId) => {
  if (server.ownerId === userId) return true
  
  const member = server.members?.find(m => m.id === userId)
  if (!member) return false
  
  const roles = member.roles || []
  for (const roleId of roles) {
    const role = server.roles?.find(r => r.id === roleId)
    if (role?.permissions?.includes('admin') || role?.permissions?.includes('manage_server')) {
      return true
    }
  }
  
  return false
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTOMOD CONFIG - Get and update automod settings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get automod configuration for a server
 * GET /api/servers/:serverId/automod
 */
router.get('/servers/:serverId/automod', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  res.json(config)
})

/**
 * Update automod configuration
 * PUT /api/servers/:serverId/automod
 */
router.put('/servers/:serverId/automod', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    req.body,
    req.user.id
  )
  
  // Log with actor name
  await auditLogService.log({
    serverId: req.params.serverId,
    action: AUDIT_ACTIONS.AUTOMOD_CONFIG_UPDATE,
    actorId: req.user.id,
    actorName: req.user.username || req.user.email,
    details: { config: result }
  })
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  // Notify server members of config update
  io.to(`server:${req.params.serverId}`).emit('automod:config-updated', {
    serverId: req.params.serverId,
    config: result
  })
  
  res.json(result)
})

/**
 * Enable/disable automod testing mode
 * Testing mode makes the owner subject to automod rules
 * POST /api/servers/:serverId/automod/testing-mode
 */
router.post('/servers/:serverId/automod/testing-mode', authenticateToken, async (req, res) => {
  const { enabled } = req.body
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  // Only owner can toggle testing mode
  if (server.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Only the server owner can toggle testing mode' })
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { testingMode: Boolean(enabled) },
    req.user.id
  )
  
  io.to(`server:${req.params.serverId}`).emit('automod:testing-mode', {
    serverId: req.params.serverId,
    testingMode: Boolean(enabled)
  })
  
  res.json({ success: true, testingMode: Boolean(enabled) })
})

/**
 * Enable/disable automod
 * POST /api/servers/:serverId/automod/toggle
 */
router.post('/servers/:serverId/automod/toggle', authenticateToken, async (req, res) => {
  const { enabled } = req.body
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { enabled: Boolean(enabled) },
    req.user.id
  )
  
  io.to(`server:${req.params.serverId}`).emit('automod:toggled', {
    serverId: req.params.serverId,
    enabled: Boolean(enabled)
  })
  
  res.json({ success: true, enabled: Boolean(enabled) })
})

// ═══════════════════════════════════════════════════════════════════════════
// WORD FILTER - Blocked words/phrases
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update word filter settings
 * PUT /api/servers/:serverId/automod/word-filter
 */
router.put('/servers/:serverId/automod/word-filter', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  config.rules.wordFilter = {
    ...config.rules.wordFilter,
    ...req.body
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(result.rules.wordFilter)
})

/**
 * Add blocked word
 * POST /api/servers/:serverId/automod/word-filter/words
 */
router.post('/servers/:serverId/automod/word-filter/words', authenticateToken, async (req, res) => {
  const { word } = req.body
  
  if (!word || typeof word !== 'string') {
    return res.status(400).json({ error: 'Word is required' })
  }
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  
  if (!config.rules.wordFilter.words) {
    config.rules.wordFilter.words = []
  }
  
  // Add word if not already present
  if (!config.rules.wordFilter.words.includes(word)) {
    config.rules.wordFilter.words.push(word)
  }
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json({ success: true, words: config.rules.wordFilter.words })
})

/**
 * Remove blocked word
 * DELETE /api/servers/:serverId/automod/word-filter/words/:word
 */
router.delete('/servers/:serverId/automod/word-filter/words/:word', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  
  if (config.rules.wordFilter.words) {
    config.rules.wordFilter.words = config.rules.wordFilter.words.filter(
      w => w !== req.params.word
    )
  }
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json({ success: true, words: config.rules.wordFilter.words })
})

// ═══════════════════════════════════════════════════════════════════════════
// SPAM PROTECTION - Rate limiting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update spam protection settings
 * PUT /api/servers/:serverId/automod/spam-protection
 */
router.put('/servers/:serverId/automod/spam-protection', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  config.rules.spamProtection = {
    ...config.rules.spamProtection,
    ...req.body
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(result.rules.spamProtection)
})

// ═══════════════════════════════════════════════════════════════════════════
// LINK BLOCK - URL filtering
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update link block settings
 * PUT /api/servers/:serverId/automod/link-block
 */
router.put('/servers/:serverId/automod/link-block', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  config.rules.linkBlock = {
    ...config.rules.linkBlock,
    ...req.body
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(result.rules.linkBlock)
})

/**
 * Add allowed domain
 * POST /api/servers/:serverId/automod/link-block/allowlist
 */
router.post('/servers/:serverId/automod/link-block/allowlist', authenticateToken, async (req, res) => {
  const { domain } = req.body
  
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'Domain is required' })
  }
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  
  if (!config.rules.linkBlock.allowlist) {
    config.rules.linkBlock.allowlist = []
  }
  
  if (!config.rules.linkBlock.allowlist.includes(domain)) {
    config.rules.linkBlock.allowlist.push(domain)
  }
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json({ success: true, allowlist: config.rules.linkBlock.allowlist })
})

/**
 * Remove allowed domain
 * DELETE /api/servers/:serverId/automod/link-block/allowlist/:domain
 */
router.delete('/servers/:serverId/automod/link-block/allowlist/:domain', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  
  if (config.rules.linkBlock.allowlist) {
    config.rules.linkBlock.allowlist = config.rules.linkBlock.allowlist.filter(
      d => d !== req.params.domain
    )
  }
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json({ success: true, allowlist: config.rules.linkBlock.allowlist })
})

// ═══════════════════════════════════════════════════════════════════════════
// MENTION SPAM - Mention limits
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update mention spam settings
 * PUT /api/servers/:serverId/automod/mention-spam
 */
router.put('/servers/:serverId/automod/mention-spam', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  config.rules.mentionSpam = {
    ...config.rules.mentionSpam,
    ...req.body
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(result.rules.mentionSpam)
})

// ═══════════════════════════════════════════════════════════════════════════
// CAPS FILTER - Excessive caps
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update caps filter settings
 * PUT /api/servers/:serverId/automod/caps-filter
 */
router.put('/servers/:serverId/automod/caps-filter', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  config.rules.capsFilter = {
    ...config.rules.capsFilter,
    ...req.body
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(result.rules.capsFilter)
})

// ═══════════════════════════════════════════════════════════════════════════
// INVITE BLOCK - Discord invite blocking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Update invite block settings
 * PUT /api/servers/:serverId/automod/invite-block
 */
router.put('/servers/:serverId/automod/invite-block', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  config.rules.inviteBlock = {
    ...config.rules.inviteBlock,
    ...req.body
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(result.rules.inviteBlock)
})

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM RULES - Regex-based rules
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add custom rule
 * POST /api/servers/:serverId/automod/custom-rules
 */
router.post('/servers/:serverId/automod/custom-rules', authenticateToken, async (req, res) => {
  const { name, pattern, action = 'delete', warnMessage, exemptRoles, exemptChannels } = req.body
  
  if (!name || !pattern) {
    return res.status(400).json({ error: 'Name and pattern are required' })
  }
  
  // Validate regex
  try {
    new RegExp(pattern, 'gi')
  } catch (err) {
    return res.status(400).json({ error: 'Invalid regex pattern' })
  }
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  
  if (!config.rules.customRules) {
    config.rules.customRules = []
  }
  
  const rule = {
    id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    name,
    pattern,
    action,
    warnMessage: warnMessage || 'Your message violated a server rule.',
    exemptRoles: exemptRoles || [],
    exemptChannels: exemptChannels || [],
    enabled: true,
    createdAt: new Date().toISOString()
  }
  
  config.rules.customRules.push(rule)
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(rule)
})

/**
 * Update custom rule
 * PUT /api/servers/:serverId/automod/custom-rules/:ruleId
 */
router.put('/servers/:serverId/automod/custom-rules/:ruleId', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  
  if (!config.rules.customRules) {
    return res.status(404).json({ error: 'Rule not found' })
  }
  
  const ruleIndex = config.rules.customRules.findIndex(r => r.id === req.params.ruleId)
  if (ruleIndex === -1) {
    return res.status(404).json({ error: 'Rule not found' })
  }
  
  // Validate regex if pattern provided
  if (req.body.pattern) {
    try {
      new RegExp(req.body.pattern, 'gi')
    } catch (err) {
      return res.status(400).json({ error: 'Invalid regex pattern' })
    }
  }
  
  config.rules.customRules[ruleIndex] = {
    ...config.rules.customRules[ruleIndex],
    ...req.body,
    updatedAt: new Date().toISOString()
  }
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json(config.rules.customRules[ruleIndex])
})

/**
 * Delete custom rule
 * DELETE /api/servers/:serverId/automod/custom-rules/:ruleId
 */
router.delete('/servers/:serverId/automod/custom-rules/:ruleId', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  
  if (!config.rules.customRules) {
    return res.status(404).json({ error: 'Rule not found' })
  }
  
  config.rules.customRules = config.rules.customRules.filter(r => r.id !== req.params.ruleId)
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json({ success: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// EXEMPTIONS - Role and channel exemptions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add exemption to a rule
 * POST /api/servers/:serverId/automod/exemptions
 */
router.post('/servers/:serverId/automod/exemptions', authenticateToken, async (req, res) => {
  const { ruleName, type, id } = req.body // type: 'role' or 'channel', id: roleId or channelId
  
  if (!ruleName || !type || !id) {
    return res.status(400).json({ error: 'ruleName, type, and id are required' })
  }
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  const rule = config.rules[ruleName]
  
  if (!rule) {
    return res.status(404).json({ error: 'Rule not found' })
  }
  
  const list = type === 'role' ? 'exemptRoles' : 'exemptChannels'
  if (!rule[list]) rule[list] = []
  
  if (!rule[list].includes(id)) {
    rule[list].push(id)
  }
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json({ success: true, [list]: rule[list] })
})

/**
 * Remove exemption from a rule
 * DELETE /api/servers/:serverId/automod/exemptions
 */
router.delete('/servers/:serverId/automod/exemptions', authenticateToken, async (req, res) => {
  const { ruleName, type, id } = req.body
  
  if (!ruleName || !type || !id) {
    return res.status(400).json({ error: 'ruleName, type, and id are required' })
  }
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  const rule = config.rules[ruleName]
  
  if (!rule) {
    return res.status(404).json({ error: 'Rule not found' })
  }
  
  const list = type === 'role' ? 'exemptRoles' : 'exemptChannels'
  if (rule[list]) {
    rule[list] = rule[list].filter(i => i !== id)
  }
  
  await automodService.updateAutomodConfig(
    req.params.serverId,
    { rules: config.rules },
    req.user.id
  )
  
  res.json({ success: true, [list]: rule[list] })
})

// ═══════════════════════════════════════════════════════════════════════════
// WARNINGS - User warning management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get warnings for a user
 * GET /api/servers/:serverId/automod/warnings/:userId
 */
router.get('/servers/:serverId/automod/warnings/:userId', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const warnings = await automodService.getWarnings(req.params.serverId, req.params.userId)
  res.json(warnings)
})

/**
 * Clear warnings for a user
 * DELETE /api/servers/:serverId/automod/warnings/:userId
 */
router.delete('/servers/:serverId/automod/warnings/:userId', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  await automodService.clearWarnings(req.params.serverId, req.params.userId)
  
  // Log the action
  await auditLogService.log({
    serverId: req.params.serverId,
    action: AUDIT_ACTIONS.AUTOMOD_WARN_CLEAR,
    actorId: req.user.id,
    actorName: req.user.username || req.user.email,
    targetId: req.params.userId,
    reason: 'Warnings cleared manually'
  })
  
  res.json({ success: true })
})

/**
 * Update warn settings
 * PUT /api/servers/:serverId/automod/warn-settings
 */
router.put('/servers/:serverId/automod/warn-settings', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const config = await automodService.getAutomodConfig(req.params.serverId)
  config.warnSettings = {
    ...config.warnSettings,
    ...req.body
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { warnSettings: config.warnSettings },
    req.user.id
  )
  
  res.json(result.warnSettings)
})

// ═══════════════════════════════════════════════════════════════════════════
// LOG CHANNEL - Set channel for automod logs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set automod log channel
 * PUT /api/servers/:serverId/automod/log-channel
 */
router.put('/servers/:serverId/automod/log-channel', authenticateToken, async (req, res) => {
  const { channelId } = req.body
  
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  
  if (!canManageAutomod(server, req.user.id)) {
    return res.status(403).json({ error: 'Not authorized' })
  }
  
  const result = await automodService.updateAutomodConfig(
    req.params.serverId,
    { logChannelId: channelId || null },
    req.user.id
  )
  
  res.json({ success: true, logChannelId: result.logChannelId })
})

export default router