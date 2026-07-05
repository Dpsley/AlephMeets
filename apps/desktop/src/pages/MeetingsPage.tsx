import { CalendarClock, CalendarPlus, Clock3, Search, Trash2, Users, Video } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MeetingActionsModal } from '../components/MeetingActionsModal'
import {
  MeetingParticipantsPopover,
  meetingParticipantsCount,
  type MeetingOwnerInfo,
} from '../components/MeetingParticipantsPopover'
import { ScheduleModal } from '../components/ScheduleModal'
import { api } from '../lib/api'
import { meetingDate, plainTextFromRichText } from '../lib/format'
import { canManageScheduledMeeting, isPastMeeting, isScheduledMeeting } from '../lib/meetings'
import { openMeetingWindow } from '../lib/meeting-window'
import { useApp } from '../state/AppContext'
import type { Meeting, User } from '../types'

function normalizedEmail(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

function meetingOwner(meeting: Meeting, user: User | null): MeetingOwnerInfo {
  const ownerEmail = normalizedEmail(meeting.ownerEmail)
  const isLocalOwner = !ownerEmail || ownerEmail === normalizedEmail(user?.email)
  return {
    userId: isLocalOwner ? meeting.hostId : undefined,
    email: meeting.ownerEmail,
    displayName: meeting.ownerDisplayName || meeting.hostDisplayName,
    avatarUrl: isLocalOwner ? meeting.hostAvatarUrl : null,
  }
}

export function MeetingsPage(): React.JSX.Element {
  const { meetings, reloadMeetings, user } = useApp()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming')
  const [search, setSearch] = useState('')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null)
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
          const owner = meetingOwner(meeting, user)
          const canManage = canManageScheduledMeeting(meeting, user)
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
                    <Users size={15} />{meetingParticipantsCount(attendees, owner)} участников
                    <MeetingParticipantsPopover attendees={attendees} owner={owner} />
                  </span>
                </div>
              </div>
              <div className="meeting-card-actions">
                {tab === 'upcoming' && <button className="button primary small" onClick={() => void openMeetingWindow(meeting.id).then((opened) => { if (!opened) navigate(`/meeting/${meeting.id}`) })}>Войти</button>}
                {tab === 'upcoming' && canManage && (
                  <button className="button secondary small" onClick={() => setSelectedMeeting(meeting)}>
                    <CalendarClock size={15} />Изменить
                  </button>
                )}
                {tab === 'upcoming' && canManage && (
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
      {selectedMeeting && (
        <MeetingActionsModal
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
