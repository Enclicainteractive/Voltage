import express from 'express'
import axios from 'axios'
import dns from 'dns'
import net from 'net'
import http from 'http'
import https from 'https'
import { authenticateToken } from '../middleware/authMiddleware.js'

const router = express.Router()

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.localdomain$/i,
  /\.internal$/i,
]

const BLOCKED_IP_RANGES = new net.BlockList()
const REQUEST_TIMEOUT_MS = 15000
const STREAM_TIMEOUT_MS = 60000
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024
const MAX_REDIRECTS = 3
const RANGE_HEADER_MAX_LENGTH = 128
const RANGE_HEADER_PATTERN = /^bytes=(\d{0,19})-(\d{0,19})$/i
const ALLOWED_CONTENT_TYPES = new Set([
  'audio/3gpp',
  'audio/3gpp2',
  'audio/aac',
  'audio/flac',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/wave',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
  'video/3gpp',
  'video/3gpp2',
  'video/mp4',
  'video/mpeg',
  'video/ogg',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
])

const addBlockedSubnet = (address, prefix, family) => {
  BLOCKED_IP_RANGES.addSubnet(address, prefix, family)
}

// IPv4 private, loopback, link-local, multicast, and reserved ranges.
addBlockedSubnet('0.0.0.0', 8, 'ipv4')
addBlockedSubnet('10.0.0.0', 8, 'ipv4')
addBlockedSubnet('100.64.0.0', 10, 'ipv4')
addBlockedSubnet('127.0.0.0', 8, 'ipv4')
addBlockedSubnet('169.254.0.0', 16, 'ipv4')
addBlockedSubnet('172.16.0.0', 12, 'ipv4')
addBlockedSubnet('192.0.0.0', 24, 'ipv4')
addBlockedSubnet('192.0.2.0', 24, 'ipv4')
addBlockedSubnet('192.88.99.0', 24, 'ipv4')
addBlockedSubnet('192.168.0.0', 16, 'ipv4')
addBlockedSubnet('198.18.0.0', 15, 'ipv4')
addBlockedSubnet('198.51.100.0', 24, 'ipv4')
addBlockedSubnet('203.0.113.0', 24, 'ipv4')
addBlockedSubnet('224.0.0.0', 4, 'ipv4')
addBlockedSubnet('240.0.0.0', 4, 'ipv4')
addBlockedSubnet('255.255.255.255', 32, 'ipv4')

// IPv6 loopback, local, multicast, documentation, transition, and other special-use ranges.
addBlockedSubnet('::', 128, 'ipv6')
addBlockedSubnet('::1', 128, 'ipv6')
addBlockedSubnet('::ffff:0:0', 96, 'ipv6')
addBlockedSubnet('64:ff9b::', 96, 'ipv6')
addBlockedSubnet('64:ff9b:1::', 48, 'ipv6')
addBlockedSubnet('100::', 64, 'ipv6')
addBlockedSubnet('2001::', 32, 'ipv6')
addBlockedSubnet('2001:2::', 48, 'ipv6')
addBlockedSubnet('2001:db8::', 32, 'ipv6')
addBlockedSubnet('2001:10::', 28, 'ipv6')
addBlockedSubnet('2001:20::', 28, 'ipv6')
addBlockedSubnet('2002::', 16, 'ipv6')
addBlockedSubnet('3fff::', 20, 'ipv6')
addBlockedSubnet('fc00::', 7, 'ipv6')
addBlockedSubnet('fe80::', 10, 'ipv6')
addBlockedSubnet('fec0::', 10, 'ipv6')
addBlockedSubnet('ff00::', 8, 'ipv6')

const normalizeHostname = (hostname = '') => {
  if (!hostname) return ''
  return String(hostname).trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

const normalizeIpAddress = (address = '') => {
  if (!address) return ''
  return String(address).trim().replace(/^\[|\]$/g, '').split('%')[0]
}

const isBlockedIpAddress = (address = '') => {
  const normalized = normalizeIpAddress(address)
  const family = net.isIP(normalized)
  if (!family) return true
  return BLOCKED_IP_RANGES.check(normalized, family === 6 ? 'ipv6' : 'ipv4')
}

const assertAllowedHostname = (hostname = '') => {
  const normalized = normalizeHostname(hostname)
  if (!normalized) {
    const error = new Error('Invalid target hostname')
    error.statusCode = 400
    throw error
  }

  if (BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(normalized))) {
    const error = new Error('Private network URLs are not allowed')
    error.statusCode = 403
    throw error
  }

  if (net.isIP(normalized) && isBlockedIpAddress(normalized)) {
    const error = new Error('Private network URLs are not allowed')
    error.statusCode = 403
    throw error
  }
}

const resolveAndValidateHostname = async (hostname = '') => {
  const normalized = normalizeHostname(hostname)
  assertAllowedHostname(normalized)

  if (net.isIP(normalized)) {
    return [{ address: normalized, family: net.isIP(normalized) }]
  }

  let resolvedAddresses
  try {
    resolvedAddresses = await dns.promises.lookup(normalized, { all: true, verbatim: true })
  } catch (_error) {
    const error = new Error('Could not resolve upstream host')
    error.statusCode = 502
    throw error
  }

  if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length === 0) {
    const error = new Error('Could not resolve upstream host')
    error.statusCode = 502
    throw error
  }

  for (const entry of resolvedAddresses) {
    if (!entry?.address || isBlockedIpAddress(entry.address)) {
      const error = new Error('Private network URLs are not allowed')
      error.statusCode = 403
      throw error
    }
  }

  return resolvedAddresses
}

const secureLookup = (hostname, options, callback) => {
  const normalizedOptions =
    typeof options === 'number'
      ? { family: options }
      : (options && typeof options === 'object' ? options : {})

  dns.lookup(
    hostname,
    {
      family: normalizedOptions.family,
      hints: normalizedOptions.hints,
      all: true,
      verbatim: true,
    },
    (error, addresses) => {
      if (error) {
        callback(error)
        return
      }

      if (!Array.isArray(addresses) || addresses.length === 0) {
        const noAddressError = new Error('No upstream addresses found')
        noAddressError.code = 'ENOTFOUND'
        callback(noAddressError)
        return
      }

      const safeAddresses = addresses.filter((entry) => entry?.address && !isBlockedIpAddress(entry.address))

      if (safeAddresses.length !== addresses.length || safeAddresses.length === 0) {
        const blockedAddressError = new Error('Blocked upstream address')
        blockedAddressError.code = 'EHOSTUNREACH'
        callback(blockedAddressError)
        return
      }

      if (normalizedOptions.all) {
        callback(null, safeAddresses)
        return
      }

      const [selected] = safeAddresses
      callback(null, selected.address, selected.family)
    },
  )
}

const pickPassthroughHeaders = (headers = {}) => {
  const responseHeaders = {}

  const acceptRanges = headers['accept-ranges']
  const contentLength = headers['content-length']
  const contentRange = headers['content-range']
  const contentType = headers['content-type']
  const etag = headers.etag
  const lastModified = headers['last-modified']

  if (acceptRanges) responseHeaders['accept-ranges'] = acceptRanges
  if (contentLength) responseHeaders['content-length'] = contentLength
  if (contentRange) responseHeaders['content-range'] = contentRange
  if (contentType) responseHeaders['content-type'] = contentType
  if (etag) responseHeaders.etag = etag
  if (lastModified) responseHeaders['last-modified'] = lastModified

  return responseHeaders
}

const sanitizeRangeHeader = (rangeHeader) => {
  if (typeof rangeHeader !== 'string') return null
  const candidate = rangeHeader.trim()
  if (!candidate || candidate.length > RANGE_HEADER_MAX_LENGTH) return null

  const match = candidate.match(RANGE_HEADER_PATTERN)
  if (!match) return null

  const start = match[1]
  const end = match[2]

  if (!start && !end) return null
  if (start && end && BigInt(start) > BigInt(end)) return null

  return `bytes=${start}-${end}`
}

const isAllowedContentType = (contentType) => {
  if (typeof contentType !== 'string') return false
  const normalized = contentType.split(';')[0].trim().toLowerCase()
  return ALLOWED_CONTENT_TYPES.has(normalized)
}

const parseResponseLength = (contentLengthHeader) => {
  if (typeof contentLengthHeader !== 'string') return null
  const parsed = Number.parseInt(contentLengthHeader, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const httpAgent = new http.Agent({ keepAlive: false, lookup: secureLookup })
const httpsAgent = new https.Agent({ keepAlive: false, lookup: secureLookup })

const fetchUpstreamMedia = async (startingUrl, forwardedRange) => {
  let currentUrl = startingUrl
  const visitedUrls = new Set()

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const currentUrlString = currentUrl.toString()
    if (visitedUrls.has(currentUrlString)) {
      const error = new Error('Upstream redirect loop detected')
      error.statusCode = 502
      throw error
    }
    visitedUrls.add(currentUrlString)

    await resolveAndValidateHostname(currentUrl.hostname)

    const response = await axios.get(currentUrlString, {
      responseType: 'stream',
      validateStatus: () => true,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      proxy: false,
      httpAgent,
      httpsAgent,
      headers: {
        ...(forwardedRange ? { Range: forwardedRange } : {}),
        'User-Agent': 'Voltage/1.0 media proxy',
      },
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location
      response.data?.destroy?.()

      if (!location) {
        const error = new Error('Upstream redirect missing location')
        error.statusCode = 502
        throw error
      }

      if (redirects >= MAX_REDIRECTS) {
        const error = new Error('Too many upstream redirects')
        error.statusCode = 502
        throw error
      }

      let redirectedUrl
      try {
        redirectedUrl = new URL(location, currentUrl)
      } catch {
        const error = new Error('Invalid upstream redirect location')
        error.statusCode = 502
        throw error
      }

      if (!['http:', 'https:'].includes(redirectedUrl.protocol)) {
        const error = new Error('Only http and https URLs are supported')
        error.statusCode = 400
        throw error
      }

      if (redirectedUrl.username || redirectedUrl.password) {
        const error = new Error('Upstream URL credentials are not allowed')
        error.statusCode = 400
        throw error
      }

      currentUrl = redirectedUrl
      continue
    }

    return response
  }

  const error = new Error('Failed to fetch remote media')
  error.statusCode = 502
  throw error
}

router.get('/proxy', authenticateToken, async (req, res) => {
  const remoteUrl = String(req.query.url || '').trim()
  if (!remoteUrl) {
    return res.status(400).json({ error: 'Missing url parameter' })
  }

  let parsedUrl
  try {
    parsedUrl = new URL(remoteUrl)
  } catch {
    return res.status(400).json({ error: 'Invalid url parameter' })
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are supported' })
  }

  if (parsedUrl.username || parsedUrl.password) {
    return res.status(400).json({ error: 'URL credentials are not allowed' })
  }

  const forwardedRange = sanitizeRangeHeader(req.headers.range)

  try {
    const upstream = await fetchUpstreamMedia(parsedUrl, forwardedRange)

    const contentType = upstream.headers?.['content-type']
    if (!isAllowedContentType(contentType)) {
      upstream.data?.destroy?.()
      return res.status(415).json({ error: 'Unsupported upstream content type' })
    }

    const declaredContentLength = parseResponseLength(upstream.headers?.['content-length'])
    if (declaredContentLength !== null && declaredContentLength > MAX_RESPONSE_BYTES) {
      upstream.data?.destroy?.()
      return res.status(413).json({ error: 'Upstream response too large' })
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      upstream.data?.destroy?.()
      return res.status(502).json({ error: 'Failed to fetch remote media' })
    }

    const passthroughHeaders = pickPassthroughHeaders(upstream.headers)
    Object.entries(passthroughHeaders).forEach(([key, value]) => {
      res.setHeader(key, value)
    })

    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=120')
    res.setHeader('Vary', 'Authorization, Range')
    res.status(upstream.status)

    let responseBytes = 0
    let streamTimedOut = false
    const timeoutHandle = setTimeout(() => {
      streamTimedOut = true
      upstream.data?.destroy?.(new Error('Upstream stream timed out'))
    }, STREAM_TIMEOUT_MS)

    const clearTimers = () => {
      clearTimeout(timeoutHandle)
    }

    upstream.data.on('data', (chunk) => {
      responseBytes += chunk.length
      if (responseBytes > MAX_RESPONSE_BYTES) {
        upstream.data.destroy(new Error('Upstream response exceeded maximum size'))
      }
    })

    upstream.data.on('error', (error) => {
      clearTimers()
      if (!res.headersSent) {
        if (streamTimedOut) {
          res.status(504).json({ error: 'Upstream media stream timed out' })
          return
        }

        if (responseBytes > MAX_RESPONSE_BYTES) {
          res.status(413).json({ error: 'Upstream response too large' })
          return
        }

        res.status(502).json({ error: 'Failed to stream remote media' })
        return
      }
      res.destroy(error)
    })

    upstream.data.on('end', clearTimers)
    res.on('close', clearTimers)

    upstream.data.pipe(res)
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502
    console.error('[MediaProxy] Failed to fetch remote media:', error.message)
    res.status(statusCode).json({ error: error.message || 'Failed to fetch remote media' })
  }
})

export default router
