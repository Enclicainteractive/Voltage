import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'api'
process.env.VOLT_API_ENABLED = 'true'
process.env.VOLT_WEBSOCKET_ENABLED = 'false'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[API Service] Starting API-only server on port 5000')
await import('../server.js')
