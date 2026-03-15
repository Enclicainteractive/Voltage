const HONEYPOT_FIELDS = ['website', 'url', 'homepage', 'site', 'comment', 'hp_field']

const validateHoneypot = (body) => {
  for (const field of HONEYPOT_FIELDS) {
    if (body[field] && body[field].length > 0) {
      console.log(`[Security] Honeypot triggered: ${field}`)
      return false
    }
  }
  return true
}

const validateTimestamp = (body) => {
  if (!body._t) return true

    const now = Date.now()
    const ts = Number(body._t)

    if (!Number.isFinite(ts)) return false

      const age = now - ts

      const maxAge = 10 * 60 * 1000   // allow 10 minutes
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
  if (!validateHoneypot(body)) {
    return { valid: false, error: 'Invalid request' }
  }
  
  if (!validateTimestamp(body)) {
    return { valid: false, error: 'Request expired' }
  }
  
  return { valid: true }
}

export const sanitizeBody = (body) => {
  const sanitized = { ...body }
  
  for (const field of HONEYPOT_FIELDS) {
    delete sanitized[field]
  }
  
  delete sanitized._t
  
  return sanitized
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
