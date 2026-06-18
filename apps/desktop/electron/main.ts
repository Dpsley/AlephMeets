import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session, shell } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.setName('AlephMeets')
if (process.platform === 'win32') app.setAppUserModelId('com.alephmeets.desktop')

const authSlots = new Map<number, string>()
const transientAuth = new Map<string, Buffer>()

function authFilePath(): string {
  return join(app.getPath('userData'), 'auth-tokens.bin')
}

function readAuth(slot: string): string | null {
  try {
    const encrypted = slot === 'primary'
      ? (existsSync(authFilePath()) ? readFileSync(authFilePath()) : null)
      : transientAuth.get(slot) ?? null
    return encrypted ? safeStorage.decryptString(encrypted) : null
  } catch {
    return null
  }
}

function writeAuth(slot: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable')
  const encrypted = safeStorage.encryptString(value)
  if (slot === 'primary') writeFileSync(authFilePath(), encrypted)
  else transientAuth.set(slot, encrypted)
}

function clearAuth(slot: string): void {
  if (slot === 'primary') {
    if (existsSync(authFilePath())) unlinkSync(authFilePath())
  } else {
    transientAuth.delete(slot)
  }
}

function createWindow(authSlot = 'primary'): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'AlephMeets',
    backgroundColor: '#f7f8fa',
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.ico'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#ffffff', symbolColor: '#555b66', height: 42 }
        : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const webContentsId = browserWindow.webContents.id
  authSlots.set(webContentsId, authSlot)
  browserWindow.on('closed', () => {
    authSlots.delete(webContentsId)
    if (authSlot !== 'primary') transientAuth.delete(authSlot)
  })

  browserWindow.once('ready-to-show', () => browserWindow.show())
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void browserWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void browserWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return browserWindow
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'display-capture', 'notifications'].includes(permission))
  })
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      callback({ video: sources[0] })
    },
    { useSystemPicker: true },
  )

  ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('window:maximize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (target?.isMaximized()) target.unmaximize()
    else target?.maximize()
  })
  ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.on('window:new-test', () => createWindow(randomUUID()))
  ipcMain.on('window:titlebar-theme', (event, theme: 'light' | 'dark') => {
    if (process.platform !== 'win32') return
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({
      color: theme === 'dark' ? '#191c20' : '#ffffff',
      symbolColor: theme === 'dark' ? '#e8e9eb' : '#555b66',
      height: 42,
    })
  })
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('auth:get', (event) => {
    const slot = authSlots.get(event.sender.id) ?? 'primary'
    return readAuth(slot)
  })
  ipcMain.handle('auth:set', (event, value: string) => {
    const slot = authSlots.get(event.sender.id) ?? 'primary'
    writeAuth(slot, value)
  })
  ipcMain.handle('auth:clear', (event) => {
    const slot = authSlots.get(event.sender.id) ?? 'primary'
    clearAuth(slot)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
