// The logger's preload bridge is present in packaged Electron windows. Do not
// record bodies, headers, phone numbers, messages or authentication values.
export function reportApiFailure(path: string, status: number, kind: string, server: string): void {
  if (typeof window === 'undefined') return
  try {
    window.__electronLog?.error('API request failed', { server, path: path.split(/[?#]/)[0], status, kind })
  } catch { /* Logging must never interfere with handling the original failure. */ }
}

export function initializeRendererDiagnostics(apiUrl: string): void {
  window.__electronLog?.info('Renderer starting', { apiUrl })
  window.addEventListener('error', (event) => {
    window.__electronLog?.error('Unhandled renderer error', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    window.__electronLog?.error('Unhandled renderer rejection', event.reason)
  })
}
