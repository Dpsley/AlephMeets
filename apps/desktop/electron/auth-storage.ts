import { safeStorage } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export function createAuthStorage(
  filePath: () => string,
  confirmSessionOnly: () => Promise<boolean>,
) {
  const encryptedSessions = new Map<string, Buffer>()
  // These tokens never leave this process and disappear when the app quits.
  const sessionOnlyTokens = new Map<string, string>()

  function removeFile(): void {
    const path = filePath()
    if (existsSync(path)) unlinkSync(path)
  }

  return {
    read(slot: string): string | null {
      const temporary = sessionOnlyTokens.get(slot)
      if (temporary !== undefined) return temporary
      try {
        const path = filePath()
        const encrypted = slot === 'primary'
          ? (existsSync(path) ? readFileSync(path) : null)
          : encryptedSessions.get(slot) ?? null
        return encrypted ? safeStorage.decryptString(encrypted) : null
      } catch {
        return null
      }
    },

    async write(slot: string, value: string): Promise<void> {
      if (sessionOnlyTokens.has(slot)) {
        sessionOnlyTokens.set(slot, value)
        return
      }

      let encrypted: Buffer | null = null
      try {
        const insecureBackend = process.platform === 'linux'
          && safeStorage.getSelectedStorageBackend() === 'basic_text'
        if (!insecureBackend && safeStorage.isEncryptionAvailable()) {
          encrypted = safeStorage.encryptString(value)
        }
      } catch {
        // Keychain access can fail even after the availability check succeeds.
      }

      if (encrypted) {
        if (slot === 'primary') writeFileSync(filePath(), encrypted)
        else encryptedSessions.set(slot, encrypted)
        return
      }

      if (!await confirmSessionOnly()) {
        throw new Error('Вход отменён: защищённое хранилище недоступно. Разрешите доступ к нему и перезапустите AlephMeets либо выберите вход до закрытия приложения.')
      }
      // Do not restore a previous account after restarting a temporary session.
      if (slot === 'primary') removeFile()
      encryptedSessions.delete(slot)
      sessionOnlyTokens.set(slot, value)
    },

    clear(slot: string): void {
      sessionOnlyTokens.delete(slot)
      encryptedSessions.delete(slot)
      if (slot === 'primary') removeFile()
    },
  }
}
