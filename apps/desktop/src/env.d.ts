/// <reference types="vite/client" />

interface Window {
  alephDesktop?: {
    platform: string
    minimize: () => void
    maximize: () => void
    close: () => void
    openNewWindow: () => void
    setTitlebarTheme: (theme: 'light' | 'dark') => void
    getVersion: () => Promise<string>
    getAuthTokens: () => Promise<string | null>
    setAuthTokens: (value: string) => Promise<void>
    clearAuthTokens: () => Promise<void>
  }
}
