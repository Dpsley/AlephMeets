import {
  LiveKitRoom,
  ConnectionQualityIndicator,
  ParticipantTile,
  RoomAudioRenderer,
  TrackToggle,
  TrackMutedIndicator,
  VideoTrack,
  useParticipants,
  useRoomContext,
  useTracks,
} from '@livekit/components-react'
import { ConnectionState, RoomEvent, Track, RemoteTrackPublication, type LocalTrackPublication, type RemoteParticipant, type RemoteTrack } from 'livekit-client'
import {
  ArrowLeft,
  Bot,
  Camera,
  CameraOff,
  Download,
  FileText,
  Info,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  PencilRuler,
  PhoneOff,
  Send,
  ShieldCheck,
  UserPlus,
  Video,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Attachment, Contact, DirectCallContext, Meeting } from '../types'
import { api } from '../lib/api'
import { plainTextFromRichText } from '../lib/format'
import { getMeetingWindowContext } from '../lib/meeting-window'
import { ensureDesktopMediaAccess, isRetryableMediaError, mediaErrorMessage, type MediaKind } from '../lib/media'
import { useApp } from '../state/AppContext'
import { BrandMark } from '../components/BrandMark'
import { Avatar, Modal } from '../components/ui'
import { WindowControls } from '../components/WindowControls'
import {
  MeetingWhiteboard,
  WHITEBOARD_TOPIC,
  applyWhiteboardMessage,
  readWhiteboardMessage,
  whiteboardItemsToPngBlob,
  type WhiteboardItem,
} from '../components/MeetingWhiteboard'
import {
  ParticipantPicker,
  participantUserIds,
  type ParticipantSelection,
} from '../components/ParticipantPicker'

type DeviceState = 'checking' | 'available' | 'unavailable'
type TranscriptionStatus = 'idle' | 'connecting' | 'listening' | 'error'

type TranscriptEntry = {
  id: string
  speakerId: string
  speakerName: string
  text: string
  receivedAt: number
  segmentId?: number
}

type MeetingChatAttachment = Pick<Attachment, 'originalName' | 'mimeType' | 'url'> & {
  byteSize: number
}

type MeetingChatAttachmentPayload = {
  type: 'attachment'
  attachment: MeetingChatAttachment
}

type MeetingChatMessage = {
  id: string
  message: string
  senderId: string
  senderName: string
  sentAt: number
}

type MeetingRealtimeMessage =
  | { type: 'chat'; chat: MeetingChatMessage }
  | { type: 'transcript:active'; active: boolean }
  | { type: 'transcript:entry'; entry: TranscriptEntry }

type TranscriptionStats = {
  audioLevel: number
  framesSent: number
  responsesReceived: number
  tracks: number
  sampleRate: number
  speakers: string[]
}

const TRANSCRIBE_WS_URL = import.meta.env.VITE_TRANSCRIBE_WS_URL || 'wss://api.alephtrade.com/agent01/audio_transcribe_ws'
const TRANSCRIBE_SAMPLE_RATE = 16_000
const MEETING_REALTIME_TOPIC = 'aleph:meeting-realtime'
const meetingRealtimeEncoder = new TextEncoder()
const meetingRealtimeDecoder = new TextDecoder()
const EMPTY_TRANSCRIPTION_STATS: TranscriptionStats = {
  audioLevel: 0,
  framesSent: 0,
  responsesReceived: 0,
  tracks: 0,
  sampleRate: TRANSCRIBE_SAMPLE_RATE,
  speakers: [],
}

function readMeetingRealtimeMessage(payload: Uint8Array): MeetingRealtimeMessage | null {
  try {
    const parsed = JSON.parse(meetingRealtimeDecoder.decode(payload)) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    if (
      parsed.type === 'chat'
      && parsed.chat
      && typeof parsed.chat === 'object'
      && typeof (parsed.chat as Record<string, unknown>).message === 'string'
    ) {
      return parsed as unknown as MeetingRealtimeMessage
    }
    if (parsed.type === 'transcript:active' && typeof parsed.active === 'boolean') {
      return parsed as unknown as MeetingRealtimeMessage
    }
    if (
      parsed.type === 'transcript:entry'
      && parsed.entry
      && typeof parsed.entry === 'object'
      && typeof (parsed.entry as Record<string, unknown>).text === 'string'
    ) {
      return parsed as unknown as MeetingRealtimeMessage
    }
    return null
  } catch {
    return null
  }
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

function transcriptFilename(meeting: Meeting): string {
  const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace(/Z$/, '')
  const safeTitle = meeting.title
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `transcript-${safeTitle || meeting.id}-${stamp}.txt`
}

function analysisFilename(meeting: Meeting): string {
  const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace(/Z$/, '')
  const safeTitle = meeting.title
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `analysis-${safeTitle || meeting.id}-${stamp}.txt`
}

function buildTranscriptText(meeting: Meeting, entries: TranscriptEntry[]): string {
  const lines = [
    'AlephMeets - расшифровка звонка',
    `Встреча: ${meeting.title}`,
    `Идентификатор: ${meeting.roomName}`,
    `Начало: ${new Date(meeting.startsAt).toLocaleString('ru-RU')}`,
    '',
    'Расшифровка:',
    '',
  ]
  for (const entry of entries) {
    lines.push(`[${transcriptTime(entry.receivedAt)}] ${entry.speakerName}`)
    lines.push(entry.text)
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

function isScreenShareCancelError(reason: unknown): boolean {
  const message = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason)
  return /abort|cancel|notallowed|denied|video was requested|no video stream/i.test(message)
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
    let publishing = false
    const publish = async (): Promise<void> => {
      if (room.state !== ConnectionState.Connected || publishing) return
      publishing = true
      try {
        if (audioEnabled && !room.localParticipant.getTrackPublication(Track.Source.Microphone)) {
          try {
            if (audioTrack?.readyState === 'live') {
              audioTrack.enabled = true
              await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.Microphone })
            } else {
              await room.localParticipant.setMicrophoneEnabled(true)
            }
          } catch (error) {
            if (active) onDeviceError('audio', error)
          }
        }
        if (videoEnabled && !room.localParticipant.getTrackPublication(Track.Source.Camera)) {
          try {
            if (videoTrack?.readyState === 'live') {
              videoTrack.enabled = true
              videoTrack.contentHint = 'motion'
              await room.localParticipant.publishTrack(videoTrack, { source: Track.Source.Camera })
            } else {
              await room.localParticipant.setCameraEnabled(true)
            }
          } catch (error) {
            if (active) onDeviceError('video', error)
          }
        }
      } finally {
        publishing = false
      }
    }
    room.on(RoomEvent.Connected, publish)
    room.on(RoomEvent.Reconnected, publish)
    void publish()
    return () => {
      active = false
      room.off(RoomEvent.Connected, publish)
      room.off(RoomEvent.Reconnected, publish)
    }
  }, [audioEnabled, audioTrack, onDeviceError, room, videoEnabled, videoTrack])

  return null
}

function meetingChatAttachmentPayload(value: string): MeetingChatAttachmentPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<MeetingChatAttachmentPayload>
    const byteSize = Number(parsed.attachment?.byteSize)
    if (
      parsed.type === 'attachment'
      && parsed.attachment
      && typeof parsed.attachment.originalName === 'string'
      && typeof parsed.attachment.mimeType === 'string'
      && Number.isFinite(byteSize)
      && typeof parsed.attachment.url === 'string'
    ) {
      return {
        type: 'attachment',
        attachment: {
          originalName: parsed.attachment.originalName,
          mimeType: parsed.attachment.mimeType || 'application/octet-stream',
          byteSize,
          url: parsed.attachment.url,
        },
      }
    }
  } catch {
    return null
  }
  return null
}

function meetingChatAttachmentSize(bytes: number | string): string {
  const normalized = Number(bytes)
  const size = Number.isFinite(normalized) ? normalized : 0
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} МБ`
  return `${Math.max(1, Math.round(size / 1024))} КБ`
}

function renderMeetingChatAttachmentPreview(attachment: MeetingChatAttachment): React.JSX.Element {
  if (!attachment.url) {
    return (
      <div className="attachment-preview-empty">
        <FileText size={34} />
        <strong>{attachment.originalName}</strong>
        <small>Файл еще не готов к просмотру.</small>
      </div>
    )
  }
  if (attachment.mimeType.startsWith('image/')) {
    return <img className="attachment-preview-image" src={attachment.url} alt={attachment.originalName} />
  }
  if (attachment.mimeType.startsWith('audio/')) {
    return <audio className="attachment-preview-media" controls src={attachment.url} />
  }
  if (attachment.mimeType.startsWith('video/')) {
    return <video className="attachment-preview-video" controls src={attachment.url} />
  }
  if (attachment.mimeType === 'application/pdf' || attachment.mimeType.startsWith('text/')) {
    return <iframe className="attachment-preview-frame" title={attachment.originalName} src={attachment.url} />
  }
  return (
    <div className="attachment-preview-empty">
      <FileText size={34} />
      <strong>{attachment.originalName}</strong>
      <small>Для этого типа файла доступно только скачивание.</small>
    </div>
  )
}

function renderMeetingChatAttachmentInline(
  attachment: MeetingChatAttachment,
  onPreview: () => void,
  onOpenExternal: () => void,
): React.JSX.Element {
  if (attachment.mimeType.startsWith('image/') && attachment.url) {
    return (
      <button type="button" className="meeting-chat-attachment meeting-chat-attachment-image" onClick={onPreview}>
        <img className="meeting-chat-inline-image" src={attachment.url} alt={attachment.originalName} loading="lazy" />
        <div className="meeting-chat-attachment-caption">
          <b>{attachment.originalName}</b>
          <small>{meetingChatAttachmentSize(attachment.byteSize)}</small>
        </div>
      </button>
    )
  }
  if (attachment.mimeType.startsWith('audio/') && attachment.url) {
    return (
      <div className="meeting-chat-attachment meeting-chat-attachment-media">
        <audio controls preload="metadata" src={attachment.url} />
        <div className="meeting-chat-attachment-caption">
          <b>{attachment.originalName}</b>
          <small>{meetingChatAttachmentSize(attachment.byteSize)}</small>
        </div>
      </div>
    )
  }
  if (attachment.mimeType.startsWith('video/') && attachment.url) {
    return (
      <div className="meeting-chat-attachment meeting-chat-attachment-media">
        <video controls preload="metadata" src={attachment.url} />
        <div className="meeting-chat-attachment-caption">
          <b>{attachment.originalName}</b>
          <small>{meetingChatAttachmentSize(attachment.byteSize)}</small>
        </div>
      </div>
    )
  }
  return (
    <button type="button" className="meeting-chat-attachment" onClick={onOpenExternal}>
      <span><FileText size={18} /></span>
      <div>
        <b>{attachment.originalName}</b>
        <small>{meetingChatAttachmentSize(attachment.byteSize)}</small>
      </div>
    </button>
  )
}

function MeetingChat({
  callContext,
  messages,
  sendMessage,
  isSending,
  onClose,
  onError,
}: {
  callContext?: DirectCallContext
  messages: MeetingChatMessage[]
  sendMessage: (message: string) => Promise<void>
  isSending: boolean
  onClose: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [uploading, setUploading] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<MeetingChatAttachment | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || isSending) return
    await sendMessage(message)
    setDraft('')
  }

  const uploadAttachment = async (file: File): Promise<void> => {
    if (!callContext || uploading) return
    setUploading(true)
    try {
      const result = await api.uploadCallMaterial(callContext.conversationId, callContext.messageId, file, file.name, 'meeting-chat')
      const attachment = result.message.attachments.at(-1)
      await sendMessage(JSON.stringify({
        type: 'attachment',
        attachment: attachment
          ? {
              originalName: attachment.originalName,
              mimeType: attachment.mimeType,
              byteSize: Number(attachment.byteSize),
              url: attachment.url,
            }
          : {
              originalName: file.name,
              mimeType: file.type || 'application/octet-stream',
              byteSize: file.size,
              url: '',
            },
      } satisfies MeetingChatAttachmentPayload))
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось отправить вложение встречи.')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const downloadAttachment = async (attachment: MeetingChatAttachment): Promise<void> => {
    if (!attachment.url) return
    try {
      if (window.alephDesktop?.downloadFile) {
        await window.alephDesktop.downloadFile(attachment.url, attachment.originalName)
      } else {
        window.open(attachment.url, '_blank', 'noopener')
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Не удалось скачать вложение.')
    }
  }

  const openAttachmentExternal = (attachment: MeetingChatAttachment): void => {
    if (attachment.url) window.open(attachment.url, '_blank', 'noopener')
  }

  return (
    <>
      <aside className="meeting-chat-panel">
        <header><strong>Чат встречи</strong><button onClick={onClose} title="Закрыть чат"><X /></button></header>
        <div className="meeting-chat-messages">
          {messages.map((message, index) => {
            const attachmentPayload = meetingChatAttachmentPayload(message.message)
            return (
              <div className="meeting-chat-message" key={message.id ?? index}>
                <strong>{message.senderName || 'Участник'}</strong>
                {attachmentPayload ? (
                  renderMeetingChatAttachmentInline(
                    attachmentPayload.attachment,
                    () => setPreviewAttachment(attachmentPayload.attachment),
                    () => openAttachmentExternal(attachmentPayload.attachment),
                  )
                ) : (
                  <span>{message.message}</span>
                )}
              </div>
            )
          })}
          {!messages.length && <p>Сообщений пока нет.</p>}
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <input
            ref={fileRef}
            hidden
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void uploadAttachment(file)
            }}
          />
          {callContext && (
            <button
              type="button"
              disabled={uploading}
              title={uploading ? 'Вложение отправляется' : 'Прикрепить файл'}
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip />
            </button>
          )}
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Сообщение" />
          <button disabled={!draft.trim() || isSending} title="Отправить"><Send /></button>
        </form>
      </aside>
      <Modal open={Boolean(previewAttachment)} onClose={() => setPreviewAttachment(null)} title={previewAttachment?.originalName ?? 'Вложение'} width={780}>
        {previewAttachment && (
          <div className="attachment-preview">
            {renderMeetingChatAttachmentPreview(previewAttachment)}
            <footer>
              <span>{previewAttachment.mimeType || 'application/octet-stream'} - {meetingChatAttachmentSize(previewAttachment.byteSize)}</span>
              <button className="button primary" type="button" disabled={!previewAttachment.url} onClick={() => void downloadAttachment(previewAttachment)}>
                <Download size={16} />Скачать
              </button>
            </footer>
          </div>
        )}
      </Modal>
    </>
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
        <div className="meeting-transcript-speakers">
          <small>В расшифровку уходят</small>
          <strong>{stats.speakers.length ? stats.speakers.join(', ') : 'Нет аудио'}</strong>
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
            <header>
              <strong>{entry.speakerName}</strong>
              <time>{transcriptTime(entry.receivedAt)}</time>
            </header>
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
    let audioContext: AudioContext
    try {
      audioContext = new AudioContext({ sampleRate: TRANSCRIBE_SAMPLE_RATE })
    } catch {
      audioContext = new AudioContext()
    }

    const endpoint = transcribeWebSocketUrl(audioContext.sampleRate)
    type TrackSession = {
      track: MediaStreamTrack
      speakerId: string
      speakerName: string
      source: MediaStreamAudioSourceNode
      processor: ScriptProcessorNode
      outputMute: GainNode
      socket: WebSocket
      closedByCleanup: boolean
      handleEnded: () => void
    }
    const sessions = new Map<MediaStreamTrack, TrackSession>()
    const stats: TranscriptionStats = {
      audioLevel: 0,
      framesSent: 0,
      responsesReceived: 0,
      tracks: 0,
      sampleRate: audioContext.sampleRate,
      speakers: [],
    }

    onStatusChange('connecting')
    onStatsChange(stats)
    void audioContext.resume().catch(() => undefined)

    const updateStats = (): void => {
      if (!alive) return
      const speakers = [...new Set([...sessions.values()].map((session) => session.speakerName))]
      stats.tracks = sessions.size
      stats.speakers = speakers
      onStatsChange({ ...stats, speakers })
    }

    const fail = (message: string): void => {
      if (!alive) return
      onStatusChange('error')
      onError(message)
    }

    const statsTimer = window.setInterval(() => {
      stats.audioLevel *= 0.82
      updateStats()
    }, 500)

    const cleanupSession = (session: TrackSession): void => {
      session.closedByCleanup = true
      session.track.removeEventListener('ended', session.handleEnded)
      session.processor.onaudioprocess = null
      session.source.disconnect()
      session.processor.disconnect()
      session.outputMute.disconnect()
      try {
        if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'finalize' }))
        session.socket.close()
      } catch {
        // The socket can already be closing when the audio track is unpublished.
      }
    }

    const removeMediaTrack = (track: MediaStreamTrack): void => {
      const session = sessions.get(track)
      if (!session) return
      sessions.delete(track)
      cleanupSession(session)
      updateStats()
    }

    const addMediaTrack = (track: MediaStreamTrack | undefined, speakerId: string, speakerName: string): void => {
      if (!track || track.kind !== 'audio' || track.readyState !== 'live' || sessions.has(track)) return
      const source = audioContext.createMediaStreamSource(new MediaStream([track]))
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      const outputMute = audioContext.createGain()
      const socket = new WebSocket(endpoint)
      const handleEnded = (): void => removeMediaTrack(track)
      const session: TrackSession = {
        track,
        speakerId,
        speakerName,
        source,
        processor,
        outputMute,
        socket,
        closedByCleanup: false,
        handleEnded,
      }

      socket.binaryType = 'arraybuffer'
      outputMute.gain.value = 0
      source.connect(processor)
      processor.connect(outputMute).connect(audioContext.destination)
      sessions.set(track, session)
      track.addEventListener('ended', handleEnded, { once: true })
      updateStats()

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
        const level = input.length > 0 ? Math.min(1, Math.sqrt(sum / input.length) * 8) : 0
        stats.audioLevel = Math.max(stats.audioLevel, level)
        stats.framesSent += 1
        socket.send(frame.buffer)
      }

      socket.onopen = (): void => {
        if (alive) onStatusChange('listening')
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
          fail(payload.message || payload.error || `Сервис расшифровки вернул ошибку для ${speakerName}.`)
          return
        }
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) return
        onStatusChange('listening')
        onTranscript({
          id: `${speakerId}-${payload.segment_id ?? Date.now()}-${crypto.randomUUID()}`,
          speakerId,
          speakerName,
          text,
          segmentId: payload.segment_id,
          receivedAt: Date.now(),
        })
      }
      socket.onerror = (): void => fail(`Не удалось подключить ${speakerName} к сервису расшифровки: ${endpoint}`)
      socket.onclose = (event): void => {
        if (alive && !session.closedByCleanup) {
          const details = event.code ? ` Код закрытия: ${event.code}${event.reason ? `, причина: ${event.reason}` : ''}.` : ''
          fail(`Соединение с сервисом расшифровки для ${speakerName} закрыто.${details}`)
        }
      }
    }

    const localSpeakerId = room.localParticipant.identity
    const localSpeakerName = room.localParticipant.name || 'Вы'

    const addRemoteTrack = (track: RemoteTrack, participant: RemoteParticipant): void => {
      if (track.kind === Track.Kind.Audio) {
        addMediaTrack(track.mediaStreamTrack, participant.identity, participant.name || participant.identity)
      }
    }

    const addRemotePublication = (publication: RemoteTrackPublication, participant: RemoteParticipant): void => {
      if (publication.isSubscribed && publication.track) addRemoteTrack(publication.track, participant)
    }

    const addLocalPublication = (publication: LocalTrackPublication): void => {
      addMediaTrack(publication.track?.mediaStreamTrack, localSpeakerId, localSpeakerName)
    }

    const handleTrackSubscribed = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void => addRemoteTrack(track, participant)

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

    addMediaTrack(localAudioTrack, localSpeakerId, localSpeakerName)
    room.localParticipant.audioTrackPublications.forEach(addLocalPublication)
    room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((publication) => addRemotePublication(publication, participant))
    })
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished)
    room.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished)

    return () => {
      alive = false
      window.clearInterval(statsTimer)
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed)
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished)
      room.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished)
      sessions.forEach(cleanupSession)
      sessions.clear()
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
  callContext,
  localAudioTrack,
  onError,
  onReload,
  closeRequest,
  onTranscriptStopperChange,
  aiAssistantActive,
  onAiAssistantActiveChange,
  whiteboardItems,
  onWhiteboardItemsChange,
}: {
  meeting: Meeting
  isOrganizer: boolean
  callContext?: DirectCallContext
  localAudioTrack?: MediaStreamTrack
  onError: (message: string) => void
  onReload: () => Promise<void>
  closeRequest: number
  onTranscriptStopperChange: (stopper: (() => Promise<void>) | null) => void
  aiAssistantActive: boolean
  onAiAssistantActiveChange: (active: boolean) => void
  whiteboardItems: WhiteboardItem[]
  onWhiteboardItemsChange: (items: WhiteboardItem[]) => void
}): React.JSX.Element {
  const room = useRoomContext()
  const participants = useParticipants()
  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: true },
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ], { onlySubscribed: true })
  const screenShareTracks = tracks.filter((track) => track.source === Track.Source.ScreenShare)
  const cameraTracks = participants.map((participant) => (
    tracks.find((track) => (
      track.participant.identity === participant.identity
      && track.source === Track.Source.Camera
    ))
  )).filter((track): track is NonNullable<typeof track> => Boolean(track))
  const displayTracks = screenShareTracks.length > 0 ? screenShareTracks : cameraTracks

  useEffect(() => {
    participants.forEach((participant) => {
      if (participant.identity === room.localParticipant.identity) return
      participant.videoTrackPublications.forEach((publication) => {
        if (!(publication instanceof RemoteTrackPublication)) return
        publication.setEnabled(true)
        if (!publication.isSubscribed) publication.setSubscribed(true)
      })
    })
  }, [participants, room])

  const candidates = participants.filter(
    (participant) => participant.identity !== room.localParticipant.identity,
  )
  const attendees = meeting.attendees ?? []
  const connectedIds = new Set(participants.map((participant) => participant.identity))
  const pendingAttendees = attendees.filter(
    (attendee) => attendee.response === 'invited' && attendee.userId && !connectedIds.has(attendee.userId),
  )
  const [exitOpen, setExitOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([])
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus>('idle')
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null)
  const [transcriptionRestart, setTranscriptionRestart] = useState(0)
  const [transcriptionStats, setTranscriptionStats] = useState<TranscriptionStats>(EMPTY_TRANSCRIPTION_STATS)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [inviteParticipants, setInviteParticipants] = useState<ParticipantSelection[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [newHostId, setNewHostId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [screenShareRequest, setScreenShareRequest] = useState<{
    requestId: number
    sources: Array<{ id: string; name: string; thumbnail: string }>
  } | null>(null)
  const [meetingChatMessages, setMeetingChatMessages] = useState<MeetingChatMessage[]>([])
  const [meetingChatSending, setMeetingChatSending] = useState(false)
  const [chatUnread, setChatUnread] = useState(false)
  const transcriptArchiveRef = useRef<TranscriptEntry[]>([])
  const transcriptUploadRef = useRef<Promise<void> | null>(null)
  const meetingChatMessagesRef = useRef<MeetingChatMessage[]>([])
  const chatOpenRef = useRef(false)
  const sharedWhiteboardItemsRef = useRef<WhiteboardItem[]>(whiteboardItems)

  useEffect(() => {
    meetingChatMessagesRef.current = meetingChatMessages
  }, [meetingChatMessages])

  const setMeetingChatOpen = useCallback((open: boolean): void => {
    chatOpenRef.current = open
    setChatOpen(open)
    if (open) setChatUnread(false)
  }, [])

  useEffect(() => {
    sharedWhiteboardItemsRef.current = whiteboardItems
  }, [whiteboardItems])

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

  const publishRealtime = useCallback(async (
    message: MeetingRealtimeMessage,
    destinationIdentities?: string[],
  ): Promise<void> => {
    await room.localParticipant.publishData(
      meetingRealtimeEncoder.encode(JSON.stringify(message)),
      {
        reliable: true,
        topic: MEETING_REALTIME_TOPIC,
        destinationIdentities,
      },
    )
  }, [room])

  const uploadTranscript = useCallback(async (): Promise<void> => {
    if (!callContext || !isOrganizer || transcriptUploadRef.current) {
      await transcriptUploadRef.current
      return
    }
    const entries = transcriptArchiveRef.current
    const text = buildTranscriptText(meeting, entries)
    const file = new Blob([text], { type: 'text/plain;charset=utf-8' })
    transcriptUploadRef.current = (async () => {
      await api.uploadCallTranscript(
        callContext.conversationId,
        callContext.messageId,
        file,
        transcriptFilename(meeting),
      )
      await api.createCallAnalysis(
        callContext.conversationId,
        callContext.messageId,
        text,
        analysisFilename(meeting),
      )
    })()
    await transcriptUploadRef.current
  }, [callContext, isOrganizer, meeting])

  useEffect(() => {
    if (!callContext || !isOrganizer || !aiAssistantActive) {
      onTranscriptStopperChange(null)
      return
    }
    onTranscriptStopperChange(uploadTranscript)
    return () => onTranscriptStopperChange(null)
  }, [aiAssistantActive, callContext, isOrganizer, onTranscriptStopperChange, uploadTranscript])

  const storeTranscriptEntry = useCallback((entry: TranscriptEntry): void => {
    setTranscriptionError(null)
    if (!transcriptArchiveRef.current.some((current) => current.id === entry.id)) {
      transcriptArchiveRef.current = [...transcriptArchiveRef.current, entry]
    }
    setTranscriptEntries((current) => (
      current.some((item) => item.id === entry.id) ? current : [...current.slice(-199), entry]
    ))
  }, [])

  const appendTranscript = useCallback((entry: TranscriptEntry): void => {
    storeTranscriptEntry(entry)
    void publishRealtime({ type: 'transcript:entry', entry }).catch((reason) => {
      setTranscriptionError(reason instanceof Error ? reason.message : 'Не удалось передать расшифровку участникам.')
    })
  }, [publishRealtime, storeTranscriptEntry])

  const appendMeetingChatMessage = useCallback((message: MeetingChatMessage): void => {
    setMeetingChatMessages((current) => (
      current.some((item) => item.id === message.id) ? current : [...current.slice(-199), message]
    ))
  }, [])

  const sendMeetingChatMessage = useCallback(async (message: string): Promise<void> => {
    if (meetingChatSending) return
    setMeetingChatSending(true)
    const chat: MeetingChatMessage = {
      id: crypto.randomUUID(),
      message,
      senderId: room.localParticipant.identity,
      senderName: room.localParticipant.name || room.localParticipant.identity,
      sentAt: Date.now(),
    }
    try {
      await publishRealtime({ type: 'chat', chat })
      appendMeetingChatMessage(chat)
    } finally {
      setMeetingChatSending(false)
    }
  }, [appendMeetingChatMessage, meetingChatSending, publishRealtime, room])

  const setLocalWhiteboardVisibility = useCallback((open: boolean): void => {
    setWhiteboardOpen(open)
    if (open) {
      setMeetingChatOpen(false)
      setTranscriptOpen(false)
    }
  }, [setMeetingChatOpen])

  useEffect(() => {
    const handleData = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ): void => {
      if (topic === WHITEBOARD_TOPIC) {
        const message = readWhiteboardMessage(payload)
        if (!message) return
        const nextItems = applyWhiteboardMessage(sharedWhiteboardItemsRef.current, message)
        sharedWhiteboardItemsRef.current = nextItems
        onWhiteboardItemsChange(nextItems)
        return
      }
      if (topic !== MEETING_REALTIME_TOPIC) return
      const message = readMeetingRealtimeMessage(payload)
      if (!message) return
      if (message.type === 'chat') {
        const chat = {
          ...message.chat,
          senderId: message.chat.senderId || participant?.identity || 'participant',
          senderName: message.chat.senderName || participant?.name || participant?.identity || 'Участник',
        }
        const isNew = !meetingChatMessagesRef.current.some((item) => item.id === chat.id)
        appendMeetingChatMessage(chat)
        if (isNew && chat.senderId !== room.localParticipant.identity && !chatOpenRef.current) {
          setChatUnread(true)
        }
        return
      }
      if (message.type === 'transcript:active') {
        onAiAssistantActiveChange(message.active)
        setTranscriptionStatus(message.active ? 'listening' : 'idle')
        if (message.active) {
          setTranscriptOpen(true)
          setMeetingChatOpen(false)
          setWhiteboardOpen(false)
        }
        return
      }
      if (message.type === 'transcript:entry') {
        storeTranscriptEntry(message.entry)
      }
    }

    const syncParticipant = (participant: RemoteParticipant): void => {
      if (!isOrganizer) return
      const destinations = [participant.identity]
      const messages: MeetingRealtimeMessage[] = [
        { type: 'transcript:active', active: aiAssistantActive },
        ...meetingChatMessagesRef.current.slice(-100).map((chat): MeetingRealtimeMessage => ({ type: 'chat', chat })),
        ...transcriptArchiveRef.current.slice(-100).map((entry): MeetingRealtimeMessage => ({ type: 'transcript:entry', entry })),
      ]
      void (async () => {
        for (const message of messages) await publishRealtime(message, destinations)
        for (const item of sharedWhiteboardItemsRef.current) {
          await room.localParticipant.publishData(
            meetingRealtimeEncoder.encode(JSON.stringify({ type: 'whiteboard:add', item })),
            { reliable: true, topic: WHITEBOARD_TOPIC, destinationIdentities: destinations },
          )
        }
      })().catch((reason) => {
        onError(reason instanceof Error ? reason.message : 'Не удалось синхронизировать состояние встречи.')
      })
    }

    room.on(RoomEvent.DataReceived, handleData)
    room.on(RoomEvent.ParticipantConnected, syncParticipant)
    room.remoteParticipants.forEach(syncParticipant)
    return () => {
      room.off(RoomEvent.DataReceived, handleData)
      room.off(RoomEvent.ParticipantConnected, syncParticipant)
    }
  }, [
    aiAssistantActive,
    appendMeetingChatMessage,
    isOrganizer,
    onAiAssistantActiveChange,
    onError,
    onWhiteboardItemsChange,
    publishRealtime,
    room,
    setMeetingChatOpen,
    storeTranscriptEntry,
  ])

  const clearTranscript = (): void => {
    transcriptArchiveRef.current = []
    setTranscriptEntries([])
  }

  const inviteAiAssistant = (): void => {
    if (aiAssistantActive) {
      setTranscriptOpen(true)
      return
    }
    clearTranscript()
    setTranscriptionError(null)
    setTranscriptionStatus('connecting')
    setMeetingChatOpen(false)
    setWhiteboardOpen(false)
    setTranscriptOpen(true)
    setTranscriptionRestart((value) => value + 1)
    onAiAssistantActiveChange(true)
    void publishRealtime({ type: 'transcript:active', active: true }).catch((reason) => {
      setTranscriptionError(reason instanceof Error ? reason.message : 'Не удалось включить расшифровку для участников.')
    })
  }

  const toggleTranscript = (): void => {
    if (transcriptOpen) {
      setTranscriptOpen(false)
      return
    }
    setTranscriptionError(null)
    setMeetingChatOpen(false)
    setWhiteboardOpen(false)
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
    setInviteParticipants([])
    setLoadingContacts(true)
    try {
      const result = await api.contacts()
      const unavailable = new Set([
        meeting.hostId,
        ...attendees
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
    const selectedContactIds = participantUserIds(inviteParticipants)
    if (!selectedContactIds.length || submitting) return
    setSubmitting(true)
    try {
      await api.inviteMeetingContacts(meeting.id, selectedContactIds)
      await onReload()
      setInviteParticipants([])
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
        active={aiAssistantActive && isOrganizer}
        restartKey={transcriptionRestart}
        localAudioTrack={localAudioTrack}
        onTranscript={appendTranscript}
        onStatusChange={setTranscriptionStatus}
        onStatsChange={setTranscriptionStats}
        onError={handleTranscriptionError}
      />
      <div className={`aleph-conference ${chatOpen ? 'with-chat' : ''}`}>
        <div className="meeting-stage">
          {whiteboardOpen ? (
            <MeetingWhiteboard
              initialItems={whiteboardItems}
              onClose={() => setLocalWhiteboardVisibility(false)}
              onError={onError}
              onItemsChange={onWhiteboardItemsChange}
            />
          ) : (
          <div className={`meeting-participant-grid ${screenShareTracks.length ? 'screen-share-active' : ''}`}>
            {displayTracks.map((track) => {
              const attendee = attendees.find((item) => item.userId === track.participant.identity)
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
            {aiAssistantActive && (
              <div className="meeting-pending-participant meeting-ai-assistant">
                <div className="meeting-pending-pulse">
                  <Avatar name="АИ" size="large" />
                </div>
                <strong>Алефа</strong>
                <span>Пишет и расшифровывает</span>
              </div>
            )}
          </div>
          )}
          <div className="meeting-control-bar">
            <TrackToggle source={Track.Source.Microphone} onDeviceError={(reason) => onError(mediaErrorMessage('audio', reason))}>
              <span>Микрофон</span>
            </TrackToggle>
            <TrackToggle source={Track.Source.Camera} onDeviceError={() => undefined}>
              <span>Камера</span>
            </TrackToggle>
            <TrackToggle
              source={Track.Source.ScreenShare}
              onDeviceError={(reason) => {
                if (!isScreenShareCancelError(reason)) onError(mediaErrorMessage('video', reason))
              }}
            >
              <span>Демонстрация</span>
            </TrackToggle>
            <button
              onClick={() => {
                const nextOpen = !chatOpen
                setMeetingChatOpen(nextOpen)
                if (nextOpen) {
                  setTranscriptOpen(false)
                  setWhiteboardOpen(false)
                }
              }}
              className={`meeting-chat-control ${chatOpen ? 'active' : ''}`}
            >
              <MessageSquare /><span>Чат</span>
              {chatUnread && !chatOpen ? <i className="meeting-chat-unread" aria-label="Новые сообщения" /> : null}
            </button>
            <button onClick={() => setInfoOpen(true)}><Info /><span>Информация</span></button>
            <button onClick={toggleTranscript} className={transcriptOpen ? 'active' : ''}>
              <FileText /><span>Дешифровка</span>
            </button>
            {isOrganizer && callContext && (
              <button onClick={inviteAiAssistant} className={aiAssistantActive ? 'active' : ''}>
                <Bot /><span>{aiAssistantActive ? 'Алефа пишет' : 'Позвать Алефу'}</span>
              </button>
            )}
            <button
              onClick={() => {
                const nextOpen = !whiteboardOpen
                setLocalWhiteboardVisibility(nextOpen)
              }}
              className={whiteboardOpen ? 'active' : ''}
            >
              <PencilRuler /><span>Доска</span>
            </button>
            {isOrganizer && <button onClick={() => void openInvite()}><UserPlus /><span>Пригласить</span></button>}
            <button className="meeting-leave-control" onClick={() => isOrganizer ? setExitOpen(true) : void room.disconnect()}>
              <PhoneOff /><span>Завершить</span>
            </button>
          </div>
        </div>
        {chatOpen && (
          <MeetingChat
            callContext={callContext}
            messages={meetingChatMessages}
            sendMessage={sendMeetingChatMessage}
            isSending={meetingChatSending}
            onClose={() => setMeetingChatOpen(false)}
            onError={onError}
          />
        )}
        {transcriptOpen && (
          <MeetingTranscriptPanel
            entries={transcriptEntries}
            status={transcriptionStatus}
            error={transcriptionError}
            stats={transcriptionStats}
            onClose={() => setTranscriptOpen(false)}
            onClear={clearTranscript}
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

      <Modal
        open={inviteOpen}
        onClose={() => { if (!submitting) setInviteOpen(false) }}
        title="Пригласить во встречу"
        width={460}
        className="participant-picker-modal meeting-invite-modal"
      >
        <div className="form-stack meeting-invite-list">
          <ParticipantPicker
            label="Участники"
            contacts={contacts}
            contactsLoading={loadingContacts}
            contactOnly
            placeholder="Начните вводить имя, телефон или email"
            value={inviteParticipants}
            onChange={setInviteParticipants}
          />
          {!loadingContacts && !contacts.length && (
            <p className="meeting-invite-empty">Нет доступных контактов для приглашения.</p>
          )}
          <footer className="modal-actions">
            <button className="button secondary" onClick={() => setInviteOpen(false)} disabled={submitting}>Отмена</button>
            <button className="button primary" onClick={() => void invite()} disabled={!participantUserIds(inviteParticipants).length || submitting}>Пригласить</button>
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
  const navigationState = location.state as { meeting?: Meeting; callContext?: DirectCallContext; autoJoin?: boolean } | null
  const [windowContext, setWindowContext] = useState<{ meeting?: Meeting; callContext?: DirectCallContext; autoJoin?: boolean } | null>(null)
  const meetingFromNavigation = navigationState?.meeting ?? windowContext?.meeting
  const callContext = navigationState?.callContext ?? windowContext?.callContext
  const autoJoin = navigationState?.autoJoin ?? windowContext?.autoJoin ?? false
  const meeting = meetings.find((item) => item.id === meetingId) ?? meetingFromNavigation
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const autoJoinStartedRef = useRef(false)
  const callFinishedRef = useRef(false)
  const recordingStopRef = useRef<(() => Promise<void>) | null>(null)
  const transcriptStopRef = useRef<(() => Promise<void>) | null>(null)
  const whiteboardUploadRef = useRef<Promise<void> | null>(null)
  const whiteboardItemsRef = useRef<WhiteboardItem[]>([])
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
  const [aiAssistantActive, setAiAssistantActive] = useState(false)
  const [whiteboardItems, setWhiteboardItems] = useState<WhiteboardItem[]>([])

  const updateWhiteboardItems = useCallback((items: WhiteboardItem[]): void => {
    whiteboardItemsRef.current = items
    setWhiteboardItems(items)
  }, [])

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
    if ((!isOrganizer && !autoJoin) || !mediaReady || joined || autoJoinStartedRef.current) return
    autoJoinStartedRef.current = true
    void join()
  }, [autoJoin, isOrganizer, join, joined, mediaReady])

  const setRecordingStopper = useCallback((stopper: (() => Promise<void>) | null): void => {
    recordingStopRef.current = stopper
  }, [])

  const setTranscriptStopper = useCallback((stopper: (() => Promise<void>) | null): void => {
    transcriptStopRef.current = stopper
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

  const stopCallTranscript = useCallback(async (): Promise<void> => {
    const stop = transcriptStopRef.current
    if (!stop) return
    transcriptStopRef.current = null
    await stop()
  }, [])

  const uploadWhiteboardSnapshot = useCallback(async (): Promise<void> => {
    if (!callContext || whiteboardUploadRef.current) {
      await whiteboardUploadRef.current
      return
    }
    const items = whiteboardItemsRef.current
    if (!items.length) return
    whiteboardUploadRef.current = (async () => {
      const blob = await whiteboardItemsToPngBlob(items)
      await api.uploadCallMaterial(
        callContext.conversationId,
        callContext.messageId,
        blob,
        `whiteboard-${Date.now()}.png`,
        'whiteboard',
      )
    })()
    await whiteboardUploadRef.current
  }, [callContext])

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
    }
    try {
      await uploadWhiteboardSnapshot()
    } catch (reason) {
      closeError ??= reason
    }
    try {
      await stopCallTranscript()
    } catch (reason) {
      closeError ??= reason
    } finally {
      if (closeError) {
        setError(closeError instanceof Error ? closeError.message : 'Не удалось сохранить запись звонка.')
      }
      closeMeetingWindow(navigate)
    }
  }, [finishDirectCall, navigate, stopCallRecording, stopCallTranscript, uploadWhiteboardSnapshot])

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
          connectOptions={{ autoSubscribe: true }}
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
          {callContext && isOrganizer && aiAssistantActive && <CallRecorder
            callContext={callContext}
            localAudioTrack={connection.audioTrack}
            onStopperChange={setRecordingStopper}
            onError={setError}
          />}
          <MeetingConference
            meeting={meeting}
            isOrganizer={isOrganizer}
            callContext={callContext}
            localAudioTrack={connection.audioTrack}
            onError={setError}
            onReload={reloadMeetings}
            closeRequest={closeRequest}
            onTranscriptStopperChange={setTranscriptStopper}
            aiAssistantActive={aiAssistantActive}
            onAiAssistantActiveChange={setAiAssistantActive}
            whiteboardItems={whiteboardItems}
            onWhiteboardItemsChange={updateWhiteboardItems}
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
