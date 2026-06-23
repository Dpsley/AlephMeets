import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session, shell, systemPreferences } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appIconPath } from './app-icon'
import { destroyMandatoryUpdateGate, enforceMandatoryUpdate } from './mandatory-updater'

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.setName('AlephMeets')
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'com.alephmeets.desktop' : 'com.alephmeets.desktop.dev')
}

const authSlots = new Map<number, string>()
const transientAuth = new Map<string, Buffer>()
const meetingWindows = new Map<string, BrowserWindow>()
const meetingContexts = new Map<number, Record<string, unknown> | null>()
const forceClosingMeetingWindows = new Set<number>()
const pendingDisplayRequests = new Map<number, {
  frame: Electron.WebFrameMain
  sources: Electron.DesktopCapturerSource[]
  callback: (streams: Electron.Streams) => void
  timer: ReturnType<typeof setTimeout>
}>()
let nextDisplayRequestId = 1

type MediaAccessKind = 'camera' | 'microphone'

type MediaAccessResult = {
  kind: MediaAccessKind
  status: string
  granted: boolean
}

const mediaSettingsUrls: Record<MediaAccessKind, string> = {
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
}

function isMediaAccessKind(value: unknown): value is MediaAccessKind {
  return value === 'camera' || value === 'microphone'
}

async function ensureMediaAccess(kind: MediaAccessKind): Promise<MediaAccessResult> {
  if (process.platform !== 'darwin') return { kind, status: 'granted', granted: true }

  let status = systemPreferences.getMediaAccessStatus(kind)
  if (status === 'granted') return { kind, status, granted: true }
  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess(kind)
    status = systemPreferences.getMediaAccessStatus(kind)
    return { kind, status: granted ? 'granted' : status, granted }
  }
  return { kind, status, granted: false }
}

function isSameFrame(
  left: Electron.WebFrameMain | null,
  right: Electron.WebFrameMain | null,
): boolean {
  return Boolean(left && right && left.processId === right.processId && left.routingId === right.routingId)
}

function finishDisplayRequest(requestId: number, sourceId?: string): void {
  const request = pendingDisplayRequests.get(requestId)
  if (!request) return
  pendingDisplayRequests.delete(requestId)
  clearTimeout(request.timer)
  const source = sourceId ? request.sources.find((item) => item.id === sourceId) : undefined
  request.callback(source ? { video: source } : {})
}

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
    icon: appIconPath(),
    frame: process.platform !== 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
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
  browserWindow.on('maximize', () => browserWindow.webContents.send('window:maximized-changed', true))
  browserWindow.on('unmaximize', () => browserWindow.webContents.send('window:maximized-changed', false))

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

function createMeetingWindow(
  meetingId: string,
  authSlot: string,
  context: Record<string, unknown> | null,
): BrowserWindow {
  const existing = meetingWindows.get(meetingId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }
  const browserWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'AlephMeets',
    backgroundColor: '#111316',
    icon: appIconPath(),
    frame: process.platform !== 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const webContentsId = browserWindow.webContents.id
  authSlots.set(webContentsId, authSlot)
  meetingContexts.set(webContentsId, context)
  meetingWindows.set(meetingId, browserWindow)
  browserWindow.on('close', (event) => {
    if (forceClosingMeetingWindows.has(webContentsId)) return
    event.preventDefault()
    browserWindow.webContents.send('meeting:close-requested')
  })
  browserWindow.on('closed', () => {
    forceClosingMeetingWindows.delete(webContentsId)
    authSlots.delete(webContentsId)
    meetingContexts.delete(webContentsId)
    if (meetingWindows.get(meetingId) === browserWindow) meetingWindows.delete(meetingId)
  })
  browserWindow.on('maximize', () => browserWindow.webContents.send('window:maximized-changed', true))
  browserWindow.on('unmaximize', () => browserWindow.webContents.send('window:maximized-changed', false))
  browserWindow.once('ready-to-show', () => browserWindow.show())
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void browserWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/meeting/${encodeURIComponent(meetingId)}`)
  } else {
    void browserWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: `/meeting/${encodeURIComponent(meetingId)}`,
    })
  }
  return browserWindow
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'display-capture', 'notifications'].includes(permission))
  })
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!request.frame) {
        callback({})
        return
      }
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      })
      const requestId = nextDisplayRequestId++
      for (const [pendingId, pending] of pendingDisplayRequests) {
        if (isSameFrame(pending.frame.top, request.frame.top)) finishDisplayRequest(pendingId)
      }
      const timer = setTimeout(() => finishDisplayRequest(requestId), 60_000)
      pendingDisplayRequests.set(requestId, { frame: request.frame, sources, callback, timer })
      request.frame.send('screen-share:sources', {
        requestId,
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL(),
        })),
      })
    },
    { useSystemPicker: true },
  )

  ipcMain.on('screen-share:select', (event, requestId: number, sourceId?: string) => {
    const request = pendingDisplayRequests.get(requestId)
    if (!request || !isSameFrame(request.frame.top, event.sender.mainFrame)) return
    finishDisplayRequest(requestId, sourceId)
  })

  ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.on('window:maximize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (target?.isMaximized()) target.unmaximize()
    else target?.maximize()
  })
  ipcMain.on('window:close', (event) => {
    if (meetingContexts.has(event.sender.id)) event.sender.send('meeting:close-requested')
    else BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.on('meeting:force-close', (event) => {
    forceClosingMeetingWindows.add(event.sender.id)
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('window:is-maximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('media:ensure-access', async (_event, kinds?: unknown[]) => {
    const requested = Array.isArray(kinds) && kinds.length ? kinds : ['microphone', 'camera']
    const unique = [...new Set(requested.filter(isMediaAccessKind))]
    return Promise.all(unique.map((kind) => ensureMediaAccess(kind)))
  })
  ipcMain.handle('media:open-settings', async (_event, kind: unknown) => {
    if (process.platform !== 'darwin' || !isMediaAccessKind(kind)) return false
    await shell.openExternal(mediaSettingsUrls[kind])
    return true
  })
  ipcMain.handle('meeting:open', (event, meetingId: string, context?: Record<string, unknown>) => {
    const slot = authSlots.get(event.sender.id) ?? 'primary'
    createMeetingWindow(meetingId, slot, context ?? null)
  })
  ipcMain.handle('meeting:context', (event) => meetingContexts.get(event.sender.id) ?? null)
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

  if (!await enforceMandatoryUpdate()) return

  createWindow()
  destroyMandatoryUpdateGate()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const requestId of pendingDisplayRequests.keys()) finishDisplayRequest(requestId)
  if (process.platform !== 'darwin') app.quit()
})
