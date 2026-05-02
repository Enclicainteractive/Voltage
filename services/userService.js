// services/userService.js
//
// Defense-in-depth helpers for stripping sensitive fields from user records
// before they leave the API surface. The canonical user store still lives in
// services/dataService.js (`userService` export) — this module is a thin,
// safe-by-default facade that callers can use whenever a user object is
// about to be serialized to the network.
//
// The list of sensitive fields below is intentionally broad. We strip any
// known credential / secret material plus a defensive wildcard for keys
// containing "secret", "hash" (except the harmless `avatarHash`), "token",
// or "salt". This protects us against future schema additions accidentally
// leaking through `res.json(user)` style code paths.

const EXPLICIT_SENSITIVE_FIELDS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'passwordSalt',
  'salt',
  'recoveryToken',
  'recovery_token',
  'resetToken',
  'reset_token',
  'resetExpiry',
  'reset_expiry',
  'mfaSecret',
  'mfa_secret',
  'totpSecret',
  'totp_secret',
  'twoFactorSecret',
  'two_factor_secret',
  'apiKey',
  'api_key',
  'sessionSecret',
  'session_secret',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'jwtSecret',
  'jwt_secret',
  'oauthAccessToken',
  'oauthRefreshToken',
  'webhookSecret',
  'encryptionKey',
  'privateKey',
  'private_key'
])

// Field names that are safe to keep even though they contain "Hash"/"Token"
// in their name. Add to this list explicitly so we never silently leak.
const SENSITIVE_FIELD_ALLOWLIST = new Set([
  'avatarHash',
  'iconHash',
  'bannerHash'
])
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const isSensitiveByPattern = (key) => {
  if (typeof key !== 'string') return false
  if (SENSITIVE_FIELD_ALLOWLIST.has(key)) return false
  const lower = key.toLowerCase()
  if (lower.includes('secret')) return true
  if (lower.includes('password')) return true
  if (lower.endsWith('token') || lower.includes('token')) return true
  // Be a bit careful with `hash` — only redact when paired with credential-y
  // contexts. `avatarHash`/`iconHash` are content-addressable identifiers, not
  // secrets. Keys ending in "Hash" without an allowlist hit get stripped.
  if (lower.endsWith('hash') || lower.endsWith('_hash')) return true
  if (lower === 'salt' || lower.endsWith('salt')) return true
  return false
}

/**
 * Return a shallow copy of `user` with all known sensitive fields removed.
 * Safe to pass to `res.json(...)`. Returns `null`/`undefined` unchanged.
 *
 * @param {object|null|undefined} user
 * @returns {object|null|undefined}
 */
const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]'

const sanitizeNestedValue = (value, seen) => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeNestedValue(entry, seen))
  }
  if (!value || typeof value !== 'object') return value
  if (!isPlainObject(value)) return value
  if (seen.has(value)) return null

  seen.add(value)
  const safe = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue
    if (EXPLICIT_SENSITIVE_FIELDS.has(key)) continue
    if (isSensitiveByPattern(key)) continue
    safe[key] = sanitizeNestedValue(nestedValue, seen)
  }
  seen.delete(value)

  return safe
}

export const toSafeUser = (user) => {
  if (!user || typeof user !== 'object') return user
  return sanitizeNestedValue(user, new WeakSet())
}

/**
 * Map version of `toSafeUser` for arrays of users.
 *
 * @param {Array<object>|null|undefined} users
 * @returns {Array<object>}
 */
export const toSafeUsers = (users) => {
  if (!Array.isArray(users)) return []
  return users.map(toSafeUser)
}

/**
 * Convenience predicate for callers that want to assert a user object
 * does not contain sensitive material before responding. Intended for
 * use in tests / dev assertions, not as a runtime guard.
 *
 * @param {object} user
 * @returns {boolean}
 */
export const containsSensitiveFields = (user) => {
  if (!user || typeof user !== 'object') return false

  const seen = new WeakSet()
  const hasSensitiveNestedValue = (value) => {
    if (Array.isArray(value)) {
      return value.some((entry) => hasSensitiveNestedValue(entry))
    }
    if (!value || typeof value !== 'object') return false
    if (!isPlainObject(value)) return false
    if (seen.has(value)) return false

    seen.add(value)
    for (const [key, nestedValue] of Object.entries(value)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) continue
      if (EXPLICIT_SENSITIVE_FIELDS.has(key)) return true
      if (isSensitiveByPattern(key)) return true
      if (hasSensitiveNestedValue(nestedValue)) return true
    }
    return false
  }

  return hasSensitiveNestedValue(user)
}

export default {
  toSafeUser,
  toSafeUsers,
  containsSensitiveFields
}
