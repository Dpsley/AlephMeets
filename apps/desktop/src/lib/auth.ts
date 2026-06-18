export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

const browserStorageKey = 'aleph-meets:auth-tokens'
let tokens: AuthTokens | null = null

export async function loadAuthTokens(): Promise<AuthTokens | null> {
  const serialized = window.alephDesktop
    ? await window.alephDesktop.getAuthTokens()
    : localStorage.getItem(browserStorageKey)
  if (!serialized) {
    tokens = null
    return null
  }
  try {
    tokens = JSON.parse(serialized) as AuthTokens
  } catch {
    await clearAuthTokens()
  }
  return tokens
}

export function getAccessToken(): string | null {
  return tokens?.accessToken ?? null
}

export function getRefreshToken(): string | null {
  return tokens?.refreshToken ?? null
}

export async function saveAuthTokens(value: AuthTokens): Promise<void> {
  tokens = value
  const serialized = JSON.stringify(value)
  if (window.alephDesktop) await window.alephDesktop.setAuthTokens(serialized)
  else localStorage.setItem(browserStorageKey, serialized)
}

export async function clearAuthTokens(): Promise<void> {
  tokens = null
  if (window.alephDesktop) await window.alephDesktop.clearAuthTokens()
  else localStorage.removeItem(browserStorageKey)
}
