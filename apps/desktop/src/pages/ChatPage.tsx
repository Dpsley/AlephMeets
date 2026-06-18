import { io, type Socket } from 'socket.io-client'
import { FileText, Mic, Paperclip, Phone, Search, Send, Settings2, Square, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Avatar, EmptyState, Modal } from '../components/ui'
import { API_URL, api } from '../lib/api'
import { getAccessToken } from '../lib/auth'
import { relativeTime, shortTime } from '../lib/format'
import { useApp } from '../state/AppContext'
import type { Contact, Conversation, Message } from '../types'

export function ChatPage(): React.JSX.Element {
  const location = useLocation()
  const { user, startDirectCall } = useApp()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [messageSearchOpen, setMessageSearchOpen] = useState(false)
  const [messageSearch, setMessageSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const [calling, setCalling] = useState(false)
  const [callError, setCallError] = useState<string | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [manageGroupOpen, setManageGroupOpen] = useState(false)
  const [groupTitle, setGroupTitle] = useState('')
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([])
  const [groupSaving, setGroupSaving] = useState(false)
  const [groupError, setGroupError] = useState<string | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordStartedAt = useRef(0)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const conversationSearchRef = useRef<HTMLInputElement | null>(null)

  const loadConversations = async (): Promise<Conversation[]> => {
    const result = await api.conversations()
    setConversations(result.conversations)
    setSelectedId((current) => (
      current && result.conversations.some((conversation) => conversation.id === current)
        ? current
        : result.conversations[0]?.id ?? null
    ))
    return result.conversations
  }

  useEffect(() => {
    void loadConversations()
    void api.contacts().then((result) => setContacts(result.contacts))
    const socket = io(API_URL, {
      transports: ['websocket'],
      auth: (callback) => callback({ token: getAccessToken() }),
    })
    socketRef.current = socket
    socket.on('message:new', (message: Message) => {
      if (message.conversationId === selectedIdRef.current) {
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
        setConversations((current) => current.map((conversation) => (
          conversation.id === message.conversationId
            ? { ...conversation, unreadCount: 0, lastMessage: message }
            : conversation
        )))
        void api.markConversationRead(message.conversationId)
      } else {
        void loadConversations()
      }
    })
    socket.on('conversation:updated', () => void loadConversations())
    return () => { socket.disconnect() }
  }, [])

  useEffect(() => {
    if (!selectedId) return
    selectedIdRef.current = selectedId
    setMessages([])
    setMessageSearch('')
    setMessageSearchOpen(false)
    setConversations((current) => current.map((conversation) => (
      conversation.id === selectedId ? { ...conversation, unreadCount: 0 } : conversation
    )))
    void api.messages(selectedId).then((result) => setMessages(result.messages))
    socketRef.current?.emit('conversation:join', selectedId)
    return () => {
      socketRef.current?.emit('conversation:leave', selectedId)
      if (selectedIdRef.current === selectedId) selectedIdRef.current = null
    }
  }, [selectedId])

  useEffect(() => {
    const requestedId = (location.state as { conversationId?: string } | null)?.conversationId
    if (requestedId) setSelectedId(requestedId)
  }, [location.state])

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages])

  const selected = conversations.find((item) => item.id === selectedId)
  const directContact = selected?.kind === 'direct'
    ? selected.members.find((member) => member.id !== user?.id)
    : undefined
  const filtered = conversations.filter((item) => item.title?.toLowerCase().includes(search.toLowerCase()))
  const visibleMessages = messageSearch.trim()
    ? messages.filter((message) => {
      const query = messageSearch.trim().toLowerCase()
      return [
        message.body,
        message.senderName,
        ...message.attachments.map((attachment) => attachment.originalName),
      ].some((value) => value?.toLowerCase().includes(query))
    })
    : messages

  const send = async (): Promise<void> => {
    if (!selectedId || !draft.trim() || sending) return
    const body = draft.trim()
    setDraft('')
    setSending(true)
    try {
      const result = await api.sendMessage(selectedId, body)
      setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message])
      void loadConversations()
    } finally {
      setSending(false)
    }
  }

  const uploadFile = async (file: File): Promise<void> => {
    if (!selectedId) return
    const result = await api.upload(selectedId, file, file.name)
    setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message])
  }

  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      recorderRef.current?.stop()
      setRecording(false)
      return
    }
    if (!selectedId) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const chunks: Blob[] = []
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined })
    recorderRef.current = recorder
    recordStartedAt.current = Date.now()
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data)
    recorder.onstop = () => {
      const duration = Date.now() - recordStartedAt.current
      const blob = new Blob(chunks, { type: recorder.mimeType })
      stream.getTracks().forEach((track) => track.stop())
      void api.upload(selectedId, blob, `voice-${Date.now()}.webm`, 'audio', duration).then((result) => {
        setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message])
      })
    }
    recorder.start()
    setRecording(true)
  }

  const startCall = async (): Promise<void> => {
    if (!directContact || !user || calling) return
    setCalling(true)
    setCallError(null)
    try {
      await startDirectCall(directContact)
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : 'Не удалось начать звонок.')
    } finally {
      setCalling(false)
    }
  }

  const openCreateGroup = (): void => {
    setGroupTitle('')
    setGroupMemberIds([])
    setGroupError(null)
    setCreateGroupOpen(true)
  }

  const createGroup = async (): Promise<void> => {
    if (!groupTitle.trim() || !groupMemberIds.length || groupSaving) return
    setGroupSaving(true)
    setGroupError(null)
    try {
      const result = await api.createConversation(groupMemberIds, groupTitle.trim())
      await loadConversations()
      setSelectedId(result.conversation.id)
      setCreateGroupOpen(false)
    } catch (reason) {
      setGroupError(reason instanceof Error ? reason.message : 'Не удалось создать группу.')
    } finally {
      setGroupSaving(false)
    }
  }

  const openGroupManagement = (): void => {
    if (!selected || selected.kind !== 'group') return
    setGroupTitle(selected.title)
    setGroupError(null)
    setManageGroupOpen(true)
  }

  const renameGroup = async (): Promise<void> => {
    if (!selected || !groupTitle.trim() || groupSaving) return
    setGroupSaving(true)
    setGroupError(null)
    try {
      await api.renameConversation(selected.id, groupTitle.trim())
      await loadConversations()
    } catch (reason) {
      setGroupError(reason instanceof Error ? reason.message : 'Не удалось изменить название.')
    } finally {
      setGroupSaving(false)
    }
  }

  const addGroupMember = async (memberId: string): Promise<void> => {
    if (!selected) return
    setGroupError(null)
    try {
      await api.addConversationMembers(selected.id, [memberId])
      await loadConversations()
    } catch (reason) {
      setGroupError(reason instanceof Error ? reason.message : 'Не удалось добавить участника.')
    }
  }

  const removeGroupMember = async (memberId: string): Promise<void> => {
    if (!selected) return
    setGroupError(null)
    try {
      await api.removeConversationMember(selected.id, memberId)
      await loadConversations()
    } catch (reason) {
      setGroupError(reason instanceof Error ? reason.message : 'Не удалось удалить участника.')
    }
  }

  return (
    <>
    <div className="chat-layout">
      <aside className="conversation-sidebar">
        <header><div><p className="eyebrow">Сообщения</p><h1>Чаты</h1></div><button className="icon-button"><Users size={19} /></button></header>
        <div className="search-box chat-search"><button className="search-trigger" onClick={() => conversationSearchRef.current?.focus()} title="Поиск по чатам" aria-label="Поиск по чатам"><Search size={17} /></button><input ref={conversationSearchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск" /></div>
        <button className="group-create-button" onClick={openCreateGroup}><UserPlus size={18} />Создать групповой чат</button>
        <div className="conversation-list">
          {filtered.map((conversation) => <button key={conversation.id} className={selectedId === conversation.id ? 'active' : ''} onClick={() => setSelectedId(conversation.id)}><Avatar name={conversation.title || 'Чат'} size="large" /><div className="conversation-copy"><div><strong>{conversation.title || 'Диалог'}</strong><time>{conversation.lastMessage ? relativeTime(conversation.lastMessage.createdAt) : ''}</time></div><p>{conversation.lastMessage?.kind === 'audio' ? 'Голосовое сообщение' : conversation.lastMessage?.kind === 'file' ? 'Вложение' : conversation.lastMessage?.body ?? 'Нет сообщений'}</p></div>{conversation.unreadCount > 0 && <span className="unread-badge">{conversation.unreadCount}</span>}</button>)}
        </div>
      </aside>
      <section className="chat-main">
        {selected ? <>
          <header className="chat-header"><div><Avatar name={selected.title || 'Чат'} status={directContact?.status} /><div><h2>{selected.title}</h2><span>{selected.kind === 'group' ? `${selected.members.length} участников` : 'В сети'}</span></div></div><div><button className={`icon-button ${messageSearchOpen ? 'active' : ''}`} onClick={() => setMessageSearchOpen((open) => !open)} title="Поиск по сообщениям" aria-label="Поиск по сообщениям"><Search size={19} /></button>{selected.kind === 'group' && selected.currentUserRole === 'owner' && <button className="icon-button" onClick={openGroupManagement} title="Управление группой" aria-label="Управление группой"><Settings2 size={19} /></button>}{directContact && <button className="icon-button call-button" onClick={() => void startCall()} disabled={calling} title={`Позвонить: ${directContact.displayName}`} aria-label={`Позвонить: ${directContact.displayName}`}><Phone size={19} /></button>}</div></header>
          {messageSearchOpen && <div className="message-search-bar"><Search size={18} /><input value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Поиск по сообщениям" autoFocus /><button className="icon-button" onClick={() => { setMessageSearch(''); setMessageSearchOpen(false) }} title="Закрыть поиск"><X size={17} /></button></div>}
          {callError && <div className="chat-call-error">{callError}</div>}
          <div className="message-scroll">
            <div className="message-date"><span>Сегодня</span></div>
            {visibleMessages.map((message) => {
              const own = message.senderId === user?.id
              return <div className={`message ${own ? 'own' : ''}`} key={message.id}>{!own && <Avatar name={message.senderName || 'User'} src={message.senderAvatarUrl} size="small" />}<div className="message-body">{!own && <strong>{message.senderName}</strong>}{message.body && <p>{message.body}</p>}{message.attachments?.map((attachment) => attachment.mimeType.startsWith('audio/') ? <audio controls src={attachment.url} key={attachment.id} /> : <a className="file-attachment" href={attachment.url} target="_blank" rel="noreferrer" key={attachment.id}><span><FileText size={20} /></span><div><strong>{attachment.originalName}</strong><small>{Math.max(1, Math.round(attachment.byteSize / 1024))} КБ</small></div></a>)}<time>{shortTime(message.createdAt)}</time></div></div>
            })}
            <div ref={bottomRef} />
          </div>
          <footer className="composer"><input ref={fileRef} hidden type="file" onChange={(event) => event.target.files?.[0] && void uploadFile(event.target.files[0])} /><button className="icon-button" onClick={() => fileRef.current?.click()}><Paperclip size={20} /></button><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="Напишите сообщение..." rows={1} /><button className={`icon-button record-button ${recording ? 'recording' : ''}`} onClick={() => void toggleRecording()}>{recording ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}</button><button className="send-button" onClick={() => void send()} disabled={!draft.trim()}><Send size={19} /></button></footer>
        </> : <EmptyState icon={<Users />} title="Выберите чат" text="Переписки и файлы появятся здесь." />}
      </section>
    </div>
    <Modal open={createGroupOpen} onClose={() => setCreateGroupOpen(false)} title="Создать групповой чат" width={480}>
      <div className="form-stack">
        <label><span>Название группы</span><input value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} maxLength={150} autoFocus placeholder="Например, Команда проекта" /></label>
        <div className="group-member-picker">
          <strong>Участники</strong>
          {contacts.map((contact) => <label key={contact.id} className="group-member-option"><input type="checkbox" checked={groupMemberIds.includes(contact.id)} onChange={() => setGroupMemberIds((current) => current.includes(contact.id) ? current.filter((id) => id !== contact.id) : [...current, contact.id])} /><div className="group-member-avatar"><Avatar name={contact.displayName} src={contact.avatarUrl} size="small" /></div><span className="group-member-copy">{contact.displayName}<small>{contact.email}</small></span></label>)}
          {!contacts.length && <p className="group-empty">Сначала добавьте пользователей в контакты.</p>}
        </div>
        {groupError && <p className="form-error">{groupError}</p>}
        <footer className="modal-actions"><button className="button secondary" onClick={() => setCreateGroupOpen(false)}>Отмена</button><button className="button primary" onClick={() => void createGroup()} disabled={!groupTitle.trim() || !groupMemberIds.length || groupSaving}>{groupSaving ? 'Создание...' : 'Создать'}</button></footer>
      </div>
    </Modal>
    <Modal open={manageGroupOpen} onClose={() => setManageGroupOpen(false)} title="Управление группой" width={520}>
      {selected?.kind === 'group' && <div className="form-stack">
        <label><span>Название группы</span><div className="group-title-editor"><input value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} maxLength={150} /><button className="button secondary" onClick={() => void renameGroup()} disabled={!groupTitle.trim() || groupSaving}>Сохранить</button></div></label>
        <div className="group-management-list"><strong>Участники</strong>{selected.members.map((member) => <div className="group-management-row" key={member.id}><div className="group-member-avatar"><Avatar name={member.displayName} src={member.avatarUrl} size="small" /></div><span className="group-member-copy">{member.displayName}<small>{member.role === 'owner' ? 'Владелец' : member.email}</small></span>{member.role !== 'owner' && <button className="icon-button danger" onClick={() => void removeGroupMember(member.id)} title="Удалить участника"><UserMinus size={17} /></button>}</div>)}</div>
        <div className="group-management-list"><strong>Добавить участника</strong>{contacts.filter((contact) => !selected.members.some((member) => member.id === contact.id)).map((contact) => <div className="group-management-row" key={contact.id}><div className="group-member-avatar"><Avatar name={contact.displayName} src={contact.avatarUrl} size="small" /></div><span className="group-member-copy">{contact.displayName}<small>{contact.email}</small></span><button className="icon-button accent" onClick={() => void addGroupMember(contact.id)} title="Добавить участника"><UserPlus size={17} /></button></div>)}{contacts.every((contact) => selected.members.some((member) => member.id === contact.id)) && <p className="group-empty">Все контакты уже добавлены.</p>}</div>
        {groupError && <p className="form-error">{groupError}</p>}
      </div>}
    </Modal>
    </>
  )
}
