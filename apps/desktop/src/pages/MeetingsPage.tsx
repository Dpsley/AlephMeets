import { CalendarPlus, Clock3, Search, Users, Video } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScheduleModal } from '../components/ScheduleModal'
import { meetingDate } from '../lib/format'
import { isPastMeeting, isScheduledMeeting } from '../lib/meetings'
import { openMeetingWindow } from '../lib/meeting-window'
import { useApp } from '../state/AppContext'

export function MeetingsPage(): React.JSX.Element {
  const { meetings } = useApp()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming')
  const [search, setSearch] = useState('')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const filtered = useMemo(() => meetings.filter((meeting) => {
    const belongsToTab = tab === 'past' ? isPastMeeting(meeting) : isScheduledMeeting(meeting)
    return belongsToTab && meeting.title.toLowerCase().includes(search.toLowerCase())
  }), [meetings, tab, search])

  return (
    <div className="page">
      <header className="page-header">
        <div><p className="eyebrow">Видеоконференции</p><h1>Встречи</h1><span>Управляйте запланированными и прошедшими звонками.</span></div>
        <button className="button primary" onClick={() => setScheduleOpen(true)}><CalendarPlus size={18} />Запланировать</button>
      </header>
      <div className="toolbar">
        <div className="segmented"><button className={tab === 'upcoming' ? 'active' : ''} onClick={() => setTab('upcoming')}>Предстоящие</button><button className={tab === 'past' ? 'active' : ''} onClick={() => setTab('past')}>Прошедшие</button></div>
        <div className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск встреч" /></div>
      </div>
      <section className="cards-list">
        {filtered.map((meeting) => (
          <article className="meeting-card" key={meeting.id}>
            <div className="meeting-icon"><Video size={24} /></div>
            <div className="meeting-card-main"><div className="meeting-card-title"><h3>{meeting.title}</h3><span className={`status-pill status-${meeting.status}`}>{meeting.status === 'live' ? 'Идет сейчас' : meeting.status === 'scheduled' ? 'Запланирована' : 'Завершена'}</span></div><p>{meeting.description || 'Без описания'}</p><div className="meeting-meta"><span><Clock3 size={15} />{meetingDate(meeting.startsAt)}</span><span><Users size={15} />{meeting.attendees?.length ?? 0} участников</span></div></div>
            {tab === 'upcoming' && <button className="button primary small" onClick={() => void openMeetingWindow(meeting.id).then((opened) => { if (!opened) navigate(`/meeting/${meeting.id}`) })}>Войти</button>}
          </article>
        ))}
        {!filtered.length && <div className="soft-empty large"><Video /><h3>Встреч не найдено</h3><p>Измените поиск или запланируйте новую встречу.</p></div>}
      </section>
      <ScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
    </div>
  )
}
