import { spawnSync } from 'node:child_process'

const env = { ...process.env }
const signingVariables = [
  'CSC_LINK',
  'CSC_NAME',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE',
]

for (const name of signingVariables) {
  if (!env[name]?.trim()) delete env[name]
}

const macBuilderVersion = env.MAC_ELECTRON_BUILDER_VERSION?.trim() || '26.0.12'
delete env.MAC_ELECTRON_BUILDER_VERSION

const builderPath = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const builderArgs = [
  'exec',
  '--yes',
  '--package',
  `electron-builder@${macBuilderVersion}`,
  '--',
  'electron-builder',
  '--mac',
  ...process.argv.slice(2),
  '--publish',
  'never',
]
const hasExplicitSigningIdentity = Boolean(env.CSC_LINK || env.CSC_NAME)
if (process.platform === 'darwin' && env.CI === 'true' && !hasExplicitSigningIdentity) {
  builderArgs.push('-c.mac.identity=-')
}

const result = spawnSync(builderPath, builderArgs, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
