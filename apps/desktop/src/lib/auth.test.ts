import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearAuthTokens, getAccessToken, getRefreshToken, saveAuthTokens } from './auth'

afterEach(async () => {
  await clearAuthTokens()
  vi.unstubAllGlobals()
})

describe('saving desktop auth tokens', () => {
  it('only replaces active tokens after the main process accepts storage', async () => {
    const setAuthTokens = vi.fn(async (_value: string) => {})
    vi.stubGlobal('window', { alephDesktop: { setAuthTokens, clearAuthTokens: vi.fn() } })
    const previous = { accessToken: 'previous-access', refreshToken: 'previous-refresh', expiresIn: 60 }
    await saveAuthTokens(previous)
    setAuthTokens.mockRejectedValueOnce(new Error('Вход отменён'))

    await expect(saveAuthTokens({
      accessToken: 'rejected-access', refreshToken: 'rejected-refresh', expiresIn: 60,
    })).rejects.toThrow('Вход отменён')

    expect(getAccessToken()).toBe('previous-access')
    expect(getRefreshToken()).toBe('previous-refresh')
  })
})
