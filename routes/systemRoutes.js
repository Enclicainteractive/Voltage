/**
 * systemRoutes.js
 *
 * REST API for system messages — the in-app inbox for Voltage-generated
 * notifications (update alerts, account standing, discovery status, announcements).
 *
 * All routes require authentication.
 * Admin-only routes additionally require the 'admin' platform role.
 */

import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { systemMessageService, adminService, userService } from '../services/dataService.js'
import { io } from '../server.js'

const router = express.Router()
router.use(authenticateToken)

// ---------------------------------------------------------------------------
// Middleware: platform admin guard
// ---------------------------------------------------------------------------
const requireAdmin = (req, res, next) => {
  if (!adminService.isAdmin(req.user.id)) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// ---------------------------------------------------------------------------
// User inbox
// ---------------------------------------------------------------------------

/** GET /api/system/messages — fetch inbox for the authenticated user */
router.get('/messages', (req, res) => {
  const messages = systemMessageService.getForUser(req.user.id)
  const unread = messages.filter(m => !m.read).length
  res.json({ messages, unread })
})

/** GET /api/system/messages/unread-count */
router.get('/messages/unread-count', (req, res) => {
  res.json({ count: systemMessageService.unreadCount(req.user.id) })
})

/** POST /api/system/messages/:messageId/read — mark one message read */
router.post('/messages/:messageId/read', (req, res) => {
  const ok = systemMessageService.markRead(req.user.id, req.params.messageId)
  if (!ok) return res.status(404).json({ error: 'Message not found' })
  res.json({ success: true })
})

/** POST /api/system/messages/read-all — mark all messages read */
router.post('/messages/read-all', (req, res) => {
  systemMessageService.markAllRead(req.user.id)
  res.json({ success: true })
})

/** DELETE /api/system/messages/:messageId — delete one message */
router.delete('/messages/:messageId', (req, res) => {
  const ok = systemMessageService.delete(req.user.id, req.params.messageId)
  if (!ok) return res.status(404).json({ error: 'Message not found' })
  res.json({ success: true })
})

/** DELETE /api/system/messages — clear entire inbox */
router.delete('/messages', (req, res) => {
  systemMessageService.clearAll(req.user.id)
  res.json({ success: true })
})

// ---------------------------------------------------------------------------
// Admin: send system messages
// ---------------------------------------------------------------------------

/**
 * POST /api/system/send — send a system message to one or more users
 * Body: { category, title, body, icon?, severity?, recipients, dedupeKey?, meta? }
 * recipients: array of user IDs  OR  the strings "all" | "admins" | "owners"
 */
router.post('/send', requireAdmin, (req, res) => {
  const { category, title, body, icon, severity, recipients, dedupeKey, meta } = req.body

  if (!category || !title || !body) {
    return res.status(400).json({ error: 'category, title, and body are required' })
  }

  // Resolve audience
  let targetIds = []
  if (recipients === 'all') {
    targetIds = userService.getAllUsers().map(u => u.id)
  } else if (recipients === 'admins') {
    targetIds = userService.getAllUsers()
      .filter(u => {
        const role = u.adminRole || u.role
        return role === 'admin' || role === 'owner' || u.isAdmin === true
      })
      .map(u => u.id)
  } else if (Array.isArray(recipients)) {
    targetIds = recipients
  } else {
    return res.status(400).json({ error: 'recipients must be an array of user IDs, "all", or "admins"' })
  }

  const created = systemMessageService.send({
    category, title, body, icon, severity, dedupeKey, meta,
    recipients: targetIds
  })

  // Push live socket event to all online recipients
  for (const msg of created) {
    io.to(`user:${msg.userId}`).emit('system:message', {
      ...msg,
      userId: undefined   // don't leak other users' IDs
    })
  }

  res.json({ sent: created.length, messages: created })
})

export default router
