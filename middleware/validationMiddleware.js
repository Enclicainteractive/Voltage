/**
 * VoltChat Data Validation Middleware
 * 
 * Provides comprehensive input validation and sanitization
 */

import { body, param, query, validationResult } from 'express-validator'
import sanitizeHtml from 'sanitize-html'
import validator from 'validator'

class ValidationError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'ValidationError'
    this.errors = errors
    this.statusCode = 400
  }
}

/**
 * Handle validation results
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req)
  
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map(error => ({
      field: error.path || error.param,
      message: error.msg,
      value: error.value,
      location: error.location
    }))
    
    console.warn('[Validation] Request failed validation:', {
      path: req.path,
      method: req.method,
      errors: formattedErrors,
      body: req.body ? Object.keys(req.body) : undefined
    })
    
    return res.status(400).json({
      error: 'Validation failed',
      errors: formattedErrors,
      timestamp: Date.now()
    })
  }
  
  next()
}

/**
 * Common validation patterns
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
  
  // Display names: broader character set, 1-50 chars
  displayName: /^.{1,50}$/,
  
  // Hex color codes
  hexColor: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
  
  // Base64 for encrypted content
  base64: /^[A-Za-z0-9+/]*={0,2}$/,
  
  // File names: safe characters only
  fileName: /^[a-zA-Z0-9._-]{1,255}$/,
  
  // Invite codes
  inviteCode: /^[a-zA-Z0-9]{4,20}$/
}

/**
 * Custom validators
 */
const customValidators = {
  isValidUserId: (value) => patterns.userId.test(value),
  isValidServerId: (value) => patterns.serverId.test(value),
  isValidChannelId: (value) => patterns.channelId.test(value),
  isValidMessageId: (value) => patterns.messageId.test(value),
  isValidUsername: (value) => patterns.username.test(value),
  isValidDisplayName: (value) => patterns.displayName.test(value),
  isValidHexColor: (value) => patterns.hexColor.test(value),
  isValidFileName: (value) => patterns.fileName.test(value),
  isValidInviteCode: (value) => patterns.inviteCode.test(value),
  
  isValidMessageContent: (value) => {
    if (typeof value !== 'string') return false
    if (value.length > 4000) return false // Max message length
    return true
  },
  
  isValidBio: (value) => {
    if (typeof value !== 'string') return false
    if (value.length > 1000) return false
    return true
  },
  
  isValidUrl: (value) => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol)
    } catch {
      return false
    }
  },
  
  isValidEmail: (value) => {
    return validator.isEmail(value) && value.length <= 254
  },
  
  isValidAge: (value) => {
    const age = parseInt(value)
    return !isNaN(age) && age >= 13 && age <= 120
  },
  
  isValidTimestamp: (value) => {
    const timestamp = new Date(value)
    return !isNaN(timestamp.getTime())
  },
  
  isValidJSON: (value) => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Sanitization functions
 */
const sanitizers = {
  sanitizeHtml: (html) => {
    return sanitizeHtml(html, {
      allowedTags: ['b', 'i', 'em', 'strong', 'u', 's', 'code', 'pre', 'br'],
      allowedAttributes: {},
      disallowedTagsMode: 'discard'
    })
  },
  
  sanitizeText: (text) => {
    if (typeof text !== 'string') return ''
    return text.trim().replace(/\s+/g, ' ') // Normalize whitespace
  },
  
  sanitizeUsername: (username) => {
    if (typeof username !== 'string') return ''
    return username.toLowerCase().trim()
  },
  
  sanitizeFileName: (fileName) => {
    if (typeof fileName !== 'string') return ''
    return fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255)
  },
  
  sanitizeUrl: (url) => {
    if (typeof url !== 'string') return ''
    try {
      const parsed = new URL(url)
      return ['http:', 'https:'].includes(parsed.protocol) ? url : ''
    } catch {
      return ''
    }
  }
}

/**
 * Pre-built validation chains for common endpoints
 */
const validationChains = {
  // User registration/profile validation
  userProfile: [
    body('username')
      .custom(customValidators.isValidUsername)
      .withMessage('Username must be 2-32 characters, alphanumeric with underscores and periods only'),
    body('displayName')
      .optional()
      .custom(customValidators.isValidDisplayName)
      .withMessage('Display name must be 1-50 characters'),
    body('email')
      .optional()
      .custom(customValidators.isValidEmail)
      .withMessage('Must be a valid email address'),
    body('bio')
      .optional()
      .custom(customValidators.isValidBio)
      .withMessage('Bio must be 1000 characters or less'),
    body('avatar')
      .optional()
      .custom(customValidators.isValidUrl)
      .withMessage('Avatar must be a valid URL'),
    body('banner')
      .optional()
      .custom(customValidators.isValidUrl)
      .withMessage('Banner must be a valid URL')
  ],

  // Message validation
  message: [
    body('channelId')
      .custom(customValidators.isValidChannelId)
      .withMessage('Invalid channel ID format'),
    body('content')
      .custom(customValidators.isValidMessageContent)
      .withMessage('Message content must be 1-4000 characters'),
    body('replyTo')
      .optional()
      .custom(customValidators.isValidMessageId)
      .withMessage('Invalid reply message ID format'),
    body('attachments')
      .optional()
      .isArray({ max: 10 })
      .withMessage('Maximum 10 attachments allowed'),
    body('attachments.*.fileName')
      .optional()
      .custom(customValidators.isValidFileName)
      .withMessage('Invalid file name'),
    body('mentions')
      .optional()
      .isArray({ max: 50 })
      .withMessage('Maximum 50 mentions allowed'),
    body('encrypted')
      .optional()
      .isBoolean()
      .withMessage('Encrypted must be a boolean'),
    body('iv')
      .optional()
      .isBase64()
      .withMessage('IV must be valid base64')
  ],

  // Server creation/update validation
  server: [
    body('name')
      .isLength({ min: 1, max: 100 })
      .matches(/^[a-zA-Z0-9\s._-]+$/)
      .withMessage('Server name must be 1-100 characters, alphanumeric with spaces and basic punctuation'),
    body('description')
      .optional()
      .isLength({ max: 500 })
      .withMessage('Description must be 500 characters or less'),
    body('icon')
      .optional()
      .custom(customValidators.isValidUrl)
      .withMessage('Icon must be a valid URL'),
    body('banner')
      .optional()
      .custom(customValidators.isValidUrl)
      .withMessage('Banner must be a valid URL'),
    body('themeColor')
      .optional()
      .custom(customValidators.isValidHexColor)
      .withMessage('Theme color must be a valid hex color')
  ],

  // Channel validation
  channel: [
    body('name')
      .isLength({ min: 1, max: 100 })
      .matches(/^[a-zA-Z0-9_-]+$/)
      .withMessage('Channel name must be 1-100 characters, alphanumeric with underscores and hyphens only'),
    body('topic')
      .optional()
      .isLength({ max: 1000 })
      .withMessage('Topic must be 1000 characters or less'),
    body('type')
      .optional()
      .isIn(['text', 'voice', 'category'])
      .withMessage('Type must be text, voice, or category'),
    body('nsfw')
      .optional()
      .isBoolean()
      .withMessage('NSFW must be a boolean'),
    body('slowMode')
      .optional()
      .isInt({ min: 0, max: 21600 })
      .withMessage('Slow mode must be 0-21600 seconds')
  ],

  // DM validation
  dm: [
    body('recipientId')
      .custom(customValidators.isValidUserId)
      .withMessage('Invalid recipient user ID format'),
    body('content')
      .custom(customValidators.isValidMessageContent)
      .withMessage('Message content must be 1-4000 characters'),
    body('encrypted')
      .optional()
      .isBoolean()
      .withMessage('Encrypted must be a boolean'),
    body('iv')
      .optional()
      .isBase64()
      .withMessage('IV must be valid base64')
  ],

  // Invite validation
  invite: [
    body('serverId')
      .custom(customValidators.isValidServerId)
      .withMessage('Invalid server ID format'),
    body('channelId')
      .optional()
      .custom(customValidators.isValidChannelId)
      .withMessage('Invalid channel ID format'),
    body('maxUses')
      .optional()
      .isInt({ min: 0, max: 1000 })
      .withMessage('Max uses must be 0-1000'),
    body('maxAge')
      .optional()
      .isInt({ min: 0, max: 604800 })
      .withMessage('Max age must be 0-604800 seconds')
  ],

  // ID parameter validation
  idParam: [
    param('id')
      .matches(/^[a-zA-Z0-9_-]{1,100}$/)
      .withMessage('Invalid ID format')
  ],

  userIdParam: [
    param('userId')
      .custom(customValidators.isValidUserId)
      .withMessage('Invalid user ID format')
  ],

  serverIdParam: [
    param('serverId')
      .custom(customValidators.isValidServerId)
      .withMessage('Invalid server ID format')
  ],

  channelIdParam: [
    param('channelId')
      .custom(customValidators.isValidChannelId)
      .withMessage('Invalid channel ID format')
  ],

  messageIdParam: [
    param('messageId')
      .custom(customValidators.isValidMessageId)
      .withMessage('Invalid message ID format')
  ],

  // Query parameter validation
  pagination: [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be 1-100'),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a positive integer'),
    query('before')
      .optional()
      .isISO8601()
      .withMessage('Before must be a valid ISO 8601 date'),
    query('after')
      .optional()
      .isISO8601()
      .withMessage('After must be a valid ISO 8601 date')
  ]
}

/**
 * Middleware factory for validation
 */
const createValidationMiddleware = (validations) => {
  return [...validations, handleValidationErrors]
}

/**
 * Security-focused input sanitization middleware
 */
const sanitizationMiddleware = (req, res, next) => {
  // Sanitize common input fields
  if (req.body) {
    if (req.body.content && typeof req.body.content === 'string') {
      req.body.content = sanitizers.sanitizeText(req.body.content)
    }
    
    if (req.body.username && typeof req.body.username === 'string') {
      req.body.username = sanitizers.sanitizeUsername(req.body.username)
    }
    
    if (req.body.displayName && typeof req.body.displayName === 'string') {
      req.body.displayName = sanitizers.sanitizeText(req.body.displayName)
    }
    
    if (req.body.bio && typeof req.body.bio === 'string') {
      req.body.bio = sanitizers.sanitizeHtml(req.body.bio)
    }
    
    if (req.body.description && typeof req.body.description === 'string') {
      req.body.description = sanitizers.sanitizeHtml(req.body.description)
    }
    
    if (req.body.topic && typeof req.body.topic === 'string') {
      req.body.topic = sanitizers.sanitizeHtml(req.body.topic)
    }
  }
  
  next()
}

/**
 * Rate limiting for validation failures
 */
const validationRateLimiter = new Map()

const validationRateLimitMiddleware = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress
  const key = `validation_failures_${clientIp}`
  const now = Date.now()
  const windowMs = 5 * 60 * 1000 // 5 minutes
  
  const failures = validationRateLimiter.get(key) || []
  const recentFailures = failures.filter(timestamp => now - timestamp < windowMs)
  
  if (recentFailures.length >= 20) { // Max 20 validation failures per 5 minutes
    return res.status(429).json({
      error: 'Too many validation failures',
      message: 'Please slow down and check your input data',
      retryAfter: Math.ceil(windowMs / 1000),
      timestamp: Date.now()
    })
  }
  
  // Store failure timestamp if validation fails
  const originalSend = res.send
  res.send = function(data) {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      recentFailures.push(now)
      validationRateLimiter.set(key, recentFailures)
    }
    originalSend.call(this, data)
  }
  
  next()
}

/**
 * Clean up old rate limit entries
 */
setInterval(() => {
  const now = Date.now()
  const windowMs = 5 * 60 * 1000
  
  for (const [key, failures] of validationRateLimiter.entries()) {
    const recentFailures = failures.filter(timestamp => now - timestamp < windowMs)
    if (recentFailures.length === 0) {
      validationRateLimiter.delete(key)
    } else {
      validationRateLimiter.set(key, recentFailures)
    }
  }
}, 60000) // Clean up every minute

export {
  ValidationError,
  validationChains,
  createValidationMiddleware,
  sanitizationMiddleware,
  validationRateLimitMiddleware,
  customValidators,
  sanitizers,
  patterns
}