import {
  Bell,
  CalendarSync,
  Camera,
  CheckCircle2,
  ChevronRight,
  HardDrive,
  Headphones,
  Mic,
  Moon,
  Monitor,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sun,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Avatar, Modal } from '../components/ui'
import { api } from '../lib/api'
import { ensureDesktopMediaAccess, mediaErrorMessage } from '../lib/media'
import { useApp } from '../state/AppContext'
import type { ExchangeSettings } from '../types'

const emptyExchange: ExchangeSettings = {
  serverUrl: '',
  email: '',
  username: '',
  password: '',
  domain: '',
  authMethod: 'ntlm',
  verifyTls: true,
}

type SettingsSection = 'general' | 'video' | 'audio' | 'notifications' | 'privacy'

const settingsSections: Array<{
  id: SettingsSection
  label: string
  icon: typeof Monitor
}> = [
  { id: 'general', label: 'Общие', icon: Monitor },
  { id: 'video', label: 'Видео', icon: Camera },
  { id: 'audio', label: 'Аудио', icon: Headphones },
  { id: 'notifications', label: 'Уведомления', icon: Bell },
  { id: 'privacy', label: 'Конфиденциальность', icon: ShieldCheck },
]

export function SettingsPage(): React.JSX.Element {
  const { user, presenceByUserId, theme, setTheme } = useApp()
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [exchange, setExchange] = useState<ExchangeSettings | null>(null)
  const [configured, setConfigured] = useState(false)
  const [form, setForm] = useState<ExchangeSettings>(emptyExchange)
  const [exchangeOpen, setExchangeOpen] = useState(false)
  const [version, setVersion] = useState('0.1.0')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState('')
  const [micTesting, setMicTesting] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [micTestError, setMicTestError] = useState<string | null>(null)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  )
  const micStreamRef = useRef<MediaStream | null>(null)
  const micAudioContextRef = useRef<AudioContext | null>(null)
  const micAnimationRef = useRef<number | null>(null)

  const videoDevices = useMemo(() => devices.filter((device) => device.kind === 'videoinput'), [devices])
  const audioInputDevices = useMemo(() => devices.filter((device) => device.kind === 'audioinput'), [devices])
  const audioDevices = useMemo(() => devices.filter((device) => device.kind !== 'videoinput'), [devices])

  const loadExchange = async (): Promise<void> => {
    const result = await api.exchangeSettings()
    setConfigured(result.configured)
    setExchange(result.settings)
  }

  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then(setDevices)
    void loadExchange()
    void window.alephDesktop?.getVersion().then(setVersion)
  }, [])

  const stopMicTest = useCallback((resetState = true): void => {
    if (micAnimationRef.current !== null) {
      cancelAnimationFrame(micAnimationRef.current)
      micAnimationRef.current = null
    }
    micStreamRef.current?.getTracks().forEach((track) => track.stop())
    micStreamRef.current = null
    const context = micAudioContextRef.current
    micAudioContextRef.current = null
    if (context && context.state !== 'closed') void context.close().catch(() => undefined)
    if (resetState) {
      setMicTesting(false)
      setMicLevel(0)
    }
  }, [])

  useEffect(() => () => stopMicTest(false), [stopMicTest])

  const changeMicrophone = (deviceId: string): void => {
    setSelectedMicrophoneId(deviceId)
    if (micTesting) stopMicTest()
  }

  const startMicTest = async (): Promise<void> => {
    if (micTesting) {
      stopMicTest()
      return
    }
    setMicTestError(null)
    try {
      await ensureDesktopMediaAccess(['microphone'])
      const audio: MediaTrackConstraints = selectedMicrophoneId
        ? {
          deviceId: { exact: selectedMicrophoneId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
        : {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      micStreamRef.current = stream
      const nextDevices = await navigator.mediaDevices.enumerateDevices()
      setDevices(nextDevices)

      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.72
      source.connect(analyser)
      micAudioContextRef.current = audioContext
      await audioContext.resume().catch(() => undefined)

      const data = new Float32Array(analyser.fftSize)
      const updateLevel = (): void => {
        analyser.getFloatTimeDomainData(data)
        let sumSquares = 0
        for (const sample of data) sumSquares += sample * sample
        const rms = Math.sqrt(sumSquares / data.length)
        const decibels = 20 * Math.log10(Math.max(rms, 0.000001))
        const normalized = Math.round(Math.min(100, Math.max(0, ((decibels + 60) / 60) * 100)))
        setMicLevel(normalized)
        micAnimationRef.current = requestAnimationFrame(updateLevel)
      }
      setMicTesting(true)
      updateLevel()
    } catch (reason) {
      stopMicTest()
      setMicTestError(mediaErrorMessage('audio', reason))
    }
  }

  const openExchange = (): void => {
    setError(null)
    setMessage(null)
    setForm({
      ...emptyExchange,
      ...exchange,
      email: exchange?.email || user?.email || '',
      username: exchange?.username || user?.email || '',
      password: '',
    })
    setExchangeOpen(true)
  }

  const saveExchange = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const result = await api.saveExchangeSettings(form)
      setConfigured(true)
      setExchange(result.settings)
      setMessage(result.sync
        ? `Exchange подключён. Импортировано: ${result.sync.imported}, экспортировано: ${result.sync.exported}.`
        : 'Exchange подключён. Первая синхронизация не выполнена; сервер повторит попытку в течение 5 минут.')
      setExchangeOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подключиться к Exchange.')
    } finally {
      setSaving(false)
    }
  }

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setMessage(null)
    setError(null)
    try {
      const result = await api.syncExchange()
      setMessage(`Синхронизировано: импорт ${result.imported}, экспорт ${result.exported}.`)
      await loadExchange()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка синхронизации Exchange.')
    } finally {
      setSyncing(false)
    }
  }

  const requestNotifications = async (): Promise<void> => {
    if (typeof Notification === 'undefined') return
    setNotificationPermission(await Notification.requestPermission())
  }

  return (
    <div className="page settings-page">
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="Разделы настроек">
          {settingsSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeSection === id}
              className={activeSection === id ? 'active' : ''}
              onClick={() => setActiveSection(id)}
            >
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
        <section className="settings-content" data-active-section={activeSection}>
          <div className="settings-section profile-settings" data-settings-section="general">
            <h2>Профиль</h2>
            <div>
              <Avatar name={user?.displayName ?? 'User'} src={user?.avatarUrl} status={user ? presenceByUserId[user.id] ?? user.status : undefined} size="large" />
              <span>
                <strong>{user?.displayName}</strong>
                {user?.email && <small>{user.email}</small>}
                {!user?.email && user?.phone && <small>{user.phone}</small>}
                <em>Aleph ID · вход по SMS</em>
              </span>
            </div>
          </div>

          <div className="settings-section" data-settings-section="general">
            <h2>Внешний вид</h2>
            <div className="theme-choice" role="group" aria-label="Тема приложения">
              <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
                <Sun size={17} />Светлая
              </button>
              <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
                <Moon size={17} />Темная
              </button>
            </div>
          </div>

          <div className="settings-section" data-settings-section="general">
            <h2>Устройства</h2>
            <div className="setting-row">
              <span className="setting-icon"><Camera /></span>
              <div><strong>Камера</strong><small>{devices.find((item) => item.kind === 'videoinput')?.label || 'Разрешение будет запрошено при входе'}</small></div>
              <ChevronRight />
            </div>
            <div className="setting-row">
              <span className="setting-icon"><Headphones /></span>
              <div><strong>Микрофон</strong><small>{devices.find((item) => item.kind === 'audioinput')?.label || 'Системное устройство'}</small></div>
              <ChevronRight />
            </div>
          </div>

          <div className="settings-section" data-settings-section="general">
            <div className="section-title-row">
              <div><h2>Календарь Exchange / Outlook</h2><p>Удаленная синхронизация через EWS</p></div>
              {configured
                ? <span className="connected"><CheckCircle2 size={16} />Настроен</span>
                : <span className="not-connected">Не настроен</span>}
            </div>
            <div className="integration-card">
              <span className="outlook-logo">O</span>
              <div>
                <strong>{exchange?.email || 'Microsoft Exchange / OWA'}</strong>
                <small>{exchange?.serverUrl || 'Введите адрес OWA или EWS и учетные данные'}</small>
                {exchange?.lastSyncedAt && <em className="integration-hint">Последняя синхронизация: {new Date(exchange.lastSyncedAt).toLocaleString('ru-RU')}</em>}
                {exchange?.lastSyncError && <em className="integration-error">{exchange.lastSyncError}</em>}
              </div>
              <button className="button secondary small" onClick={openExchange}><Settings2 size={16} />Настроить</button>
              <button className="button secondary small" onClick={() => void sync()} disabled={!configured || syncing}>
                <RefreshCw size={16} className={syncing ? 'spinning' : ''} />
                {syncing ? 'Синхронизация' : 'Синхронизировать'}
              </button>
            </div>
            {message && <p className="integration-success">{message}</p>}
            {error && !exchangeOpen && <p className="form-error integration-message">{error}</p>}
          </div>

          <div className="settings-section" data-settings-section="general">
            <h2>Приложение</h2>
            <div className="setting-row">
              <span className="setting-icon"><HardDrive /></span>
              <div><strong>AlephMeets {version}</strong><small>Приложение для {window.alephDesktop?.platform === 'darwin' ? 'macOS' : window.alephDesktop?.platform === 'win32' ? 'Windows' : 'настольных систем'}</small></div>
              <span className="muted">Актуальная версия</span>
            </div>
          </div>

          <div className="settings-section" data-settings-section="video">
            <h2>Видео</h2>
            {videoDevices.length ? videoDevices.map((device, index) => (
              <div className="setting-row" key={device.deviceId || `camera-${index}`}>
                <span className="setting-icon"><Camera /></span>
                <div>
                  <strong>{device.label || `Камера ${index + 1}`}</strong>
                  <small>Доступна для видеовстреч</small>
                </div>
                <CheckCircle2 />
              </div>
            )) : (
              <div className="settings-empty-device">
                <Camera />
                <strong>Камера не найдена</strong>
                <span>Можно входить во встречи только с микрофоном.</span>
              </div>
            )}
          </div>

          <div className="settings-section" data-settings-section="audio">
            <h2>Аудио</h2>
            <div className="microphone-test-card">
              <label>
                <span>Тест микрофона</span>
                <select value={selectedMicrophoneId} onChange={(event) => changeMicrophone(event.target.value)} disabled={micTesting}>
                  <option value="">Системный микрофон</option>
                  {audioInputDevices.map((device, index) => (
                    <option value={device.deviceId} key={device.deviceId || `microphone-${index}`}>
                      {device.label || `Микрофон ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="microphone-meter" role="meter" aria-label="Уровень громкости микрофона" aria-valuemin={0} aria-valuemax={100} aria-valuenow={micLevel}>
                <span style={{ width: `${micLevel}%` }} />
              </div>
              <div className="microphone-test-actions">
                <button className="button secondary small" type="button" onClick={() => void startMicTest()}>
                  <Mic size={16} />{micTesting ? 'Остановить тест' : 'Начать тест'}
                </button>
                <strong>{micTesting ? `${micLevel}%` : 'Тест остановлен'}</strong>
              </div>
              {micTestError && <p className="form-error">{micTestError}</p>}
            </div>
            {audioDevices.length ? audioDevices.map((device, index) => (
              <div className="setting-row" key={device.deviceId || `${device.kind}-${index}`}>
                <span className="setting-icon"><Headphones /></span>
                <div>
                  <strong>{device.label || `Аудиоустройство ${index + 1}`}</strong>
                  <small>{device.kind === 'audioinput' ? 'Микрофон' : 'Устройство вывода'}</small>
                </div>
                <CheckCircle2 />
              </div>
            )) : (
              <div className="settings-empty-device">
                <Headphones />
                <strong>Аудиоустройства не найдены</strong>
                <span>Проверьте подключение и разрешения Windows или macOS.</span>
              </div>
            )}
          </div>

          <div className="settings-section" data-settings-section="notifications">
            <h2>Уведомления</h2>
            <div className="setting-row">
              <span className="setting-icon"><Bell /></span>
              <div>
                <strong>Системные уведомления</strong>
                <small>{notificationPermission === 'granted' ? 'Разрешены системой' : notificationPermission === 'denied' ? 'Заблокированы системой' : 'Разрешение ещё не запрошено'}</small>
              </div>
              {notificationPermission !== 'granted' && (
                <button className="button secondary small" onClick={() => void requestNotifications()}>Разрешить</button>
              )}
            </div>
          </div>

          <div className="settings-section" data-settings-section="privacy">
            <h2>Конфиденциальность</h2>
            <div className="setting-row">
              <span className="setting-icon"><ShieldCheck /></span>
              <div><strong>Камера и микрофон</strong><small>Включаются только при входе во встречу и управляются кнопками звонка.</small></div>
              <CheckCircle2 />
            </div>
          </div>
        </section>
      </div>

      <Modal open={exchangeOpen} onClose={() => setExchangeOpen(false)} title="Подключение Exchange / OWA" width={620}>
        <form className="form-stack" onSubmit={(event) => void saveExchange(event)}>
          <div className="exchange-note"><CalendarSync size={19} /><span><strong>Календарь подключается через EWS</strong><small>Можно вставить адрес OWA, например https://mail.company.ru/owa. AlephMeets автоматически использует /EWS/Exchange.asmx.</small></span></div>
          <label><span>Адрес OWA или EWS</span><input type="url" value={form.serverUrl} onChange={(event) => setForm({ ...form, serverUrl: event.target.value })} placeholder="https://mail.company.ru/owa" required autoFocus /></label>
          <div className="form-row">
            <label className="grow"><span>Email календаря</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="user@company.ru" required /></label>
            <label className="grow"><span>Метод входа</span><select value={form.authMethod} onChange={(event) => setForm({ ...form, authMethod: event.target.value as 'basic' | 'ntlm' })}><option value="ntlm">NTLM (Exchange)</option><option value="basic">Basic</option></select></label>
          </div>
          <div className="form-row">
            <label className="grow"><span>Логин</span><input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="user или user@company.ru" required /></label>
            <label className="grow"><span>Домен</span><input value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="COMPANY (для NTLM)" /></label>
          </div>
          <label><span>Пароль</span><input type="password" value={form.password ?? ''} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={configured ? 'Сохранен — оставьте пустым, чтобы не менять' : 'Пароль учетной записи Exchange'} required={!configured} /></label>
          <label className="check-row"><input type="checkbox" checked={form.verifyTls} onChange={(event) => setForm({ ...form, verifyTls: event.target.checked })} /><span><strong>Проверять TLS-сертификат сервера</strong><small>Отключайте только для внутреннего сервера с собственным сертификатом</small></span></label>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions"><button type="button" className="button secondary" onClick={() => setExchangeOpen(false)}>Отмена</button><button className="button primary" disabled={saving}>{saving ? 'Проверка подключения...' : 'Проверить и сохранить'}</button></footer>
        </form>
      </Modal>
    </div>
  )
}
