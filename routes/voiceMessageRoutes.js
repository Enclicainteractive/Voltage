/**
 * Voice Message Routes
 * Dedicated upload/delete/serve endpoints for voice messages.
 * Stores duration + isVoiceMessage metadata alongside the file record
 * so clients can render the voice player correctly.
 */

import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { fileService } from '../services/dataService.js'
import { cdnService } from '../services/cdnService.js'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = cdnService.getUploadDir()

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

const router = express.Router()

// ── Multer config ─────────────────────────────────────────────────────────────
// Accept all common audio MIME types including the codec-qualified variants
// that browsers emit (e.g. "audio/webm;codecs=opus").
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/webm; codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/ogg; codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/aac',
  'audio/flac',
  'audio/x-m4a',
  'audio/3gpp',
  'audio/3gpp2',
])

const ALLOWED_AUDIO_EXTS = new Set([
  '.webm', '.ogg', '.mp4', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.3gp',
])

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    // Preserve the original extension; fall back to .webm (most common from browsers)
    const ext = path.extname(file.originalname) || '.webm'
    cb(null, `vm_${uuidv4()}${ext}`)
  },
})

const fileFilter = (_req, file, cb) => {
  // Strip codec parameters for the MIME check
  const baseMime = (file.mimetype || '').split(';')[0].trim().toLowerCase()
  const ext = path.extname(file.originalname).toLowerCase()

  if (
    ALLOWED_AUDIO_MIMES.has(file.mimetype) ||
    ALLOWED_AUDIO_MIMES.has(baseMime) ||
    baseMime.startsWith('audio/') ||
    ALLOWED_AUDIO_EXTS.has(ext)
  ) {
    cb(null, true)
  } else {
    cb(new Error(`Unsupported audio type: ${file.mimetype}`), false)
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit
    files: 1,
  },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const isAdminFlag = (v) => v === true || v === 1 || v === '1' || v === 'true'

// ── POST /api/voice-message ───────────────────────────────────────────────────
// Upload a voice message blob.
// Body (multipart/form-data):
//   file      – the audio blob
//   duration  – recording duration in seconds (integer)
//   context   – "dm" | "channel" (optional, for logging)
//   serverId  – server ID (optional, for CDN routing)
router.post('/', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' })
    }

    const duration = parseInt(req.body.duration, 10) || 0
    const serverId = req.body.serverId || null
    const context = req.body.context || 'unknown'

    const fileId = uuidv4()
    const ext = path.extname(req.file.originalname) || '.webm'

    // Upload via CDN service (handles local vs S3/R2/etc.)
    const result = await cdnService.upload(req.file, {
      serverId,
      userId: req.user.id,
    })

    const attachment = {
      id: fileId,
      name: req.file.originalname || `voice_message_${Date.now()}${ext}`,
      type: 'audio',
      mimetype: req.file.mimetype,
      size: formatFileSize(req.file.size),
      sizeBytes: req.file.size,
      url: result.url,
      filename: result.filename,
      path: result.path || null,
      provider: result.provider,
      cdn: result.cdn || false,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.user.id,
      serverId,
      // Voice-message specific metadata
      isVoiceMessage: true,
      duration,
      context,
    }

    fileService.saveFile(attachment)

    console.log(
      `[VoiceMsg] Uploaded by ${req.user.username || req.user.id}` +
      ` | duration=${duration}s | size=${attachment.size}` +
      ` | context=${context} | provider=${result.provider}`
    )

    res.json({ attachment })
  } catch (err) {
    console.error('[VoiceMsg] Upload error:', err)
    res.status(500).json({ error: 'Voice message upload failed', message: err.message })
  }
})

// ── DELETE /api/voice-message/:fileId ─────────────────────────────────────────
// Delete a voice message. Only the uploader or an admin may delete.
router.delete('/:fileId', authenticateToken, async (req, res) => {
  try {
    const fileData = fileService.getFile(req.params.fileId)

    if (!fileData) {
      return res.status(404).json({ error: 'Voice message not found' })
    }

    // Authorisation check
    if (fileData.uploadedBy !== req.user.id && !isAdminFlag(req.user.isAdmin)) {
      return res.status(403).json({ error: 'Not authorised to delete this voice message' })
    }

    // Remove from storage
    if (fileData.provider && fileData.provider !== 'local' && fileData.filename) {
      await cdnService.delete(fileData.filename)
    } else {
      const localPath = fileData.path || path.join(UPLOADS_DIR, fileData.filename || '')
      if (localPath && fs.existsSync(localPath)) {
        fs.unlinkSync(localPath)
      }
    }

    fileService.deleteFile(req.params.fileId)

    console.log(`[VoiceMsg] Deleted ${req.params.fileId} by ${req.user.username || req.user.id}`)
    res.json({ success: true })
  } catch (err) {
    console.error('[VoiceMsg] Delete error:', err)
    res.status(500).json({ error: 'Delete failed', message: err.message })
  }
})

// ── GET /api/voice-message/metadata/:fileId ───────────────────────────────────
// Retrieve stored metadata for a voice message (duration, uploader, etc.)
router.get('/metadata/:fileId', authenticateToken, (req, res) => {
  try {
    const fileData = fileService.getFile(req.params.fileId)
    if (!fileData) {
      return res.status(404).json({ error: 'Voice message not found' })
    }
    res.json(fileData)
  } catch (err) {
    console.error('[VoiceMsg] Metadata error:', err)
    res.status(500).json({ error: 'Failed to get metadata' })
  }
})

export default router
