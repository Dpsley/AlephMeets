import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from 'date-fns'
import { ru } from 'date-fns/locale'
import { CalendarPlus, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScheduleModal } from '../components/ScheduleModal'
import { api } from '../lib/api'
import { openMeetingWindow } from '../lib/meeting-window'
import { useApp } from '../state/AppContext'

export function CalendarPage(): React.JSX.Element {
  const { meetings, reloadMeetings, lastCalendarSyncedAt } = useApp()
  const navigate = useNavigate()
  const [month, setMonth] = useState(startOfMonth(new Date()))
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const days = useMemo(() => eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  }), [month])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setSyncMessage(null)
    try {
      const result = await api.syncExchange()
      await reloadMeetings()
      setSyncMessage(`Exchange: импортировано ${result.imported}, экспортировано ${result.exported}`)
    } catch (reason) {
      setSyncMessage(reason instanceof Error ? reason.message : 'Ошибка синхронизации')
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
      {syncMessage && <div className="notice-bar">{syncMessage}</div>}
      <section className="calendar-panel">
        <header className="calendar-toolbar"><h2>{format(month, 'LLLL yyyy', { locale: ru })}</h2><div><button className="icon-button" onClick={() => setMonth(subMonths(month, 1))}><ChevronLeft /></button><button className="button ghost small" onClick={() => setMonth(startOfMonth(new Date()))}>Сегодня</button><button className="icon-button" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight /></button></div></header>
        <div className="weekdays">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="calendar-grid">
          {days.map((day) => {
            const dayMeetings = meetings.filter((meeting) => meeting.status === 'scheduled' && isSameDay(new Date(meeting.startsAt), day))
            return <div className={`calendar-day ${!isSameMonth(day, month) ? 'outside' : ''} ${isSameDay(day, new Date()) ? 'today' : ''}`} key={day.toISOString()}><span className="day-number">{format(day, 'd')}</span><div className="day-events">{dayMeetings.slice(0, 3).map((meeting) => <button key={meeting.id} className={meeting.status === 'live' ? 'live' : ''} onClick={() => void openMeetingWindow(meeting.id).then((opened) => { if (!opened) navigate(`/meeting/${meeting.id}`) })}><i />{format(new Date(meeting.startsAt), 'HH:mm')} {meeting.title}</button>)}{dayMeetings.length > 3 && <small>+ еще {dayMeetings.length - 3}</small>}</div></div>
          })}
        </div>
      </section>
      <ScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
    </div>
  )
}
