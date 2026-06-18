import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('alephDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  openNewWindow: () => ipcRenderer.send('window:new-test'),
  setTitlebarTheme: (theme: 'light' | 'dark') => ipcRenderer.send('window:titlebar-theme', theme),
  getVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  getAuthTokens: () => ipcRenderer.invoke('auth:get') as Promise<string | null>,
  setAuthTokens: (value: string) => ipcRenderer.invoke('auth:set', value) as Promise<void>,
  clearAuthTokens: () => ipcRenderer.invoke('auth:clear') as Promise<void>,
})
