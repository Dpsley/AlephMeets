export type MediaKind = 'audio' | 'video'
export type DesktopMediaAccessKind = 'camera' | 'microphone'

export async function ensureDesktopMediaAccess(kinds: DesktopMediaAccessKind[]): Promise<void> {
  const results = await window.alephDesktop?.ensureMediaAccess(kinds)
  const denied = results?.find((result) => !result.granted)
  if (!denied) return
  const label = denied.kind === 'camera' ? 'Камера' : 'Микрофон'
  throw new DOMException(
    `${label} заблокирован в настройках конфиденциальности macOS.`,
    'NotAllowedError',
  )
}

export function isMissingDeviceError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  const message = error instanceof Error ? error.message : String(error)
  return name === 'NotFoundError' || /requested device not found|device not found/i.test(message)
}

export function isRetryableMediaError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  return name === 'NotReadableError' || name === 'AbortError'
}

export function mediaErrorMessage(kind: MediaKind, error: unknown): string {
  const label = kind === 'audio' ? 'Микрофон' : 'Камера'
  if (isMissingDeviceError(error)) {
    return `${label} не найдена. Подключение продолжено ${kind === 'audio' ? 'без звука' : 'без видео'}.`
  }
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Нет разрешения на использование устройства «${label}».`
  }
  if (isRetryableMediaError(error)) {
    return `${label} ${kind === 'audio' ? 'временно недоступен' : 'временно недоступна'}. Переподключите устройство и повторите попытку.`
  }
  return `Не удалось включить устройство «${label}».`
}
