/// <reference types="vite/client" />

interface Window {
  alephDesktop?: {
    platform: string
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    claimRingtone: () => Promise<boolean>
    onMaximizedChanged: (listener: (maximized: boolean) => void) => () => void
    getVersion: () => Promise<string>
    showNotification: (notification: { id: string; title: string; body: string; route?: string }) => void
    onNavigate: (listener: (route: string) => void) => () => void
    ensureMediaAccess: (kinds: Array<'camera' | 'microphone'>) => Promise<Array<{
      kind: 'camera' | 'microphone'
      status: string
      granted: boolean
    }>>
    openMediaSettings: (kind: 'camera' | 'microphone') => Promise<boolean>
    downloadFile: (url: string, filename?: string) => Promise<{ path?: string; cancelled?: boolean }>
    saveDataUrl: (dataUrl: string, filename?: string) => Promise<{ path?: string; cancelled?: boolean }>
    openMeeting: (meetingId: string, context?: Record<string, unknown>) => Promise<void>
    getMeetingContext: () => Promise<Record<string, unknown> | null>
    forceCloseMeeting: () => void
    onMeetingCloseRequested: (listener: () => void) => () => void
    onScreenShareSources: (listener: (request: {
      requestId: number
      sources: Array<{ id: string; name: string; thumbnail: string }>
    }) => void) => () => void
    selectScreenShareSource: (requestId: number, sourceId?: string) => void
    getAuthTokens: () => Promise<string | null>
    setAuthTokens: (value: string) => Promise<void>
    clearAuthTokens: () => Promise<void>
  }
}
