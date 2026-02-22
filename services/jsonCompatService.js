import fs from 'fs'
import { getStorageInfo, isManagedDataFile, loadManagedDataByFile, saveManagedDataByFile } from './dataService.js'

let patched = false
let originalReadFileSync = null
let originalWriteFileSync = null
let originalExistsSync = null

const isUtf8Read = (options) => {
  if (!options) return false
  if (typeof options === 'string') return options.toLowerCase() === 'utf8'
  if (typeof options === 'object' && options.encoding) {
    return String(options.encoding).toLowerCase() === 'utf8'
  }
  return false
}

const toText = (data, options) => {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) {
    const encoding = typeof options === 'string'
      ? options
      : (typeof options === 'object' && options?.encoding ? options.encoding : 'utf8')
    return data.toString(encoding || 'utf8')
  }
  return String(data ?? '')
}

const shouldIntercept = (targetPath) => {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.endsWith('.json')) return false
  if (!getStorageInfo().usingStorage) return false
  return isManagedDataFile(targetPath)
}

export const installJsonCompat = () => {
  if (patched) return
  patched = true

  originalReadFileSync = fs.readFileSync.bind(fs)
  originalWriteFileSync = fs.writeFileSync.bind(fs)
  originalExistsSync = fs.existsSync.bind(fs)

  fs.readFileSync = ((targetPath, options) => {
    if (!shouldIntercept(targetPath)) {
      return originalReadFileSync(targetPath, options)
    }

    const payload = loadManagedDataByFile(targetPath, {})
    const json = JSON.stringify(payload ?? {}, null, 2)
    if (isUtf8Read(options)) return json
    return Buffer.from(json, 'utf8')
  })

  fs.writeFileSync = ((targetPath, data, options) => {
    if (!shouldIntercept(targetPath)) {
      return originalWriteFileSync(targetPath, data, options)
    }

    const raw = toText(data, options)
    let parsed = {}
    try {
      parsed = raw.trim().length ? JSON.parse(raw) : {}
    } catch (err) {
      throw new Error(`Invalid JSON write for managed file ${targetPath}: ${err.message}`)
    }
    saveManagedDataByFile(targetPath, parsed)
    return undefined
  })

  fs.existsSync = ((targetPath) => {
    if (shouldIntercept(targetPath)) return true
    return originalExistsSync(targetPath)
  })

  console.log('[JSONCompat] Enabled DB-backed data/*.json compatibility layer')
}

export default {
  installJsonCompat
}

installJsonCompat()
