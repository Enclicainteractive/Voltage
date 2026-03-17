import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import federationRoutes, { setupFederationRoutes } from '../routes/federationRoutes.js'

dotenv.config()

process.env.VOLT_SERVICE = 'federation'

const app = express()

app.use(cors())
app.use(express.json({ limit: '2gb' }))
setupFederationRoutes(null)
app.use('/api/federation', federationRoutes)

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'federation', timestamp: new Date().toISOString() })
})

const PORT = process.env.PORT || 5002

app.listen(PORT, () => {
  console.log(`[Federation Server] Running on port ${PORT}`)
})
