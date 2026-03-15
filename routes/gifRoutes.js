import express from 'express'

const router = express.Router()

const KLIPY_API_BASE = 'https://api.klipy.com/api/v1'
const DEFAULT_API_KEY = process.env.KLIPY_API_KEY || '2r1MIMBg4NdErEylItHGb6vvntahrw8t4WnyHLR9fYzidFzqs6FOQsSaJXa7YzFK'

const CONTENT_TYPES = {
  gifs: { endpoint: 'gifs', formats: ['gif', 'webp', 'jpg', 'mp4', 'webm'] },
  stickers: { endpoint: 'stickers', formats: ['webp', 'png', 'gif'] },
  clips: { endpoint: 'clips', formats: ['mp4', 'webm'] },
  memes: { endpoint: 'static-memes', formats: ['webp', 'jpg', 'png'] }
}

const getCustomerId = (req, enableTracking) => {
  if (!enableTracking) return null
  return req.user?.id || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'guest'
}

const getLocale = (req) => {
  const raw = req.query.locale || req.headers['x-klipy-locale'] || req.headers['accept-language'] || 'en-US'
  const locale = String(raw).split(',')[0].trim()
  if (locale.includes('_')) return locale
  if (locale.includes('-')) {
    const [language, country] = locale.split('-')
    return req.path.includes('/categories')
      ? `${language.toLowerCase()}_${country.toUpperCase()}`
      : country.toLowerCase()
  }
  return locale.toLowerCase()
}

const pickFormat = (file, size = 'sm', format) => {
  if (!file) return null
  
  // Check for flat structure (clips, stickers, memes have direct format keys)
  if (format && file[format]?.url) return file[format].url
  if (format && file[format]) return file[format] // Some APIs return URL directly
  
  // Check for direct format URLs (like file.mp4 = "url")
  const formats = ['mp4', 'webm', 'gif', 'webp', 'png', 'jpg']
  for (const fmt of formats) {
    if (file[fmt]?.url) return file[fmt].url
    if (typeof file[fmt] === 'string' && file[fmt].startsWith('http')) return file[fmt]
  }
  
  // Check for nested structure (gifs have sm/md/xs/hd)
  const sizes = [size, 'md', 'xs', 'hd']
  const nestedFormats = ['gif', 'webp', 'jpg', 'mp4', 'webm', 'png']
  
  for (const s of sizes) {
    for (const f of nestedFormats) {
      if (file?.[s]?.[f]?.url) return file[s][f].url
    }
  }
  
  return null
}

const normalizeItem = (item, type) => {
  const formats = CONTENT_TYPES[type]?.formats || CONTENT_TYPES.gifs.formats
  
  return {
    id: item.id,
    slug: item.slug,
    title: item.title,
    type: type.replace('static-memes', 'meme').replace('gifs', 'gif'),
    preview: pickFormat(item.file, 'xs') || pickFormat(item.file, 'sm'),
    url: pickFormat(item.file, 'sm') || pickFormat(item.file, 'md'),
    media_formats: {
      gif: { url: pickFormat(item.file, 'sm', 'gif') || pickFormat(item.file, 'md', 'gif') },
      tinygif: { url: pickFormat(item.file, 'xs', 'gif') },
      mp4: { url: pickFormat(item.file, 'sm', 'mp4') },
      webm: { url: pickFormat(item.file, 'sm', 'webm') },
      webp: { url: pickFormat(item.file, 'sm', 'webp') || pickFormat(item.file, 'md', 'webp') },
      png: { url: pickFormat(item.file, 'sm', 'png') }
    },
    source: 'klipy',
    original: item
  }
}

const proxyKlipy = async (endpoint, query = {}, options = {}) => {
  const apiKey = DEFAULT_API_KEY
  const url = new URL(`${KLIPY_API_BASE}/${apiKey}${endpoint}`)

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  })

  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
    const error = new Error(data?.error || data?.message || `KLIPY request failed with ${response.status}`)
    error.status = response.status
    error.payload = data
    throw error
  }

  return data
}

const getTypeFromPath = (path) => {
  if (path.startsWith('/stickers')) return 'stickers'
  if (path.startsWith('/clips')) return 'clips'
  if (path.startsWith('/memes')) return 'memes'
  if (path.startsWith('/static-memes')) return 'memes'
  return 'gifs'
}

const extractAdParams = (query) => {
  const adParams = {}
  const adKeys = [
    'ad-min-width', 'ad-max-width', 'ad-min-height', 'ad-max-height',
    'ad-app-version', 'ad-os', 'ad-osv', 'ad-hwv', 'ad-make', 'ad-model',
    'ad-ifa', 'ad-device-h', 'ad-device-w', 'ad-ppi', 'ad-pxratio',
    'ad-language', 'ad-carrier', 'ad-mccmnc', 'ad-connection-type',
    'ad-didsha1', 'ad-didmd5', 'ad-dpidsha1', 'ad-dpidmd5',
    'ad-macsha1', 'ad-macmd5', 'ad-yob', 'ad-gender',
    'ad-position', 'ad-iframe'
  ]
  
  adKeys.forEach(key => {
    if (query[key] !== undefined) {
      adParams[key] = query[key]
    }
  })
  
  return adParams
}

const createSearchHandler = (type) => async (req, res) => {
  const contentType = type || getTypeFromPath(req.path)
  const { q, limit = '24', pos, content_filter = 'medium', format_filter } = req.query
  const enableTracking = req.query.tracking === 'true'
  
  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' })
  }

  try {
    const config = CONTENT_TYPES[contentType]
    const page = Number.parseInt(String(pos || '1'), 10) || 1
    const customerId = getCustomerId(req, enableTracking)
    
    const query = {
      page,
      per_page: Math.min(50, Math.max(1, Number.parseInt(String(limit), 10) || 24)),
      q,
      customer_id: customerId,
      locale: getLocale(req),
      content_filter,
      format_filter: format_filter || config.formats.join(',')
    }
    
    const adParams = extractAdParams(req.query)
    Object.assign(query, adParams)

    const data = await proxyKlipy(`/${config.endpoint}/search`, query)

    const items = Array.isArray(data?.data?.data) ? data.data.data.map(item => normalizeItem(item, contentType)) : []
    
    // Check for ads in response
    const ads = []
    if (data?.data?.data) {
      data.data.data.forEach((item, index) => {
        if (item.type === 'ad') {
          ads.push({
            ...item,
            _adIndex: index
          })
        }
      })
    }
    
    res.json({
      results: items,
      next: data?.data?.has_next ? String((data?.data?.current_page || page) + 1) : null,
      source: 'klipy',
      tracking_enabled: enableTracking,
      ads: ads.length > 0 ? ads : undefined
    })
  } catch (error) {
    console.error(`${contentType} search proxy error:`, error)
    res.status(error.status || 500).json({ error: 'Failed to proxy request', details: error.payload || error.message })
  }
}

const createTrendingHandler = (type) => async (req, res) => {
  const contentType = type || getTypeFromPath(req.path)
  const enableTracking = req.query.tracking === 'true'
  
  try {
    const config = CONTENT_TYPES[contentType]
    const page = Number.parseInt(String(req.query.page || '1'), 10) || 1
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit || '24'), 10) || 24))
    const customerId = getCustomerId(req, enableTracking)
    
    const query = {
      page,
      per_page: limit,
      customer_id: customerId,
      locale: getLocale(req),
      format_filter: req.query.format_filter || config.formats.join(',')
    }
    
    const adParams = extractAdParams(req.query)
    Object.assign(query, adParams)

    const data = await proxyKlipy(`/${config.endpoint}/trending`, query)

    // Check for ads in response
    const ads = []
    let items = []
    
    if (Array.isArray(data?.data?.data)) {
      items = data.data.data
        .filter(item => item.type !== 'ad')
        .map(item => normalizeItem(item, contentType))
      
      data.data.data.forEach((item, index) => {
        if (item.type === 'ad') {
          ads.push({
            ...item,
            _adIndex: index
          })
        }
      })
    }
    
    res.json({
      results: items,
      next: data?.data?.has_next ? String((data?.data?.current_page || page) + 1) : null,
      source: 'klipy',
      tracking_enabled: enableTracking,
      ads: ads.length > 0 ? ads : undefined
    })
  } catch (error) {
    console.error(`${contentType} trending proxy error:`, error)
    res.status(error.status || 500).json({ error: 'Failed to proxy request', details: error.payload || error.message })
  }
}

const createCategoriesHandler = (type) => async (req, res) => {
  const contentType = type || getTypeFromPath(req.path)
  try {
    const config = CONTENT_TYPES[contentType]
    const data = await proxyKlipy(`/${config.endpoint}/categories`, {
      locale: getLocale({ ...req, path: '/categories' })
    })
    res.json({
      results: Array.isArray(data?.data?.categories) ? data.data.categories : [],
      source: 'klipy'
    })
  } catch (error) {
    console.error(`${contentType} categories proxy error:`, error)
    res.status(error.status || 500).json({ error: 'Failed to proxy request', details: error.payload || error.message })
  }
}

const createShareHandler = (type) => async (req, res) => {
  const contentType = type || getTypeFromPath(req.path)
  const { slug } = req.params
  const enableTracking = req.query.tracking === 'true'
  const customerId = req.query.customer_id || getCustomerId(req, enableTracking)
  
  if (!enableTracking) {
    return res.json({ result: true, tracked: false, message: 'Tracking disabled by user preference' })
  }

  try {
    const config = CONTENT_TYPES[contentType]
    
    await proxyKlipy(`/${config.endpoint}/share/${slug}`, {
      customer_id: customerId
    }, { method: 'POST', body: { customer_id: customerId } })

    res.json({ result: true, tracked: true })
  } catch (error) {
    console.error(`${contentType} share proxy error:`, error)
    res.status(error.status || 500).json({ error: 'Failed to proxy request', details: error.payload || error.message })
  }
}

const createReportHandler = (type) => async (req, res) => {
  const contentType = type || getTypeFromPath(req.path)
  const { slug } = req.params
  const { reason } = req.body || {}
  
  try {
    const config = CONTENT_TYPES[contentType]
    
    await proxyKlipy(`/${config.endpoint}/report/${slug}`, {
      reason
    }, { method: 'POST', body: { reason } })

    res.json({ result: true })
  } catch (error) {
    console.error(`${contentType} report proxy error:`, error)
    res.status(error.status || 500).json({ error: 'Failed to proxy request', details: error.payload || error.message })
  }
}

// GIF routes
router.get('/gifs/search', createSearchHandler('gifs'))
router.get('/gifs/trending', createTrendingHandler('gifs'))
router.get('/gifs/categories', createCategoriesHandler('gifs'))
router.post('/gifs/share/:slug', createShareHandler('gifs'))
router.post('/gifs/report/:slug', createReportHandler('gifs'))

// Sticker routes
router.get('/stickers/search', createSearchHandler('stickers'))
router.get('/stickers/trending', createTrendingHandler('stickers'))
router.get('/stickers/categories', createCategoriesHandler('stickers'))
router.post('/stickers/share/:slug', createShareHandler('stickers'))
router.post('/stickers/report/:slug', createReportHandler('stickers'))

// Clip routes
router.get('/clips/search', createSearchHandler('clips'))
router.get('/clips/trending', createTrendingHandler('clips'))
router.get('/clips/categories', createCategoriesHandler('clips'))
router.post('/clips/share/:slug', createShareHandler('clips'))
router.post('/clips/report/:slug', createReportHandler('clips'))

// Meme routes
router.get('/memes/search', createSearchHandler('memes'))
router.get('/memes/trending', createTrendingHandler('memes'))
router.get('/memes/categories', createCategoriesHandler('memes'))
router.post('/memes/share/:slug', createShareHandler('memes'))
router.post('/memes/report/:slug', createReportHandler('memes'))

// Static memes (alias for memes)
router.get('/static-memes/search', createSearchHandler('memes'))
router.get('/static-memes/trending', createTrendingHandler('memes'))
router.get('/static-memes/categories', createCategoriesHandler('memes'))
router.post('/static-memes/share/:slug', createShareHandler('memes'))
router.post('/static-memes/report/:slug', createReportHandler('memes'))

// Generic routes (for backward compatibility)
router.get('/search', createSearchHandler())
router.get('/trending', createTrendingHandler())
router.get('/categories', createCategoriesHandler())
router.post('/share/:slug', createShareHandler())
router.post('/report/:slug', createReportHandler())

export default router
