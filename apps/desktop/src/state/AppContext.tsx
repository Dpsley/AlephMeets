import { io, type Socket } from 'socket.io-client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Avatar, Modal } from '../components/ui'
import {
  clearAuthTokens,
  getAccessToken,
  loadAuthTokens,
  saveAuthTokens,
} from '../lib/auth'
import { API_URL, api } from '../lib/api'
import type { DirectCallContext, Meeting, Message, User } from '../types'

interface AppState {
  user: User | null
  authenticated: boolean
  meetings: Meeting[]
  loading: boolean
  error: string | null
  presenceByUserId: Record<string, User['status']>
  requestLoginCode: (phone: string) => Promise<void>
  verifyLoginCode: (phone: string, code: string) => Promise<void>
  logout: () => Promise<void>
  reloadMeetings: () => Promise<void>
  inviteToCall: (targetUserId: string, meeting: Meeting, callContext: DirectCallContext) => void
  startDirectCall: (contact: User) => Promise<void>
}

interface IncomingCall {
  meeting: Meeting
  caller: User
  callContext?: DirectCallContext
}

interface MessageNotice {
  conversationId: string
  senderName: string
  body: string
}

const AppContext = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const navigate = useNavigate()
  const [user, setUser] = useState<User | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, User['status']>>({})
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [messageNotice, setMessageNotice] = useState<MessageNotice | null>(null)
  const callSocketRef = useRef<Socket | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reloadMeetings = useCallback(async () => {
    const result = await api.meetings()
    setMeetings(result.meetings)
  }, [])

  const loadSession = useCallback(async (): Promise<void> => {
    const [session, meetingResult] = await Promise.all([api.session(), api.meetings()])
    setUser(session.user)
    setMeetings(meetingResult.meetings)
    setError(null)
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const stored = await loadAuthTokens()
        if (!stored) return
        await loadSession()
      } catch (reason) {
        await clearAuthTokens()
        if (active) {
          setUser(null)
          setMeetings([])
          setError(reason instanceof Error ? reason.message : 'Не удалось восстановить сессию.')
        }
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [loadSession])

  const requestLoginCode = useCallback(async (phone: string): Promise<void> => {
    setError(null)
    await api.requestSms(phone)
  }, [])

  const verifyLoginCode = useCallback(async (phone: string, code: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.verifySms(phone, code)
      await saveAuthTokens(result.tokens)
      await loadSession()
    } catch (reason) {
      await clearAuthTokens()
      throw reason
    } finally {
      setLoading(false)
    }
  }, [loadSession])

  const logout = useCallback(async (): Promise<void> => {
    try {
      if (getAccessToken()) await api.logout()
    } finally {
      await clearAuthTokens()
      setUser(null)
      setMeetings([])
      setIncomingCall(null)
      setMessageNotice(null)
      setPresenceByUserId({})
      setError(null)
      navigate('/chat')
    }
  }, [navigate])

  const inviteToCall = useCallback((targetUserId: string, meeting: Meeting, callContext: DirectCallContext) => {
    callSocketRef.current?.emit('call:invite', { targetUserId, meeting, callContext })
  }, [])

  const startDirectCall = useCallback(async (contact: User): Promise<void> => {
    if (!user) throw new Error('Профиль пользователя не загружен.')
    const start = new Date()
    const conversation = await api.createConversation([contact.id])
    const created = await api.createMeeting({
      title: `Звонок: ${user.displayName} — ${contact.displayName}`,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
      timezone: user.timezone,
      attendees: contact.email ? [contact.email] : [],
      attendeeUserIds: [contact.id],
      waitingRoom: false,
      muteOnEntry: false,
      allowJoinBeforeHost: true,
    })
    const activated = await api.updateMeetingStatus(created.meeting.id, 'live')
    const callLog = await api.startCallLog(conversation.conversation.id, activated.meeting.id)
    const callContext: DirectCallContext = {
      conversationId: conversation.conversation.id,
      messageId: callLog.message.id,
      startedAt: start.toISOString(),
    }
    inviteToCall(contact.id, activated.meeting, callContext)
    await reloadMeetings()
    navigate(`/meeting/${activated.meeting.id}`, { state: { callContext } })
  }, [inviteToCall, navigate, reloadMeetings, user])

  useEffect(() => {
    if (!user || !getAccessToken()) return
    const socket = io(API_URL, {
      transports: ['websocket'],
      auth: (callback) => callback({ token: getAccessToken() }),
    })
    callSocketRef.current = socket
    const heartbeat = setInterval(() => socket.emit('presence:heartbeat'), 30_000)
    socket.on('connect', () => {
      socket.emit('presence:heartbeat')
      setPresenceByUserId((current) => ({ ...current, [user.id]: 'online' }))
    })
    socket.on('presence:changed', (presence: { userId: string; status: User['status'] }) => {
      setPresenceByUserId((current) => ({ ...current, [presence.userId]: presence.status }))
    })
    socket.on('calendar:synced', () => void reloadMeetings())
    socket.on('call:incoming', (call: IncomingCall) => setIncomingCall(call))
    socket.on('message:new', (message: Message) => {
      if (message.senderId === user.id) return
      const body = message.kind === 'audio'
        ? 'Голосовое сообщение'
        : message.kind === 'file'
          ? 'Вложение'
          : message.body || 'Новое сообщение'
      setMessageNotice({
        conversationId: message.conversationId,
        senderName: message.senderName || 'Новое сообщение',
        body,
      })
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = setTimeout(() => setMessageNotice(null), 6000)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const notification = new Notification(message.senderName || 'AlephMeets', { body })
        notification.onclick = () => navigate('/chat', { state: { conversationId: message.conversationId } })
      }
    })
    return () => {
      clearInterval(heartbeat)
      socket.disconnect()
      callSocketRef.current = null
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [navigate, reloadMeetings, user])

  useEffect(() => {
    if (!incomingCall) return
    const audioContext = new AudioContext()
    let active = true
    let interval: ReturnType<typeof setInterval> | undefined
    const ring = (): void => {
      if (!active || audioContext.state === 'closed') return
      const now = audioContext.currentTime
      const gain = audioContext.createGain()
      gain.connect(audioContext.destination)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.055, now + 0.03)
      gain.gain.setValueAtTime(0.055, now + 1.05)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.18)
      for (const frequency of [440, 480]) {
        const oscillator = audioContext.createOscillator()
        oscillator.frequency.setValueAtTime(frequency, now)
        oscillator.connect(gain)
        oscillator.start(now)
        oscillator.stop(now + 1.2)
      }
    }
    void audioContext.resume().then(() => {
      if (!active) return
      ring()
      interval = setInterval(ring, 2800)
    })
    return () => {
      active = false
      if (interval) clearInterval(interval)
      void audioContext.close()
    }
  }, [incomingCall])

  const declineIncomingCall = useCallback((): void => {
    if (!incomingCall) return
    if (incomingCall.callContext) {
      void api.finishCallLog(
        incomingCall.callContext.conversationId,
        incomingCall.callContext.messageId,
        'declined',
        Date.now() - new Date(incomingCall.callContext.startedAt).getTime(),
      )
    }
    setIncomingCall(null)
  }, [incomingCall])

  const value = useMemo(() => ({
    user,
    authenticated: Boolean(user),
    meetings,
    loading,
    error,
    presenceByUserId,
    requestLoginCode,
    verifyLoginCode,
    logout,
    reloadMeetings,
    inviteToCall,
    startDirectCall,
  }), [
    user,
    meetings,
    loading,
    error,
    presenceByUserId,
    requestLoginCode,
    verifyLoginCode,
    logout,
    reloadMeetings,
    inviteToCall,
    startDirectCall,
  ])

  return (
    <AppContext.Provider value={value}>
      {children}
      <Modal open={Boolean(incomingCall)} onClose={declineIncomingCall} title="Входящий вызов" width={380}>
        {incomingCall && <div className="incoming-call">
          <Avatar name={incomingCall.caller.displayName} src={incomingCall.caller.avatarUrl} size="large" />
          <strong>{incomingCall.caller.displayName}</strong>
          <span>приглашает вас в аудио- и видеозвонок</span>
          <div>
            <button className="button secondary" onClick={declineIncomingCall}>Отклонить</button>
            <button className="button primary" onClick={() => {
              const call = incomingCall
              setIncomingCall(null)
              navigate(`/meeting/${call.meeting.id}`, {
                state: { meeting: call.meeting, callContext: call.callContext },
              })
            }}>Принять</button>
          </div>
        </div>}
      </Modal>
      {messageNotice && <button className="message-notification" onClick={() => {
        const notice = messageNotice
        setMessageNotice(null)
        navigate('/chat', { state: { conversationId: notice.conversationId } })
      }}>
        <strong>{messageNotice.senderName}</strong>
        <span>{messageNotice.body}</span>
      </button>}
    </AppContext.Provider>
  )
}

export function useApp(): AppState {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside AppProvider')
  return value
}
