/// <reference types="vite/client" />

interface Window {
  alephDesktop?: {
    platform: string
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onMaximizedChanged: (listener: (maximized: boolean) => void) => () => void
    getVersion: () => Promise<string>
    getAuthTokens: () => Promise<string | null>
    setAuthTokens: (value: string) => Promise<void>
    clearAuthTokens: () => Promise<void>
  }
}
