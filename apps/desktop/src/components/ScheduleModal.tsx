import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../state/AppContext'
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

type RecurrenceRule = 'none' | 'daily' | 'weekly' | 'monthly'

export function ScheduleModal({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const { user, reloadMeetings } = useApp()
  const initialStart = useMemo(() => {
    const date = new Date()
    date.setDate(date.getDate() + 1)
    date.setHours(11, 0, 0, 0)
    return localDateTime(date)
  }, [open])
  const [title, setTitle] = useState('Новая встреча')
  const [startsAt, setStartsAt] = useState(initialStart)
  const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule>('none')
  const [recurrenceCount, setRecurrenceCount] = useState(5)
  const [participants, setParticipants] = useState<ParticipantSelection[]>([])
  const [waitingRoom, setWaitingRoom] = useState(true)
  const [muteOnEntry, setMuteOnEntry] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    const start = new Date(startsAt)
    const end = new Date(start.getTime() + 60 * 60_000)
    setSaving(true)
    try {
      await api.createMeeting({
        title,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timezone: user?.timezone ?? 'Europe/Moscow',
        attendees: participantEmails(participants),
        attendeeUserIds: participantUserIds(participants),
        syncCalendar: true,
        waitingRoom,
        muteOnEntry,
        allowJoinBeforeHost: false,
        recurrenceRule,
        recurrenceCount: recurrenceRule === 'none' ? 1 : recurrenceCount,
      })
      await reloadMeetings()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось создать встречу')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Запланировать встречу" width={560}>
      <form className="form-stack" onSubmit={submit}>
        <label>
          <span>Тема</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required />
        </label>
        <div className="form-row">
          <label className="grow">
            <span>Дата и время</span>
            <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
          </label>
        </div>
        <div className="form-row">
          <label className="grow">
            <span>Повторять</span>
            <select value={recurrenceRule} onChange={(event) => setRecurrenceRule(event.target.value as RecurrenceRule)}>
              <option value="none">Не повторять</option>
              <option value="daily">Каждый день</option>
              <option value="weekly">Каждую неделю</option>
              <option value="monthly">Каждый месяц</option>
            </select>
          </label>
          {recurrenceRule !== 'none' && (
            <label>
              <span>Количество встреч</span>
              <input
                type="number"
                min={2}
                max={52}
                value={recurrenceCount}
                onChange={(event) => setRecurrenceCount(Math.min(52, Math.max(2, Number(event.target.value) || 2)))}
              />
            </label>
          )}
        </div>
        {recurrenceRule !== 'none' && (
          <small className="form-hint">Будет создана серия из {recurrenceCount} встреч.</small>
        )}
        <ParticipantPicker value={participants} onChange={setParticipants} />
        <div className="settings-box">
          <label className="check-row">
            <input type="checkbox" checked={waitingRoom} onChange={(event) => setWaitingRoom(event.target.checked)} />
            <span><strong>Зал ожидания</strong><small>Подтверждать вход участников</small></span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={muteOnEntry} onChange={(event) => setMuteOnEntry(event.target.checked)} />
            <span><strong>Выключать микрофон при входе</strong><small>Участники смогут включить его самостоятельно</small></span>
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>Отмена</button>
          <button className="button primary" disabled={saving}>{saving ? 'Создание...' : 'Запланировать'}</button>
        </footer>
      </form>
    </Modal>
  )
}
