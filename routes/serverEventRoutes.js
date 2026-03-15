import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { io } from '../server.js'
import { serverEventService, serverService } from '../services/dataService.js'

const router = express.Router()

const getMemberRoles = (server, userId) => {
  const member = server?.members?.find(item => item.id === userId)
  if (!member) return []
  if (Array.isArray(member.roles)) return member.roles
  return member.role ? [member.role] : []
}

const canManageEvents = (server, userId) => {
  if (!server) return false
  if (server.ownerId === userId) return true
  const roleIds = getMemberRoles(server, userId)
  return roleIds.some(roleId => {
    const role = server.roles?.find(item => item.id === roleId)
    return role?.permissions?.includes('admin') ||
      role?.permissions?.includes('manage_server') ||
      role?.permissions?.includes('manage_events')
  })
}

const isMember = (server, userId) => {
  if (!server || !userId) return false
  if (server.ownerId === userId) return true
  return Array.isArray(server.members) && server.members.some(member => member.id === userId)
}

const handleUpcomingEvents = async (req, res) => {
  const serversRaw = serverService.getAllServers()
  const servers = Array.isArray(serversRaw) ? serversRaw : Object.values(serversRaw || {})
  const joinedServerIds = servers
    .filter(server => isMember(server, req.user.id))
    .map(server => server.id)

  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50)
  const events = serverEventService.getUpcomingEvents(joinedServerIds, limit)
  res.json(events)
}

router.get('/upcoming', authenticateToken, handleUpcomingEvents)
router.get('/events/upcoming', authenticateToken, handleUpcomingEvents)

router.get('/servers/:serverId/events', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!isMember(server, req.user.id)) return res.status(403).json({ error: 'Not authorized' })
  res.json(serverEventService.getServerEvents(req.params.serverId))
})

router.post('/servers/:serverId/events', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!canManageEvents(server, req.user.id)) return res.status(403).json({ error: 'Not authorized' })

  const event = {
    id: uuidv4(),
    serverId: req.params.serverId,
    title: String(req.body.title || '').trim(),
    description: String(req.body.description || '').trim(),
    location: String(req.body.location || '').trim(),
    startAt: req.body.startAt || null,
    endAt: req.body.endAt || null,
    coverImage: String(req.body.coverImage || '').trim() || null,
    createdBy: req.user.id,
    createdByName: req.user.username || req.user.email || 'Unknown',
    attendeeIds: Array.isArray(req.body.attendeeIds) ? req.body.attendeeIds : []
  }

  if (!event.title || !event.startAt) {
    return res.status(400).json({ error: 'Title and startAt are required' })
  }

  const created = await serverEventService.createEvent(event)
  io.to(`server:${req.params.serverId}`).emit('server:event-created', created)
  res.status(201).json(created)
})

router.put('/servers/:serverId/events/:eventId', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!canManageEvents(server, req.user.id)) return res.status(403).json({ error: 'Not authorized' })

  const updated = await serverEventService.updateEvent(req.params.eventId, {
    title: req.body.title,
    description: req.body.description,
    location: req.body.location,
    startAt: req.body.startAt,
    endAt: req.body.endAt,
    coverImage: req.body.coverImage,
    attendeeIds: Array.isArray(req.body.attendeeIds) ? req.body.attendeeIds : undefined
  })

  if (!updated || updated.serverId !== req.params.serverId) {
    return res.status(404).json({ error: 'Event not found' })
  }

  io.to(`server:${req.params.serverId}`).emit('server:event-updated', updated)
  res.json(updated)
})

router.delete('/servers/:serverId/events/:eventId', authenticateToken, async (req, res) => {
  const server = await serverService.getServer(req.params.serverId)
  if (!server) return res.status(404).json({ error: 'Server not found' })
  if (!canManageEvents(server, req.user.id)) return res.status(403).json({ error: 'Not authorized' })

  const deleted = await serverEventService.deleteEvent(req.params.eventId)
  if (!deleted || deleted.serverId !== req.params.serverId) {
    return res.status(404).json({ error: 'Event not found' })
  }

  io.to(`server:${req.params.serverId}`).emit('server:event-deleted', {
    serverId: req.params.serverId,
    eventId: req.params.eventId
  })
  res.json({ success: true })
})

export default router
