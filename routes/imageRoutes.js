import express from 'express'
import fs from 'fs'
import path from 'path'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'
import { cdnService } from '../services/cdnService.js'

const router = express.Router()
const UPLOADS_DIR = cdnService.getUploadDir()

const DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/

const getStoredUserMedia = (userId, kind) => {
  const profile = userService.getUser(userId)
  if (!profile) return null
  if (kind === 'banner') return String(profile.banner || '').trim() || null
  return String(profile.imageUrl || profile.imageurl || profile.avatar || '').trim() || null
}

const getManagedUploadFilename = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const baseUrls = [
    config.getImageServerUrl(),
    config.getServerUrl()
  ]
    .map(value => String(value || '').replace(/\/$/, ''))
    .filter(Boolean)

  let normalized = raw
  for (const baseUrl of baseUrls) {
    if (normalized.startsWith(baseUrl)) {
      normalized = normalized.slice(baseUrl.length)
      break
    }
  }

  const match = normalized.match(/^\/api\/upload\/file\/([^/?#]+)$/)
  return match?.[1] || null
}

const serveDataUrl = (res, value) => {
  const match = String(value || '').match(DATA_URL_PATTERN)
  if (!match) return false
  const [, mimeType, encoded] = match
  const payload = Buffer.from(encoded, 'base64')
  res.setHeader('Content-Type', mimeType)
  res.setHeader('Content-Length', payload.length)
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.end(payload)
  return true
}

const serveManagedUpload = (res, filename) => {
  if (!filename) return false
  const filePath = path.join(UPLOADS_DIR, filename)
  if (!fs.existsSync(filePath)) return false
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.sendFile(filePath)
  return true
}

const handleUserImage = (kind) => (req, res) => {
  const value = getStoredUserMedia(req.params.userId, kind)
  if (!value) {
    return res.status(404).json({ error: `${kind} not found` })
  }

  if (serveDataUrl(res, value)) {
    return
  }

  const uploadFilename = getManagedUploadFilename(value)
  if (serveManagedUpload(res, uploadFilename)) {
    return
  }

  if (/^https?:\/\//i.test(value)) {
    return res.redirect(302, value)
  }

  if (value.startsWith('/api/upload/file/')) {
    return res.redirect(302, value)
  }

  return res.status(404).json({ error: `${kind} not found` })
}

router.get('/users/:userId/profile', handleUserImage('profile'))
router.get('/users/:userId/banner', handleUserImage('banner'))

export default router
