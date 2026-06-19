import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  VideoConference,
} from '@livekit/components-react'
import { Track } from 'livekit-client'
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Mic,
  MicOff,
  Settings,
  ShieldCheck,
  Video,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { DirectCallContext, Meeting } from '../types'
import { api } from '../lib/api'
import { isRetryableMediaError, mediaErrorMessage, type MediaKind } from '../lib/media'
import { useApp } from '../state/AppContext'
import { BrandMark } from '../components/BrandMark'
import { WindowControls } from '../components/WindowControls'

type DeviceState = 'checking' | 'available' | 'unavailable'

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

export function MeetingPage(): React.JSX.Element {
  const { meetingId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { meetings, user, loading } = useApp()
  const navigationState = location.state as {
    meeting?: Meeting
    callContext?: DirectCallContext
  } | null
  const meetingFromNavigation = navigationState?.meeting
  const callContext = navigationState?.callContext
  const meeting = meetings.find((item) => item.id === meetingId) ?? meetingFromNavigation
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
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
  const callFinishedRef = useRef(false)

  const addDeviceNotice = useCallback((message: string): void => {
    setDeviceNotices((current) => current.includes(message) ? current : [...current, message])
  }, [])

  const handleDeviceError = useCallback((kind: MediaKind, reason: unknown): void => {
    addDeviceNotice(mediaErrorMessage(kind, reason))
    if (kind === 'audio') {
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
  }, [joined])

  useEffect(() => {
    streamRef.current?.getVideoTracks().forEach((track) => { track.enabled = videoEnabled })
  }, [videoEnabled])

  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = audioEnabled })
  }, [audioEnabled])

  const join = async (): Promise<void> => {
    if (!meetingId || !mediaReady) return
    setError(null)
    try {
      const token = await api.meetingToken(meetingId)
      const audioTrack = audioEnabled
        ? streamRef.current?.getAudioTracks()[0]?.clone()
        : undefined
      const videoTrack = videoEnabled
        ? streamRef.current?.getVideoTracks()[0]?.clone()
        : undefined
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (token.isHost) await api.updateMeetingStatus(meetingId, 'live')
      setConnection({ ...token, audioTrack, videoTrack })
      setJoined(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подключиться к встрече.')
    }
  }

  const finishDirectCall = (): void => {
    if (!callContext || callFinishedRef.current) return
    callFinishedRef.current = true
    void api.finishCallLog(
      callContext.conversationId,
      callContext.messageId,
      'ended',
      Date.now() - new Date(callContext.startedAt).getTime(),
    )
  }

  if (loading || !meeting) {
    return <div className="meeting-loading-screen"><WindowControls /><div className="meeting-loading"><span className="spinner" />Загрузка встречи...</div></div>
  }

  if (joined && connection) {
    return (
      <div className="meeting-room" data-lk-theme="default">
        <div className="meeting-topbar">
          <div><BrandMark small /><strong>{meeting.title}</strong></div>
          <div><ShieldCheck size={15} />Защищенное соединение</div>
          <WindowControls theme="dark" />
        </div>
        <LiveKitRoom
          token={connection.token}
          serverUrl={connection.serverUrl}
          connect
          audio={false}
          video={false}
          onDisconnected={() => {
            if (connection.isHost) void api.updateMeetingStatus(meeting.id, 'ended')
            finishDirectCall()
            navigate('/chat')
          }}
          onError={(reason) => setError(
            /requested device not found/i.test(reason.message)
              ? 'Одно из медиаустройств отключено. Встреча продолжена с доступными устройствами.'
              : reason.message,
          )}
        >
          <InitialMediaPublisher
            audioEnabled={audioEnabled && audioState === 'available'}
            videoEnabled={videoEnabled && videoState === 'available'}
            audioTrack={connection.audioTrack}
            videoTrack={connection.videoTrack}
            onDeviceError={handleDeviceError}
          />
          <VideoConference />
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
        <button className="icon-button" onClick={() => navigate(-1)}><ArrowLeft /></button>
        <div className="brand"><BrandMark /><strong>AlephMeets</strong></div>
        <button className="button ghost small"><Settings size={17} />Настройки</button>
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
            <button
              className={!audioEnabled ? 'off' : ''}
              disabled={audioState !== 'available'}
              onClick={() => setAudioEnabled((value) => !value)}
            >
              {audioEnabled && audioState === 'available' ? <Mic /> : <MicOff />}
              <span>{audioState === 'checking' ? 'Проверка...' : audioEnabled ? 'Микрофон' : 'Без звука'}</span>
            </button>
            <button
              className={!videoEnabled ? 'off' : ''}
              disabled={videoState !== 'available'}
              onClick={() => setVideoEnabled((value) => !value)}
            >
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
            <span>Организатор</span><strong>{user?.displayName}</strong>
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
