import express from 'express'
import axios from 'axios'

const router = express.Router()

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/i,
  /\.local$/i,
]

const isPrivateHostname = (hostname = '') => {
  if (!hostname) return true
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) return true

  const lower = hostname.toLowerCase()
  if (lower.startsWith('172.')) {
    const secondOctet = Number.parseInt(lower.split('.')[1], 10)
    return secondOctet >= 16 && secondOctet <= 31
  }

  return false
}

const pickPassthroughHeaders = (headers = {}) => {
  const responseHeaders = {}
  const allowedHeaders = [
    'accept-ranges',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified',
  ]

  for (const header of allowedHeaders) {
    if (headers[header]) {
      responseHeaders[header] = headers[header]
    }
  }

  return responseHeaders
}

router.get('/proxy', async (req, res) => {
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

  if (isPrivateHostname(parsedUrl.hostname)) {
    return res.status(403).json({ error: 'Private network URLs are not allowed' })
  }

  try {
    const upstream = await axios.get(parsedUrl.toString(), {
      responseType: 'stream',
      validateStatus: () => true,
      timeout: 20000,
      headers: {
        Range: req.headers.range,
        'User-Agent': 'Voltage/1.0 media proxy',
      },
    })

    const passthroughHeaders = pickPassthroughHeaders(upstream.headers)
    Object.entries(passthroughHeaders).forEach(([key, value]) => {
      res.setHeader(key, value)
    })

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.status(upstream.status)

    upstream.data.on('error', (error) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Failed to stream remote media' })
        return
      }
      res.destroy(error)
    })

    upstream.data.pipe(res)
  } catch (error) {
    console.error('[MediaProxy] Failed to fetch remote media:', error.message)
    res.status(502).json({ error: 'Failed to fetch remote media' })
  }
})

export default router
