import {
  Bell,
  CalendarSync,
  Camera,
  CheckCircle2,
  ChevronRight,
  HardDrive,
  Headphones,
  Monitor,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Avatar, Modal } from '../components/ui'
import { api } from '../lib/api'
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
  const { user } = useApp()
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
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  )

  const videoDevices = devices.filter((device) => device.kind === 'videoinput')
  const audioDevices = devices.filter((device) => device.kind !== 'videoinput')

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
      setMessage('Подключение к Exchange проверено и сохранено.')
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
              <Avatar name={user?.displayName ?? 'User'} src={user?.avatarUrl} status={user?.status} size="large" />
              <span>
                <strong>{user?.displayName}</strong>
                <small>{user?.email}</small>
                <em>Aleph ID · вход по SMS</em>
              </span>
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
            <div className="setting-row">
              <span className="setting-icon"><HardDrive /></span>
              <div><strong>Локальный профиль</strong><small>Сейчас используется статичная сессия разработки без внешней авторизации.</small></div>
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
