import express from 'express'
import { authenticateToken } from '../middleware/authMiddleware.js'

const router = express.Router()

router.delete('/:messageId', authenticateToken, (req, res) => {
  res.json({ success: true })
})

export default router
