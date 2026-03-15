import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

const LOGS_DIR = path.join(DATA_DIR, 'security', 'logs')
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
}

class SecurityLogger {
  constructor() {
    this.suspiciousPatterns = [
      { pattern: /(\%27)|(\')|(\-\-)|(\%23)/i, name: 'SQL Injection attempt' },
      { pattern: /(<script)|(%3Cscript)|(javascript:)/i, name: 'XSS attempt' },
      { pattern: /(\.\.\/)|(\.\.\\)/i, name: 'Path traversal attempt' },
      { pattern: /(\%2F\%2E\%2E)|(\.\.\/)/i, name: 'Directory traversal' },
      { pattern: /(eval|alert|prompt|confirm)\s*\(/i, name: 'JS Injection attempt' },
      { pattern: /(<iframe)|(<embed)|(<object)/i, name: 'HTML injection attempt' },
      { pattern: /(\$\{)|(\{\{)/i, name: 'Template injection attempt' },
      { pattern: /(union.*select|insert.*into|delete.*from|drop.*table)/i, name: 'SQL command attempt' },
    ]
    
    this.eventTypes = {
      AUTH_SUCCESS: 'auth_success',
      AUTH_FAILURE: 'auth_failure',
      LOGIN_SUCCESS: 'login_success',
      LOGIN_FAILURE: 'login_failure',
      LOGOUT: 'logout',
      REGISTER: 'register',
      RATE_LIMIT: 'rate_limit',
      SQL_INJECTION: 'sql_injection',
      XSS_ATTEMPT: 'xss_attempt',
      PATH_TRAVERSAL: 'path_traversal',
      INVALID_INPUT: 'invalid_input',
      SUSPICIOUS_REQUEST: 'suspicious_request',
      BLOCKED_IP: 'blocked_ip',
      FILE_UPLOAD: 'file_upload',
      WEBSOCKET_CONNECT: 'websocket_connect',
      WEBSOCKET_DISCONNECT: 'websocket_disconnect',
      API_ACCESS: 'api_access',
      ADMIN_ACTION: 'admin_action',
      CONFIG_CHANGE: 'config_change',
    }
  }

  logSecurityEvent(type, data = {}) {
    const timestamp = new Date().toISOString()
    const logEntry = {
      timestamp,
      type,
      ...data,
    }

    const logFile = path.join(LOGS_DIR, `security-${new Date().toISOString().split('T')[0]}.log`)
    fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', (err) => {
      if (err) console.error('[SecurityLogger] Failed to write log:', err.message)
    })

    if (type.includes('FAILURE') || type.includes('INJECTION') || type.includes('BLOCKED')) {
      console.log(`[SECURITY] ${type}:`, data)
    }
  }

  logAuth(userId, ip, success, method = 'password') {
    this.logSecurityEvent(success ? this.eventTypes.AUTH_SUCCESS : this.eventTypes.AUTH_FAILURE, {
      userId,
      ip,
      method,
    })
  }

  logLogin(userId, ip, success) {
    this.logSecurityEvent(success ? this.eventTypes.LOGIN_SUCCESS : this.eventTypes.LOGIN_FAILURE, {
      userId,
      ip,
    })
  }

  logRateLimit(ip, endpoint) {
    this.logSecurityEvent(this.eventTypes.RATE_LIMIT, {
      ip,
      endpoint,
    })
  }

  logSuspicious(pattern, ip, details = {}) {
    this.logSecurityEvent(this.eventTypes.SUSPICIOUS_REQUEST, {
      ip,
      pattern,
      ...details,
    })
  }

  logBlockedIP(ip, reason) {
    this.logSecurityEvent(this.eventTypes.BLOCKED_IP, {
      ip,
      reason,
    })
  }

  logApiAccess(ip, endpoint, method, userId = null) {
    this.logSecurityEvent(this.eventTypes.API_ACCESS, {
      ip,
      endpoint,
      method,
      userId,
    })
  }

  logAdminAction(adminId, action, target) {
    this.logSecurityEvent(this.eventTypes.ADMIN_ACTION, {
      adminId,
      action,
      target,
    })
  }

  analyzeRequest(req) {
    const suspicious = []
    const ip = req.ip || req.socket.remoteAddress

    const checkString = (str) => {
      if (typeof str !== 'string') return
      
      for (const { pattern, name } of this.suspiciousPatterns) {
        if (pattern.test(str)) {
          suspicious.push({ type: name, value: str.substring(0, 100) })
        }
      }
    }

    checkString(req.url)
    checkString(req.query?.q)
    checkString(req.body?.search)
    checkString(req.body?.query)

    if (suspicious.length > 0) {
      this.logSuspicious(suspicious[0].type, ip, {
        url: req.url,
        method: req.method,
        suspicious,
      })
    }

    return suspicious
  }

  getSecurityStats(days = 7) {
    const stats = {
      totalEvents: 0,
      authFailures: 0,
      sqlInjections: 0,
      xssAttempts: 0,
      rateLimits: 0,
      blockedIPs: 0,
    }

    const now = Date.now()
    const cutoff = now - (days * 24 * 60 * 60 * 1000)

    try {
      for (let i = 0; i < days; i++) {
        const date = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        const logFile = path.join(LOGS_DIR, `security-${date}.log`)
        
        if (!fs.existsSync(logFile)) continue
        
        const content = fs.readFileSync(logFile, 'utf8')
        const lines = content.trim().split('\n')
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            stats.totalEvents++
            
            if (entry.type === this.eventTypes.AUTH_FAILURE) stats.authFailures++
            if (entry.type === this.eventTypes.SQL_INJECTION || entry.pattern?.includes('SQL')) stats.sqlInjections++
            if (entry.type === this.eventTypes.XSS_ATTEMPT || entry.pattern?.includes('XSS')) stats.xssAttempts++
            if (entry.type === this.eventTypes.RATE_LIMIT) stats.rateLimits++
            if (entry.type === this.eventTypes.BLOCKED_IP) stats.blockedIPs++
          } catch {}
        }
      }
    } catch (err) {
      console.error('[SecurityLogger] Error getting stats:', err.message)
    }

    return stats
  }

  getRecentEvents(limit = 100) {
    const events = []
    const logFile = path.join(LOGS_DIR, `security-${new Date().toISOString().split('T')[0]}.log`)
    
    if (!fs.existsSync(logFile)) return events
    
    const content = fs.readFileSync(logFile, 'utf8')
    const lines = content.trim().split('\n')
    
    for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
      try {
        events.push(JSON.parse(lines[i]))
      } catch {}
    }
    
    return events
  }
}

const securityLogger = new SecurityLogger()
export default securityLogger
