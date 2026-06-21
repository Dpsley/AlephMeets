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
  getAuthTokens: () => ipcRenderer.invoke('auth:get') as Promise<string | null>,
  setAuthTokens: (value: string) => ipcRenderer.invoke('auth:set', value) as Promise<void>,
  clearAuthTokens: () => ipcRenderer.invoke('auth:clear') as Promise<void>,
})
