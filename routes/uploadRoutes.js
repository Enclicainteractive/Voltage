import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { fileService } from '../services/dataService.js'
import { cdnService } from '../services/cdnService.js'
import config from '../config/config.js'
import { findFileOnPeer, proxyFileFromPeer } from '../services/scaleService.js'

const UPLOADS_DIR = cdnService.getUploadDir()
const UPLOADS_ROOT = path.resolve(UPLOADS_DIR)
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/

const BLOCKED_UPLOAD_EXTS = new Set([
  '.html',
  '.htm',
  '.svg',
  '.svgz',
  '.xhtml',
  '.xml',
  '.php',
  '.php3',
  '.php4',
  '.php5',
  '.php7',
  '.phtml',
  '.phar',
  '.asp',
  '.aspx',
  '.asa',
  '.cer',
  '.jsp',
  '.jspx',
  '.cgi',
  '.fcgi'
])

const BLOCKED_UPLOAD_MIMES = new Set([
  'text/html',
  'image/svg+xml',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/x-httpd-php',
  'application/x-php',
  'text/php'
])

const ALLOWED_UPLOAD_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/x-m4a',
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/css', 'text/javascript', 'application/json',
  'application/javascript', 'text/markdown', 'text/x-markdown',
  'text/csv', 'text/tab-separated-values'
])

const ALLOWED_UPLOAD_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico',
  '.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv',
  '.mp3', '.wav', '.m4a', '.flac', '.aac', '.wma',
  '.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx',
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.less',
  '.json', '.yaml', '.yml', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.java', '.py', '.rb', '.go', '.rs', '.swift',
  '.kt', '.kts', '.pl', '.r', '.m', '.mm', '.scala', '.groovy', '.lua',
  '.vim', '.dockerfile', '.makefile', '.cmake', '.gradle', '.txt', '.md', '.log',
  '.csv', '.tsv', '.ini', '.conf', '.cfg', '.env', '.gitignore'
])

const INLINE_SAFE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv',
  '.mp3', '.wav', '.m4a', '.flac', '.aac',
  '.pdf'
])

const CONTENT_TYPE_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values'
}

const normalizeMime = (mimeType) => String(mimeType || '').split(';')[0].trim().toLowerCase()
const isAdminFlag = (value) => value === true || value === 1 || value === '1' || value === 'true'

const sanitizeFilename = (value) => {
  const filename = path.basename(String(value || '').trim())
  if (!filename || filename === '.' || filename === '..') return null
  if (!SAFE_FILENAME_PATTERN.test(filename)) return null
  return filename
}

const isPathWithinUploads = (candidatePath) => {
  const resolved = path.resolve(candidatePath)
  return resolved.startsWith(`${UPLOADS_ROOT}${path.sep}`)
}

const resolveUploadPath = (value) => {
  const safeFilename = sanitizeFilename(value)
  if (!safeFilename) return null

  const resolvedPath = path.resolve(UPLOADS_ROOT, safeFilename)
  if (!isPathWithinUploads(resolvedPath)) return null

  return { safeFilename, resolvedPath }
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

const buildSafePeerRedirectUrl = (peerBaseUrl, routePath, safeFilename) => {
  if (!safeFilename) return null

  try {
    const peerUrl = new URL(String(peerBaseUrl || '').trim())
    if (!['http:', 'https:'].includes(peerUrl.protocol)) return null
    if (peerUrl.username || peerUrl.password) return null

    const normalizedPath = peerUrl.pathname.endsWith('/') && peerUrl.pathname !== '/'
      ? peerUrl.pathname.slice(0, -1)
      : peerUrl.pathname

    return `${peerUrl.origin}${normalizedPath}${routePath}/${encodeURIComponent(safeFilename)}`
  } catch {
    return null
  }
}

const applySafeFileHeaders = (res, filename, sizeInBytes) => {
  const ext = path.extname(filename).toLowerCase()
  const contentType = CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream'
  const dispositionType = INLINE_SAFE_EXTS.has(ext) ? 'inline' : 'attachment'
  const safeDownloadName = filename.replace(/"/g, '')

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', sizeInBytes)
  res.setHeader('Cache-Control', 'public, max-age=31536000')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.setHeader('Content-Disposition', `${dispositionType}; filename="${safeDownloadName}"`)
}

// Create uploads directory if it doesn't exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

const router = express.Router()

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    const filename = `${uuidv4()}${ext}`
    cb(null, filename)
  }
})

// File filter for allowed MIME types
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase()
  const mimeType = normalizeMime(file.mimetype)

  if (BLOCKED_UPLOAD_EXTS.has(ext) || BLOCKED_UPLOAD_MIMES.has(mimeType)) {
    return cb(new Error(`Blocked upload type: ${file.mimetype || ext || 'unknown'}`), false)
  }

  if (!ALLOWED_UPLOAD_EXTS.has(ext) && !ALLOWED_UPLOAD_MIMES.has(mimeType)) {
    console.warn(`[Upload] Rejected file type: ${file.mimetype} (${file.originalname})`)
    return cb(new Error(`Unsupported file type: ${file.mimetype || ext || 'unknown'}`), false)
  }

  return cb(null, true)
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB limit
    files: 10
  }
})

const uploadFields = upload.fields([
  { name: 'files', maxCount: 10 },
  { name: 'file', maxCount: 10 }
])

// Determine file type category
const getFileType = (mimetype, filename) => {
  const ext = path.extname(filename).toLowerCase()
  
  if (mimetype.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) {
    return 'image'
  }
  if (mimetype.startsWith('video/') || ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'].includes(ext)) {
    return 'video'
  }
  if (mimetype.startsWith('audio/') || ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma'].includes(ext)) {
    return 'audio'
  }
  
  // Code files
  const codeExts = [
    '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.sass', '.less',
    '.json', '.yaml', '.yml', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.java', '.py', '.rb', '.go', '.rs', '.swift',
    '.kt', '.kts', '.pl', '.r', '.m', '.mm', '.scala', '.groovy', '.lua'
  ]
  if (codeExts.includes(ext)) return 'code'
  
  // Text files
  const textExts = ['.txt', '.md', '.log', '.csv', '.tsv', '.ini', '.conf', '.cfg', '.env']
  if (textExts.includes(ext)) return 'text'
  
  return 'file'
}

// Format file size for display
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

const handleUpload = async (req, res) => {
  try {
    const uploadedFiles = Array.isArray(req.files)
      ? req.files
      : [
          ...((req.files && Array.isArray(req.files.files)) ? req.files.files : []),
          ...((req.files && Array.isArray(req.files.file)) ? req.files.file : [])
        ]

    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' })
    }

    const serverId = req.body.serverId || req.query.serverId || null

    const attachments = await Promise.all(uploadedFiles.map(async (file) => {
      const fileId = uuidv4()
      const fileType = getFileType(file.mimetype, file.originalname)
      
      const result = await cdnService.upload(file, {
        serverId,
        userId: req.user.id
      })

      const attachment = {
        id: fileId,
        name: file.originalname,
        type: fileType,
        mimetype: file.mimetype,
        size: formatFileSize(file.size),
        sizeBytes: file.size,
        url: result.url,
        filename: result.filename,
        path: result.path || null,
        provider: result.provider,
        cdn: result.cdn || false,
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.user.id,
        serverId: serverId
      }
      
      fileService.saveFile(attachment)
      
      return attachment
    }))

    console.log(`[API] Uploaded ${attachments.length} files by ${req.user.username || req.user.id}${serverId ? ` to server ${serverId}` : ''} (provider: ${cdnService.getProvider()})`)
    res.json({ attachments })
  } catch (err) {
    console.error('[API] Upload error:', err)
    res.status(500).json({ error: 'Upload failed', message: err.message })
  }
}

// Upload endpoint
router.post('/', authenticateToken, uploadFields, handleUpload)
router.post('/file', authenticateToken, uploadFields, handleUpload)

// Get file metadata
router.get('/metadata/:fileId', authenticateToken, (req, res) => {
  try {
    const fileData = fileService.getFile(req.params.fileId)
    if (!fileData) {
      return res.status(404).json({ error: 'File not found' })
    }

    if (fileData.uploadedBy !== req.user.id && !isAdminFlag(req.user.isAdmin)) {
      return res.status(404).json({ error: 'File not found' })
    }
    
    res.json(fileData)
  } catch (err) {
    console.error('[API] Get metadata error:', err)
    res.status(500).json({ error: 'Failed to get file metadata' })
  }
})

// Serve file by ID
router.get('/file/:filename', async (req, res) => {
  try {
    const resolved = resolveUploadPath(req.params.filename)
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid filename' })
    }
    const { safeFilename, resolvedPath: filePath } = resolved
    
    if (!fs.existsSync(filePath)) {
      // ── Scale fallback: ask peer nodes if they have it ────────────────────
      if (config.isScalingEnabled()) {
        const scaleCfg = config.getScalingConfig()
        const peerNode = await findFileOnPeer(safeFilename)

        if (peerNode) {
          const mode = scaleCfg.fileResolutionMode || 'proxy'

          if (mode === 'redirect') {
            // Redirect only to validated peer URLs; otherwise fall back to proxy mode.
            const peerUrl = buildSafePeerRedirectUrl(peerNode.url, '/api/upload/file', safeFilename)
            if (!peerUrl) {
              console.warn(`[Scale] Invalid peer redirect URL for node ${peerNode.id}; falling back to proxy`)
              return await proxyFileFromPeer(peerNode, safeFilename, res)
            }
            console.log(`[Scale] Redirecting ${safeFilename} to node ${peerNode.id}`)
            return res.redirect(302, peerUrl)
          } else {
            // Default: proxy the file through this node (hides peer topology)
            console.log(`[Scale] Proxying ${safeFilename} from node ${peerNode.id}`)
            return await proxyFileFromPeer(peerNode, safeFilename, res)
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      console.error(`[API] File not found: ${safeFilename}`)
      return res.status(404).json({ error: 'File not found' })
    }
    
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'File not found' })
    }

    applySafeFileHeaders(res, safeFilename, stat.size)
    
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('[API] Send file error:', err)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to serve file' })
        }
      }
    })
  } catch (err) {
    console.error('[API] File serve error:', err)
    res.status(500).json({ error: 'Failed to serve file' })
  }
})

// Legacy endpoint for backward compatibility
router.get('/:filename', async (req, res) => {
  try {
    const resolved = resolveUploadPath(req.params.filename)
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid filename' })
    }
    const { safeFilename, resolvedPath: filePath } = resolved
    
    if (!fs.existsSync(filePath)) {
      // Scale fallback for legacy path too
      if (config.isScalingEnabled()) {
        const scaleCfg = config.getScalingConfig()
        const peerNode = await findFileOnPeer(safeFilename)
        if (peerNode) {
          const mode = scaleCfg.fileResolutionMode || 'proxy'
          if (mode === 'redirect') {
            const peerUrl = buildSafePeerRedirectUrl(peerNode.url, '/api/upload', safeFilename)
            if (!peerUrl) {
              console.warn(`[Scale] Invalid peer redirect URL for node ${peerNode.id}; falling back to proxy`)
              return await proxyFileFromPeer(peerNode, safeFilename, res)
            }
            return res.redirect(302, peerUrl)
          } else {
            return await proxyFileFromPeer(peerNode, safeFilename, res)
          }
        }
      }
      return res.status(404).json({ error: 'File not found' })
    }

    const stat = fs.statSync(filePath)
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'File not found' })
    }

    applySafeFileHeaders(res, safeFilename, stat.size)
    res.sendFile(filePath)
  } catch (err) {
    console.error('[API] File serve error:', err)
    res.status(500).json({ error: 'Failed to serve file' })
  }
})

// Delete file
router.delete('/:fileId', authenticateToken, async (req, res) => {
  try {
    const fileData = fileService.getFile(req.params.fileId)
    
    if (!fileData) {
      return res.status(404).json({ error: 'File not found' })
    }
    
    if (fileData.uploadedBy !== req.user.id && !isAdminFlag(req.user.isAdmin)) {
      return res.status(403).json({ error: 'Not authorized to delete this file' })
    }
    
    if (fileData.provider !== 'local' && fileData.filename) {
      await cdnService.delete(fileData.filename)
    } else {
      const localPath = resolveLocalFilePath(fileData)
      if (!localPath) {
        return res.status(400).json({ error: 'Invalid local file path' })
      }

      if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
        fs.unlinkSync(localPath)
      }
    }
    
    fileService.deleteFile(req.params.fileId)
    
    console.log(`[API] Deleted file: ${req.params.fileId} (provider: ${fileData.provider || 'local'})`)
    res.json({ success: true })
  } catch (err) {
    console.error('[API] Delete error:', err)
    res.status(500).json({ error: 'Delete failed' })
  }
})

// Get user's uploaded files
router.get('/user/files', authenticateToken, (req, res) => {
  try {
    const files = fileService.getUserFiles(req.user.id)
    res.json({ files })
  } catch (err) {
    console.error('[API] Get user files error:', err)
    res.status(500).json({ error: 'Failed to get files' })
  }
})

// CDN status endpoint
router.get('/cdn/status', authenticateToken, (req, res) => {
  const cdnConfig = cdnService.getConfig()
  res.json(cdnConfig)
})

export default router
