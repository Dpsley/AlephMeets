import {
  LiveKitRoom,
  ConnectionQualityIndicator,
  ParticipantTile,
  RoomAudioRenderer,
  TrackToggle,
  TrackMutedIndicator,
  VideoTrack,
  useChat,
  useParticipants,
  useRoomContext,
  useTracks,
} from '@livekit/components-react'
import { Track } from 'livekit-client'
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Info,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  ShieldCheck,
  UserPlus,
  Video,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Contact, DirectCallContext, Meeting } from '../types'
import { api } from '../lib/api'
import { getMeetingWindowContext } from '../lib/meeting-window'
import { ensureDesktopMediaAccess, isRetryableMediaError, mediaErrorMessage, type MediaKind } from '../lib/media'
import { useApp } from '../state/AppContext'
import { BrandMark } from '../components/BrandMark'
import { Avatar, Modal } from '../components/ui'
import { WindowControls } from '../components/WindowControls'

type DeviceState = 'checking' | 'available' | 'unavailable'

function closeMeetingWindow(navigate: ReturnType<typeof useNavigate>): void {
  if (window.alephDesktop) window.alephDesktop.forceCloseMeeting()
  else navigate('/chat')
}

function InitialMediaPublisher({
  audioEnabled,
  videoEnabled,
  audioTrack,
  videoTrack,
  onDeviceError,
}: {
  audioEnabled: boolean
  videoEnabled: boolean
  audioTrack?: MediaStreamTrack
  videoTrack?: MediaStreamTrack
  onDeviceError: (kind: MediaKind, error: unknown) => void
}): null {
  const room = useRoomContext()

  useEffect(() => {
    let active = true
    const publish = async (): Promise<void> => {
      if (audioEnabled) {
        try {
          if (audioTrack?.readyState === 'live') {
            await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.Microphone })
          } else {
            await room.localParticipant.setMicrophoneEnabled(true)
          }
        } catch (error) {
          if (active) onDeviceError('audio', error)
        }
      }
      if (videoEnabled) {
        try {
          if (videoTrack?.readyState === 'live') {
            await room.localParticipant.publishTrack(videoTrack, { source: Track.Source.Camera })
          } else {
            await room.localParticipant.setCameraEnabled(true)
          }
        } catch (error) {
          if (active) onDeviceError('video', error)
        }
      }
    }
    void publish()
    return () => { active = false }
  }, [audioEnabled, audioTrack, onDeviceError, room, videoEnabled, videoTrack])

  return null
}

function MeetingChat({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { chatMessages, send, isSending } = useChat()
  const [draft, setDraft] = useState('')

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || isSending) return
    await send(message)
    setDraft('')
  }

  return (
    <aside className="meeting-chat-panel">
      <header><strong>Чат встречи</strong><button onClick={onClose} title="Закрыть чат"><X /></button></header>
      <div className="meeting-chat-messages">
        {chatMessages.map((message, index) => (
          <div className="meeting-chat-message" key={message.id ?? index}>
            <strong>{message.from?.name || 'Участник'}</strong>
            <span>{message.message}</span>
          </div>
        ))}
        {!chatMessages.length && <p>Сообщений пока нет.</p>}
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Сообщение" />
        <button disabled={!draft.trim() || isSending} title="Отправить"><Send /></button>
      </form>
    </aside>
  )
}

function MeetingConference({
  meeting,
  isOrganizer,
  onError,
  onReload,
  closeRequest,
}: {
  meeting: Meeting
  isOrganizer: boolean
  onError: (message: string) => void
  onReload: () => Promise<void>
  closeRequest: number
}): React.JSX.Element {
  const room = useRoomContext()
  const participants = useParticipants()
  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: true },
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ], { onlySubscribed: false })
  const displayTracks = participants.map((participant) => (
    tracks.find((track) => (
      track.participant.identity === participant.identity
      && track.source === Track.Source.ScreenShare
    )) ?? tracks.find((track) => (
      track.participant.identity === participant.identity
      && track.source === Track.Source.Camera
    ))
  )).filter((track): track is NonNullable<typeof track> => Boolean(track))
  const candidates = participants.filter(
    (participant) => participant.identity !== room.localParticipant.identity,
  )
  const connectedIds = new Set(participants.map((participant) => participant.identity))
  const pendingAttendees = meeting.attendees.filter(
    (attendee) => attendee.response === 'invited' && attendee.userId && !connectedIds.has(attendee.userId),
  )
  const [exitOpen, setExitOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [newHostId, setNewHostId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [screenShareRequest, setScreenShareRequest] = useState<{
    requestId: number
    sources: Array<{ id: string; name: string; thumbnail: string }>
  } | null>(null)

  useEffect(() => {
    if (!candidates.some((participant) => participant.identity === newHostId)) {
      setNewHostId(candidates[0]?.identity ?? '')
    }
  }, [candidates, newHostId])

  useEffect(() => {
    if (!closeRequest) return
    if (isOrganizer) setExitOpen(true)
    else void room.disconnect()
  }, [closeRequest, isOrganizer, room])

  useEffect(() => {
    return window.alephDesktop?.onScreenShareSources(setScreenShareRequest)
  }, [])

  const chooseScreenShareSource = (sourceId?: string): void => {
    if (!screenShareRequest) return
    window.alephDesktop?.selectScreenShareSource(screenShareRequest.requestId, sourceId)
    setScreenShareRequest(null)
  }

  const openInvite = async (): Promise<void> => {
    setInviteOpen(true)
    setLoadingContacts(true)
    try {
      const result = await api.contacts()
      const unavailable = new Set([
        meeting.hostId,
        ...meeting.attendees
          .filter((attendee) => attendee.response === 'invited' || attendee.response === 'accepted')
          .map((attendee) => attendee.userId)
          .filter(Boolean) as string[],
      ])
      setContacts(result.contacts.filter((contact) => !unavailable.has(contact.id)))
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось загрузить контакты.')
      setInviteOpen(false)
    } finally {
      setLoadingContacts(false)
    }
  }

  const invite = async (): Promise<void> => {
    if (!selectedContactIds.length || submitting) return
    setSubmitting(true)
    try {
      await api.inviteMeetingContacts(meeting.id, selectedContactIds)
      await onReload()
      setSelectedContactIds([])
      setInviteOpen(false)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось пригласить участников.')
    } finally {
      setSubmitting(false)
    }
  }

  const transferAndLeave = async (): Promise<void> => {
    if (!newHostId || submitting) return
    setSubmitting(true)
    try {
      await api.transferMeetingHost(meeting.id, newHostId)
      await room.disconnect()
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось передать роль организатора.')
      setSubmitting(false)
    }
  }

  const endForEveryone = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await api.endMeetingForEveryone(meeting.id)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось завершить встречу.')
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className={`aleph-conference ${chatOpen ? 'with-chat' : ''}`}>
        <div className="meeting-stage">
          <div className="meeting-participant-grid">
            {displayTracks.map((track) => {
              const attendee = meeting.attendees.find((item) => item.userId === track.participant.identity)
              const displayName = track.participant.name || attendee?.displayName || meeting.hostDisplayName || track.participant.identity
              const avatarUrl = track.participant.identity === meeting.hostId
                ? meeting.hostAvatarUrl
                : attendee?.avatarUrl
              return (
                <ParticipantTile key={`${track.participant.identity}-${track.source}`} trackRef={track}>
                  <div className="meeting-participant-avatar"><Avatar name={displayName} src={avatarUrl} size="large" /></div>
                  {'publication' in track && track.publication && <VideoTrack trackRef={track} />}
                  <div className="lk-participant-metadata">
                    <div className="lk-participant-metadata-item">
                      <TrackMutedIndicator
                        trackRef={{ participant: track.participant, source: Track.Source.Microphone }}
                        show="muted"
                      />
                      <span>{displayName}</span>
                    </div>
                    <ConnectionQualityIndicator />
                  </div>
                </ParticipantTile>
              )
            })}
            {pendingAttendees.map((attendee) => (
              <div className="meeting-pending-participant" key={attendee.userId}>
                <div className="meeting-pending-pulse">
                  <Avatar name={attendee.displayName || attendee.email || 'Участник'} src={attendee.avatarUrl} size="large" />
                </div>
                <strong>{attendee.displayName || attendee.email || 'Участник'}</strong>
                <span>Вызов...</span>
              </div>
            ))}
          </div>
          <div className="meeting-control-bar">
            <TrackToggle source={Track.Source.Microphone} onDeviceError={(reason) => onError(mediaErrorMessage('audio', reason))}>
              <span>Микрофон</span>
            </TrackToggle>
            <TrackToggle source={Track.Source.Camera} onDeviceError={() => undefined}>
              <span>Камера</span>
            </TrackToggle>
            <TrackToggle source={Track.Source.ScreenShare}>
              <span>Демонстрация</span>
            </TrackToggle>
            <button onClick={() => setChatOpen((value) => !value)} className={chatOpen ? 'active' : ''}>
              <MessageSquare /><span>Чат</span>
            </button>
            <button onClick={() => setInfoOpen(true)}><Info /><span>Информация</span></button>
            {isOrganizer && <button onClick={() => void openInvite()}><UserPlus /><span>Пригласить</span></button>}
            <button className="meeting-leave-control" onClick={() => isOrganizer ? setExitOpen(true) : void room.disconnect()}>
              <PhoneOff /><span>Завершить</span>
            </button>
          </div>
        </div>
        {chatOpen && <MeetingChat onClose={() => setChatOpen(false)} />}
      </div>

      <Modal open={infoOpen} onClose={() => setInfoOpen(false)} title="Информация о встрече" width={460}>
        <dl className="meeting-info-list">
          <div><dt>Название</dt><dd>{meeting.title}</dd></div>
          <div><dt>Идентификатор</dt><dd>{meeting.roomName}</dd></div>
          <div><dt>Организатор</dt><dd>{meeting.hostDisplayName || meeting.hostId}</dd></div>
        </dl>
      </Modal>

      <Modal
        open={Boolean(screenShareRequest)}
        onClose={() => chooseScreenShareSource()}
        title="Выберите экран или окно"
        width={760}
      >
        <div className="screen-share-picker">
          {screenShareRequest?.sources.map((source) => (
            <button key={source.id} onClick={() => chooseScreenShareSource(source.id)}>
              <img src={source.thumbnail} alt="" />
              <span>{source.name}</span>
            </button>
          ))}
          {!screenShareRequest?.sources.length && <p>Нет доступных экранов или окон.</p>}
        </div>
      </Modal>

      <Modal open={inviteOpen} onClose={() => { if (!submitting) setInviteOpen(false) }} title="Пригласить во встречу" width={480}>
        <div className="meeting-invite-list">
          {loadingContacts && <div className="center-loader"><span className="spinner" /></div>}
          {!loadingContacts && contacts.map((contact) => (
            <label key={contact.id}>
              <input
                type="checkbox"
                checked={selectedContactIds.includes(contact.id)}
                onChange={(event) => setSelectedContactIds((current) => event.target.checked
                  ? [...current, contact.id]
                  : current.filter((id) => id !== contact.id))}
              />
              <Avatar name={contact.displayName} src={contact.avatarUrl} />
              <span><strong>{contact.displayName}</strong>{(contact.email || contact.phone) && <small>{contact.email || contact.phone}</small>}</span>
            </label>
          ))}
          {!loadingContacts && !contacts.length && <p className="soft-empty">Нет доступных контактов для приглашения.</p>}
          <footer className="modal-actions">
            <button className="button secondary" onClick={() => setInviteOpen(false)} disabled={submitting}>Отмена</button>
            <button className="button primary" onClick={() => void invite()} disabled={!selectedContactIds.length || submitting}>Пригласить</button>
          </footer>
        </div>
      </Modal>

      <Modal open={exitOpen} onClose={() => { if (!submitting) setExitOpen(false) }} title="Завершение встречи" width={480}>
        <div className="form-stack meeting-exit-form">
          <p>Перед выходом передайте роль организатора другому участнику или завершите встречу для всех.</p>
          <label>
            <span>Новый организатор</span>
            <select value={newHostId} onChange={(event) => setNewHostId(event.target.value)}>
              {candidates.map((participant) => (
                <option value={participant.identity} key={participant.identity}>
                  {participant.name || participant.identity}
                </option>
              ))}
            </select>
          </label>
          {!candidates.length && <p className="form-error">В конференции пока нет другого подключённого участника.</p>}
          <footer className="meeting-exit-actions">
            <button className="button secondary" onClick={() => setExitOpen(false)} disabled={submitting}>Остаться</button>
            <button className="button secondary" onClick={() => void transferAndLeave()} disabled={!newHostId || submitting}>Передать и выйти</button>
            <button className="button meeting-end-button" onClick={() => void endForEveryone()} disabled={submitting}>Завершить для всех</button>
          </footer>
        </div>
      </Modal>
    </>
  )
}

export function MeetingPage(): React.JSX.Element {
  const { meetingId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { meetings, user, loading, reloadMeetings } = useApp()
  const navigationState = location.state as { meeting?: Meeting; callContext?: DirectCallContext } | null
  const [windowContext, setWindowContext] = useState<{ meeting?: Meeting; callContext?: DirectCallContext } | null>(null)
  const meetingFromNavigation = navigationState?.meeting ?? windowContext?.meeting
  const callContext = navigationState?.callContext ?? windowContext?.callContext
  const meeting = meetings.find((item) => item.id === meetingId) ?? meetingFromNavigation
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const autoJoinStartedRef = useRef(false)
  const callFinishedRef = useRef(false)
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)
  const [audioState, setAudioState] = useState<DeviceState>('checking')
  const [videoState, setVideoState] = useState<DeviceState>('checking')
  const [mediaReady, setMediaReady] = useState(false)
  const [deviceNotices, setDeviceNotices] = useState<string[]>([])
  const [joined, setJoined] = useState(false)
  const [connection, setConnection] = useState<{
    token: string
    serverUrl: string
    isHost: boolean
    audioTrack?: MediaStreamTrack
    videoTrack?: MediaStreamTrack
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [closeRequest, setCloseRequest] = useState(0)

  useEffect(() => { void getMeetingWindowContext().then(setWindowContext) }, [])

  const addDeviceNotice = useCallback((message: string): void => {
    setDeviceNotices((current) => current.includes(message) ? current : [...current, message])
  }, [])

  const handleDeviceError = useCallback((kind: MediaKind, reason: unknown): void => {
    if (kind === 'audio') {
      addDeviceNotice(mediaErrorMessage(kind, reason))
      setAudioState('unavailable')
      setAudioEnabled(false)
    } else {
      setVideoState('unavailable')
      setVideoEnabled(false)
    }
  }, [addDeviceNotice])

  useEffect(() => {
    if (joined) return
    let active = true
    const acquiredStreams: MediaStream[] = []

    const acquire = async (kind: MediaKind): Promise<MediaStreamTrack | null> => {
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await ensureDesktopMediaAccess([kind === 'audio' ? 'microphone' : 'camera'])
          const stream = await navigator.mediaDevices.getUserMedia(
            kind === 'audio'
              ? { audio: { echoCancellation: true, noiseSuppression: true }, video: false }
              : { audio: false, video: true },
          )
          acquiredStreams.push(stream)
          if (!active) {
            stream.getTracks().forEach((track) => track.stop())
            return null
          }
          if (kind === 'audio') setAudioState('available')
          else setVideoState('available')
          return kind === 'audio' ? stream.getAudioTracks()[0] ?? null : stream.getVideoTracks()[0] ?? null
        } catch (reason) {
          lastError = reason
          if (attempt === 0 && isRetryableMediaError(reason)) {
            await new Promise((resolve) => setTimeout(resolve, 350))
            continue
          }
          break
        }
      }
      if (active) handleDeviceError(kind, lastError)
      return null
    }

    const prepareMedia = async (): Promise<void> => {
      const audioTrack = await acquire('audio')
      const videoTrack = await acquire('video')
      if (!active) return
      const preview = new MediaStream([audioTrack, videoTrack].filter(Boolean) as MediaStreamTrack[])
      streamRef.current = preview
      if (videoRef.current) videoRef.current.srcObject = preview
      setMediaReady(true)
    }
    void prepareMedia()

    return () => {
      active = false
      acquiredStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()))
      streamRef.current = null
    }
  }, [handleDeviceError, joined])

  useEffect(() => {
    streamRef.current?.getVideoTracks().forEach((track) => { track.enabled = videoEnabled })
  }, [videoEnabled])
  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = audioEnabled })
  }, [audioEnabled])

  const join = useCallback(async (): Promise<void> => {
    if (!meetingId || !mediaReady || joined) return
    setError(null)
    try {
      const token = await api.meetingToken(meetingId)
      const audioTrack = audioEnabled ? streamRef.current?.getAudioTracks()[0]?.clone() : undefined
      const videoTrack = videoEnabled ? streamRef.current?.getVideoTracks()[0]?.clone() : undefined
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (token.isHost) await api.updateMeetingStatus(meetingId, 'live')
      setConnection({ ...token, audioTrack, videoTrack })
      setJoined(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подключиться к встрече.')
      autoJoinStartedRef.current = false
    }
  }, [audioEnabled, joined, mediaReady, meetingId, videoEnabled])

  const isOrganizer = Boolean(meeting && user && meeting.hostId === user.id)
  useEffect(() => {
    if (!isOrganizer || !mediaReady || joined || autoJoinStartedRef.current) return
    autoJoinStartedRef.current = true
    void join()
  }, [isOrganizer, join, joined, mediaReady])

  const finishDirectCall = useCallback((): void => {
    if (!callContext || callFinishedRef.current) return
    callFinishedRef.current = true
    void api.finishCallLog(
      callContext.conversationId,
      callContext.messageId,
      'ended',
      Date.now() - new Date(callContext.startedAt).getTime(),
    )
  }, [callContext])

  const leavePrejoin = useCallback(async (): Promise<void> => {
    if (!meeting || cancelling) return
    setCancelling(true)
    if (isOrganizer) {
      await api.endMeetingForEveryone(meeting.id).catch(() => undefined)
      finishDirectCall()
    } else {
      await api.declineMeetingInvitation(meeting.id).catch(() => undefined)
    }
    closeMeetingWindow(navigate)
  }, [cancelling, finishDirectCall, isOrganizer, meeting, navigate])

  useEffect(() => {
    if (!window.alephDesktop) return
    return window.alephDesktop.onMeetingCloseRequested(() => {
      if (joined) setCloseRequest((value) => value + 1)
      else void leavePrejoin()
    })
  }, [joined, leavePrejoin])

  if (loading || !meeting || (isOrganizer && !joined)) {
    return <div className="meeting-loading-screen"><WindowControls /><div className="meeting-loading"><span className="spinner" />{error || 'Подключение к встрече...'}</div></div>
  }

  if (joined && connection) {
    return (
      <div className="meeting-room" data-lk-theme="default">
        <div className="meeting-topbar">
          <div><BrandMark small /><strong>{meeting.title}</strong></div>
          <div><ShieldCheck size={15} />Защищённое соединение</div>
          <WindowControls theme="dark" />
        </div>
        <LiveKitRoom
          token={connection.token}
          serverUrl={connection.serverUrl}
          connect
          audio={false}
          video={false}
          onDisconnected={() => {
            finishDirectCall()
            closeMeetingWindow(navigate)
          }}
          onError={(reason) => {
            if (!/requested device not found/i.test(reason.message)) setError(reason.message)
          }}
        >
          <InitialMediaPublisher
            audioEnabled={audioEnabled && audioState === 'available'}
            videoEnabled={videoEnabled && videoState === 'available'}
            audioTrack={connection.audioTrack}
            videoTrack={connection.videoTrack}
            onDeviceError={handleDeviceError}
          />
          <MeetingConference meeting={meeting} isOrganizer={isOrganizer} onError={setError} onReload={reloadMeetings} closeRequest={closeRequest} />
          <RoomAudioRenderer />
        </LiveKitRoom>
        {deviceNotices.length > 0 && <div className="meeting-notice">{deviceNotices.join(' ')}</div>}
        {error && <div className="meeting-error">{error}</div>}
      </div>
    )
  }

  return (
    <div className="prejoin-page">
      <header>
        <button className="icon-button" onClick={() => void leavePrejoin()} disabled={cancelling}><ArrowLeft /></button>
        <div className="brand"><BrandMark /><strong>AlephMeets</strong></div>
        <WindowControls />
      </header>
      <main className="prejoin-content">
        <section className="preview-card">
          <div className={`camera-preview ${!videoEnabled || videoState !== 'available' ? 'disabled' : ''}`}>
            <video ref={videoRef} autoPlay muted playsInline />
            {(!videoEnabled || videoState !== 'available') && <div>
              <span>{user?.displayName?.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>
              <p>{videoState === 'checking' ? 'Проверка камеры...' : 'Камера выключена'}</p>
            </div>}
            <span className="preview-name">{user?.displayName} (Вы)</span>
          </div>
          <div className="preview-controls">
            <button className={!audioEnabled ? 'off' : ''} disabled={audioState !== 'available'} onClick={() => setAudioEnabled((value) => !value)}>
              {audioEnabled && audioState === 'available' ? <Mic /> : <MicOff />}
              <span>{audioState === 'checking' ? 'Проверка...' : audioEnabled ? 'Микрофон' : 'Без звука'}</span>
            </button>
            <button className={!videoEnabled ? 'off' : ''} disabled={videoState !== 'available'} onClick={() => setVideoEnabled((value) => !value)}>
              {videoEnabled && videoState === 'available' ? <Camera /> : <CameraOff />}
              <span>{videoState === 'checking' ? 'Проверка...' : videoEnabled ? 'Камера' : 'Без видео'}</span>
            </button>
          </div>
        </section>
        <aside className="join-card">
          <span className="meeting-badge"><Video size={17} />Видеовстреча</span>
          <h1>{meeting.title}</h1>
          <p>{meeting.description || 'Встреча AlephMeets'}</p>
          <div className="join-details">
            <span>Организатор</span><strong>{meeting.hostDisplayName || meeting.hostId}</strong>
            <span>Идентификатор</span><strong>{meeting.roomName}</strong>
          </div>
          {deviceNotices.map((notice) => <p className="device-notice" key={notice}>{notice}</p>)}
          {error && <p className="form-error">{error}</p>}
          <button className="button primary join-button" onClick={() => void join()} disabled={!mediaReady}>
            {mediaReady ? 'Войти во встречу' : 'Проверка устройств...'}
          </button>
          <small className="privacy-note"><ShieldCheck size={14} />Подключаясь, вы соглашаетесь с правилами встречи</small>
        </aside>
      </main>
    </div>
  )
}
