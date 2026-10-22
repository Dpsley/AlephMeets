import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const encryption = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().slice('encrypted:'.length)),
}))
vi.mock('electron', () => ({ safeStorage: encryption }))

import { createAuthStorage } from './auth-storage'

let directory: string
let path: string

beforeEach(() => {
  vi.clearAllMocks()
  encryption.isEncryptionAvailable.mockReturnValue(true)
  directory = mkdtempSync(join(tmpdir(), 'aleph-auth-test-'))
  path = join(directory, 'auth-tokens.bin')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('desktop auth storage', () => {
  it('persists encrypted tokens and restores them in a new process store', async () => {
    const confirm = vi.fn(async () => true)
    const store = createAuthStorage(() => path, confirm)

    await store.write('primary', 'tokens')

    expect(readFileSync(path).toString()).toBe('encrypted:tokens')
    expect(createAuthStorage(() => path, confirm).read('primary')).toBe('tokens')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('requires consent before using memory when Keychain is unavailable', async () => {
    encryption.isEncryptionAvailable.mockReturnValue(false)
    const confirm = vi.fn(async () => false)
    const store = createAuthStorage(() => path, confirm)

    await expect(store.write('primary', 'tokens')).rejects.toThrow('Вход отменён:')

    expect(confirm).toHaveBeenCalledOnce()
    expect(store.read('primary')).toBeNull()
    expect(existsSync(path)).toBe(false)
    expect(encryption.encryptString).not.toHaveBeenCalled()
  })

  it('keeps an approved session and refreshed tokens in memory without restoring an old account', async () => {
    writeFileSync(path, 'encrypted:previous-account')
    encryption.isEncryptionAvailable.mockReturnValue(false)
    const confirm = vi.fn(async () => true)
    const store = createAuthStorage(() => path, confirm)

    await store.write('primary', 'new-account')
    expect(store.read('primary')).toBe('new-account')
    await store.write('primary', 'refreshed-tokens')

    expect(store.read('primary')).toBe('refreshed-tokens')
    expect(store.read('other-account')).toBeNull()
    expect(confirm).toHaveBeenCalledOnce()
    expect(existsSync(path)).toBe(false)
    expect(createAuthStorage(() => path, confirm).read('primary')).toBeNull()
    store.clear('primary')
    expect(store.read('primary')).toBeNull()
    await store.write('primary', 'another-login')
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('offers a temporary session if encryption itself fails', async () => {
    encryption.encryptString.mockImplementationOnce(() => { throw new Error('Keychain denied access') })
    const confirm = vi.fn(async () => true)
    const store = createAuthStorage(() => path, confirm)

    await store.write('primary', 'tokens')

    expect(confirm).toHaveBeenCalledOnce()
    expect(store.read('primary')).toBe('tokens')
    expect(existsSync(path)).toBe(false)
  })

  it('does not treat a disk write failure as unavailable encryption', async () => {
    const confirm = vi.fn(async () => true)
    const store = createAuthStorage(() => join(directory, 'missing', 'auth.bin'), confirm)

    await expect(store.write('primary', 'tokens')).rejects.toThrow()

    expect(confirm).not.toHaveBeenCalled()
    expect(store.read('primary')).toBeNull()
  })

  it('clears encrypted tokens on logout', async () => {
    const store = createAuthStorage(() => path, async () => false)
    await store.write('primary', 'tokens')
    store.clear('primary')
    expect(existsSync(path)).toBe(false)
    expect(store.read('primary')).toBeNull()
  })

  it('isolates temporary accounts and never writes them to disk', async () => {
    const store = createAuthStorage(() => path, async () => false)
    await store.write('primary', 'primary-tokens')
    await store.write('secondary', 'secondary-tokens')

    expect(store.read('primary')).toBe('primary-tokens')
    expect(store.read('secondary')).toBe('secondary-tokens')
    expect(readFileSync(path).toString()).toBe('encrypted:primary-tokens')
    store.clear('secondary')
    expect(store.read('secondary')).toBeNull()
    expect(store.read('primary')).toBe('primary-tokens')
  })
})
