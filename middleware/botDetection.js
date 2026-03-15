import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

const BOT_DIR = path.join(DATA_DIR, 'security', 'bot')
if (!fs.existsSync(BOT_DIR)) {
  fs.mkdirSync(BOT_DIR, { recursive: true })
}

class BotDetector {
  constructor() {
    this.honeypotFields = ['website', 'url', 'homepage', 'site', 'comment']
    this.suspiciousUserAgents = [
      'curl', 'wget', 'python', 'scrapy', 'bot', 'spider', 'crawler',
      'nikto', 'nmap', 'masscan', 'sqlmap', 'hydra', 'burp'
    ]
    this.suspiciousPatterns = [
      /\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b/i,
      /<script|javascript:|on\w+=/i,
      /\.\.\/|\.\.\\/,
      /%2F%2E%2E/i,
      /(\%27)|(\')|(\-\-)|(\%23)/i,
    ]
    this.behavioralScores = new Map()
    this.maxScore = 100
    this.blockThreshold = 70
  }

  generateHoneypotField() {
    return 'hp_' + crypto.randomBytes(4).toString('hex')
  }

  checkHoneypot(req) {
    for (const field of this.honeypotFields) {
      if (req.body?.[field] || req.query?.[field]) {
        return { detected: true, field, reason: 'Honeypot field filled' }
      }
    }
    return { detected: false }
  }

  checkUserAgent(req) {
    const ua = req.headers['user-agent'] || ''
    const uaLower = ua.toLowerCase()

    for (const suspicious of this.suspiciousUserAgents) {
      if (uaLower.includes(suspicious)) {
        return { detected: true, reason: `Suspicious user agent: ${suspicious}`, ua }
      }
    }

    if (!ua || ua.length < 10) {
      return { detected: true, reason: 'Missing or too short user agent', ua }
    }

    return { detected: false }
  }

  checkRequestPattern(req) {
    const checkStrings = [
      req.url,
      req.query?.q,
      req.query?.search,
      req.body?.query,
      req.body?.search
    ].filter(Boolean)

    for (const str of checkStrings) {
      for (const pattern of this.suspiciousPatterns) {
        if (pattern.test(str)) {
          return { detected: true, reason: 'Suspicious pattern detected', pattern: str.substring(0, 50) }
        }
      }
    }

    return { detected: false }
  }

  calculateBehavioralScore(req, ip) {
    let score = 0
    const now = Date.now()
    const windowMs = 5 * 60 * 1000

    const key = ip
    let history = this.behavioralScores.get(key) || {
      requests: [],
      pages: new Set(),
      failedAuth: 0,
      uniqueEndpoints: new Set()
    }

    history.requests.push(now)
    history.requests = history.requests.filter(t => now - t < windowMs)
    history.uniqueEndpoints.add(req.path)

    const requestsPerMinute = history.requests.length
    if (requestsPerMinute > 120) score += 30
    else if (requestsPerMinute > 60) score += 15
    else if (requestsPerMinute > 30) score += 5

    if (history.uniqueEndpoints.size > 50) score += 20
    if (history.uniqueEndpoints.size > 30) score += 10

    const suspiciousPaths = ['/admin', '/wp-admin', '/.env', '/phpinfo', '/shell', '/backdoor']
    for (const p of suspiciousPaths) {
      if (req.path.toLowerCase().includes(p)) {
        score += 25
      }
    }

    this.behavioralScores.set(key, history)

    if (history.requests.length === 1) {
      setTimeout(() => {
        this.behavioralScores.delete(key)
      }, windowMs)
    }

    return score
  }

  analyze(req) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    const results = {
      ip,
      isBot: false,
      score: 0,
      reasons: []
    }

    const honeypot = this.checkHoneypot(req)
    if (honeypot.detected) {
      results.isBot = true
      results.score += 50
      results.reasons.push(honeypot)
    }

    const userAgent = this.checkUserAgent(req)
    if (userAgent.detected) {
      results.score += 30
      results.reasons.push(userAgent)
    }

    const pattern = this.checkRequestPattern(req)
    if (pattern.detected) {
      results.isBot = true
      results.score += 40
      results.reasons.push(pattern)
    }

    const behavioralScore = this.calculateBehavioralScore(req, ip)
    results.score += behavioralScore

    if (results.score >= this.blockThreshold) {
      results.isBot = true
    }

    if (results.isBot) {
      console.log(`[BotDetector] Bot detected from ${ip}, score: ${results.score}`, results.reasons)
    }

    return results
  }

  shouldBlock(analysis) {
    return analysis.isBot && analysis.score >= this.blockThreshold
  }

  getStats() {
    let totalScored = 0
    let totalScore = 0
    
    for (const data of this.behavioralScores.values()) {
      totalScored++
      totalScore += data.requests.length
    }

    return {
      trackedIPs: this.behavioralScores.size,
      averageRequests: totalScored > 0 ? totalScore / totalScored : 0
    }
  }
}

const botDetector = new BotDetector()

export default botDetector
export { BotDetector }
