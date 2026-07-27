import { io, type Socket } from 'socket.io-client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Avatar, Modal } from '../components/ui'
import {
  clearAuthTokens,
  getAccessToken,
  loadAuthTokens,
  saveAuthTokens,
} from '../lib/auth'
import { API_URL, api } from '../lib/api'
import { openMeetingWindow } from '../lib/meeting-window'
import { startRingtone, storedRingtone, type RingtoneMode } from '../lib/ringtone'
import type { Conversation, DirectCallContext, Meeting, Message, User } from '../types'

export type ThemeMode = 'light' | 'dark'

interface AppState {
  user: User | null
  authenticated: boolean
  meetings: Meeting[]
  lastCalendarSyncedAt: string | null
  loading: boolean
  error: string | null
  theme: ThemeMode
  ringtone: RingtoneMode
  presenceByUserId: Record<string, User['status']>
  setTheme: (theme: ThemeMode) => void
  setRingtone: (ringtone: RingtoneMode) => void
  requestLoginCode: (phone: string) => Promise<void>
  verifyLoginCode: (phone: string, code: string) => Promise<void>
  logout: () => Promise<void>
  reloadMeetings: () => Promise<void>
  inviteToCall: (targetUserId: string, meeting: Meeting, callContext: DirectCallContext) => void
  startDirectCall: (contact: User) => Promise<void>
  startConversationCall: (conversation: Conversation) => Promise<void>
}

interface IncomingCall {
  meeting: Meeting
  caller: User
  callContext?: DirectCallContext
  invitation?: boolean
}

interface MessageNotice {
  conversationId: string
  senderName: string
  body: string
}

const AppContext = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const [user, setUser] = useState<User | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [lastCalendarSyncedAt, setLastCalendarSyncedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [theme, setThemeState] = useState<ThemeMode>(() => localStorage.getItem('aleph-theme') === 'dark' ? 'dark' : 'light')
  const [ringtone, setRingtoneState] = useState<RingtoneMode>(storedRingtone)
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, User['status']>>({})
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [incomingCallError, setIncomingCallError] = useState<string | null>(null)
  const [messageNotice, setMessageNotice] = useState<MessageNotice | null>(null)
  const callSocketRef = useRef<Socket | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reloadMeetings = useCallback(async () => {
    const result = await api.meetings()
    setMeetings(result.meetings)
  }, [])

  const setTheme = useCallback((nextTheme: ThemeMode): void => {
    setThemeState(nextTheme)
  }, [])

  const setRingtone = useCallback((nextRingtone: RingtoneMode): void => {
    setRingtoneState(nextRingtone)
    localStorage.setItem('aleph-ringtone', nextRingtone)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('aleph-theme', theme)
  }, [theme])

  useEffect(() => {
    const syncRingtone = (event: StorageEvent): void => {
      if (event.key === 'aleph-ringtone') setRingtoneState(storedRingtone())
    }
    window.addEventListener('storage', syncRingtone)
    return () => window.removeEventListener('storage', syncRingtone)
  }, [])

  const loadSession = useCallback(async (): Promise<void> => {
    const [session, meetingResult, exchange] = await Promise.all([
      api.session(),
      api.meetings(),
      api.exchangeSettings().catch(() => null),
    ])
    setUser(session.user)
    setMeetings(meetingResult.meetings)
    setLastCalendarSyncedAt(exchange?.settings?.lastSyncedAt ?? null)
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
      setLastCalendarSyncedAt(null)
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
    if (!await openMeetingWindow(activated.meeting.id, { meeting: activated.meeting, callContext })) {
      navigate(`/meeting/${activated.meeting.id}`, { state: { callContext } })
    }
  }, [inviteToCall, navigate, reloadMeetings, user])

  const startConversationCall = useCallback(async (conversation: Conversation): Promise<void> => {
    if (!user) throw new Error('Профиль пользователя не загружен.')
    const recipients = conversation.members.filter((member) => member.id !== user.id)
    if (!recipients.length) throw new Error('В беседе нет участников для вызова.')
    const start = new Date()
    const created = await api.createMeeting({
      title: `Звонок: ${conversation.title || 'Групповой чат'}`,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
      timezone: user.timezone,
      attendees: recipients.map((member) => member.email).filter((email): email is string => Boolean(email)),
      attendeeUserIds: recipients.map((member) => member.id),
      waitingRoom: false,
      muteOnEntry: false,
      allowJoinBeforeHost: true,
    })
    const activated = await api.updateMeetingStatus(created.meeting.id, 'live')
    const callLog = await api.startCallLog(conversation.id, activated.meeting.id)
    const callContext: DirectCallContext = {
      conversationId: conversation.id,
      messageId: callLog.message.id,
      startedAt: start.toISOString(),
      groupCall: true,
    }
    for (const recipient of recipients) inviteToCall(recipient.id, activated.meeting, callContext)
    await reloadMeetings()
    if (!await openMeetingWindow(activated.meeting.id, { meeting: activated.meeting, callContext })) {
      navigate(`/meeting/${activated.meeting.id}`, { state: { callContext } })
    }
  }, [inviteToCall, navigate, reloadMeetings, user])

  const navigateFromSystem = useCallback((route: string): void => {
    const target = new URL(route, 'https://alephmeets.local')
    if (target.pathname === '/chat' && target.searchParams.has('conversationId')) {
      navigate('/chat', { state: { conversationId: target.searchParams.get('conversationId') ?? undefined } })
      return
    }
    navigate(`${target.pathname}${target.search}${target.hash}`)
  }, [navigate])

  const showSystemNotification = useCallback((notification: {
    id: string
    title: string
    body: string
    route?: string
  }): void => {
    if (window.alephDesktop?.showNotification) {
      window.alephDesktop.showNotification(notification)
      return
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const webNotification = new Notification(notification.title, { body: notification.body })
    if (notification.route) {
      webNotification.onclick = () => navigateFromSystem(notification.route as string)
    }
  }, [navigateFromSystem])

  useEffect(() => window.alephDesktop?.onNavigate(navigateFromSystem), [navigateFromSystem])

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
    socket.on('calendar:synced', (result: { syncedAt: string }) => {
      setLastCalendarSyncedAt(result.syncedAt)
      void reloadMeetings()
    })
    socket.on('meeting:updated', (update: { meetingId: string; status?: Meeting['status'] }) => {
      void reloadMeetings()
      if (update.status === 'ended' || update.status === 'cancelled') {
        setIncomingCall((current) => current?.meeting.id === update.meetingId ? null : current)
      }
    })
    socket.on('conversation:updated', (update: { conversationId: string }) => {
      window.dispatchEvent(new CustomEvent('aleph:conversations-updated', { detail: update }))
    })
    socket.on('call:incoming', (call: IncomingCall) => {
      if (call.callContext?.conversationId) {
        window.dispatchEvent(new CustomEvent('aleph:conversations-updated', {
          detail: { conversationId: call.callContext.conversationId },
        }))
      }
      setIncomingCallError(null)
      setIncomingCall(call)
      showSystemNotification({
        id: `incoming-call:${call.meeting.id}`,
        title: 'Входящий вызов',
        body: `${call.caller.displayName} приглашает вас в звонок`,
      })
    })
    socket.on('call:cancelled', ({ meetingId, reason }: { meetingId: string; reason?: string }) => {
      setIncomingCall((current) => {
        if (current?.meeting.id !== meetingId) return current
        if (reason === 'missed' && !current.callContext) {
          showSystemNotification({
            id: `missed-call:${meetingId}`,
            title: 'Пропущенный вызов',
            body: `Вы не ответили на вызов от ${current.caller.displayName}`,
          })
        }
        return null
      })
    })
    socket.on('call:redirected', ({ meeting: redirectedMeeting }: { meeting: Meeting }) => {
      setIncomingCall(null)
      void openMeetingWindow(redirectedMeeting.id, {
        meeting: redirectedMeeting,
        autoJoin: true,
      }).then((opened) => {
        window.dispatchEvent(new CustomEvent('aleph:leave-current-call'))
        if (!opened) navigate(`/meeting/${redirectedMeeting.id}`, {
          state: { meeting: redirectedMeeting, autoJoin: true },
        })
      })
    })
    socket.on('message:new', (message: Message) => {
      window.dispatchEvent(new CustomEvent('aleph:conversations-updated', {
        detail: { conversationId: message.conversationId },
      }))
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
      const missedCall = message.kind === 'system'
        && message.metadata?.type === 'call'
        && message.metadata.status === 'missed'
      showSystemNotification({
        id: `message:${message.id}`,
        title: missedCall ? 'Пропущенный вызов' : message.senderName || 'AlephMeets',
        body: missedCall
          ? `Вызов от ${message.senderName || 'пользователя'} остался без ответа`
          : body,
        route: `/chat?conversationId=${encodeURIComponent(message.conversationId)}`,
      })
    })
    return () => {
      clearInterval(heartbeat)
      socket.disconnect()
      callSocketRef.current = null
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [navigate, reloadMeetings, showSystemNotification, user])

  useEffect(() => {
    if (!incomingCall) return
    let active = true
    let stop = (): void => undefined
    void (window.alephDesktop?.claimRingtone?.() ?? Promise.resolve(true)).then((claimed) => {
      if (!active || !claimed) return
      stop = startRingtone(ringtone)
    })
    return () => {
      active = false
      stop()
    }
  }, [incomingCall, ringtone])

  const declineIncomingCall = useCallback((): void => {
    if (!incomingCall) return
    void api.declineMeetingInvitation(incomingCall.meeting.id).catch(() => undefined)
    if (incomingCall.callContext && !incomingCall.callContext.groupCall) {
      void api.finishCallLog(
        incomingCall.callContext.conversationId,
        incomingCall.callContext.messageId,
        'declined',
        Date.now() - new Date(incomingCall.callContext.startedAt).getTime(),
      )
    }
    setIncomingCallError(null)
    setIncomingCall(null)
  }, [incomingCall])

  const currentMeetingId = useMemo(() => {
    const match = location.pathname.match(/^\/meeting\/([^/]+)/)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  }, [location.pathname])
  const currentMeeting = currentMeetingId
    ? meetings.find((meeting) => meeting.id === currentMeetingId)
    : undefined
  const hasParallelIncomingCall = Boolean(
    incomingCall && currentMeetingId && currentMeetingId !== incomingCall.meeting.id,
  )
  const canMergeParallelCall = Boolean(
    hasParallelIncomingCall
    && currentMeeting
    && (incomingCall?.meeting.attendees?.length ?? 0) <= 1,
  )

  const openIncomingCall = useCallback(async (
    call: IncomingCall,
    leaveCurrentMeeting: boolean,
  ): Promise<void> => {
    setIncomingCall(null)
    setIncomingCallError(null)
    const opened = await openMeetingWindow(call.meeting.id, {
      meeting: call.meeting,
      callContext: call.callContext,
      autoJoin: true,
    })
    if (leaveCurrentMeeting && currentMeetingId) {
      if (currentMeeting?.hostId === user?.id) {
        void api.endMeetingForEveryone(currentMeetingId).catch(() => undefined)
      }
      window.dispatchEvent(new CustomEvent('aleph:leave-current-call'))
    }
    if (!opened) {
      navigate(`/meeting/${call.meeting.id}`, {
        state: { meeting: call.meeting, callContext: call.callContext, autoJoin: true },
      })
    }
  }, [currentMeeting?.hostId, currentMeetingId, navigate, user?.id])

  const mergeParallelCall = useCallback(async (): Promise<void> => {
    if (!incomingCall || !currentMeetingId) return
    setIncomingCallError(null)
    try {
      await api.mergeIncomingCall(currentMeetingId, incomingCall.meeting.id, incomingCall.caller.id)
      setIncomingCall(null)
      await reloadMeetings()
    } catch (reason) {
      setIncomingCallError(reason instanceof Error ? reason.message : 'Не удалось пригласить звонящего в текущую встречу.')
    }
  }, [currentMeetingId, incomingCall, reloadMeetings])

  const value = useMemo(() => ({
    user,
    authenticated: Boolean(user),
    meetings,
    lastCalendarSyncedAt,
    loading,
    error,
    theme,
    ringtone,
    presenceByUserId,
    setTheme,
    setRingtone,
    requestLoginCode,
    verifyLoginCode,
    logout,
    reloadMeetings,
    inviteToCall,
    startDirectCall,
    startConversationCall,
  }), [
    user,
    meetings,
    lastCalendarSyncedAt,
    loading,
    error,
    theme,
    ringtone,
    presenceByUserId,
    setTheme,
    setRingtone,
    requestLoginCode,
    verifyLoginCode,
    logout,
    reloadMeetings,
    inviteToCall,
    startDirectCall,
    startConversationCall,
  ])

  return (
    <AppContext.Provider value={value}>
      {children}
      <Modal
        open={Boolean(incomingCall)}
        onClose={declineIncomingCall}
        title={hasParallelIncomingCall ? 'Еще один входящий вызов' : 'Входящий вызов'}
        width={hasParallelIncomingCall ? 460 : 380}
      >
        {incomingCall && <div className="incoming-call">
          <Avatar
            name={incomingCall.caller.displayName}
            src={incomingCall.caller.avatarUrl}
            status={presenceByUserId[incomingCall.caller.id] ?? incomingCall.caller.status}
            size="large"
          />
          <strong>{incomingCall.caller.displayName}</strong>
          <span>
            {hasParallelIncomingCall
              ? 'Вы уже участвуете во встрече. Выберите, как обработать новый вызов.'
              : 'приглашает вас в аудио- и видеозвонок'}
          </span>
          {incomingCallError && <p className="form-error">{incomingCallError}</p>}
          <div className={hasParallelIncomingCall ? 'incoming-call-actions-stacked' : ''}>
            <button className="button secondary" onClick={declineIncomingCall}>Отклонить</button>
            {canMergeParallelCall && (
              <button className="button secondary" onClick={() => void mergeParallelCall()}>
                Пригласить в текущий звонок
              </button>
            )}
            <button className="button primary" onClick={() => void openIncomingCall(incomingCall, hasParallelIncomingCall)}>
              {hasParallelIncomingCall ? 'Завершить текущий и принять' : 'Принять'}
            </button>
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
