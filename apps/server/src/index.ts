import { createApp } from './app.js'
import { config } from './config.js'
import { pool } from './db.js'

const app = await createApp()

const shutdown = async (): Promise<void> => {
  await app.close()
  await pool.end()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  await pool.end()
  process.exit(1)
}
