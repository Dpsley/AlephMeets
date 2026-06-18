import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  VideoConference,
} from '@livekit/components-react'
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
import type { Meeting } from '../types'
import { api } from '../lib/api'
import { mediaErrorMessage, type MediaKind } from '../lib/media'
import { useApp } from '../state/AppContext'
import { BrandMark } from '../components/BrandMark'

type DeviceState = 'checking' | 'available' | 'unavailable'

function InitialMediaPublisher({
  audioEnabled,
  videoEnabled,
  onDeviceError,
}: {
  audioEnabled: boolean
  videoEnabled: boolean
  onDeviceError: (kind: MediaKind, error: unknown) => void
}): null {
  const room = useRoomContext()

  useEffect(() => {
    let active = true
    const publish = async (): Promise<void> => {
      if (audioEnabled) {
        try {
          await room.localParticipant.setMicrophoneEnabled(true)
        } catch (error) {
          if (active) onDeviceError('audio', error)
        }
      }
      if (videoEnabled) {
        try {
          await room.localParticipant.setCameraEnabled(true)
        } catch (error) {
          if (active) onDeviceError('video', error)
        }
      }
    }
    void publish()
    return () => { active = false }
  }, [audioEnabled, onDeviceError, room, videoEnabled])

  return null
}

export function MeetingPage(): React.JSX.Element {
  const { meetingId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { meetings, user, loading } = useApp()
  const meetingFromNavigation = (location.state as { meeting?: Meeting } | null)?.meeting
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
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.alephDesktop?.setTitlebarTheme(joined ? 'dark' : 'light')
    return () => window.alephDesktop?.setTitlebarTheme('light')
  }, [joined])

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
      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          kind === 'audio' ? { audio: true, video: false } : { audio: false, video: true },
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
        if (active) handleDeviceError(kind, reason)
        return null
      }
    }

    const prepareMedia = async (): Promise<void> => {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
      const hasAudio = devices.some((device) => device.kind === 'audioinput')
      const hasVideo = devices.some((device) => device.kind === 'videoinput')

      if (!hasAudio) handleDeviceError('audio', new DOMException('Device not found', 'NotFoundError'))
      if (!hasVideo) handleDeviceError('video', new DOMException('Device not found', 'NotFoundError'))

      const [audioTrack, videoTrack] = await Promise.all([
        hasAudio ? acquire('audio') : Promise.resolve(null),
        hasVideo ? acquire('video') : Promise.resolve(null),
      ])
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
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (token.isHost) await api.updateMeetingStatus(meetingId, 'live')
      setConnection(token)
      setJoined(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подключиться к встрече.')
    }
  }

  if (loading || !meeting) {
    return <div className="meeting-loading"><span className="spinner" />Загрузка встречи...</div>
  }

  if (joined && connection) {
    return (
      <div className="meeting-room" data-lk-theme="default">
        <div className="meeting-topbar">
          <div><BrandMark small /><strong>{meeting.title}</strong></div>
          <div><ShieldCheck size={15} />Защищенное соединение</div>
        </div>
        <LiveKitRoom
          token={connection.token}
          serverUrl={connection.serverUrl}
          connect
          audio={false}
          video={false}
          onDisconnected={() => {
            if (connection.isHost) void api.updateMeetingStatus(meeting.id, 'ended')
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
