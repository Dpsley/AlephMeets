import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('alephDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  onMaximizedChanged: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },
  getVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  ensureMediaAccess: (kinds: Array<'camera' | 'microphone'>) =>
    ipcRenderer.invoke('media:ensure-access', kinds) as Promise<Array<{
      kind: 'camera' | 'microphone'
      status: string
      granted: boolean
    }>>,
  openMediaSettings: (kind: 'camera' | 'microphone') =>
    ipcRenderer.invoke('media:open-settings', kind) as Promise<boolean>,
  downloadFile: (url: string, filename?: string) =>
    ipcRenderer.invoke('file:download', url, filename) as Promise<{ path?: string; cancelled?: boolean }>,
  openMeeting: (meetingId: string, context?: Record<string, unknown>) =>
    ipcRenderer.invoke('meeting:open', meetingId, context) as Promise<void>,
  getMeetingContext: () =>
    ipcRenderer.invoke('meeting:context') as Promise<Record<string, unknown> | null>,
  forceCloseMeeting: () => ipcRenderer.send('meeting:force-close'),
  onMeetingCloseRequested: (listener: () => void) => {
    const handler = (): void => listener()
    ipcRenderer.on('meeting:close-requested', handler)
    return () => ipcRenderer.removeListener('meeting:close-requested', handler)
  },
  onScreenShareSources: (listener: (request: {
    requestId: number
    sources: Array<{ id: string; name: string; thumbnail: string }>
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: {
      requestId: number
      sources: Array<{ id: string; name: string; thumbnail: string }>
    }): void => listener(request)
    ipcRenderer.on('screen-share:sources', handler)
    return () => ipcRenderer.removeListener('screen-share:sources', handler)
  },
  selectScreenShareSource: (requestId: number, sourceId?: string) =>
    ipcRenderer.send('screen-share:select', requestId, sourceId),
  getAuthTokens: () => ipcRenderer.invoke('auth:get') as Promise<string | null>,
  setAuthTokens: (value: string) => ipcRenderer.invoke('auth:set', value) as Promise<void>,
  clearAuthTokens: () => ipcRenderer.invoke('auth:clear') as Promise<void>,
})
