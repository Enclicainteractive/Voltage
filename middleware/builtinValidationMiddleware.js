/**
 * VoltChat Built-in Data Validation Middleware
 * 
 * Provides comprehensive input validation and sanitization using built-in Node.js features
 */

class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'ValidationError'
    this.errors = errors
    this.statusCode = 400
  }
}

/**
 * Validation patterns using RegExp
 */
const patterns = {
  // User IDs: alphanumeric, hyphens, underscores, 1-50 chars
  userId: /^[a-zA-Z0-9_-]{1,50}$/,
  
  // Server IDs: same as user IDs
  serverId: /^[a-zA-Z0-9_-]{1,50}$/,
  
  // Channel IDs: same as user IDs
  channelId: /^[a-zA-Z0-9_-]{1,50}$/,
  
  // Message IDs: UUIDs or similar
  messageId: /^[a-zA-Z0-9_-]{1,100}$/,
  
  // Usernames: alphanumeric, underscores, periods, 2-32 chars
  username: /^[a-zA-Z0-9_.]{2,32}$/,
  
  // Display names: printable characters, 1-50 chars
  displayName: /^[\x20-\x7E\u00A0-\u024F\u0370-\u03FF\u1E00-\u1EFF]{1,50}$/,
  
  // Hex color codes
  hexColor: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
  
  // Base64 pattern
  base64: /^[A-Za-z0-9+/]*={0,2}$/,
  
  // File names: safe characters only
  fileName: /^[a-zA-Z0-9._-]{1,255}$/,
  
  // Invite codes
  inviteCode: /^[a-zA-Z0-9]{4,20}$/,
  
  // Email pattern (basic)
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  
  // URL pattern (basic)
  url: /^https?:\/\/[^\s/$.?#].[^\s]*$/i,
  
  // ISO date pattern
  isoDate: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/,
  
  // Server/channel names
  serverName: /^[a-zA-Z0-9\s._-]{1,100}$/,
  channelName: /^[a-zA-Z0-9_-]{1,100}$/
}

/**
 * Built-in validation functions
 */
const validators = {
  isString: (value) => typeof value === 'string',
  
  isNumber: (value) => typeof value === 'number' && !isNaN(value),
  
  isInteger: (value) => Number.isInteger(value),
  
  isBoolean: (value) => typeof value === 'boolean',
  
  isArray: (value) => Array.isArray(value),
  
  isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  
  isLength: (value, min = 0, max = Infinity) => {
    const len = typeof value === 'string' ? value.length : 0
    return len >= min && len <= max
  },
  
  isInRange: (value, min = 0, max = Infinity) => {
    const num = Number(value)
    return !isNaN(num) && num >= min && num <= max
  },
  
  matches: (value, pattern) => {
    return typeof value === 'string' && pattern.test(value)
  },
  
  isIn: (value, options) => {
    return options.includes(value)
  },
  
  isEmail: (value) => {
    return typeof value === 'string' && 
           patterns.email.test(value) && 
           value.length <= 254
  },
  
  isURL: (value) => {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol)
    } catch {
      return patterns.url.test(value)
    }
  },
  
  isBase64: (value) => {
    return typeof value === 'string' && patterns.base64.test(value)
  },
  
  isISO8601: (value) => {
    if (typeof value !== 'string') return false
    if (!patterns.isoDate.test(value)) return false
    const date = new Date(value)
    return !isNaN(date.getTime())
  },
  
  isJSON: (value) => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Content sanitization functions
 */
const sanitizers = {
  sanitizeText: (text) => {
    if (typeof text !== 'string') return ''
    return text
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
  },
  
  sanitizeHtml: (html) => {
    if (typeof html !== 'string') return ''
    
    // Simple HTML sanitization - remove script tags and dangerous attributes
    return html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<iframe[^>]*>.*?<\/iframe>/gis, '')
      .replace(/<object[^>]*>.*?<\/object>/gis, '')
      .replace(/<embed[^>]*>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '') // Remove event handlers
      .replace(/javascript:/gi, '') // Remove javascript: URLs
      .replace(/data:/gi, '') // Remove data: URLs
      .trim()
  },
  
  sanitizeUsername: (username) => {
    if (typeof username !== 'string') return ''
    return username.toLowerCase().trim().replace(/[^a-zA-Z0-9_.]/g, '')
  },
  
  sanitizeFileName: (fileName) => {
    if (typeof fileName !== 'string') return ''
    return fileName
      .replace(/[<>:"/\\|?*]/g, '_') // Replace dangerous characters
      .replace(/^\.+/, '') // Remove leading dots
      .slice(0, 255)
  },
  
  sanitizeUrl: (url) => {
    if (typeof url !== 'string') return ''
    try {
      const parsed = new URL(url)
      return ['http:', 'https:'].includes(parsed.protocol) ? url : ''
    } catch {
      return ''
    }
  },
  
  escapeHtml: (text) => {
    if (typeof text !== 'string') return ''
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
  }
}

/**
 * Validation rule builder
 */
class ValidationRule {
  constructor(field) {
    this.field = field
    this.rules = []
    this.optional = false
  }
  
  isOptional() {
    this.optional = true
    return this
  }
  
  isRequired() {
    this.rules.push({
      validate: (value) => value !== undefined && value !== null && value !== '',
      message: `${this.field} is required`
    })
    return this
  }
  
  isString() {
    this.rules.push({
      validate: validators.isString,
      message: `${this.field} must be a string`
    })
    return this
  }
  
  isNumber() {
    this.rules.push({
      validate: validators.isNumber,
      message: `${this.field} must be a number`
    })
    return this
  }
  
  isInteger() {
    this.rules.push({
      validate: validators.isInteger,
      message: `${this.field} must be an integer`
    })
    return this
  }
  
  isBoolean() {
    this.rules.push({
      validate: validators.isBoolean,
      message: `${this.field} must be a boolean`
    })
    return this
  }
  
  isArray(maxLength = Infinity) {
    this.rules.push({
      validate: (value) => validators.isArray(value) && value.length <= maxLength,
      message: `${this.field} must be an array with maximum ${maxLength} items`
    })
    return this
  }
  
  isLength(min = 0, max = Infinity) {
    this.rules.push({
      validate: (value) => validators.isLength(value, min, max),
      message: `${this.field} must be ${min}-${max} characters long`
    })
    return this
  }
  
  isInRange(min = 0, max = Infinity) {
    this.rules.push({
      validate: (value) => validators.isInRange(value, min, max),
      message: `${this.field} must be between ${min} and ${max}`
    })
    return this
  }
  
  matches(pattern, message) {
    this.rules.push({
      validate: (value) => validators.matches(value, pattern),
      message: message || `${this.field} format is invalid`
    })
    return this
  }
  
  isIn(options) {
    this.rules.push({
      validate: (value) => validators.isIn(value, options),
      message: `${this.field} must be one of: ${options.join(', ')}`
    })
    return this
  }
  
  isEmail() {
    this.rules.push({
      validate: validators.isEmail,
      message: `${this.field} must be a valid email address`
    })
    return this
  }
  
  isURL() {
    this.rules.push({
      validate: validators.isURL,
      message: `${this.field} must be a valid URL`
    })
    return this
  }
  
  isBase64() {
    this.rules.push({
      validate: validators.isBase64,
      message: `${this.field} must be valid base64`
    })
    return this
  }
  
  isISO8601() {
    this.rules.push({
      validate: validators.isISO8601,
      message: `${this.field} must be a valid ISO 8601 date`
    })
    return this
  }
  
  custom(validateFn, message) {
    this.rules.push({
      validate: validateFn,
      message: message || `${this.field} is invalid`
    })
    return this
  }
  
  validate(value) {
    const errors = []
    
    // Skip validation if field is optional and value is empty
    if (this.optional && (value === undefined || value === null || value === '')) {
      return errors
    }
    
    for (const rule of this.rules) {
      if (!rule.validate(value)) {
        errors.push({
          field: this.field,
          message: rule.message,
          value: value
        })
      }
    }
    
    return errors
  }
}

/**
 * Validation builder functions
 */
const body = (field) => new ValidationRule(`body.${field}`)
const param = (field) => new ValidationRule(`params.${field}`)
const query = (field) => new ValidationRule(`query.${field}`)

/**
 * Pre-built validation schemas
 */
const validationSchemas = {
  // User profile validation
  userProfile: [
    body('username').isRequired().isString().matches(patterns.username, 'Username must be 2-32 characters, alphanumeric with underscores and periods only'),
    body('displayName').isOptional().isString().matches(patterns.displayName, 'Display name must be 1-50 characters'),
    body('email').isOptional().isEmail(),
    body('bio').isOptional().isString().isLength(0, 1000),
    body('avatar').isOptional().isURL(),
    body('banner').isOptional().isURL()
  ],

  // Message validation
  message: [
    body('channelId').isRequired().matches(patterns.channelId, 'Invalid channel ID format'),
    body('content').isRequired().isString().isLength(1, 4000),
    body('replyTo').isOptional().matches(patterns.messageId, 'Invalid reply message ID format'),
    body('attachments').isOptional().isArray(10),
    body('mentions').isOptional().isArray(50),
    body('encrypted').isOptional().isBoolean(),
    body('iv').isOptional().isBase64()
  ],

  // Server validation
  server: [
    body('name').isRequired().isString().matches(patterns.serverName, 'Server name must be 1-100 characters, alphanumeric with spaces and basic punctuation'),
    body('description').isOptional().isString().isLength(0, 500),
    body('icon').isOptional().isURL(),
    body('banner').isOptional().isURL(),
    body('themeColor').isOptional().matches(patterns.hexColor, 'Theme color must be a valid hex color')
  ],

  // Channel validation
  channel: [
    body('name').isRequired().isString().matches(patterns.channelName, 'Channel name must be 1-100 characters, alphanumeric with underscores and hyphens only'),
    body('topic').isOptional().isString().isLength(0, 1000),
    body('type').isOptional().isIn(['text', 'voice', 'category']),
    body('nsfw').isOptional().isBoolean(),
    body('slowMode').isOptional().isInteger().isInRange(0, 21600)
  ],

  // DM validation
  dm: [
    body('recipientId').isRequired().matches(patterns.userId, 'Invalid recipient user ID format'),
    body('content').isRequired().isString().isLength(1, 4000),
    body('encrypted').isOptional().isBoolean(),
    body('iv').isOptional().isBase64()
  ],

  // Common parameter validations
  userIdParam: [param('userId').isRequired().matches(patterns.userId, 'Invalid user ID format')],
  serverIdParam: [param('serverId').isRequired().matches(patterns.serverId, 'Invalid server ID format')],
  channelIdParam: [param('channelId').isRequired().matches(patterns.channelId, 'Invalid channel ID format')],
  messageIdParam: [param('messageId').isRequired().matches(patterns.messageId, 'Invalid message ID format')],

  // Pagination
  pagination: [
    query('limit').isOptional().isInteger().isInRange(1, 100),
    query('offset').isOptional().isInteger().isInRange(0),
    query('before').isOptional().isISO8601(),
    query('after').isOptional().isISO8601()
  ]
}

/**
 * Main validation middleware
 */
const validateRequest = (schema) => {
  return (req, res, next) => {
    const errors = []
    
    for (const rule of schema) {
      let value
      
      // Extract value based on rule field type
      if (rule.field.startsWith('body.')) {
        const fieldName = rule.field.replace('body.', '')
        value = req.body?.[fieldName]
      } else if (rule.field.startsWith('params.')) {
        const fieldName = rule.field.replace('params.', '')
        value = req.params?.[fieldName]
      } else if (rule.field.startsWith('query.')) {
        const fieldName = rule.field.replace('query.', '')
        value = req.query?.[fieldName]
      }
      
      const fieldErrors = rule.validate(value)
      errors.push(...fieldErrors)
    }
    
    if (errors.length > 0) {
      console.warn('[Validation] Request failed validation:', {
        path: req.path,
        method: req.method,
        errors: errors.map(e => ({ field: e.field, message: e.message })),
        ip: req.ip
      })
      
      return res.status(400).json({
        error: 'Validation failed',
        errors: errors,
        timestamp: Date.now()
      })
    }
    
    next()
  }
}

/**
 * Input sanitization middleware
 */
const sanitizeInput = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    // Sanitize common string fields
    const stringFields = ['content', 'username', 'displayName', 'name', 'description', 'topic', 'bio']
    
    for (const field of stringFields) {
      if (req.body[field] && typeof req.body[field] === 'string') {
        if (field === 'content' || field === 'description' || field === 'topic' || field === 'bio') {
          req.body[field] = sanitizers.sanitizeHtml(req.body[field])
        } else if (field === 'username') {
          req.body[field] = sanitizers.sanitizeUsername(req.body[field])
        } else {
          req.body[field] = sanitizers.sanitizeText(req.body[field])
        }
      }
    }
    
    // Sanitize URLs
    const urlFields = ['avatar', 'banner', 'icon']
    for (const field of urlFields) {
      if (req.body[field] && typeof req.body[field] === 'string') {
        req.body[field] = sanitizers.sanitizeUrl(req.body[field])
      }
    }
  }
  
  next()
}

/**
 * Rate limiting for validation failures
 */
const validationFailures = new Map()

const validationRateLimit = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown'
  const key = `validation_failures_${clientIp}`
  const now = Date.now()
  const windowMs = 5 * 60 * 1000 // 5 minutes
  
  // Clean up old entries
  const failures = validationFailures.get(key) || []
  const recentFailures = failures.filter(timestamp => now - timestamp < windowMs)
  
  if (recentFailures.length >= 20) { // Max 20 validation failures per 5 minutes
    return res.status(429).json({
      error: 'Too many validation failures',
      message: 'Please slow down and check your input data',
      retryAfter: Math.ceil(windowMs / 1000),
      timestamp: now
    })
  }
  
  // Track failures
  const originalSend = res.send
  res.send = function(data) {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      recentFailures.push(now)
      validationFailures.set(key, recentFailures)
    }
    originalSend.call(this, data)
  }
  
  next()
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now()
  const windowMs = 5 * 60 * 1000
  
  for (const [key, failures] of validationFailures.entries()) {
    const recentFailures = failures.filter(timestamp => now - timestamp < windowMs)
    if (recentFailures.length === 0) {
      validationFailures.delete(key)
    } else {
      validationFailures.set(key, recentFailures)
    }
  }
}, 5 * 60 * 1000)

export {
  ValidationError,
  validationSchemas,
  validateRequest,
  sanitizeInput,
  validationRateLimit,
  validators,
  sanitizers,
  patterns,
  body,
  param,
  query
}