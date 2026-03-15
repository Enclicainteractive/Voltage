import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

class FileUploadSecurity {
  constructor() {
    this.allowedExtensions = new Set([
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico',
      '.mp3', '.wav', '.ogg', '.webm',
      '.mp4', '.webm', '.mov',
      '.pdf', '.txt', '.md', '.json',
      '.zip', '.gz', '.tar',
    ])
    
    this.allowedMimeTypes = new Map([
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.png', 'image/png'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp'],
      ['.svg', 'image/svg+xml'],
      ['.ico', 'image/x-icon'],
      ['.mp3', 'audio/mpeg'],
      ['.wav', 'audio/wav'],
      ['.ogg', 'audio/ogg'],
      ['.webm', 'audio/webm'],
      ['.mp4', 'video/mp4'],
      ['.webm', 'video/webm'],
      ['.mov', 'video/quicktime'],
      ['.pdf', 'application/pdf'],
      ['.txt', 'text/plain'],
      ['.md', 'text/markdown'],
      ['.json', 'application/json'],
      ['.zip', 'application/zip'],
      ['.gz', 'application/gzip'],
      ['.tar', 'application/x-tar'],
    ])
    
    this.maxFileSize = 10 * 1024 * 1024
    this.maxUploadSize = 50 * 1024 * 1024
    
    this.dangerousExtensions = new Set([
      '.exe', '.bat', '.cmd', '.sh', '.bash', '.ps1', '.vbs', '.js', '.jar',
      '.scr', '.pif', '.msi', '.dll', '.so', '.dylib',
      '.html', '.htm', '.xhtml', '.php', '.asp', '.jsp',
      '.xml', '.xsl', '.xslt', '.svg',
      '.sql', '.db', '.sqlite',
      '.key', '.pem', '.crt', '.cer',
    ])
  }

  validateFilename(filename) {
    if (!filename || typeof filename !== 'string') {
      return { valid: false, error: 'Invalid filename' }
    }

    const sanitized = filename
      .replace(/[^\w\s\-\.]/g, '')
      .replace(/\.{2,}/g, '.')
      .trim()

    if (sanitized.length === 0 || sanitized.length > 255) {
      return { valid: false, error: 'Invalid filename length' }
    }

    if (sanitized !== filename) {
      return { valid: false, error: 'Filename contains invalid characters' }
    }

    return { valid: true, sanitized }
  }

  validateExtension(filename) {
    const ext = path.extname(filename).toLowerCase()
    
    if (!ext || ext.length === 0) {
      return { valid: false, error: 'No file extension' }
    }

    if (this.dangerousExtensions.has(ext)) {
      return { valid: false, error: 'File type not allowed' }
    }

    if (!this.allowedExtensions.has(ext)) {
      return { valid: false, error: 'Unknown file extension' }
    }

    return { valid: true, extension: ext }
  }

  validateMimeType(filename, mimeType) {
    const ext = path.extname(filename).toLowerCase()
    const allowedMime = this.allowedMimeTypes.get(ext)
    
    if (!allowedMime) {
      return { valid: false, error: 'Cannot verify file type' }
    }

    if (allowedMime !== mimeType && !mimeType.startsWith(allowedMime.split('/')[0])) {
      return { valid: false, error: 'MIME type mismatch' }
    }

    return { valid: true }
  }

  validateFileSize(size, contentLength) {
    if (size > this.maxFileSize) {
      return { valid: false, error: 'File too large' }
    }

    if (contentLength > this.maxUploadSize) {
      return { valid: false, error: 'Upload too large' }
    }

    return { valid: true }
  }

  generateSecureFilename(originalName) {
    const ext = path.extname(originalName).toLowerCase()
    const hash = crypto.randomBytes(8).toString('hex')
    const timestamp = Date.now()
    return `${timestamp}-${hash}${ext}`
  }

  async scanFile(filePath) {
    try {
      const stats = fs.statSync(filePath)
      
      if (stats.size === 0) {
        return { valid: false, error: 'Empty file' }
      }

      const buffer = Buffer.alloc(512)
      const fd = fs.openSync(filePath, 'r')
      fs.readSync(fd, buffer, 0, 512, 0)
      fs.closeSync(fd)

      const signatures = [
        { magic: 'ffd8', type: 'jpeg' },
        { magic: '8950', type: 'png' },
        { magic: '4749', type: 'gif' },
        { magic: '2550', type: 'pdf' },
        { magic: '504b', type: 'zip' },
        { magic: '1f8b', type: 'gzip' },
      ]

      const hex = buffer.toString('hex').substring(0, 4)
      
      for (const sig of signatures) {
        if (hex.startsWith(sig.magic)) {
          return { valid: true, detected: sig.type }
        }
      }

      if (buffer[0] === 0x89 && buffer[1] === 0x50) {
        return { valid: true, detected: 'png' }
      }

      return { valid: true, detected: 'unknown' }
    } catch (err) {
      return { valid: false, error: err.message }
    }
  }

  validateUpload(filename, size, mimeType, contentLength) {
    const filenameResult = this.validateFilename(filename)
    if (!filenameResult.valid) return filenameResult

    const extResult = this.validateExtension(filename)
    if (!extResult.valid) return extResult

    const sizeResult = this.validateFileSize(size, contentLength)
    if (!sizeResult.valid) return sizeResult

    return { valid: true }
  }

  cleanupOldFiles(directory, maxAgeDays = 7) {
    try {
      const now = Date.now()
      const maxAge = maxAgeDays * 24 * 60 * 60 * 1000
      
      if (!fs.existsSync(directory)) return 0
      
      let deleted = 0
      const files = fs.readdirSync(directory)
      
      for (const file of files) {
        const filePath = path.join(directory, file)
        const stats = fs.statSync(filePath)
        
        if (stats.isFile() && (now - stats.mtimeMs) > maxAge) {
          fs.unlinkSync(filePath)
          deleted++
        }
      }
      
      return deleted
    } catch (err) {
      console.error('[FileSecurity] Cleanup error:', err.message)
      return 0
    }
  }
}

const fileUploadSecurity = new FileUploadSecurity()

setInterval(() => {
  fileUploadSecurity.cleanupOldFiles(UPLOADS_DIR, 30)
}, 24 * 60 * 60 * 1000)

export default fileUploadSecurity
