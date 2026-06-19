import {
  CalendarDays,
  ContactRound,
  Link2,
  LogOut,
  MessageSquareText,
  Plus,
  Settings,
  Video,
} from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useApp } from '../state/AppContext'
import { Avatar, Modal } from './ui'
import { BrandMark } from './BrandMark'
import { WindowControls } from './WindowControls'

const navItems = [
  { to: '/chat', label: 'Чаты', icon: MessageSquareText },
  { to: '/meetings', label: 'Встречи', icon: Video },
  { to: '/calendar', label: 'Календарь', icon: CalendarDays },
  { to: '/contacts', label: 'Контакты', icon: ContactRound },
]

export function AppLayout(): React.JSX.Element {
  const navigate = useNavigate()
  const { user, loading, error, logout, reloadMeetings } = useApp()
  const [joinOpen, setJoinOpen] = useState(false)
  const [joinValue, setJoinValue] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const newMeeting = async (): Promise<void> => {
    setCreating(true)
    try {
      const start = new Date()
      const result = await api.createMeeting({
        title: `Встреча ${user?.displayName ?? ''}`,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
        timezone: user?.timezone ?? 'Europe/Moscow',
        attendees: [],
        waitingRoom: false,
        muteOnEntry: false,
        allowJoinBeforeHost: true,
      })
      await api.updateMeetingStatus(result.meeting.id, 'live')
      await reloadMeetings()
      navigate(`/meeting/${result.meeting.id}`)
    } finally {
      setCreating(false)
    }
  }

  const joinMeeting = async (): Promise<void> => {
    setJoinError(null)
    try {
      const result = await api.meetingByCode(joinValue.trim())
      setJoinOpen(false)
      navigate(`/meeting/${result.meeting.id}`, { state: { meeting: result.meeting } })
    } catch (reason) {
      setJoinError(reason instanceof Error ? reason.message : 'Встреча не найдена.')
    }
  }

  return (
    <div className="app-shell">
      <div className="titlebar">
        <BrandMark />
        <strong>AlephMeets</strong>
        <WindowControls />
      </div>
      <aside className="sidebar">
        <div className="sidebar-meeting-actions">
          <button className="sidebar-meeting-button primary" onClick={() => void newMeeting()} disabled={creating}>
            <Video size={18} fill="currentColor" />
            <span>{creating ? 'Создание...' : 'Новая встреча'}</span>
          </button>
          <button className="sidebar-meeting-button" onClick={() => setJoinOpen(true)}>
            <Plus size={19} />
            <span>Войти по коду</span>
          </button>
        </div>
        <nav className="sidebar-nav">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon size={21} strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            <Settings size={21} strokeWidth={1.8} />
            <span>Настройки</span>
          </NavLink>
          <div className="profile-compact">
            <Avatar name={user?.displayName ?? 'User'} src={user?.avatarUrl} status={user?.status} />
            <div>
              <strong>{user?.displayName ?? 'Загрузка...'}</strong>
              <small>{user?.email ?? ''}</small>
            </div>
            <button className="profile-switch" onClick={() => void logout()} title="Выйти">
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main className="app-content">
        {loading ? <div className="center-loader"><span className="spinner" /></div> : null}
        {error ? (
          <div className="connection-error">
            <strong>API недоступен</strong>
            <span>{error}. Запустите `npm run dev:server`.</span>
          </div>
        ) : null}
        {!loading && !error ? <Outlet /> : null}
      </main>
      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Войти во встречу">
        <div className="form-stack">
          <label>
            <span>Идентификатор или имя комнаты</span>
            <div className="input-with-icon">
              <Link2 size={18} />
              <input
                value={joinValue}
                onChange={(event) => setJoinValue(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void joinMeeting()}
                autoFocus
                placeholder="aleph-demo-room"
              />
            </div>
          </label>
          {joinError && <p className="form-error">{joinError}</p>}
          <footer className="modal-actions">
            <button className="button secondary" onClick={() => setJoinOpen(false)}>Отмена</button>
            <button className="button primary" onClick={() => void joinMeeting()} disabled={!joinValue.trim()}>Войти</button>
          </footer>
        </div>
      </Modal>
    </div>
  )
}
