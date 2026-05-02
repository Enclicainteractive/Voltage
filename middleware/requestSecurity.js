const HONEYPOT_FIELDS = ['website', 'url', 'homepage', 'site', 'comment', 'hp_field']
const HONEYPOT_FIELD_SET = new Set(HONEYPOT_FIELDS)
const BLOCKED_BODY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_NESTED_DEPTH = 20
const MAX_TOTAL_KEYS = 2000
const MAX_ARRAY_LENGTH = 1000
const MAX_STRING_LENGTH = 100000

const isPlainObject = (value) => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const inspectBodyShape = (value, path = 'body', depth = 0, stats = { keys: 0 }) => {
  if (depth > MAX_NESTED_DEPTH) {
    return { valid: false, reason: `Payload nesting too deep at ${path}` }
  }

  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    return { valid: false, reason: `String too large at ${path}` }
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      return { valid: false, reason: `Array too large at ${path}` }
    }

    for (let index = 0; index < value.length; index += 1) {
      const result = inspectBodyShape(value[index], `${path}[${index}]`, depth + 1, stats)
      if (!result.valid) return result
    }
    return { valid: true }
  }

  if (!isPlainObject(value)) {
    return { valid: true }
  }

  for (const key of Object.keys(value)) {
    stats.keys += 1
    if (stats.keys > MAX_TOTAL_KEYS) {
      return { valid: false, reason: 'Payload contains too many keys' }
    }

    if (BLOCKED_BODY_KEYS.has(key)) {
      return { valid: false, reason: `Blocked body key detected at ${path}.${key}` }
    }

    const result = inspectBodyShape(value[key], `${path}.${key}`, depth + 1, stats)
    if (!result.valid) return result
  }

  return { valid: true }
}

const hasHoneypotValue = (value) => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

const validateHoneypot = (body) => {
  if (!isPlainObject(body)) return false

  for (const [field, value] of Object.entries(body)) {
    if (HONEYPOT_FIELD_SET.has(field) && hasHoneypotValue(value)) {
      console.log(`[Security] Honeypot triggered: ${field}`)
      return false
    }
  }
  return true
}

const validateTimestamp = (body) => {
  if (!isPlainObject(body)) return false
  if (body._t === undefined || body._t === null || body._t === '') return true

  const now = Date.now()
  const rawTs = Number(body._t)
  if (!Number.isFinite(rawTs) || rawTs <= 0) return false

  // Accept epoch seconds for compatibility; normalize to milliseconds.
  const ts = rawTs < 1e12 ? rawTs * 1000 : rawTs
  const age = now - ts

  const maxAge = 10 * 60 * 1000 // allow 10 minutes
  const futureTolerance = 60 * 1000 // allow 1 minute ahead

  if (age > maxAge) {
    console.log(`[Security] Request timestamp too old: ${age}ms`)
    return false
  }

  if (age < -futureTolerance) {
    console.log(`[Security] Request timestamp in future: ${age}ms`)
    return false
  }

  return true
}

export const validateRequestSecurity = (body) => {
  if (!isPlainObject(body)) {
    return { valid: false, error: 'Invalid request' }
  }

  const shapeCheck = inspectBodyShape(body)
  if (!shapeCheck.valid) {
    console.log(`[Security] ${shapeCheck.reason}`)
    return { valid: false, error: 'Invalid request' }
  }

  if (!validateHoneypot(body)) {
    return { valid: false, error: 'Invalid request' }
  }
  
  if (!validateTimestamp(body)) {
    return { valid: false, error: 'Request expired' }
  }
  
  return { valid: true }
}

export const sanitizeBody = (body) => {
  if (!isPlainObject(body)) return {}

  const sanitizeValue = (value, depth = 0) => {
    if (depth > MAX_NESTED_DEPTH) return null
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      return value.slice(0, MAX_STRING_LENGTH)
    }

    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => sanitizeValue(item, depth + 1))
    }

    if (!isPlainObject(value)) return value

    const sanitizedObject = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      if (BLOCKED_BODY_KEYS.has(key)) continue
      if (HONEYPOT_FIELD_SET.has(key)) continue
      if (key === '_t') continue
      sanitizedObject[key] = sanitizeValue(nestedValue, depth + 1)
    }

    return sanitizedObject
  }

  return sanitizeValue(body)
}

export const withSecurityValidation = (handler) => {
  return async (req, res, next) => {
    const validation = validateRequestSecurity(req.body)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }
    
    req.body = sanitizeBody(req.body)
    return handler(req, res, next)
  }
}
