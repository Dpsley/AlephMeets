import { Building2, Mail, MessageSquareText, Phone, Plus, Search, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
  const [callingId, setCallingId] = useState<string | null>(null)
  const load = () => void api.contacts().then((result) => setContacts(result.contacts))
  useEffect(load, [])
  const filtered = useMemo(() => contacts.filter((contact) => `${contact.displayName} ${contact.email ?? ''} ${contact.phone ?? ''} ${contact.department ?? ''}`.toLowerCase().includes(search.toLowerCase())), [contacts, search])

  const add = async (): Promise<void> => {
    setError(null)
    try { await api.addContact(contactLookup); setContactLookup(''); setAddOpen(false); load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Ошибка') }
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

  return <div className="page"><header className="page-header"><div><p className="eyebrow">Адресная книга</p><h1>Контакты</h1><span>Коллеги и участники ваших встреч.</span></div><button className="button primary" onClick={() => setAddOpen(true)}><UserPlus size={18} />Добавить контакт</button></header><div className="toolbar"><div className="search-box wide"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Имя, email или телефон" /></div><span className="result-count">{filtered.length} контакта</span></div><section className="contact-grid">{filtered.map((contact) => {
    const status = presenceByUserId[contact.id] ?? contact.status
    return <article className="contact-card" key={contact.id}><Avatar name={contact.displayName} src={contact.avatarUrl} status={status} size="large" /><h3>{contact.alias || contact.displayName}</h3>{contact.email && <p><Mail size={14} />{contact.email}</p>}{contact.phone && <p><Phone size={14} />{contact.phone}</p>}{contact.department && <p><Building2 size={14} />{contact.department}</p>}<span className={`presence-label presence-text-${status}`}>{status === 'online' ? 'В сети' : 'Не в сети'}</span><footer><button className="button secondary small" onClick={() => void chat(contact)}><MessageSquareText size={16} />Сообщение</button><button className="icon-button call-button" onClick={() => void call(contact)} disabled={callingId === contact.id} title={`Позвонить: ${contact.displayName}`} aria-label={`Позвонить: ${contact.displayName}`}><Phone size={18} /></button></footer></article>
  })}</section><Modal open={addOpen} onClose={() => setAddOpen(false)} title="Добавить контакт"><div className="form-stack"><label><span>Email или номер телефона</span><input type="text" value={contactLookup} onChange={(event) => setContactLookup(event.target.value)} placeholder="name@company.com или +7 999 123-45-67" autoFocus /></label>{error && <p className="form-error">Пользователь с такими данными не найден.</p>}<footer className="modal-actions"><button className="button secondary" onClick={() => setAddOpen(false)}>Отмена</button><button className="button primary" onClick={() => void add()} disabled={!contactLookup.trim()}><Plus size={17} />Добавить</button></footer></div></Modal></div>
}
