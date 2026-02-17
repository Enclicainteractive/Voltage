import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { discoveryService } from '../services/dataService.js'

const router = express.Router()

router.get('/', (req, res) => {
  const { limit = 50, offset = 0, category, search } = req.query
  const result = discoveryService.getApprovedServers(
    parseInt(limit),
    parseInt(offset),
    category,
    search
  )
  res.json(result)
})

router.get('/categories', (req, res) => {
  const categories = discoveryService.getCategories()
  res.json(categories)
})

router.post('/submit', authenticateToken, (req, res) => {
  const { serverId, description, category } = req.body
  
  if (!serverId) {
    return res.status(400).json({ error: 'Server ID is required' })
  }
  
  const result = discoveryService.submitServer(serverId, description, category, req.user.id)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  res.status(201).json(result)
})

router.delete('/:serverId', authenticateToken, (req, res) => {
  const result = discoveryService.removeFromDiscovery(req.params.serverId)
  res.json(result)
})

router.get('/status/:serverId', authenticateToken, (req, res) => {
  const isInDiscovery = discoveryService.isInDiscovery(req.params.serverId)
  const submissions = discoveryService.getPendingSubmissions()
  const submission = submissions.find(s => s.serverId === req.params.serverId)
  
  res.json({
    isInDiscovery,
    submission: submission || null
  })
})

router.get('/admin/pending', authenticateToken, (req, res) => {
  const submissions = discoveryService.getPendingSubmissions()
  res.json(submissions)
})

router.post('/admin/approve/:submissionId', authenticateToken, (req, res) => {
  const result = discoveryService.approveSubmission(req.params.submissionId)
  
  if (result.error) {
    return res.status(400).json({ error: result.error })
  }
  
  res.json(result)
})

router.post('/admin/reject/:submissionId', authenticateToken, (req, res) => {
  const result = discoveryService.rejectSubmission(req.params.submissionId)
  res.json(result)
})

export default router
