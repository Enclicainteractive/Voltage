import express from 'express'
import fs from 'fs'
import path from 'path'
import config from '../config/config.js'
import { userService } from '../services/dataService.js'
import { cdnService } from '../services/cdnService.js'

const router = express.Router()
const UPLOADS_DIR = cdnService.getUploadDir()
const UPLOADS_ROOT = path.resolve(UPLOADS_DIR)
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/

const ALLOWED_DATA_URL_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp'
])

const ALLOWED_MANAGED_IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.ico'
])

const CONTENT_TYPE_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

const applySafeImageHeaders = (res, mimeType, contentLength) => {
  res.setHeader('Content-Type', mimeType)
  res.setHeader('Content-Length', contentLength)
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

const sanitizeManagedFilename = (value) => {
  const filename = path.basename(String(value || '').trim())
  if (!filename || filename === '.' || filename === '..') return null
  if (!SAFE_FILENAME_PATTERN.test(filename)) return null
  if (!ALLOWED_MANAGED_IMAGE_EXTS.has(path.extname(filename).toLowerCase())) return null
  return filename
}

const resolveManagedUploadPath = (filename) => {
  const safeFilename = sanitizeManagedFilename(filename)
  if (!safeFilename) return null

  const filePath = path.resolve(UPLOADS_ROOT, safeFilename)
  if (!filePath.startsWith(`${UPLOADS_ROOT}${path.sep}`)) {
    return null
  }

  return { safeFilename, filePath }
}

const getStoredUserMedia = (userId, kind) => {
  // Try direct lookup first
  let profile = userService.getUser(userId)
  
  // If not found, try resolving by remoteUserId or localUserId (federated users)
  if (!profile) {
    const allUsers = userService.getAllUsers?.() || {}
    profile = Object.values(allUsers).find((u) => {
      if (!u) return false
      return u.id === userId || u.remoteUserId === userId || u.localUserId === userId
    })
  }
  
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
  if (!match?.[1]) return null

  let decodedFilename = match[1]
  try {
    decodedFilename = decodeURIComponent(decodedFilename)
  } catch {
    return null
  }

  return sanitizeManagedFilename(decodedFilename)
}

const serveDataUrl = (res, value) => {
  const match = String(value || '').match(DATA_URL_PATTERN)
  if (!match) return false
  const [, mimeTypeRaw, encoded] = match
  const mimeType = mimeTypeRaw.toLowerCase()

  if (!ALLOWED_DATA_URL_MIMES.has(mimeType)) {
    return false
  }

  const payload = Buffer.from(encoded, 'base64')
  if (!payload.length) return false

  applySafeImageHeaders(res, mimeType, payload.length)
  res.end(payload)
  return true
}

const serveManagedUpload = (res, filename) => {
  const resolved = resolveManagedUploadPath(filename)
  if (!resolved) return false
  const { safeFilename, filePath } = resolved
  if (!fs.existsSync(filePath)) return false
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) return false

  const ext = path.extname(safeFilename).toLowerCase()
  const mimeType = CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream'
  applySafeImageHeaders(res, mimeType, stat.size)
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

  // Do not redirect user-controlled profile/banner values.
  // Only data URLs and managed local uploads are served from this endpoint.
  return res.status(404).json({ error: `${kind} not found` })
}

router.get('/users/:userId/profile', handleUserImage('profile'))
router.get('/users/:userId/banner', handleUserImage('banner'))

export default router
