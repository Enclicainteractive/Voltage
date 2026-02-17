import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
const SALT_LENGTH = 32

export const generateKeyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
}

export const importPublicKey = (publicKeyBase64) => {
  return crypto.createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    type: 'spki',
    format: 'der'
  })
}

export const importPrivateKey = (privateKeyBase64) => {
  return crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    type: 'pkcs8',
    format: 'der'
  })
}

export const deriveSharedSecret = (privateKey, peerPublicKey) => {
  const sharedSecret = crypto.diffieHellman({
    publicKey: peerPublicKey,
    privateKey: privateKey
  })
  
  return sharedSecret
}

export const generateSymmetricKey = () => {
  return crypto.randomBytes(KEY_LENGTH)
}

export const encryptWithSymmetricKey = (plaintext, key) => {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  
  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  const tag = cipher.getAuthTag()
  
  return {
    iv: iv.toString('base64'),
    encrypted,
    tag: tag.toString('base64')
  }
}

export const decryptWithSymmetricKey = (encryptedData, key) => {
  const iv = Buffer.from(encryptedData.iv, 'base64')
  const tag = Buffer.from(encryptedData.tag, 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  
  let decrypted = decipher.update(encryptedData.encrypted, 'base64', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}

export const encryptKeyForUser = (symmetricKey, recipientPublicKeyBase64) => {
  const recipientPublicKey = importPublicKey(recipientPublicKeyBase64)
  
  const ephemeral = crypto.generateKeyPairSync('x25519')
  const sharedSecret = crypto.diffieHellman({
    publicKey: recipientPublicKey,
    privateKey: ephemeral.privateKey
  })
  
  const derivedKey = crypto.createHash('sha256').update(sharedSecret).digest()
  
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv)
  
  let encrypted = cipher.update(symmetricKey)
  encrypted = Buffer.concat([encrypted, cipher.final()])
  const tag = cipher.getAuthTag()
  
  return {
    ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    iv: iv.toString('base64'),
    encrypted: encrypted.toString('base64'),
    tag: tag.toString('base64')
  }
}

export const decryptKeyForUser = (encryptedKeyPackage, privateKeyBase64) => {
  const privateKey = importPrivateKey(privateKeyBase64)
  
  const ephemeralPublicKey = importPublicKey(encryptedKeyPackage.ephemeralPublicKey)
  
  const sharedSecret = crypto.diffieHellman({
    publicKey: ephemeralPublicKey,
    privateKey: privateKey
  })
  
  const derivedKey = crypto.createHash('sha256').update(sharedSecret).digest()
  
  const iv = Buffer.from(encryptedKeyPackage.iv, 'base64')
  const tag = Buffer.from(encryptedKeyPackage.tag, 'base64')
  const encryptedKey = Buffer.from(encryptedKeyPackage.encrypted, 'base64')
  
  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv)
  decipher.setAuthTag(tag)
  
  let decrypted = decipher.update(encryptedKey)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  
  return decrypted
}

export const encryptMessage = (message, symmetricKey) => {
  return encryptWithSymmetricKey(JSON.stringify(message), symmetricKey)
}

export const decryptMessage = (encryptedPackage, symmetricKey) => {
  const decrypted = decryptWithSymmetricKey(encryptedPackage, symmetricKey)
  return JSON.parse(decrypted)
}

export const generateKeyIdentifier = () => {
  return crypto.randomBytes(8).toString('hex')
}

export const hashData = (data) => {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex')
}

export const verifyIntegrity = (data, hash) => {
  return hashData(data) === hash
}

export const exportKeyForBackup = (privateKey, password) => {
  const salt = crypto.randomBytes(SALT_LENGTH)
  const key = crypto.pbkdf2Sync(password, salt, 100000, KEY_LENGTH, 'sha512')
  
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  
  let encrypted = cipher.update(privateKey, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  const tag = cipher.getAuthTag()
  
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    encrypted,
    tag: tag.toString('base64')
  }
}

export const importKeyFromBackup = (backup, password) => {
  const salt = Buffer.from(backup.salt, 'base64')
  const key = crypto.pbkdf2Sync(password, salt, 100000, KEY_LENGTH, 'sha512')
  
  const iv = Buffer.from(backup.iv, 'base64')
  const tag = Buffer.from(backup.tag, 'base64')
  const encrypted = Buffer.from(backup.encrypted, 'base64')
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  
  let decrypted = decipher.update(encrypted)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  
  return decrypted.toString('utf8')
}
