import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

process.env.VOLT_SERVICE = 'cdn'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()

app.use(cors())
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'cdn', timestamp: new Date().toISOString() })
})

const PORT = process.env.PORT || 5003

app.listen(PORT, () => {
  console.log('[CDN Server] Running on port ' + PORT)
})
