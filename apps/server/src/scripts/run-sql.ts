import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pool } from '../db.js'
import { rootDir } from '../config.js'

const mode = process.argv[2]

try {
  if (mode === 'seed') {
    const file = 'database/seed.sql'
    await pool.query(await readFile(resolve(rootDir, file), 'utf8'))
    console.log(`Applied ${file}`)
  } else {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    await pool.query(`INSERT INTO schema_migrations (name)
      SELECT '001_initial.sql'
      WHERE to_regclass('public.users') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='001_initial.sql')`)
    const migrationDir = resolve(rootDir, 'database/migrations')
    const files = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()
    for (const file of files) {
      const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file])
      if (exists.rowCount) continue
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(await readFile(resolve(migrationDir, file), 'utf8'))
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        console.log(`Applied database/migrations/${file}`)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
  }
} finally {
  await pool.end()
}
