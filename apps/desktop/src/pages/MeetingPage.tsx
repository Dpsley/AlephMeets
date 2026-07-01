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
import { RoomEvent, Track, type LocalTrackPublication, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client'
import {
  ArrowLeft,
  Camera,
  CameraOff,
  FileText,
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
import { plainTextFromRichText } from '../lib/format'
import { getMeetingWindowContext } from '../lib/meeting-window'
import { ensureDesktopMediaAccess, isRetryableMediaError, mediaErrorMessage, type MediaKind } from '../lib/media'
import { useApp } from '../state/AppContext'
import { BrandMark } from '../components/BrandMark'
import { Avatar, Modal } from '../components/ui'
import { WindowControls } from '../components/WindowControls'

type DeviceState = 'checking' | 'available' | 'unavailable'
type TranscriptionStatus = 'idle' | 'connecting' | 'listening' | 'error'

type TranscriptEntry = {
  id: string
  text: string
  receivedAt: number
  segmentId?: number
}

type TranscriptionStats = {
  audioLevel: number
  framesSent: number
  responsesReceived: number
  tracks: number
  sampleRate: number
}

const TRANSCRIBE_WS_URL = import.meta.env.VITE_TRANSCRIBE_WS_URL || 'wss://api.alephtrade.com/agent01/audio_transcribe_ws'
const TRANSCRIBE_SAMPLE_RATE = 16_000
const EMPTY_TRANSCRIPTION_STATS: TranscriptionStats = {
  audioLevel: 0,
  framesSent: 0,
  responsesReceived: 0,
  tracks: 0,
  sampleRate: TRANSCRIBE_SAMPLE_RATE,
}

function transcribeWebSocketUrl(sampleRate: number): string {
  const url = new URL(TRANSCRIBE_WS_URL)
  url.searchParams.set('sample_rate', String(sampleRate))
  return url.toString()
}

function transcriptTime(value: number): string {
  return new Date(value).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

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

function readTranscribeMessage(data: string): {
  type?: string
  text?: string
  message?: string
  error?: string
  segment_id?: number
} | null {
  try {
    const parsed = JSON.parse(data) as unknown
    return parsed && typeof parsed === 'object' ? parsed as ReturnType<typeof readTranscribeMessage> : null
  } catch {
    return data === 'ready' ? { type: 'ready' } : null
  }
}

function MeetingTranscriptPanel({
  entries,
  status,
  error,
  stats,
  onClose,
  onClear,
  onRetry,
}: {
  entries: TranscriptEntry[]
  status: TranscriptionStatus
  error: string | null
  stats: TranscriptionStats
  onClose: () => void
  onClear: () => void
  onRetry: () => void
}): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries])

  const statusText = status === 'connecting'
    ? 'Подключение к расшифровке...'
    : status === 'listening'
      ? 'Идет расшифровка звонка'
      : status === 'error'
        ? 'Расшифровка остановлена'
        : 'Расшифровка выключена'

  return (
    <aside className="meeting-transcript-panel">
      <header>
        <strong>Дешифровка звонка</strong>
        <button onClick={onClose} title="Закрыть дешифровку"><X /></button>
      </header>
      <div className={`meeting-transcript-status ${status}`}>
        <span />
        <p>{statusText}</p>
      </div>
      <div className="meeting-transcript-debug">
        <div>
          <small>Уровень аудио</small>
          <strong>{Math.round(stats.audioLevel * 100)}%</strong>
        </div>
        <div>
          <small>Треки</small>
          <strong>{stats.tracks}</strong>
        </div>
        <div>
          <small>Отправлено</small>
          <strong>{stats.framesSent}</strong>
        </div>
        <div>
          <small>Ответы ASR</small>
          <strong>{stats.responsesReceived}</strong>
        </div>
      </div>
      {error && (
        <div className="meeting-transcript-error">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>Повторить</button>
        </div>
      )}
      <div className="meeting-transcript-messages">
        {entries.map((entry) => (
          <article key={entry.id}>
            <time>{transcriptTime(entry.receivedAt)}</time>
            <p>{entry.text}</p>
          </article>
        ))}
        {!entries.length && <p className="meeting-transcript-empty">Текст появится здесь, когда участники начнут говорить.</p>}
        <div ref={bottomRef} />
      </div>
      <footer>
        <button type="button" onClick={onClear} disabled={!entries.length}>Очистить</button>
      </footer>
    </aside>
  )
}

function CallTranscriber({
  active,
  restartKey,
  localAudioTrack,
  onTranscript,
  onStatusChange,
  onStatsChange,
  onError,
}: {
  active: boolean
  restartKey: number
  localAudioTrack?: MediaStreamTrack
  onTranscript: (entry: TranscriptEntry) => void
  onStatusChange: (status: TranscriptionStatus) => void
  onStatsChange: (stats: TranscriptionStats) => void
  onError: (message: string) => void
}): null {
  const room = useRoomContext()

  useEffect(() => {
    if (!active) {
      onStatusChange('idle')
      onStatsChange(EMPTY_TRANSCRIPTION_STATS)
      return
    }

    let alive = true
    let closedByCleanup = false
    let failed = false
    let audioContext: AudioContext
    try {
      audioContext = new AudioContext({ sampleRate: TRANSCRIBE_SAMPLE_RATE })
    } catch {
      audioContext = new AudioContext()
    }

    const endpoint = transcribeWebSocketUrl(audioContext.sampleRate)
    const socket = new WebSocket(endpoint)
    const mixer = audioContext.createGain()
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    const outputMute = audioContext.createGain()
    const sources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>()
    const trackCleanups: Array<() => void> = []
    const silence = audioContext.createOscillator()
    const silenceGain = audioContext.createGain()
    const stats: TranscriptionStats = {
      audioLevel: 0,
      framesSent: 0,
      responsesReceived: 0,
      tracks: 0,
      sampleRate: audioContext.sampleRate,
    }

    socket.binaryType = 'arraybuffer'
    outputMute.gain.value = 0
    silenceGain.gain.value = 0
    silence.connect(silenceGain).connect(mixer)
    silence.start()
    mixer.connect(processor)
    processor.connect(outputMute).connect(audioContext.destination)

    onStatusChange('connecting')
    onStatsChange(stats)
    void audioContext.resume().catch(() => undefined)

    const statsTimer = window.setInterval(() => {
      if (!alive) return
      onStatsChange({ ...stats, tracks: sources.size })
    }, 500)

    const fail = (message: string): void => {
      if (!alive) return
      failed = true
      onStatusChange('error')
      onError(message)
    }

    processor.onaudioprocess = (event): void => {
      if (!alive || socket.readyState !== WebSocket.OPEN) return
      const input = event.inputBuffer.getChannelData(0)
      const frame = new Float32Array(input.length)
      frame.set(input)
      let sum = 0
      for (let index = 0; index < input.length; index += 1) {
        const sample = input[index] ?? 0
        sum += sample * sample
      }
      stats.audioLevel = input.length > 0 ? Math.min(1, Math.sqrt(sum / input.length) * 8) : 0
      stats.framesSent += 1
      stats.tracks = sources.size
      socket.send(frame.buffer)
    }

    const removeMediaTrack = (track: MediaStreamTrack): void => {
      const source = sources.get(track)
      if (!source) return
      source.disconnect()
      sources.delete(track)
      stats.tracks = sources.size
    }

    const addMediaTrack = (track?: MediaStreamTrack): void => {
      if (!track || track.kind !== 'audio' || track.readyState !== 'live' || sources.has(track)) return
      const source = audioContext.createMediaStreamSource(new MediaStream([track]))
      source.connect(mixer)
      sources.set(track, source)
      stats.tracks = sources.size
      const handleEnded = (): void => removeMediaTrack(track)
      track.addEventListener('ended', handleEnded, { once: true })
      trackCleanups.push(() => track.removeEventListener('ended', handleEnded))
    }

    const addRemoteTrack = (track: RemoteTrack): void => {
      if (track.kind === Track.Kind.Audio) addMediaTrack(track.mediaStreamTrack)
    }

    const addRemotePublication = (publication: RemoteTrackPublication): void => {
      if (publication.isSubscribed && publication.track) addRemoteTrack(publication.track)
    }

    const addLocalPublication = (publication: LocalTrackPublication): void => {
      addMediaTrack(publication.track?.mediaStreamTrack)
    }

    const handleTrackSubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ): void => addRemoteTrack(track)

    const handleTrackUnsubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ): void => {
      if (track.kind === Track.Kind.Audio) removeMediaTrack(track.mediaStreamTrack)
    }

    const handleLocalTrackPublished = (publication: LocalTrackPublication): void => {
      addLocalPublication(publication)
    }

    const handleLocalTrackUnpublished = (publication: LocalTrackPublication): void => {
      const track = publication.track?.mediaStreamTrack
      if (track) removeMediaTrack(track)
    }

    socket.onopen = (): void => {
      if (alive) onStatusChange('connecting')
    }
    socket.onmessage = (event): void => {
      if (!alive || typeof event.data !== 'string') return
      const payload = readTranscribeMessage(event.data)
      if (!payload) return
      stats.responsesReceived += 1
      if (payload.type === 'ready') {
        onStatusChange('listening')
        return
      }
      if (payload.type === 'error' || payload.error) {
        fail(payload.message || payload.error || 'Сервис расшифровки вернул ошибку.')
        return
      }
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text) return
      onStatusChange('listening')
      onTranscript({
        id: `${payload.segment_id ?? Date.now()}-${crypto.randomUUID()}`,
        text,
        segmentId: payload.segment_id,
        receivedAt: Date.now(),
      })
    }
    socket.onerror = (): void => fail(`Не удалось подключиться к сервису расшифровки: ${endpoint}`)
    socket.onclose = (event): void => {
      if (alive && !closedByCleanup && !failed) {
        const details = event.code ? ` Код закрытия: ${event.code}${event.reason ? `, причина: ${event.reason}` : ''}.` : ''
        fail(`Соединение с сервисом расшифровки закрыто.${details}`)
      }
    }

    addMediaTrack(localAudioTrack)
    room.localParticipant.audioTrackPublications.forEach(addLocalPublication)
    room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach(addRemotePublication)
    })
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished)
    room.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished)

    return () => {
      alive = false
      closedByCleanup = true
      window.clearInterval(statsTimer)
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished)
      room.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished)
      trackCleanups.forEach((cleanup) => cleanup())
      processor.onaudioprocess = null
      sources.forEach((source) => source.disconnect())
      sources.clear()
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'finalize' }))
        socket.close()
      } catch {
        // WebSocket can already be closing during meeting shutdown.
      }
      try {
        silence.stop()
      } catch {
        // Oscillator may already be stopped if the audio graph was torn down by Chromium.
      }
      silence.disconnect()
      silenceGain.disconnect()
      mixer.disconnect()
      processor.disconnect()
      outputMute.disconnect()
      void audioContext.close().catch(() => undefined)
    }
  }, [active, localAudioTrack, onError, onStatsChange, onStatusChange, onTranscript, restartKey, room])

  return null
}

function CallRecorder({
  callContext,
  localAudioTrack,
  onStopperChange,
  onError,
}: {
  callContext: DirectCallContext
  localAudioTrack?: MediaStreamTrack
  onStopperChange: (stopper: (() => Promise<void>) | null) => void
  onError: (message: string) => void
}): null {
  const room = useRoomContext()

  useEffect(() => {
    if (typeof MediaRecorder === 'undefined') {
      onError('Запись звонка недоступна в текущей версии Chromium.')
      return
    }

    const audioContext = new AudioContext()
    const destination = audioContext.createMediaStreamDestination()
    const chunks: Blob[] = []
    const sources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>()
    let stopped = false
    let stopPromise: Promise<void> | null = null

    const silence = audioContext.createOscillator()
    const silenceGain = audioContext.createGain()
    silenceGain.gain.value = 0
    silence.connect(silenceGain).connect(destination)
    silence.start()

    const removeMediaTrack = (track: MediaStreamTrack): void => {
      const source = sources.get(track)
      if (!source) return
      source.disconnect()
      sources.delete(track)
    }

    const addMediaTrack = (track?: MediaStreamTrack): void => {
      if (!track || track.kind !== 'audio' || track.readyState !== 'live' || sources.has(track)) return
      const source = audioContext.createMediaStreamSource(new MediaStream([track]))
      source.connect(destination)
      sources.set(track, source)
      track.addEventListener('ended', () => removeMediaTrack(track), { once: true })
    }

    const addRemoteTrack = (track: RemoteTrack): void => {
      if (track.kind === Track.Kind.Audio) addMediaTrack(track.mediaStreamTrack)
    }

    const addRemotePublication = (publication: RemoteTrackPublication): void => {
      if (publication.isSubscribed && publication.track) addRemoteTrack(publication.track)
    }

    const handleTrackSubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ): void => addRemoteTrack(track)

    const handleTrackUnsubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ): void => {
      if (track.kind === Track.Kind.Audio) removeMediaTrack(track.mediaStreamTrack)
    }

    addMediaTrack(localAudioTrack)
    room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach(addRemotePublication)
    })
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(destination.stream, { mimeType })
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.start(1000)
    void audioContext.resume().catch(() => undefined)

    const cleanupAudioGraph = (): void => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
      sources.forEach((source) => source.disconnect())
      sources.clear()
      silence.stop()
      silence.disconnect()
      silenceGain.disconnect()
      void audioContext.close().catch(() => undefined)
    }

    const stopAndUpload = async (): Promise<void> => {
      if (stopPromise) return stopPromise
      stopPromise = new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          cleanupAudioGraph()
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
        }
        if (recorder.state === 'inactive') {
          cleanupAudioGraph()
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
          return
        }
        recorder.stop()
      }).then(async (blob) => {
        if (blob.size <= 0) return
        await api.uploadCallRecording(
          callContext.conversationId,
          callContext.messageId,
          blob,
          `call-${Date.now()}.webm`,
        )
      })
      return stopPromise
    }

    onStopperChange(async () => {
      if (stopped) return
      stopped = true
      await stopAndUpload()
    })

    return () => {
      onStopperChange(null)
      if (!stopped) {
        stopped = true
        void stopAndUpload().catch((reason) => {
          onError(reason instanceof Error ? reason.message : 'Не удалось сохранить запись звонка.')
        })
      }
    }
  }, [callContext.conversationId, callContext.messageId, localAudioTrack, onError, onStopperChange, room])

  return null
}

function MeetingConference({
  meeting,
  isOrganizer,
  localAudioTrack,
  onError,
  onReload,
  closeRequest,
}: {
  meeting: Meeting
  isOrganizer: boolean
  localAudioTrack?: MediaStreamTrack
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
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([])
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus>('idle')
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null)
  const [transcriptionRestart, setTranscriptionRestart] = useState(0)
  const [transcriptionStats, setTranscriptionStats] = useState<TranscriptionStats>(EMPTY_TRANSCRIPTION_STATS)
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

  const appendTranscript = useCallback((entry: TranscriptEntry): void => {
    setTranscriptionError(null)
    setTranscriptEntries((current) => [...current.slice(-199), entry])
  }, [])

  const toggleTranscript = (): void => {
    if (transcriptOpen) {
      setTranscriptOpen(false)
      return
    }
    setTranscriptionError(null)
    setChatOpen(false)
    setTranscriptOpen(true)
  }

  const retryTranscript = (): void => {
    setTranscriptionError(null)
    setTranscriptionStatus('connecting')
    setTranscriptOpen(true)
    setTranscriptionRestart((value) => value + 1)
  }

  const handleTranscriptionError = useCallback((message: string): void => {
    setTranscriptionError(message)
  }, [])

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
      <CallTranscriber
        active={transcriptOpen}
        restartKey={transcriptionRestart}
        localAudioTrack={localAudioTrack}
        onTranscript={appendTranscript}
        onStatusChange={setTranscriptionStatus}
        onStatsChange={setTranscriptionStats}
        onError={handleTranscriptionError}
      />
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
            <button
              onClick={() => {
                const nextOpen = !chatOpen
                setChatOpen(nextOpen)
                if (nextOpen) setTranscriptOpen(false)
              }}
              className={chatOpen ? 'active' : ''}
            >
              <MessageSquare /><span>Чат</span>
            </button>
            <button onClick={() => setInfoOpen(true)}><Info /><span>Информация</span></button>
            <button onClick={toggleTranscript} className={transcriptOpen ? 'active' : ''}>
              <FileText /><span>Дешифровка</span>
            </button>
            {isOrganizer && <button onClick={() => void openInvite()}><UserPlus /><span>Пригласить</span></button>}
            <button className="meeting-leave-control" onClick={() => isOrganizer ? setExitOpen(true) : void room.disconnect()}>
              <PhoneOff /><span>Завершить</span>
            </button>
          </div>
        </div>
        {chatOpen && <MeetingChat onClose={() => setChatOpen(false)} />}
        {transcriptOpen && (
          <MeetingTranscriptPanel
            entries={transcriptEntries}
            status={transcriptionStatus}
            error={transcriptionError}
            stats={transcriptionStats}
            onClose={() => setTranscriptOpen(false)}
            onClear={() => setTranscriptEntries([])}
            onRetry={retryTranscript}
          />
        )}
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
  const recordingStopRef = useRef<(() => Promise<void>) | null>(null)
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

  const setRecordingStopper = useCallback((stopper: (() => Promise<void>) | null): void => {
    recordingStopRef.current = stopper
  }, [])

  const finishDirectCall = useCallback(async (): Promise<void> => {
    if (!callContext || callFinishedRef.current) return
    callFinishedRef.current = true
    await api.finishCallLog(
      callContext.conversationId,
      callContext.messageId,
      'ended',
      Date.now() - new Date(callContext.startedAt).getTime(),
    )
  }, [callContext])

  const stopCallRecording = useCallback(async (): Promise<void> => {
    const stop = recordingStopRef.current
    if (!stop) return
    recordingStopRef.current = null
    await stop()
  }, [])

  const closeAfterDisconnect = useCallback(async (): Promise<void> => {
    let closeError: unknown
    try {
      await finishDirectCall()
    } catch (reason) {
      closeError = reason
    }
    try {
      await stopCallRecording()
    } catch (reason) {
      closeError ??= reason
    } finally {
      if (closeError) {
        setError(closeError instanceof Error ? closeError.message : 'Не удалось сохранить запись звонка.')
      }
      closeMeetingWindow(navigate)
    }
  }, [finishDirectCall, navigate, stopCallRecording])

  const leavePrejoin = useCallback(async (): Promise<void> => {
    if (!meeting || cancelling) return
    setCancelling(true)
    if (isOrganizer) {
      await api.endMeetingForEveryone(meeting.id).catch(() => undefined)
      await finishDirectCall()
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
            void closeAfterDisconnect()
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
          {callContext && isOrganizer && <CallRecorder
            callContext={callContext}
            localAudioTrack={connection.audioTrack}
            onStopperChange={setRecordingStopper}
            onError={setError}
          />}
          <MeetingConference
            meeting={meeting}
            isOrganizer={isOrganizer}
            localAudioTrack={connection.audioTrack}
            onError={setError}
            onReload={reloadMeetings}
            closeRequest={closeRequest}
          />
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
          <p>{plainTextFromRichText(meeting.description) || 'Встреча AlephMeets'}</p>
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
