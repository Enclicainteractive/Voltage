import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import config from '../config/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

class CDNService {
  constructor() {
    this.config = config.config.cdn || {}
    this.enabled = this.config.enabled || false
    this.provider = this.config.provider || 'local'
  }

  async upload(file, options = {}) {
    const { filename, mimetype, originalname } = file
    
    const ext = path.extname(originalname)
    const fileId = uuidv4()
    const storedFilename = `${fileId}${ext}`

    if (this.enabled && this.provider !== 'local') {
      return this.uploadToCDN(file, storedFilename, options)
    }

    return this.uploadLocal(file, storedFilename, options)
  }

  async uploadLocal(file, storedFilename, options = {}) {
    const destPath = path.join(UPLOADS_DIR, storedFilename)
    
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(file.path)
      const writeStream = fs.createWriteStream(destPath)

      readStream.on('error', reject)
      writeStream.on('error', reject)
      writeStream.on('finish', () => {
        resolve({
          success: true,
          provider: 'local',
          fileId: path.basename(storedFilename, path.extname(storedFilename)),
          filename: storedFilename,
          url: `/api/upload/file/${storedFilename}`,
          path: destPath,
          size: file.size
        })
      })

      readStream.pipe(writeStream)
    })
  }

  async uploadToCDN(file, storedFilename, options = {}) {
    const cdnConfig = this.config[this.provider]
    
    if (!cdnConfig) {
      console.warn(`[CDN] Provider ${this.provider} not configured, falling back to local`)
      return this.uploadLocal(file, storedFilename, options)
    }

    try {
      switch (this.provider) {
        case 's3':
          return await this.uploadToS3(file, storedFilename, cdnConfig, options)
        case 'cloudflare':
          return await this.uploadToCloudflare(file, storedFilename, cdnConfig, options)
        default:
          console.warn(`[CDN] Unknown provider ${this.provider}, using local`)
          return this.uploadLocal(file, storedFilename, options)
      }
    } catch (error) {
      console.error(`[CDN] Upload failed with ${this.provider}:`, error.message)
      console.warn('[CDN] Falling back to local storage')
      return this.uploadLocal(file, storedFilename, options)
    }
  }

  async uploadToS3(file, filename, s3Config, options) {
    let S3Client, PutObjectCommand
    
    try {
      ({ S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3'))
    } catch {
      throw new Error('AWS SDK not installed')
    }

    const client = new S3Client({
      region: s3Config.region || 'us-east-1',
      credentials: s3Config.accessKeyId && s3Config.secretAccessKey ? {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey
      } : undefined,
      endpoint: s3Config.endpoint,
      forcePathStyle: !!s3Config.endpoint
    })

    const fileBuffer = fs.readFileSync(file.path)
    
    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: filename,
      Body: fileBuffer,
      ContentType: file.mimetype,
      ACL: 'public-read'
    })

    await client.send(command)

    const publicUrl = s3Config.publicUrl 
      ? `${s3Config.publicUrl}/${filename}`
      : `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${filename}`

    return {
      success: true,
      provider: 's3',
      fileId: path.basename(filename, path.extname(filename)),
      filename,
      url: publicUrl,
      cdn: true
    }
  }

  async uploadToCloudflare(file, filename, cfConfig, options) {
    let R2
    
    try {
      ({ R2 } = await import('@aws-sdk/client-r2'))
    } catch {
      throw new Error('AWS SDK (R2) not installed')
    }

    const client = new R2({
      region: 'auto',
      credentials: cfConfig.accessKeyId && cfConfig.secretAccessKey ? {
        accessKeyId: cfConfig.accessKeyId,
        secretAccessKey: cfConfig.secretAccessKey
      } : undefined,
      endpoint: `https://${cfConfig.accountId}.r2.cloudflarestorage.com`
    })

    const fileBuffer = fs.readFileSync(file.path)

    const command = new R2.PutObjectCommand({
      Bucket: cfConfig.bucket,
      Key: filename,
      Body: fileBuffer,
      ContentType: file.mimetype
    })

    await client.send(command)

    const publicUrl = cfConfig.publicUrl 
      ? `${cfConfig.publicUrl}/${filename}`
      : `https://${cfConfig.bucket}.${cfConfig.accountId}.r2.cloudflarestorage.com/${filename}`

    return {
      success: true,
      provider: 'cloudflare-r2',
      fileId: path.basename(filename, path.extname(filename)),
      filename,
      url: publicUrl,
      cdn: true
    }
  }

  async delete(filename) {
    if (this.enabled && this.provider !== 'local') {
      return this.deleteFromCDN(filename)
    }
    return this.deleteLocal(filename)
  }

  async deleteLocal(filename) {
    const filePath = path.join(UPLOADS_DIR, filename)
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      return { success: true, provider: 'local' }
    }
    
    return { success: false, error: 'File not found' }
  }

  async deleteFromCDN(filename) {
    const cdnConfig = this.config[this.provider]
    
    if (!cdnConfig) {
      return this.deleteLocal(filename)
    }

    try {
      switch (this.provider) {
        case 's3': {
          const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
          const client = new S3Client({ region: cdnConfig.region })
          await client.send(new DeleteObjectCommand({
            Bucket: cdnConfig.bucket,
            Key: filename
          }))
          break
        }
        case 'cloudflare': {
          const { R2, DeleteObjectCommand } = await import('@aws-sdk/client-r2')
          const client = new R2({
            region: 'auto',
            endpoint: `https://${cdnConfig.accountId}.r2.cloudflarestorage.com`
          })
          await client.send(new DeleteObjectCommand({
            Bucket: cdnConfig.bucket,
            Key: filename
          }))
          break
        }
        default:
          return this.deleteLocal(filename)
      }
      
      return { success: true, provider: this.provider }
    } catch (error) {
      console.error(`[CDN] Delete failed:`, error.message)
      return { success: false, error: error.message }
    }
  }

  getUploadDir() {
    return UPLOADS_DIR
  }

  getLocalUrl(filename) {
    return `/api/upload/file/${filename}`
  }

  isEnabled() {
    return this.enabled
  }

  getProvider() {
    return this.provider
  }

  getConfig() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      hasCredentials: !!(
        (this.config.s3?.accessKeyId && this.config.s3?.secretAccessKey) ||
        (this.config.cloudflare?.accessKeyId && this.config.cloudflare?.secretAccessKey)
      )
    }
  }
}

export const cdnService = new CDNService()
export default cdnService
