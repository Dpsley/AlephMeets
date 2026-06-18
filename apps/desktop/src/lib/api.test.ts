import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { clearAuthTokens, saveAuthTokens } from './auth'

afterEach(async () => {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') await clearAuthTokens()
  vi.unstubAllGlobals()
})

describe('API request headers', () => {
  it('does not declare JSON for an empty POST body', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ token: 'token', serverUrl: 'ws://localhost', roomName: 'room' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api.meetingToken('meeting-id')

    const init = fetchMock.mock.calls[0]?.[1]
    if (!init) throw new Error('Expected fetch request options')
    expect(new Headers(init.headers).has('Content-Type')).toBe(false)
  })

  it('declares JSON when a JSON body is present', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ meeting: {} }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api.updateMeetingStatus('meeting-id', 'live')

    const init = fetchMock.mock.calls[0]?.[1]
    if (!init) throw new Error('Expected fetch request options')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  })

  it('sends the IDP access token with every authenticated request', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    await saveAuthTokens({ accessToken: 'idp-access-token', refreshToken: 'refresh', expiresIn: 86400 })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ user: {} }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api.session()

    const init = fetchMock.mock.calls[0]?.[1]
    if (!init) throw new Error('Expected fetch request options')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer idp-access-token')
  })

  it('rotates an expired access token and retries the request once', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    await saveAuthTokens({ accessToken: 'expired-access', refreshToken: 'valid-refresh', expiresIn: 1 })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const call = fetchMock.mock.calls.length
      if (call === 1) return { ok: false, status: 401, json: async () => ({ message: 'expired' }) }
      if (call === 2) return {
        ok: true,
        status: 200,
        json: async () => ({
          tokens: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 86400 },
        }),
      }
      return { ok: true, status: 200, json: async () => ({ user: {} }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await api.session()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe('Bearer new-access')
  })
})
