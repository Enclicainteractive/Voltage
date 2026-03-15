class InputValidator {
  constructor() {
    this.patterns = {
      username: /^[a-zA-Z0-9_-]{3,32}$/,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      password: /^.{8,128}$/,
      channelName: /^[\w\s-]{2,100}$/,
      serverName: /^[\w\s-]{2,100}$/,
      messageContent: /^[\s\S]{1,4000}$/,
      userId: /^[a-zA-Z0-9_-]{8,64}$/,
      inviteCode: /^[a-zA-Z0-9]{8}$/,
      customStatus: /^[\s\S]{0,128}$/,
    }
  }

  validateUsername(username) {
    if (!username || typeof username !== 'string') {
      return { valid: false, error: 'Username is required' }
    }
    if (!this.patterns.username.test(username)) {
      return { valid: false, error: 'Username must be 3-32 characters, alphanumeric, - or _ only' }
    }
    return { valid: true }
  }

  validateEmail(email) {
    if (!email || typeof email !== 'string') {
      return { valid: false, error: 'Email is required' }
    }
    const normalized = this.normalizeEmail(email)
    if (!this.patterns.email.test(normalized)) {
      return { valid: false, error: 'Invalid email format' }
    }
    if (normalized.length > 254) {
      return { valid: false, error: 'Email too long' }
    }
    return { valid: true, normalized }
  }

  normalizeEmail(email) {
    if (!email || typeof email !== 'string') return ''
    return email.toLowerCase().trim()
  }

  validatePassword(password) {
    if (!password || typeof password !== 'string') {
      return { valid: false, error: 'Password is required' }
    }
    if (!this.patterns.password.test(password)) {
      return { valid: false, error: 'Password must be 8-128 characters' }
    }
    return { valid: true }
  }

  validateChannelName(name) {
    if (!name || typeof name !== 'string') {
      return { valid: false, error: 'Channel name is required' }
    }
    if (!this.patterns.channelName.test(name)) {
      return { valid: false, error: 'Invalid channel name' }
    }
    return { valid: true }
  }

  validateServerName(name) {
    if (!name || typeof name !== 'string') {
      return { valid: false, error: 'Server name is required' }
    }
    if (!this.patterns.serverName.test(name)) {
      return { valid: false, error: 'Invalid server name' }
    }
    return { valid: true }
  }

  validateMessageContent(content) {
    if (content === undefined || content === null) {
      return { valid: false, error: 'Message content is required' }
    }
    if (typeof content !== 'string') {
      return { valid: false, error: 'Message must be a string' }
    }
    if (!this.patterns.messageContent.test(content)) {
      return { valid: false, error: 'Message too long or invalid' }
    }
    return { valid: true }
  }

  validateId(id) {
    if (!id || typeof id !== 'string') {
      return { valid: false, error: 'ID is required' }
    }
    if (!this.patterns.userId.test(id)) {
      return { valid: false, error: 'Invalid ID format' }
    }
    return { valid: true }
  }

  validateInviteCode(code) {
    if (!code || typeof code !== 'string') {
      return { valid: false, error: 'Invite code is required' }
    }
    if (!this.patterns.inviteCode.test(code)) {
      return { valid: false, error: 'Invalid invite code' }
    }
    return { valid: true }
  }

  sanitizeString(str, maxLength = 1000) {
    if (typeof str !== 'string') return ''
    
    return str
      .replace(/[\x00-\x1F\x7F]/g, '')
      .substring(0, maxLength)
      .trim()
  }

  validateObject(obj, schema) {
    const errors = []
    
    for (const [field, rules] of Object.entries(schema)) {
      const value = obj[field]
      
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`)
        continue
      }
      
      if (value !== undefined && value !== null) {
        if (rules.type && typeof value !== rules.type) {
          errors.push(`${field} must be of type ${rules.type}`)
          continue
        }
        
        if (rules.minLength && value.length < rules.minLength) {
          errors.push(`${field} must be at least ${rules.minLength} characters`)
        }
        
        if (rules.maxLength && value.length > rules.maxLength) {
          errors.push(`${field} must be at most ${rules.maxLength} characters`)
        }
        
        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push(`${field} has invalid format`)
        }
        
        if (rules.enum && !rules.enum.includes(value)) {
          errors.push(`${field} must be one of: ${rules.enum.join(', ')}`)
        }
        
        if (rules.custom && !rules.custom(value)) {
          errors.push(`${field} is invalid`)
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    }
  }

  validateRegistration(data) {
    return this.validateObject(data, {
      email: { required: true, type: 'string', custom: (v) => this.validateEmail(v).valid },
      username: { required: true, type: 'string', custom: (v) => this.validateUsername(v).valid },
      password: { required: true, type: 'string', custom: (v) => this.validatePassword(v).valid },
    })
  }

  validateLogin(data) {
    return this.validateObject(data, {
      email: { required: true, type: 'string' },
      password: { required: true, type: 'string' },
    })
  }

  validateMessage(data) {
    return this.validateObject(data, {
      content: { required: true, type: 'string', maxLength: 4000 },
      channelId: { required: true, type: 'string' },
    })
  }

  validateChannel(data) {
    return this.validateObject(data, {
      name: { required: true, type: 'string', custom: (v) => this.validateChannelName(v).valid },
      type: { required: true, enum: ['text', 'voice', 'video', 'announcement', 'forum', 'media', 'category'] },
    })
  }

  validateServer(data) {
    return this.validateObject(data, {
      name: { required: true, type: 'string', custom: (v) => this.validateServerName(v).valid },
    })
  }
}

const inputValidator = new InputValidator()
export default inputValidator
