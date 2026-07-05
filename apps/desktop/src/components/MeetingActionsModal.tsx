import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { CalendarClock, Play, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { plainTextFromRichText } from '../lib/format'
import { canManageScheduledMeeting } from '../lib/meetings'
import { openMeetingWindow } from '../lib/meeting-window'
import { useApp } from '../state/AppContext'
import type { Meeting } from '../types'
import {
  ParticipantPicker,
  participantEmails,
  participantUserIds,
  type ParticipantSelection,
} from './ParticipantPicker'
import { Modal } from './ui'

function localDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function meetingParticipants(meeting: Meeting): ParticipantSelection[] {
  return (meeting.attendees ?? []).map((attendee) => ({
    userId: attendee.userId,
    email: attendee.email,
    displayName: attendee.displayName,
    avatarUrl: attendee.avatarUrl,
  }))
}

export function MeetingActionsModal({
  meeting,
  onClose,
  onChanged,
}: {
  meeting: Meeting
  onClose: () => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const navigate = useNavigate()
  const { user } = useApp()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(meeting.title)
  const [description, setDescription] = useState(plainTextFromRichText(meeting.description))
  const [startsAt, setStartsAt] = useState(localDateTime(new Date(meeting.startsAt)))
  const [participants, setParticipants] = useState<ParticipantSelection[]>(meetingParticipants(meeting))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canManage = canManageScheduledMeeting(meeting, user)

  useEffect(() => {
    setEditing(false)
    setTitle(meeting.title)
    setDescription(plainTextFromRichText(meeting.description))
    setStartsAt(localDateTime(new Date(meeting.startsAt)))
    setParticipants(meetingParticipants(meeting))
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
    const previousStart = new Date(meeting.startsAt)
    const previousEnd = new Date(meeting.endsAt)
    const previousDurationMs = Math.max(60 * 60_000, previousEnd.getTime() - previousStart.getTime())
    const end = new Date(start.getTime() + previousDurationMs)
    setError(null)
    setSaving(true)
    try {
      await api.updateMeeting(meeting.id, {
        title,
        description,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timezone: meeting.timezone,
        attendees: participantEmails(participants),
        attendeeUserIds: participantUserIds(participants),
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
            {canManage && <button className="button secondary" onClick={() => setEditing(true)}><CalendarClock size={17} />Изменить</button>}
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
          <label>
            <span>Описание</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </label>
          <div className="form-row">
            <label className="grow">
              <span>Дата и время</span>
              <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
            </label>
          </div>
          <ParticipantPicker value={participants} onChange={setParticipants} />
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
