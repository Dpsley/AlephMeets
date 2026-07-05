import type { Contact, Conversation, ExchangeSettings, Meeting, Message, User } from '../types'
import {
  getAccessToken,
  getRefreshToken,
  saveAuthTokens,
  type AuthTokens,
} from './auth'

export const API_URL = import.meta.env.VITE_API_URL
  || (import.meta.env.PROD ? 'https://meets-api.alephtrade.com' : 'http://127.0.0.1:4100')

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

let refreshPromise: Promise<AuthTokens> | null = null

async function renewAccessToken(): Promise<AuthTokens> {
  if (refreshPromise) return refreshPromise
  const refreshToken = getRefreshToken()
  if (!refreshToken) throw new ApiError('Сессия истекла. Войдите снова.', 401)
  refreshPromise = (async () => {
    const response = await request<{ tokens: AuthTokens }>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }, false)
    await saveAuthTokens(response.tokens)
    return response.tokens
  })()
  try {
    return await refreshPromise
  } finally {
    refreshPromise = null
  }
}

async function request<T>(path: string, init?: RequestInit, retryAfterRefresh = true): Promise<T> {
  const headers = new Headers(init?.headers)
  const accessToken = getAccessToken()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers,
    })
  } catch {
    throw new ApiError('Не удалось подключиться к API. Проверьте, что сервер запущен.', 0)
  }
  const payload = (await response.json()) as T & { message?: string }
  if (response.status === 401 && retryAfterRefresh && !path.startsWith('/api/auth/')) {
    await renewAccessToken()
    return request<T>(path, init, false)
  }
  if (!response.ok) throw new ApiError(payload.message ?? `HTTP ${response.status}`, response.status)
  return payload
}

export const api = {
  requestSms: (phone: string) =>
    request<{ success: boolean }>('/api/auth/sms/request', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),
  verifySms: (phone: string, code: string) =>
    request<{ tokens: AuthTokens; user: User }>('/api/auth/sms/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    }),
  refreshAuth: (refreshToken: string) =>
    request<{ tokens: AuthTokens }>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
  logout: () => request<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),
  session: () => request<{ user: User; authMode: string }>('/api/session'),
  meetings: () => request<{ meetings: Meeting[] }>('/api/meetings'),
  meetingByCode: (code: string) =>
    request<{ meeting: Meeting }>(`/api/meetings/join/${encodeURIComponent(code)}`),
  createMeeting: (input: Record<string, unknown>) =>
    request<{ meeting: Meeting; meetings?: Meeting[] }>('/api/meetings', { method: 'POST', body: JSON.stringify(input) }),
  updateMeeting: (id: string, input: Record<string, unknown>) =>
    request<{ meeting: Meeting }>(`/api/meetings/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteMeeting: (id: string) =>
    request<{ success: boolean }>(`/api/meetings/${id}`, { method: 'DELETE' }),
  meetingToken: (id: string) =>
    request<{ token: string; serverUrl: string; roomName: string; isHost: boolean }>(
      `/api/meetings/${id}/token`,
      { method: 'POST' },
    ),
  updateMeetingStatus: (id: string, status: Meeting['status']) =>
    request<{ meeting: Meeting }>(`/api/meetings/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  transferMeetingHost: (id: string, newHostId: string) =>
    request<{ meeting: Meeting }>(`/api/meetings/${id}/host`, {
      method: 'POST',
      body: JSON.stringify({ newHostId }),
    }),
  endMeetingForEveryone: (id: string) =>
    request<{ meeting: Meeting }>(`/api/meetings/${id}/end`, { method: 'POST' }),
  inviteMeetingContacts: (id: string, userIds: string[]) =>
    request<{ invited: string[] }>(`/api/meetings/${id}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ userIds }),
    }),
  declineMeetingInvitation: (id: string) =>
    request<{ success: boolean }>(`/api/meetings/${id}/invitations/decline`, { method: 'POST' }),
  contacts: () => request<{ contacts: Contact[] }>('/api/contacts'),
  addContact: (identifier: string) =>
    request<{ contact: Contact }>('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({ email: identifier }),
    }),
  conversations: () => request<{ conversations: Conversation[] }>('/api/conversations'),
  createConversation: (memberIds: string[], title?: string) =>
    request<{ conversation: Conversation }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ memberIds, title }),
    }),
  renameConversation: (id: string, title: string) =>
    request<{ conversation: Conversation }>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  addConversationMembers: (id: string, memberIds: string[]) =>
    request<{ success: boolean; added: number }>(`/api/conversations/${id}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    }),
  removeConversationMember: (id: string, userId: string) =>
    request<{ success: boolean }>(`/api/conversations/${id}/members/${userId}`, {
      method: 'DELETE',
    }),
  messages: (conversationId: string) =>
    request<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages`),
  markConversationRead: (conversationId: string) =>
    request<{ success: boolean }>(`/api/conversations/${conversationId}/read`, { method: 'PATCH' }),
  sendMessage: (conversationId: string, body: string) =>
    request<{ message: Message }>(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  startCallLog: (conversationId: string, meetingId: string) =>
    request<{ message: Message }>(`/api/conversations/${conversationId}/calls`, {
      method: 'POST',
      body: JSON.stringify({ meetingId }),
    }),
  finishCallLog: (
    conversationId: string,
    messageId: string,
    status: 'ended' | 'declined' | 'missed',
    durationMs: number,
  ) => request<{ message: Message }>(`/api/conversations/${conversationId}/calls/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, durationMs }),
  }),
  uploadCallRecording: (conversationId: string, messageId: string, file: Blob, name: string) => {
    const form = new FormData()
    form.append('file', file, name)
    return request<{ message: Message }>(
      `/api/conversations/${conversationId}/calls/${messageId}/recording`,
      { method: 'POST', body: form },
    )
  },
  uploadCallTranscript: (conversationId: string, messageId: string, file: Blob, name: string) => {
    const form = new FormData()
    form.append('file', file, name)
    return request<{ message: Message }>(
      `/api/conversations/${conversationId}/calls/${messageId}/transcript`,
      { method: 'POST', body: form },
    )
  },
  upload: (conversationId: string, file: Blob, name: string, kind = 'file', durationMs?: number) => {
    const form = new FormData()
    form.append('file', file, name)
    const params = new URLSearchParams({ kind })
    if (durationMs) params.set('durationMs', String(durationMs))
    return request<{ message: Message }>(
      `/api/conversations/${conversationId}/attachments?${params}`,
      { method: 'POST', body: form },
    )
  },
  exchangeSettings: () =>
    request<{ configured: boolean; settings: ExchangeSettings | null }>(
      '/api/calendar/exchange/settings',
    ),
  saveExchangeSettings: (settings: ExchangeSettings) =>
    request<{
      configured: boolean
      settings: ExchangeSettings
      sync: { imported: number; exported: number; total: number; syncedAt: string } | null
    }>('/api/calendar/exchange/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  testExchange: (settings: ExchangeSettings) =>
    request<{ success: boolean; ewsUrl: string }>('/api/calendar/exchange/test', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  syncExchange: () =>
    request<{ imported: number; exported: number; total: number; syncedAt: string }>(
      '/api/calendar/exchange/sync',
      { method: 'POST' },
    ),
}
