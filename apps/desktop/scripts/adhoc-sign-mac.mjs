import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--entitlements',
    join(context.packager.projectDir, 'build/entitlements.mac.plist'),
    appPath,
  ], { stdio: 'inherit' })
}
