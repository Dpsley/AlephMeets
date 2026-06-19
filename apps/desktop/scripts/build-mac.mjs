import { spawnSync } from 'node:child_process'

const env = { ...process.env }
const signingVariables = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]

for (const name of signingVariables) {
  if (!env[name]?.trim()) delete env[name]
}

const builderPath = process.platform === 'win32'
  ? 'electron-builder.cmd'
  : 'electron-builder'
const result = spawnSync(builderPath, ['--mac', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
