import { Check, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { api } from '../lib/api'
import type { Contact } from '../types'
import { Avatar } from './ui'

export interface ParticipantSelection {
  userId?: string
  email?: string | null
  displayName?: string | null
  avatarUrl?: string | null
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizedEmail(email: string | null | undefined): string {
  return String(email ?? '').trim().toLowerCase()
}

function normalizedPhone(phone: string | null | undefined): string {
  return String(phone ?? '').replace(/\D/g, '')
}

function contactToParticipant(contact: Contact): ParticipantSelection {
  return {
    userId: contact.id,
    email: contact.email,
    displayName: contact.displayName,
    avatarUrl: contact.avatarUrl,
  }
}

function participantLabel(participant: ParticipantSelection): string {
  return participant.displayName || participant.email || 'Участник'
}

function participantMeta(participant: ParticipantSelection): string {
  return participant.email && participant.displayName ? participant.email : ''
}

function contactMeta(contact: Contact): string {
  return [contact.email, contact.phone, contact.department].filter(Boolean).join(' · ') || 'Контакт Aleph ID'
}

function hasParticipant(participants: readonly ParticipantSelection[], candidate: ParticipantSelection): boolean {
  const email = normalizedEmail(candidate.email)
  return participants.some((participant) => {
    if (candidate.userId && participant.userId === candidate.userId) return true
    return Boolean(email && normalizedEmail(participant.email) === email)
  })
}

function addParticipant(
  participants: readonly ParticipantSelection[],
  candidate: ParticipantSelection,
): ParticipantSelection[] {
  const email = normalizedEmail(candidate.email)
  if (candidate.userId && participants.some((participant) => participant.userId === candidate.userId)) {
    return [...participants]
  }
  const rawEmailIndex = email
    ? participants.findIndex((participant) => !participant.userId && normalizedEmail(participant.email) === email)
    : -1
  if (rawEmailIndex >= 0) {
    const next = [...participants]
    next[rawEmailIndex] = candidate
    return next
  }
  if (hasParticipant(participants, candidate)) return [...participants]
  return [...participants, candidate]
}

function removeParticipant(
  participants: readonly ParticipantSelection[],
  target: ParticipantSelection,
): ParticipantSelection[] {
  const email = normalizedEmail(target.email)
  return participants.filter((participant) => {
    if (target.userId) return participant.userId !== target.userId
    return normalizedEmail(participant.email) !== email
  })
}

export function participantEmails(participants: readonly ParticipantSelection[]): string[] {
  return [...new Set(participants.map((participant) => normalizedEmail(participant.email)).filter(Boolean))]
}

export function participantUserIds(participants: readonly ParticipantSelection[]): string[] {
  return [...new Set(participants.map((participant) => participant.userId).filter((id): id is string => Boolean(id)))]
}

export function ParticipantPicker({
  label = 'Участники',
  contacts: providedContacts,
  contactsLoading: providedContactsLoading,
  contactOnly = false,
  excludeUserIds = [],
  max,
  placeholder = 'Начните вводить имя, телефон или email',
  value,
  onChange,
}: {
  label?: string
  contacts?: Contact[]
  contactsLoading?: boolean
  contactOnly?: boolean
  excludeUserIds?: string[]
  max?: number
  placeholder?: string
  value: ParticipantSelection[]
  onChange: (participants: ParticipantSelection[]) => void
}): React.JSX.Element {
  const [loadedContacts, setLoadedContacts] = useState<Contact[]>([])
  const [loadedContactsLoading, setLoadedContactsLoading] = useState(false)
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const contacts = providedContacts ?? loadedContacts
  const contactsLoading = providedContactsLoading ?? loadedContactsLoading

  useEffect(() => {
    if (providedContacts) return
    let active = true
    setLoadedContactsLoading(true)
    void api.contacts()
      .then((result) => {
        if (active) setLoadedContacts(result.contacts)
      })
      .catch(() => {
        if (active) setLoadedContacts([])
      })
      .finally(() => {
        if (active) setLoadedContactsLoading(false)
      })
    return () => { active = false }
  }, [providedContacts])

  const suggestions = useMemo(() => {
    const query = input.trim().toLowerCase()
    const phoneQuery = normalizedPhone(input)
    const excluded = new Set(excludeUserIds)
    return contacts
      .filter((contact) => !excluded.has(contact.id))
      .filter((contact) => !hasParticipant(value, contactToParticipant(contact)))
      .filter((contact) => {
        if (!query) return true
        const text = [
          contact.displayName,
          contact.email,
          contact.phone,
          contact.department,
        ].filter(Boolean).join(' ').toLowerCase()
        return text.includes(query) || Boolean(phoneQuery && normalizedPhone(contact.phone).includes(phoneQuery))
      })
      .slice(0, 8)
  }, [contacts, excludeUserIds, input, value])

  const addContact = (contact: Contact): void => {
    const participant = contactToParticipant(contact)
    onChange(max === 1 ? [participant] : addParticipant(value, participant))
    setInput('')
    setError(null)
    setFocused(false)
  }

  const confirmInput = (): void => {
    const tokens = input.split(/[,;\s]+/).map((token) => token.trim()).filter(Boolean)
    if (!tokens.length) return
    let next = [...value]
    const invalid: string[] = []
    for (const token of tokens) {
      const email = normalizedEmail(token)
      const phone = normalizedPhone(token)
      const matchedContact = contacts.find((contact) => (
        normalizedEmail(contact.email) === email
        || Boolean(phone && normalizedPhone(contact.phone) === phone)
      ))
      if (matchedContact) {
        const participant = contactToParticipant(matchedContact)
        next = max === 1 ? [participant] : addParticipant(next, participant)
      } else if (!contactOnly && emailPattern.test(email)) {
        next = addParticipant(next, { email, displayName: email, avatarUrl: null })
      } else {
        invalid.push(token)
      }
    }
    if (max && next.length > max) next = next.slice(0, max)
    onChange(next)
    if (invalid.length) {
      setInput(invalid.join(' '))
      setError(contactOnly ? 'Выберите контакт из списка.' : 'Выберите контакт из списка или введите email.')
    } else {
      setInput('')
      setError(null)
      setFocused(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      confirmInput()
    }
    if ((event.key === ',' || event.key === ';') && input.trim()) {
      event.preventDefault()
      confirmInput()
    }
  }

  return (
    <div className="participant-field">
      <span className="participant-field-label">{label}</span>
      {value.length > 0 && (
        <div className="participant-selected-list">
          {value.map((participant) => (
            <div className="participant-chip" key={participant.userId ?? normalizedEmail(participant.email)}>
              <Avatar name={participantLabel(participant)} src={participant.avatarUrl} size="small" />
              <span className="participant-chip-copy">
                <strong>{participantLabel(participant)}</strong>
                {participantMeta(participant) && <small>{participantMeta(participant)}</small>}
              </span>
              <button
                type="button"
                className="icon-button participant-remove"
                onClick={() => onChange(removeParticipant(value, participant))}
                title="Удалить участника"
                aria-label="Удалить участника"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="participant-input-wrap">
        <div className="participant-input-row">
          <input
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              setError(null)
              setFocused(true)
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoComplete="off"
          />
          <button
            type="button"
            className="participant-confirm-button"
            onClick={confirmInput}
            disabled={!input.trim()}
            title="Добавить участника"
            aria-label="Добавить участника"
          >
            <Check size={17} />
          </button>
        </div>
        {focused && (suggestions.length > 0 || contactsLoading) && (
          <div className="participant-suggestions">
            {contactsLoading && <span className="participant-suggestion-empty">Загрузка контактов...</span>}
            {suggestions.map((contact) => (
              <button
                type="button"
                className="participant-suggestion"
                key={contact.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addContact(contact)}
              >
                <Avatar name={contact.displayName} src={contact.avatarUrl} size="small" />
                <span>
                  <strong>{contact.displayName}</strong>
                  <small>{contactMeta(contact)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <small className="participant-error">{error}</small>}
    </div>
  )
}
