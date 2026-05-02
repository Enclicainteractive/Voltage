import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { adminService, channelService, globalBanService, messageService, moderationReportService, serverBanService, serverService, userService } from '../services/dataService.js'
import config from '../config/config.js'

const router = express.Router()

const getUserId = (req) => req.user?.id || req.user?.userId || null

const isConfiguredAdmin = (userId) => {
  if (!userId) return false
  const adminUsers = config.config.security?.adminUsers || []
  return adminUsers.includes(userId)
}

const isModeratorRequest = (req) => {
  const userId = getUserId(req)
  return !!(isConfiguredAdmin(userId) || (userId && adminService.isModerator(userId)))
}

const requireModerator = (req, res, next) => {
  if (!isModeratorRequest(req)) {
    return res.status(403).json({ error: 'Moderator access required' })
  }
  next()
}

const bool = (value) => value === true
const MAX_REASON_LENGTH = 1000
const MAX_USER_REPORTS_PER_10_MIN = 15
const ALLOWED_USER_REPORT_CONTEXTS = new Set(['server', 'server_message', 'user_profile'])

const sanitizeFlags = (flags = {}) => ({
  nsfw: bool(flags.nsfw),
  sexualizedMinorRisk: bool(flags.sexualizedMinorRisk),
  violenceGore: bool(flags.violenceGore),
  sexualContentText: bool(flags.sexualContentText),
  groomingRisk: bool(flags.groomingRisk),
  coercionThreats: bool(flags.coercionThreats),
  selfHarmEncouragement: bool(flags.selfHarmEncouragement),
  modelVersion: typeof flags.modelVersion === 'string' ? flags.modelVersion : null,
  policyVersion: typeof flags.policyVersion === 'string' ? flags.policyVersion : null,
  checkedAt: typeof flags.checkedAt === 'string' ? flags.checkedAt : new Date().toISOString()
})

const hasThreatSignal = (flags) => {
  return !!(flags.groomingRisk || flags.coercionThreats || flags.selfHarmEncouragement || flags.sexualizedMinorRisk)
}

const sanitizeReason = (value) => {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_REASON_LENGTH)
}

const normalizeId = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const resolveReportBoundTarget = ({ req, overrideValue, reportValue, label }) => {
  const overrideId = normalizeId(overrideValue)
  const reportId = normalizeId(reportValue)
  const configuredAdmin = isConfiguredAdmin(getUserId(req))

  if (overrideId && overrideId !== reportId && !configuredAdmin) {
    return { status: 403, error: `Only configured admins can override ${label}` }
  }

  const target = overrideId || reportId
  if (!target) {
    return { status: 400, error: `No ${label} available for this report` }
  }
  return { target }
}

const toReportMetaView = (report) => ({
  id: report.id,
  status: report.status,
  reportType: report.reportType,
  contextType: report.contextType,
  accusedUserId: report.accusedUserId || null,
  targetUserId: report.targetUserId || null,
  channelId: report.channelId || null,
  conversationId: report.conversationId || null,
  clientMeta: {
    reason: report.clientMeta?.reason || null,
    serverId: report.clientMeta?.serverId || null,
    serverName: report.clientMeta?.serverName || null,
    messageId: report.clientMeta?.messageId || null,
    messagePreview: report.clientMeta?.messagePreview || null
  },
  createdAt: report.createdAt,
  updatedAt: report.updatedAt,
  resolvedAt: report.resolvedAt || null
})

const isServerMember = (server, userId) => {
  if (!server || !userId) return false
  if (server.ownerId === userId) return true
  const members = Array.isArray(server.members) ? server.members : []
  return members.some((m) => {
    if (typeof m === 'string') return m === userId
    if (!m || typeof m !== 'object') return false
    return m.id === userId || m.userId === userId
  })
}

const getVerifiedAge = (profile) => {
  const av = profile?.ageVerification
  if (!av?.verified) return null
  const age = Number(av?.age ?? av?.estimatedAge)
  if (Number.isFinite(age) && age > 0) return age
  if (av?.category === 'child') return 17
  return null
}

router.post('/reports', authenticateToken, async (req, res) => {
  const body = req.body || {}
  const flags = sanitizeFlags(body.contentFlags || {})

  if (!hasThreatSignal(flags)) {
    return res.status(400).json({ error: 'Threat signal required for reporting' })
  }

  const report = await moderationReportService.create({
    reporterId: req.user.id,
    accusedUserId: body.accusedUserId || null,
    targetUserId: body.targetUserId || null,
    conversationId: body.conversationId || null,
    channelId: body.channelId || null,
    contextType: typeof body.contextType === 'string' ? body.contextType : 'unknown',
    reportType: typeof body.reportType === 'string' ? body.reportType : 'threat',
    priority: body.priority || 'high',
    contentFlags: flags,
    clientMeta: {
      policyVersion: flags.policyVersion,
      modelVersion: flags.modelVersion,
      clientSignature: typeof body.clientSignature === 'string' ? body.clientSignature : null,
      senderAgeContext: body.senderAgeContext || null,
      targetAgeContext: body.targetAgeContext || null,
      localOnlyModeration: true,
      e2eeSafeReport: true,
      createdAt: new Date().toISOString()
    }
  })

  const accusedUserId = report.accusedUserId || null
  const targetUserId = report.targetUserId || null
  let autoAction = null
  const reporterCanTakeModerationActions = isModeratorRequest(req)

  if (accusedUserId && targetUserId) {
    const target = await userService.getUser(targetUserId)
    const targetAge = getVerifiedAge(target)
    const targetUnder16 = Number.isFinite(targetAge) && targetAge < 16

    const severeMinorRisk = targetUnder16 && (flags.groomingRisk || flags.sexualizedMinorRisk || flags.coercionThreats)
    if (severeMinorRisk && reporterCanTakeModerationActions) {
      await globalBanService.banUser(accusedUserId, {
        reason: 'Safety auto-action: threat/minor-risk content targeting verified under-16 user',
        bannedBy: 'system:safety',
        banType: 'permanent'
      })

      await moderationReportService.appendAction(report.id, {
        action: 'auto_ban_user',
        actor: 'system:safety',
        targetUserId: accusedUserId,
        reason: 'target_under_16_severe_minor_risk'
      })

      await adminService.logAction('system:safety', 'auto_ban_user', accusedUserId, {
        reportId: report.id,
        reason: 'target_under_16_severe_minor_risk'
      })

      autoAction = {
        type: 'ban_user',
        targetUserId: accusedUserId,
        reason: 'target_under_16_severe_minor_risk'
      }
    }
  }

  res.status(201).json({
    id: report.id,
    status: report.status,
    autoAction
  })
})

router.post('/reports/user', authenticateToken, async (req, res) => {
  const body = req.body || {}
  const contextType = typeof body.contextType === 'string' ? body.contextType : ''
  if (!ALLOWED_USER_REPORT_CONTEXTS.has(contextType)) {
    return res.status(400).json({ error: 'Invalid report context' })
  }

  const reason = sanitizeReason(body.reason)
  if (reason.length < 3) {
    return res.status(400).json({ error: 'Report reason is required' })
  }

  const recentReportCount = await moderationReportService.countRecentByReporter(req.user.id, 10)
  if (recentReportCount >= MAX_USER_REPORTS_PER_10_MIN) {
    return res.status(429).json({ error: 'Too many reports in a short time window' })
  }

  let accusedUserId = body.accusedUserId || null
  let targetUserId = body.targetUserId || null
  let channelId = body.channelId || null
  let conversationId = body.conversationId || null
  let serverId = typeof body.serverId === 'string' ? body.serverId : null
  let serverName = typeof body.serverName === 'string' ? body.serverName : null
  let messageId = typeof body.messageId === 'string' ? body.messageId : null
  let messagePreview = typeof body.messagePreview === 'string' ? body.messagePreview.slice(0, 240) : null

  if (contextType === 'server') {
    if (!serverId) return res.status(400).json({ error: 'serverId is required for server reports' })
    const server = await serverService.getServer(serverId)
    if (!server) return res.status(404).json({ error: 'Server not found' })
    if (!isServerMember(server, req.user.id)) {
      return res.status(403).json({ error: 'You can only report servers you are part of' })
    }
    serverName = serverName || server.name || null
    accusedUserId = accusedUserId || server.ownerId || null
  }

  if (contextType === 'server_message') {
    if (!messageId) return res.status(400).json({ error: 'messageId is required for message reports' })
    const message = await messageService.getMessage(messageId)
    if (!message) return res.status(404).json({ error: 'Message not found' })

    const channel = await channelService.getChannel(message.channelId)
    if (!channel) return res.status(404).json({ error: 'Channel not found for message' })

    const server = await serverService.getServer(channel.serverId)
    if (!server) return res.status(404).json({ error: 'Server not found for message' })
    if (!isServerMember(server, req.user.id)) {
      return res.status(403).json({ error: 'You can only report messages from servers you are part of' })
    }

    channelId = message.channelId
    serverId = channel.serverId
    serverName = serverName || server.name || null
    accusedUserId = accusedUserId || message.userId || null
    messagePreview = messagePreview || (typeof message.content === 'string' ? message.content.slice(0, 240) : null)
  }

  if (contextType === 'user_profile') {
    if (!accusedUserId) return res.status(400).json({ error: 'accusedUserId is required for user reports' })
    if (accusedUserId === req.user.id) return res.status(400).json({ error: 'Cannot report yourself' })
    const accused = await userService.getUser(accusedUserId)
    if (!accused) return res.status(404).json({ error: 'Reported user not found' })
  }

  const duplicate = await moderationReportService.findOpenDuplicateForReporter(req.user.id, {
    contextType,
    channelId,
    conversationId,
    accusedUserId,
    targetUserId,
    reportType: 'user_report',
    serverId,
    messageId
  })
  if (duplicate) {
    return res.status(409).json({
      error: 'Duplicate open report already exists',
      reportId: duplicate.id
    })
  }

  const report = await moderationReportService.create({
    reporterId: req.user.id,
    accusedUserId,
    targetUserId,
    conversationId,
    channelId,
    contextType,
    reportType: 'user_report',
    priority: body.priority || 'normal',
    contentFlags: sanitizeFlags(body.contentFlags || {}),
    clientMeta: {
      reason,
      messageId,
      serverId,
      serverName,
      messagePreview,
      localOnlyModeration: true,
      manualUserReport: true,
      createdAt: new Date().toISOString()
    }
  })

  res.status(201).json({
    id: report.id,
    status: report.status
  })
})

router.get('/reports/my', authenticateToken, async (req, res) => {
  const { status, limit = 100, offset = 0 } = req.query
  const reports = await moderationReportService.listByReporter(req.user.id, {
    status: status || null,
    limit: Math.min(parseInt(limit, 10) || 100, 200),
    offset: parseInt(offset, 10) || 0
  })
  res.json(reports.map(toReportMetaView))
})

router.get('/reports/my/:reportId', authenticateToken, async (req, res) => {
  const report = await moderationReportService.getByIdForReporter(req.params.reportId, req.user.id)
  if (!report) return res.status(404).json({ error: 'Report not found' })
  res.json(toReportMetaView(report))
})

router.get('/reports', authenticateToken, requireModerator, async (req, res) => {
  const { status, limit = 100, offset = 0 } = req.query
  const reports = await moderationReportService.list({
    status: status || null,
    limit: Math.min(parseInt(limit, 10) || 100, 500),
    offset: parseInt(offset, 10) || 0
  })
  res.json(reports)
})

router.get('/reports/:reportId', authenticateToken, requireModerator, async (req, res) => {
  const report = await moderationReportService.getById(req.params.reportId)
  if (!report) return res.status(404).json({ error: 'Report not found' })
  res.json(report)
})

router.post('/reports/:reportId/resolve', authenticateToken, requireModerator, async (req, res) => {
  const { status = 'resolved', note = null } = req.body || {}
  const updated = await moderationReportService.resolve(req.params.reportId, {
    status,
    resolvedBy: req.user.id,
    note
  })
  if (!updated) return res.status(404).json({ error: 'Report not found' })

  await adminService.logAction(req.user.id, 'resolve_safety_report', req.params.reportId, {
    status,
    note
  })

  res.json(updated)
})

router.post('/reports/:reportId/ban-user', authenticateToken, requireModerator, async (req, res) => {
  const report = await moderationReportService.getById(req.params.reportId)
  if (!report) return res.status(404).json({ error: 'Report not found' })

  const targetUserResolution = resolveReportBoundTarget({
    req,
    overrideValue: req.body?.userId,
    reportValue: report.accusedUserId,
    label: 'target user'
  })
  if (targetUserResolution.error) {
    return res.status(targetUserResolution.status).json({ error: targetUserResolution.error })
  }
  const targetUserId = targetUserResolution.target

  await globalBanService.banUser(targetUserId, {
    reason: req.body?.reason || `Manual safety action from report ${report.id}`,
    bannedBy: req.user.id,
    banType: 'permanent'
  })

  await moderationReportService.appendAction(report.id, {
    action: 'manual_ban_user',
    actor: req.user.id,
    targetUserId,
    reason: req.body?.reason || null
  })

  await adminService.logAction(req.user.id, 'ban_user_from_safety_report', targetUserId, {
    reportId: report.id
  })

  res.json({ success: true, userId: targetUserId })
})

router.post('/reports/:reportId/delete-message', authenticateToken, requireModerator, async (req, res) => {
  const report = await moderationReportService.getById(req.params.reportId)
  if (!report) return res.status(404).json({ error: 'Report not found' })

  const messageResolution = resolveReportBoundTarget({
    req,
    overrideValue: req.body?.messageId,
    reportValue: report.clientMeta?.messageId,
    label: 'messageId'
  })
  if (messageResolution.error) {
    return res.status(messageResolution.status).json({ error: messageResolution.error })
  }
  const messageId = messageResolution.target

  const message = await messageService.getMessage(messageId)
  if (!message) {
    return res.status(404).json({ error: 'Message not found' })
  }

  await messageService.deleteMessage(messageId)

  await moderationReportService.appendAction(report.id, {
    action: 'manual_delete_message',
    actor: req.user.id,
    messageId
  })

  if (req.body?.resolve !== false) {
    await moderationReportService.resolve(report.id, {
      status: 'resolved',
      resolvedBy: req.user.id,
      note: `message_deleted:${messageId}`
    })
  }

  await adminService.logAction(req.user.id, 'delete_message_from_safety_report', messageId, {
    reportId: report.id
  })

  res.json({ success: true, messageId })
})

router.post('/reports/:reportId/ban-server', authenticateToken, requireModerator, async (req, res) => {
  const report = await moderationReportService.getById(req.params.reportId)
  if (!report) return res.status(404).json({ error: 'Report not found' })

  const serverResolution = resolveReportBoundTarget({
    req,
    overrideValue: req.body?.serverId,
    reportValue: report.clientMeta?.serverId,
    label: 'serverId'
  })
  if (serverResolution.error) {
    return res.status(serverResolution.status).json({ error: serverResolution.error })
  }
  const serverId = serverResolution.target

  const server = await serverService.getServer(serverId)
  if (!server) {
    return res.status(404).json({ error: 'Server not found' })
  }

  await serverBanService.banServer(serverId, {
    userId: server.ownerId || null,
    reason: req.body?.reason || `Manual safety action from report ${report.id}`,
    bannedBy: req.user.id
  })

  await moderationReportService.appendAction(report.id, {
    action: 'manual_ban_server',
    actor: req.user.id,
    serverId,
    reason: req.body?.reason || null
  })

  if (req.body?.resolve !== false) {
    await moderationReportService.resolve(report.id, {
      status: 'resolved',
      resolvedBy: req.user.id,
      note: `server_banned:${serverId}`
    })
  }

  await adminService.logAction(req.user.id, 'ban_server_from_safety_report', serverId, {
    reportId: report.id
  })

  res.json({ success: true, serverId })
})

export default router
