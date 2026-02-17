export const validateServerName = (name) => {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Server name is required' }
  }
  if (name.length < 2 || name.length > 100) {
    return { valid: false, error: 'Server name must be between 2 and 100 characters' }
  }
  return { valid: true }
}

export const validateChannelName = (name) => {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Channel name is required' }
  }
  if (name.length < 1 || name.length > 100) {
    return { valid: false, error: 'Channel name must be between 1 and 100 characters' }
  }
  return { valid: true }
}

export const validateMessage = (content) => {
  if (!content || typeof content !== 'string') {
    return { valid: false, error: 'Message content is required' }
  }
  if (content.length > 2000) {
    return { valid: false, error: 'Message cannot exceed 2000 characters' }
  }
  return { valid: true }
}

export const validateUsername = (username) => {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' }
  }
  if (username.length < 2 || username.length > 32) {
    return { valid: false, error: 'Username must be between 2 and 32 characters' }
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, error: 'Username can only contain letters, numbers, and underscores' }
  }
  return { valid: true }
}

export const validateDisplayName = (displayName) => {
  if (!displayName || typeof displayName !== 'string') {
    return { valid: false, error: 'Display name is required' }
  }
  if (displayName.length < 2 || displayName.length > 100) {
    return { valid: false, error: 'Display name must be between 2 and 100 characters' }
  }
  return { valid: true }
}
