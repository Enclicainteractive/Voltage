import dotenv from 'dotenv'

dotenv.config()

process.env.VOLT_SERVICE = 'worker'

const { startSystemScheduler } = require('../services/systemMessageScheduler.js')

console.log('[Worker Server] Starting background workers...')

startSystemScheduler(null)

console.log('[Worker Server] Workers running')

setInterval(() => {
  // Keep worker alive
}, 60000)
