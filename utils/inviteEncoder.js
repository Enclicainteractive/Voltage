import { deflateSync, inflateSync } from 'zlib'
import { Buffer } from 'buffer'

const INVITE_VERSION = 1
const INVITE_MAGIC = Buffer.from('VOLT')

export const InviteEncoder = {
  encode(inviteData) {
    const payload = {
      v: INVITE_VERSION,
      h: inviteData.host,
      s: inviteData.serverId,
      c: inviteData.channelId,
      k: inviteData.key
    }
    
    const jsonStr = JSON.stringify(payload)
    const compressed = deflateSync(jsonStr, { level: 9 })
    
    const versionBuffer = Buffer.alloc(1)
    versionBuffer[0] = INVITE_VERSION
    
    const combined = Buffer.concat([INVITE_MAGIC, versionBuffer, compressed])
    const base64 = combined.toString('base64url')
    
    return base64
  },
  
  decode(encoded) {
    try {
      const combined = Buffer.from(encoded, 'base64url')
      
      if (combined.length < 6) {
        return null
      }
      
      const magic = combined.slice(0, 4)
      if (!magic.equals(INVITE_MAGIC)) {
        return null
      }
      
      const version = combined[4]
      if (version !== INVITE_VERSION) {
        return null
      }
      
      const compressed = combined.slice(5)
      const jsonStr = inflateSync(compressed).toString('utf8')
      const payload = JSON.parse(jsonStr)
      
      return {
        host: payload.h,
        serverId: payload.s,
        channelId: payload.c,
        key: payload.k
      }
    } catch (e) {
      return null
    }
  },
  
  isCrossHostInvite(code) {
    if (code.length < 10) return false
    try {
      const decoded = this.decode(code)
      return decoded !== null
    } catch {
      return false
    }
  },
  
  createInviteLink(inviteData) {
    const encoded = this.encode(inviteData)
    return `https://volt.gg/inv/${encoded}`
  },
  
  parseInviteLink(urlOrCode) {
    let code = urlOrCode
    
    if (urlOrCode.includes('/inv/')) {
      const parts = urlOrCode.split('/inv/')
      code = parts[parts.length - 1]
    }
    
    return this.decode(code)
  }
}

export const createCrossHostInvite = (serverId, channelId, host, key = null) => {
  return InviteEncoder.encode({
    host,
    serverId,
    channelId,
    key
  })
}

export const parseCrossHostInvite = (code) => {
  return InviteEncoder.decode(code)
}

export default InviteEncoder
