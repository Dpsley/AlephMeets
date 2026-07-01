import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from 'date-fns'
import { ru } from 'date-fns/locale'
import { CalendarClock, CalendarPlus, ChevronLeft, ChevronRight, Play, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScheduleModal } from '../components/ScheduleModal'
import { Modal } from '../components/ui'
import { api } from '../lib/api'
import { openMeetingWindow } from '../lib/meeting-window'
import { useApp } from '../state/AppContext'
import type { Meeting } from '../types'

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function attendeeEmails(meeting: Meeting): string {
  return (meeting.attendees ?? [])
    .map((attendee) => attendee.email)
    .filter((email): email is string => Boolean(email))
    .join(', ')
}

function meetingDurationMinutes(meeting: Meeting): number {
  const duration = Math.round((new Date(meeting.endsAt).getTime() - new Date(meeting.startsAt).getTime()) / 60_000)
  return Math.max(15, duration || 60)
}

function CalendarMeetingActions({
  meeting,
  onClose,
  onChanged,
}: {
  meeting: Meeting
  onClose: () => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(meeting.title)
  const [startsAt, setStartsAt] = useState(localDateTime(new Date(meeting.startsAt)))
  const [duration, setDuration] = useState(meetingDurationMinutes(meeting))
  const [attendees, setAttendees] = useState(attendeeEmails(meeting))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canManage = meeting.status === 'scheduled' && new Date(meeting.endsAt) > new Date()

  useEffect(() => {
    setEditing(false)
    setTitle(meeting.title)
    setStartsAt(localDateTime(new Date(meeting.startsAt)))
    setDuration(meetingDurationMinutes(meeting))
    setAttendees(attendeeEmails(meeting))
    setError(null)
  }, [meeting])

  const startMeeting = async (): Promise<void> => {
    const opened = await openMeetingWindow(meeting.id)
    if (!opened) navigate(`/meeting/${meeting.id}`)
    onClose()
  }

  const deleteMeeting = async (): Promise<void> => {
    if (!window.confirm(`Удалить встречу «${meeting.title}»?`)) return
    setSaving(true)
    setError(null)
    try {
      await api.deleteMeeting(meeting.id)
      await onChanged()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось удалить встречу')
    } finally {
      setSaving(false)
    }
  }

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const start = new Date(startsAt)
    const end = new Date(start.getTime() + duration * 60_000)
    setSaving(true)
    setError(null)
    try {
      await api.updateMeeting(meeting.id, {
        title,
        description: meeting.description ?? '',
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timezone: meeting.timezone,
        attendees: attendees.split(/[,;\s]+/).filter(Boolean),
        attendeeUserIds: [],
        waitingRoom: meeting.waitingRoom,
        muteOnEntry: meeting.muteOnEntry,
        allowJoinBeforeHost: meeting.allowJoinBeforeHost,
        syncCalendar: true,
      })
      await onChanged()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось изменить встречу')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? 'Изменить встречу' : meeting.title} width={560}>
      {!editing ? (
        <div className="form-stack">
          <div className="meeting-action-summary">
            <strong>{format(new Date(meeting.startsAt), 'd MMMM yyyy, HH:mm', { locale: ru })}</strong>
            <span>{meeting.attendees?.length ?? 0} участников</span>
          </div>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions meeting-action-buttons">
            <button className="button secondary" onClick={onClose}>Закрыть</button>
            {canManage && <button className="button secondary" onClick={() => setEditing(true)}><CalendarClock size={17} />Перенести</button>}
            {canManage && <button className="button secondary danger" onClick={() => void deleteMeeting()} disabled={saving}><Trash2 size={17} />Удалить</button>}
            <button className="button primary" onClick={() => void startMeeting()}><Play size={17} />Запустить</button>
          </footer>
        </div>
      ) : (
        <form className="form-stack" onSubmit={(event) => void save(event)}>
          <label>
            <span>Название</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required />
          </label>
          <div className="form-row">
            <label className="grow">
              <span>Дата и время</span>
              <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
            </label>
            <label>
              <span>Длительность</span>
              <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                <option value={30}>30 минут</option>
                <option value={45}>45 минут</option>
                <option value={60}>1 час</option>
                <option value={90}>1,5 часа</option>
                <option value={120}>2 часа</option>
              </select>
            </label>
          </div>
          <label>
            <span>Участники</span>
            <input value={attendees} onChange={(event) => setAttendees(event.target.value)} placeholder="email через запятую" />
          </label>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setEditing(false)}>Назад</button>
            <button className="button primary" disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</button>
          </footer>
        </form>
      )}
    </Modal>
  )
}

export function CalendarPage(): React.JSX.Element {
  const { meetings, reloadMeetings, lastCalendarSyncedAt } = useApp()
  const [month, setMonth] = useState(startOfMonth(new Date()))
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null)
  const [syncing, setSyncing] = useState(false)
  const days = useMemo(() => eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  }), [month])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    try {
      await api.syncExchange()
      await reloadMeetings()
    } catch (reason) {
      console.error(reason)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="page calendar-page">
      <header className="page-header">
        <div><p className="eyebrow">Расписание</p><h1>Календарь</h1><span>Встречи AlephMeets и Exchange в одном месте.</span></div>
        <div className="calendar-header-controls">
          <div className="header-actions"><button className="button secondary" onClick={() => void sync()} disabled={syncing}><RefreshCw size={17} className={syncing ? 'spinning' : ''} />{syncing ? 'Синхронизация...' : 'Exchange / OWA'}</button><button className="button primary" onClick={() => setScheduleOpen(true)}><CalendarPlus size={17} />Создать</button></div>
          <small className="calendar-last-sync">Последняя синхронизация: {lastCalendarSyncedAt ? new Date(lastCalendarSyncedAt).toLocaleString('ru-RU') : 'ещё не выполнялась'}</small>
        </div>
      </header>
      <section className="calendar-panel">
        <header className="calendar-toolbar"><h2>{format(month, 'LLLL yyyy', { locale: ru })}</h2><div><button className="icon-button" onClick={() => setMonth(subMonths(month, 1))}><ChevronLeft /></button><button className="button ghost small" onClick={() => setMonth(startOfMonth(new Date()))}>Сегодня</button><button className="icon-button" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight /></button></div></header>
        <div className="weekdays">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="calendar-grid">
          {days.map((day) => {
            const dayMeetings = meetings.filter((meeting) => meeting.status === 'scheduled' && isSameDay(new Date(meeting.startsAt), day))
            return <div className={`calendar-day ${!isSameMonth(day, month) ? 'outside' : ''} ${isSameDay(day, new Date()) ? 'today' : ''}`} key={day.toISOString()}><span className="day-number">{format(day, 'd')}</span><div className="day-events">{dayMeetings.slice(0, 3).map((meeting) => <button key={meeting.id} className={meeting.status === 'live' ? 'live' : ''} onClick={() => setSelectedMeeting(meeting)}><i />{format(new Date(meeting.startsAt), 'HH:mm')} {meeting.title}</button>)}{dayMeetings.length > 3 && <small>+ еще {dayMeetings.length - 3}</small>}</div></div>
          })}
        </div>
      </section>
      <ScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      {selectedMeeting && (
        <CalendarMeetingActions
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
          onChanged={async () => {
            await reloadMeetings()
            setSelectedMeeting(null)
          }}
        />
      )}
    </div>
  )
}
