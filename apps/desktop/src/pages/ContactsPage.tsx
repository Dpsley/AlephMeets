import { Briefcase, Building2, Mail, MessageSquareText, Phone, Plus, Search, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Avatar, Modal } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../state/AppContext'
import type { Contact } from '../types'

export function ContactsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { presenceByUserId, startDirectCall } = useApp()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [search, setSearch] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [contactLookup, setContactLookup] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [contactsLoading, setContactsLoading] = useState(true)
  const [callingId, setCallingId] = useState<string | null>(null)
  const load = useCallback(async (): Promise<void> => {
    setContactsLoading(true)
    setContactsError(null)
    try {
      const result = await api.contacts()
      setContacts(result.contacts)
    } catch (reason) {
      setContactsError(reason instanceof Error ? reason.message : 'Не удалось синхронизировать контакты из AD.')
    } finally {
      setContactsLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const filtered = useMemo(
    () => contacts.filter((contact) => `${contact.displayName} ${contact.email ?? ''} ${contact.phone ?? ''} ${contact.position ?? ''} ${contact.department ?? ''}`.toLowerCase().includes(search.toLowerCase())),
    [contacts, search],
  )

  const add = async (): Promise<void> => {
    setError(null)
    try {
      await api.addContact(contactLookup)
      setContactLookup('')
      setAddOpen(false)
      void load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка')
    }
  }
  const chat = async (contact: Contact): Promise<void> => {
    await api.createConversation([contact.id])
    navigate('/chat')
  }
  const call = async (contact: Contact): Promise<void> => {
    setCallingId(contact.id)
    try {
      await startDirectCall(contact)
    } finally {
      setCallingId(null)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Адресная книга</p>
          <h1>Контакты</h1>
          <span>Коллеги и участники ваших встреч.</span>
        </div>
        <button className="button primary" onClick={() => setAddOpen(true)}><UserPlus size={18} />Добавить контакт</button>
      </header>
      <div className="toolbar">
        <div className="search-box wide">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Имя, email или телефон" />
        </div>
        <span className="result-count">{contactsLoading ? 'Синхронизация...' : `${filtered.length} контакта`}</span>
      </div>
      <section className="contact-grid">
        {contactsLoading && (
          <div className="contacts-sync-loader">
            <span className="spinner" />
            <strong>Пожалуйста, подождите, идет синхронизация</strong>
            <small>Загружаем контакты из AD.</small>
          </div>
        )}
        {!contactsLoading && contactsError && (
          <div className="contacts-sync-loader">
            <strong>Не удалось загрузить контакты</strong>
            <small>{contactsError}</small>
            <button className="button secondary small" type="button" onClick={() => void load()}>Повторить</button>
          </div>
        )}
        {!contactsLoading && !contactsError && filtered.map((contact) => {
          const status = presenceByUserId[contact.id] ?? contact.status
          const title = contact.alias || contact.displayName
          return (
            <article className="contact-card" key={contact.id}>
              <div className="contact-card-main">
                <Avatar name={contact.displayName} src={contact.avatarUrl} status={status} size="large" />
                <h3 title={title}>{title}</h3>
                <div className="contact-details">
                  {contact.email && <span className="contact-detail" title={contact.email}><Mail size={14} /><span>{contact.email}</span></span>}
                  {contact.phone && <span className="contact-detail" title={contact.phone}><Phone size={14} /><span>{contact.phone}</span></span>}
                  {contact.position && <span className="contact-detail" title={contact.position}><Briefcase size={14} /><span>{contact.position}</span></span>}
                  {contact.department && <span className="contact-detail" title={contact.department}><Building2 size={14} /><span>{contact.department}</span></span>}
                </div>
                <span className={`presence-label presence-text-${status}`}>{status === 'online' ? 'В сети' : 'Не в сети'}</span>
              </div>
              <footer>
                <button className="button secondary small" onClick={() => void chat(contact)}><MessageSquareText size={16} />Сообщение</button>
                <button
                  className="icon-button call-button"
                  onClick={() => void call(contact)}
                  disabled={callingId === contact.id}
                  title={`Позвонить: ${contact.displayName}`}
                  aria-label={`Позвонить: ${contact.displayName}`}
                >
                  <Phone size={18} />
                </button>
              </footer>
            </article>
          )
        })}
      </section>
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Добавить контакт">
        <div className="form-stack">
          <label>
            <span>Email или номер телефона</span>
            <input
              type="text"
              value={contactLookup}
              onChange={(event) => setContactLookup(event.target.value)}
              placeholder="name@company.com или +7 999 123-45-67"
              autoFocus
            />
          </label>
          {error && <p className="form-error">Пользователь с такими данными не найден.</p>}
          <footer className="modal-actions">
            <button className="button secondary" onClick={() => setAddOpen(false)}>Отмена</button>
            <button className="button primary" onClick={() => void add()} disabled={!contactLookup.trim()}><Plus size={17} />Добавить</button>
          </footer>
        </div>
      </Modal>
    </div>
  )
}
