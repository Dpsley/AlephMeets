import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('alephDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  openNewWindow: () => ipcRenderer.send('window:new-test'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  onMaximizedChanged: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },
  getVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  getAuthTokens: () => ipcRenderer.invoke('auth:get') as Promise<string | null>,
  setAuthTokens: (value: string) => ipcRenderer.invoke('auth:set', value) as Promise<void>,
  clearAuthTokens: () => ipcRenderer.invoke('auth:clear') as Promise<void>,
})
