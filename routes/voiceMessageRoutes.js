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
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { fileService } from '../services/dataService.js'
import { cdnService } from '../services/cdnService.js'

const UPLOADS_DIR = cdnService.getUploadDir()
const UPLOADS_ROOT = path.resolve(UPLOADS_DIR)
const MAX_VOICE_FILE_BYTES = 20 * 1024 * 1024 // 20MB
const MAX_VOICE_DURATION_SECONDS = 15 * 60 // 15 minutes
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const SAFE_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

const router = express.Router()

// ── Multer config ─────────────────────────────────────────────────────────────
const ALLOWED_AUDIO_TYPES_BY_EXT = new Map([
  ['.webm', new Set(['audio/webm'])],
  ['.ogg', new Set(['audio/ogg'])],
  ['.mp4', new Set(['audio/mp4'])],
  ['.mp3', new Set(['audio/mpeg', 'audio/mp3'])],
  ['.wav', new Set(['audio/wav', 'audio/wave', 'audio/x-wav'])],
  ['.m4a', new Set(['audio/mp4', 'audio/x-m4a'])],
  ['.aac', new Set(['audio/aac'])],
  ['.flac', new Set(['audio/flac'])],
  ['.3gp', new Set(['audio/3gpp', 'audio/3gpp2'])],
])

const ALLOWED_AUDIO_SIGNATURES_BY_EXT = new Map([
  ['.webm', new Set(['webm'])],
  ['.ogg', new Set(['ogg'])],
  ['.mp4', new Set(['mp4'])],
  ['.mp3', new Set(['mp3'])],
  ['.wav', new Set(['wav'])],
  ['.m4a', new Set(['mp4'])],
  ['.aac', new Set(['aac'])],
  ['.flac', new Set(['flac'])],
  ['.3gp', new Set(['mp4'])],
])

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase()
    cb(null, `vm_${uuidv4()}${ext}`)
  },
})

const normalizeMime = (mimeType) => String(mimeType || '').split(';')[0].trim().toLowerCase()

const getValidatedAudioType = (file) => {
  const ext = path.extname(String(file?.originalname || '')).toLowerCase()
  const mime = normalizeMime(file?.mimetype)
  const allowedMimes = ALLOWED_AUDIO_TYPES_BY_EXT.get(ext)

  if (!allowedMimes || !allowedMimes.has(mime)) {
    return null
  }

  return { ext, mime }
}

const fileFilter = (_req, file, cb) => {
  const validatedType = getValidatedAudioType(file)
  if (!validatedType) {
    return cb(new Error(`Unsupported audio upload type: ${file.mimetype || 'unknown'}`), false)
  }
  return cb(null, true)
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_VOICE_FILE_BYTES,
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

const applyApiSecurityHeaders = (res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
}

const sanitizeFilename = (value) => {
  const filename = path.basename(String(value || '').trim())
  if (!filename || filename === '.' || filename === '..') return null
  if (!SAFE_FILENAME_PATTERN.test(filename)) return null
  return filename
}

const isPathWithinUploads = (candidatePath) => {
  const resolved = path.resolve(candidatePath)
  return resolved === UPLOADS_ROOT || resolved.startsWith(`${UPLOADS_ROOT}${path.sep}`)
}

const resolveLocalFilePath = (fileData) => {
  const storedPath = typeof fileData?.path === 'string' ? fileData.path.trim() : ''
  if (storedPath) {
    const resolvedStoredPath = path.resolve(storedPath)
    if (isPathWithinUploads(resolvedStoredPath)) {
      return resolvedStoredPath
    }
  }

  const safeFilename = sanitizeFilename(fileData?.filename)
  if (!safeFilename) return null

  const resolvedFromFilename = path.resolve(UPLOADS_ROOT, safeFilename)
  return isPathWithinUploads(resolvedFromFilename) ? resolvedFromFilename : null
}

const readSignature = async (filePath, size = 64) => {
  const fileHandle = await fs.promises.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await fileHandle.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await fileHandle.close()
  }
}

const detectAudioSignature = async (filePath) => {
  const data = await readSignature(filePath, 64)
  if (data.length < 4) return null

  const startsWith = (ascii) => data.length >= ascii.length && data.subarray(0, ascii.length).toString('ascii') === ascii
  const boxType = data.length >= 8 ? data.subarray(4, 8).toString('ascii') : ''

  const isAacAdts =
    data.length >= 2 &&
    data[0] === 0xff &&
    (data[1] & 0xf6) === 0xf0

  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return 'webm'
  if (startsWith('OggS')) return 'ogg'
  if (startsWith('fLaC')) return 'flac'
  if (startsWith('RIFF') && data.length >= 12 && data.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
  if (startsWith('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0 && !isAacAdts)) return 'mp3'
  if (isAacAdts) return 'aac'
  if (boxType === 'ftyp') return 'mp4'

  return null
}

const isAudioSignatureAllowedForExt = async (filePath, ext) => {
  const signature = await detectAudioSignature(filePath)
  const allowedSignatures = ALLOWED_AUDIO_SIGNATURES_BY_EXT.get(ext)
  return !!(signature && allowedSignatures && allowedSignatures.has(signature))
}

const sanitizeDuration = (rawDuration) => {
  if (rawDuration === undefined || rawDuration === null || rawDuration === '') return 0

  const parsed = Number(rawDuration)
  if (!Number.isFinite(parsed)) return null

  const duration = Math.round(parsed)
  if (duration < 0 || duration > MAX_VOICE_DURATION_SECONDS) return null
  return duration
}

const sanitizeContext = (rawContext) => {
  const context = String(rawContext || 'unknown').trim().toLowerCase()
  if (!context) return 'unknown'
  if (context === 'dm' || context === 'channel' || context === 'unknown') return context
  return 'unknown'
}

const sanitizeServerId = (rawServerId) => {
  if (rawServerId === undefined || rawServerId === null || String(rawServerId).trim() === '') {
    return null
  }
  const serverId = String(rawServerId).trim()
  return SAFE_SERVER_ID_PATTERN.test(serverId) ? serverId : null
}

const removeLocalFileIfPresent = (filePath) => {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.lstatSync(filePath)
      if (stats.isFile()) {
        fs.unlinkSync(filePath)
      }
    }
  } catch (err) {
    console.warn('[VoiceMsg] Failed to remove local file:', err.message)
  }
}

const uploadSingleVoice = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next()

    applyApiSecurityHeaders(res)
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'Voice message is too large',
          maxSizeBytes: MAX_VOICE_FILE_BYTES,
        })
      }
      return res.status(400).json({ error: 'Invalid voice message upload', message: err.message })
    }
    return res.status(400).json({ error: 'Invalid voice message upload', message: err.message })
  })
}

// ── POST /api/voice-message ───────────────────────────────────────────────────
// Upload a voice message blob.
// Body (multipart/form-data):
//   file      – the audio blob
//   duration  – recording duration in seconds (integer)
//   context   – "dm" | "channel" (optional, for logging)
//   serverId  – server ID (optional, for CDN routing)
router.post('/', authenticateToken, uploadSingleVoice, async (req, res) => {
  try {
    applyApiSecurityHeaders(res)

    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' })
    }

    const validatedType = getValidatedAudioType(req.file)
    if (!validatedType) {
      removeLocalFileIfPresent(req.file.path)
      return res.status(400).json({ error: 'Unsupported audio extension/mime combination' })
    }

    const audioSignatureValid = await isAudioSignatureAllowedForExt(req.file.path, validatedType.ext)
    if (!audioSignatureValid) {
      removeLocalFileIfPresent(req.file.path)
      return res.status(400).json({ error: 'Uploaded file content is not valid audio for the declared type' })
    }

    const duration = sanitizeDuration(req.body.duration)
    if (duration === null) {
      removeLocalFileIfPresent(req.file.path)
      return res.status(400).json({
        error: 'Invalid duration value',
        maxDurationSeconds: MAX_VOICE_DURATION_SECONDS,
      })
    }

    const serverIdRaw = req.body.serverId
    const hasServerId = serverIdRaw !== undefined && serverIdRaw !== null && String(serverIdRaw).trim() !== ''
    const serverId = sanitizeServerId(serverIdRaw)
    if (hasServerId && !serverId) {
      removeLocalFileIfPresent(req.file.path)
      return res.status(400).json({ error: 'Invalid serverId format' })
    }

    const context = sanitizeContext(req.body.context)

    const fileId = uuidv4()
    const safeOriginalName = sanitizeFilename(req.file.originalname) || `voice_message_${Date.now()}${validatedType.ext}`

    // Upload via CDN service (handles local vs S3/R2/etc.)
    const result = await cdnService.upload(req.file, {
      serverId,
      userId: req.user.id,
    })

    // Multer temp file is no longer needed after CDN/local service copy.
    removeLocalFileIfPresent(req.file.path)

    const attachment = {
      id: fileId,
      name: safeOriginalName,
      type: 'audio',
      mimetype: validatedType.mime,
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
    removeLocalFileIfPresent(req.file?.path)
    console.error('[VoiceMsg] Upload error:', err)
    res.status(500).json({ error: 'Voice message upload failed', message: err.message })
  }
})

// ── DELETE /api/voice-message/:fileId ─────────────────────────────────────────
// Delete a voice message. Only the uploader or an admin may delete.
router.delete('/:fileId', authenticateToken, async (req, res) => {
  try {
    applyApiSecurityHeaders(res)

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
      const safeRemoteFilename = sanitizeFilename(fileData.filename)
      if (!safeRemoteFilename) {
        return res.status(400).json({ error: 'Invalid stored filename' })
      }
      await cdnService.delete(safeRemoteFilename)
    } else {
      const localPath = resolveLocalFilePath(fileData)
      if (!localPath) {
        return res.status(400).json({ error: 'Invalid stored file path' })
      }

      if (fs.existsSync(localPath)) {
        const stats = fs.lstatSync(localPath)
        if (stats.isSymbolicLink()) {
          return res.status(400).json({ error: 'Refusing to delete symbolic link' })
        }
        if (stats.isFile()) {
          fs.unlinkSync(localPath)
        }
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
    applyApiSecurityHeaders(res)

    const fileData = fileService.getFile(req.params.fileId)
    if (!fileData) {
      return res.status(404).json({ error: 'Voice message not found' })
    }

    if (fileData.uploadedBy !== req.user.id && !isAdminFlag(req.user.isAdmin)) {
      // Return 404 to avoid file-ID enumeration by unauthorized users.
      return res.status(404).json({ error: 'Voice message not found' })
    }

    res.json(fileData)
  } catch (err) {
    console.error('[VoiceMsg] Metadata error:', err)
    res.status(500).json({ error: 'Failed to get metadata' })
  }
})

export default router
