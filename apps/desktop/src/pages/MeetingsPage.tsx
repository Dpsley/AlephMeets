import { CalendarPlus, Clock3, Search, Trash2, Users, Video } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScheduleModal } from '../components/ScheduleModal'
import { api } from '../lib/api'
import { meetingDate, plainTextFromRichText } from '../lib/format'
import { isPastMeeting, isScheduledMeeting } from '../lib/meetings'
import { openMeetingWindow } from '../lib/meeting-window'
import { useApp } from '../state/AppContext'
import type { Attendee } from '../types'

function attendeeLabel(attendee: Attendee): string {
  return attendee.displayName || attendee.email || 'Участник'
}

function attendeeMeta(attendee: Attendee): string {
  return attendee.email && attendee.displayName ? attendee.email : ''
}

export function MeetingsPage(): React.JSX.Element {
  const { meetings, reloadMeetings } = useApp()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming')
  const [search, setSearch] = useState('')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const filtered = useMemo(() => meetings.filter((meeting) => {
    const belongsToTab = tab === 'past' ? isPastMeeting(meeting) : isScheduledMeeting(meeting)
    return belongsToTab && meeting.title.toLowerCase().includes(search.toLowerCase())
  }), [meetings, tab, search])

  const deleteMeeting = async (meetingId: string, title: string): Promise<void> => {
    if (!window.confirm(`Удалить встречу «${title}»?`)) return
    setDeletingId(meetingId)
    try {
      await api.deleteMeeting(meetingId)
      await reloadMeetings()
    } finally {
      setDeletingId(null)
    }
  }

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
        {filtered.map((meeting) => {
          const description = plainTextFromRichText(meeting.description) || 'Без описания'
          const attendees = meeting.attendees ?? []
          return (
            <article className="meeting-card" key={meeting.id}>
              <div className="meeting-icon"><Video size={24} /></div>
              <div className="meeting-card-main">
                <div className="meeting-card-title">
                  <h3>{meeting.title}</h3>
                  <span className={`status-pill status-${meeting.status}`}>{meeting.status === 'live' ? 'Идет сейчас' : meeting.status === 'scheduled' ? 'Запланирована' : 'Завершена'}</span>
                </div>
                <p title={description}>{description}</p>
                <div className="meeting-meta">
                  <span><Clock3 size={15} />{meetingDate(meeting.startsAt)}</span>
                  <span className="meeting-participants" tabIndex={0}>
                    <Users size={15} />{attendees.length} участников
                    <span className="meeting-participants-popover" role="tooltip">
                      <strong>Участники</strong>
                      {attendees.length ? attendees.map((attendee, index) => (
                        <span className="meeting-participant-row" key={`${attendee.userId ?? attendee.email ?? index}`}>
                          <span>{attendeeLabel(attendee)}</span>
                          {attendeeMeta(attendee) && <small>{attendeeMeta(attendee)}</small>}
                        </span>
                      )) : <small>Участники не указаны</small>}
                    </span>
                  </span>
                </div>
              </div>
              <div className="meeting-card-actions">
                {tab === 'upcoming' && <button className="button primary small" onClick={() => void openMeetingWindow(meeting.id).then((opened) => { if (!opened) navigate(`/meeting/${meeting.id}`) })}>Войти</button>}
                {tab === 'upcoming' && isScheduledMeeting(meeting) && (
                  <button
                    className="button secondary small danger"
                    onClick={() => void deleteMeeting(meeting.id, meeting.title)}
                    disabled={deletingId === meeting.id}
                  >
                    <Trash2 size={15} />{deletingId === meeting.id ? 'Удаление...' : 'Удалить'}
                  </button>
                )}
              </div>
            </article>
          )
        })}
        {!filtered.length && <div className="soft-empty large"><Video /><h3>Встреч не найдено</h3><p>Измените поиск или запланируйте новую встречу.</p></div>}
      </section>
      <ScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
    </div>
  )
}
