import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import { authenticateToken } from '../middleware/authMiddleware.js'
import { fileService } from '../services/dataService.js'
import { cdnService } from '../services/cdnService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = cdnService.getUploadDir()

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
  const allowedMimes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
    // Videos
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
    // Audio
    'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac', 'audio/x-m4a',
    // Documents
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Text & Code
    'text/plain', 'text/html', 'text/css', 'text/javascript', 'application/json',
    'application/javascript', 'text/markdown', 'text/x-markdown'
  ]
  
  // Also allow files based on common extensions
  const allowedExts = [
    '.js', '.jsx', '.ts', '.tsx', '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.java', '.py', '.rb', '.go', '.rs', '.swift',
    '.kt', '.kts', '.php', '.pl', '.r', '.m', '.mm', '.scala', '.groovy', '.lua',
    '.vim', '.dockerfile', '.makefile', '.cmake', '.gradle', '.txt', '.md', '.log',
    '.csv', '.tsv', '.ini', '.conf', '.cfg', '.env', '.gitignore'
  ]
  
  const ext = path.extname(file.originalname).toLowerCase()
  
  if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
    cb(null, true)
  } else {
    console.warn(`[Upload] Rejected file type: ${file.mimetype} (${file.originalname})`)
    cb(null, true) // Allow anyway for now, but log it
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 10
  }
})

// Determine file type category
const getFileType = (mimetype, filename) => {
  const ext = path.extname(filename).toLowerCase()
  
  if (mimetype.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext)) {
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
    '.js', '.jsx', '.ts', '.tsx', '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.java', '.py', '.rb', '.go', '.rs', '.swift',
    '.kt', '.kts', '.php', '.pl', '.r', '.m', '.mm', '.scala', '.groovy', '.lua'
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

// Upload endpoint
router.post('/', authenticateToken, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' })
    }

    const serverId = req.body.serverId || null

    const attachments = await Promise.all(req.files.map(async (file) => {
      const fileId = uuidv4()
      const ext = path.extname(file.originalname)
      const storedFilename = `${fileId}${ext}`
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
      
      fileService.saveFile(fileId, attachment)
      
      return attachment
    }))

    console.log(`[API] Uploaded ${attachments.length} files by ${req.user.username || req.user.id}${serverId ? ` to server ${serverId}` : ''} (provider: ${cdnService.getProvider()})`)
    res.json({ attachments })
  } catch (err) {
    console.error('[API] Upload error:', err)
    res.status(500).json({ error: 'Upload failed', message: err.message })
  }
})

// Get file metadata
router.get('/metadata/:fileId', authenticateToken, (req, res) => {
  try {
    const fileData = fileService.getFile(req.params.fileId)
    if (!fileData) {
      return res.status(404).json({ error: 'File not found' })
    }
    
    res.json(fileData)
  } catch (err) {
    console.error('[API] Get metadata error:', err)
    res.status(500).json({ error: 'Failed to get file metadata' })
  }
})

// Serve file by ID
router.get('/file/:filename', (req, res) => {
  try {
    const filePath = path.join(UPLOADS_DIR, req.params.filename)
    
    if (!fs.existsSync(filePath)) {
      console.error(`[API] File not found: ${req.params.filename}`)
      return res.status(404).json({ error: 'File not found' })
    }
    
    // Get file stats
    const stat = fs.statSync(filePath)
    const ext = path.extname(req.params.filename).toLowerCase()
    
    // Set appropriate content type based on extension
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.ogg': 'video/ogg',
      '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.md': 'text/markdown'
    }
    
    const contentType = contentTypes[ext] || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', stat.size)
    res.setHeader('Cache-Control', 'public, max-age=31536000')
    
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
router.get('/:filename', (req, res) => {
  try {
    const filePath = path.join(UPLOADS_DIR, req.params.filename)
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' })
    }
    
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
    
    if (fileData.uploadedBy !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Not authorized to delete this file' })
    }
    
    if (fileData.provider !== 'local' && fileData.filename) {
      await cdnService.delete(fileData.filename)
    } else if (fileData.path) {
      if (fs.existsSync(fileData.path)) {
        fs.unlinkSync(fileData.path)
      }
    } else {
      const localPath = path.join(UPLOADS_DIR, fileData.filename)
      if (fs.existsSync(localPath)) {
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
