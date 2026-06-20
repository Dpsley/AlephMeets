import { app } from 'electron'
import { join } from 'node:path'

export function appIconPath(): string {
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return app.isPackaged
    ? join(process.resourcesPath, fileName)
    : join(__dirname, `../../build/${fileName}`)
}
