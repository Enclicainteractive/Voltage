import dotenv from 'dotenv'
dotenv.config()
process.env.VOLT_SERVICE = 'websocket'
process.env.VOLT_API_ENABLED = 'false'
process.env.VOLT_WEBSOCKET_ENABLED = 'true'
process.env.VOLT_FEDERATION_ENABLED = 'false'
process.env.VOLT_WORKER_ENABLED = 'false'
console.log('[WebSocket Service] Starting WebSocket-only server on port 5001')
await import('../server.js')
