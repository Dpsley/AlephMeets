import { io, type Socket } from 'socket.io-client'
import { Check, CheckCheck, Download, FileText, Mic, Paperclip, Phone, Search, Send, Settings2, Square, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  ParticipantPicker,
  participantUserIds,
  type ParticipantSelection,
} from '../components/ParticipantPicker'
import { Avatar, EmptyState, Modal } from '../components/ui'
import { API_URL, api } from '../lib/api'
import { getAccessToken } from '../lib/auth'
import { relativeTime, shortTime } from '../lib/format'
import { ensureDesktopMediaAccess } from '../lib/media'
import { useApp } from '../state/AppContext'
import type { Attachment, CallMessageMetadata, Contact, Conversation, MeetingAnalysisMetadata, Message } from '../types'

function isCallMetadata(metadata: Message['metadata']): metadata is CallMessageMetadata {
  return metadata?.type === 'call'
}

function isMeetingAnalysisMetadata(metadata: Message['metadata']): metadata is MeetingAnalysisMetadata {
  return metadata?.type === 'meetingAnalysis'
}

function attachmentSize(bytes: number | string): string {
  const normalized = Number(bytes)
  const size = Number.isFinite(normalized) ? normalized : 0
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} МБ`
  return `${Math.max(1, Math.round(size / 1024))} КБ`
}

function isInlinePreviewAttachment(attachment: Pick<Attachment, 'mimeType'>): boolean {
  return attachment.mimeType.startsWith('image/')
    || attachment.mimeType.startsWith('audio/')
    || attachment.mimeType.startsWith('video/')
}

function isAudioChatAttachment(message: Message, attachment: Attachment): boolean {
  return message.kind === 'audio'
    || attachment.mimeType.startsWith('audio/')
    || /^voice-\d+\.webm$/i.test(attachment.originalName)
}

function recordingAttachment(message: Message, metadata: CallMessageMetadata): Pick<Attachment, 'url' | 'originalName'> | null {
  const attachedRecording = message.attachments.find((attachment) => (
    attachment.url
    && (
      attachment.originalName === metadata.recordingName
      || attachment.mimeType.startsWith('audio/')
      || attachment.mimeType.startsWith('video/')
    )
  ))
  if (attachedRecording) return attachedRecording
  return metadata.recordingUrl
    ? { url: metadata.recordingUrl, originalName: metadata.recordingName ?? 'recording.webm' }
    : null
}

function transcriptAttachment(message: Message, metadata: CallMessageMetadata): Pick<Attachment, 'url' | 'originalName'> | null {
  const attachedTranscript = message.attachments.find((attachment) => (
    attachment.url
    && (
      attachment.originalName === metadata.transcriptName
      || attachment.mimeType.startsWith('text/')
    )
  ))
  if (attachedTranscript) return attachedTranscript
  return metadata.transcriptUrl
    ? { url: metadata.transcriptUrl, originalName: metadata.transcriptName ?? 'transcript.txt' }
    : null
}

function contactParticipant(contact: Contact): ParticipantSelection {
  return {
    userId: contact.id,
    email: contact.email,
    displayName: contact.displayName,
    avatarUrl: contact.avatarUrl,
  }
}

function participantsFromIds(contacts: readonly Contact[], ids: readonly string[]): ParticipantSelection[] {
  const byId = new Map(contacts.map((contact) => [contact.id, contact]))
  return ids.map((id) => {
    const contact = byId.get(id)
    return contact ? contactParticipant(contact) : { userId: id, displayName: 'Участник' }
  })
}

export function ChatPage(): React.JSX.Element {
  const location = useLocation()
  const { user, presenceByUserId, startDirectCall } = useApp()
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
  const [attachmentMessage, setAttachmentMessage] = useState<Message | null>(null)
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [createDirectOpen, setCreateDirectOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [manageGroupOpen, setManageGroupOpen] = useState(false)
  const [directMembers, setDirectMembers] = useState<ParticipantSelection[]>([])
  const [directSaving, setDirectSaving] = useState(false)
  const [directError, setDirectError] = useState<string | null>(null)
  const [groupTitle, setGroupTitle] = useState('')
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([])
  const [groupAddMemberIds, setGroupAddMemberIds] = useState<string[]>([])
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
    setContactsLoading(true)
    void api.contacts()
      .then((result) => setContacts(result.contacts))
      .catch(() => setContacts([]))
      .finally(() => setContactsLoading(false))
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
    socket.on('message:updated', (message: Message) => {
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, ...message } : item))
      setAttachmentMessage((current) => current?.id === message.id ? { ...current, ...message } : current)
      void loadConversations()
    })
    socket.on('conversation:read', (read: { conversationId: string; userId: string }) => {
      if (read.userId !== user?.id && read.conversationId === selectedIdRef.current) {
        void api.messages(read.conversationId).then((result) => setMessages(result.messages))
      }
    })
    const handleConversationsUpdated = (): void => { void loadConversations() }
    window.addEventListener('aleph:conversations-updated', handleConversationsUpdated)
    return () => {
      window.removeEventListener('aleph:conversations-updated', handleConversationsUpdated)
      socket.disconnect()
    }
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
  const directStatus = directContact
    ? presenceByUserId[directContact.id] ?? directContact.status
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
  const currentUserIds = user?.id ? [user.id] : []
  const groupParticipants = useMemo(
    () => participantsFromIds(contacts, groupMemberIds),
    [contacts, groupMemberIds],
  )
  const groupAddParticipants = useMemo(
    () => participantsFromIds(contacts, groupAddMemberIds),
    [contacts, groupAddMemberIds],
  )
  const groupMemberExcludeIds = useMemo(
    () => selected?.kind === 'group' ? selected.members.map((member) => member.id) : [],
    [selected],
  )

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
    setCallError(null)
    let stream: MediaStream
    try {
      await ensureDesktopMediaAccess(['microphone'])
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : 'Не удалось получить доступ к микрофону.')
      return
    }
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

  const downloadCallAttachment = async (attachment: Pick<Attachment, 'url' | 'originalName'>): Promise<void> => {
    setCallError(null)
    try {
      if (window.alephDesktop?.downloadFile) {
        await window.alephDesktop.downloadFile(attachment.url, attachment.originalName)
      } else {
        window.open(attachment.url, '_blank', 'noopener')
      }
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : 'Не удалось скачать файл звонка.')
    }
  }

  const openAttachmentExternal = (attachment: Pick<Attachment, 'url'>): void => {
    if (attachment.url) window.open(attachment.url, '_blank', 'noopener')
  }

  const renderAttachmentPreview = (attachment: Attachment): React.JSX.Element => {
    if (attachment.mimeType.startsWith('image/')) {
      return <img className="attachment-preview-image" src={attachment.url} alt={attachment.originalName} />
    }
    if (attachment.mimeType.startsWith('audio/')) {
      return <audio className="attachment-preview-media" controls src={attachment.url} />
    }
    if (attachment.mimeType.startsWith('video/')) {
      return <video className="attachment-preview-video" controls src={attachment.url} />
    }
    if (attachment.mimeType === 'application/pdf' || attachment.mimeType.startsWith('text/')) {
      return <iframe className="attachment-preview-frame" title={attachment.originalName} src={attachment.url} />
    }
    return (
      <div className="attachment-preview-empty">
        <FileText size={34} />
        <strong>{attachment.originalName}</strong>
        <small>Для этого типа файла доступно только скачивание.</small>
      </div>
    )
  }

  const openCreateDirect = (): void => {
    setDirectMembers([])
    setDirectError(null)
    setCreateDirectOpen(true)
  }

  const createDirectChat = async (): Promise<void> => {
    const memberId = participantUserIds(directMembers)[0]
    if (!memberId || directSaving) return
    setDirectSaving(true)
    setDirectError(null)
    try {
      const result = await api.createConversation([memberId])
      await loadConversations()
      setSelectedId(result.conversation.id)
      setCreateDirectOpen(false)
    } catch (reason) {
      setDirectError(reason instanceof Error ? reason.message : 'Не удалось создать чат.')
    } finally {
      setDirectSaving(false)
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
    setGroupAddMemberIds([])
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

  const addGroupMembers = async (): Promise<void> => {
    if (!selected) return
    const memberIds = groupAddMemberIds.filter((id) => !selected.members.some((member) => member.id === id))
    if (!memberIds.length) return
    setGroupError(null)
    try {
      await api.addConversationMembers(selected.id, memberIds)
      setGroupAddMemberIds([])
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
        <header><div><p className="eyebrow">Сообщения</p><h1>Чаты</h1></div><button className="icon-button" onClick={openCreateDirect} title="Создать чат" aria-label="Создать чат"><Users size={19} /></button></header>
        <div className="search-box chat-search"><button className="search-trigger" onClick={() => conversationSearchRef.current?.focus()} title="Поиск по чатам" aria-label="Поиск по чатам"><Search size={17} /></button><input ref={conversationSearchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск" /></div>
        <button className="group-create-button" onClick={openCreateGroup}><UserPlus size={18} />Создать групповой чат</button>
        <div className="conversation-list">
          {filtered.map((conversation) => <button key={conversation.id} className={selectedId === conversation.id ? 'active' : ''} onClick={() => setSelectedId(conversation.id)}><Avatar name={conversation.title || 'Чат'} src={conversation.kind === 'direct' ? conversation.members.find((member) => member.id !== user?.id)?.avatarUrl : conversation.avatarUrl} size="large" /><div className="conversation-copy"><div><strong>{conversation.title || 'Диалог'}</strong><time>{conversation.lastMessage ? relativeTime(conversation.lastMessage.createdAt) : ''}</time></div><p>{conversation.lastMessage?.kind === 'audio' ? 'Голосовое сообщение' : conversation.lastMessage?.kind === 'file' ? 'Вложение' : conversation.lastMessage?.body ?? 'Нет сообщений'}</p></div>{conversation.unreadCount > 0 && <span className="unread-badge">{conversation.unreadCount}</span>}</button>)}
        </div>
      </aside>
      <section className="chat-main">
        {selected ? <>
          <header className="chat-header"><div><Avatar name={selected.title || 'Чат'} src={directContact?.avatarUrl ?? selected.avatarUrl} status={directStatus} /><div><h2>{selected.title}</h2><span className={selected.kind === 'direct' ? `chat-presence-${directStatus ?? 'offline'}` : ''}>{selected.kind === 'group' ? `${selected.members.length} участников` : directStatus === 'online' ? 'В сети' : 'Не в сети'}</span></div></div><div><button className={`icon-button ${messageSearchOpen ? 'active' : ''}`} onClick={() => setMessageSearchOpen((open) => !open)} title="Поиск по сообщениям" aria-label="Поиск по сообщениям"><Search size={19} /></button>{selected.kind === 'group' && selected.currentUserRole === 'owner' && <button className="icon-button" onClick={openGroupManagement} title="Управление группой" aria-label="Управление группой"><Settings2 size={19} /></button>}{directContact && <button className="icon-button call-button" onClick={() => void startCall()} disabled={calling} title={`Позвонить: ${directContact.displayName}`} aria-label={`Позвонить: ${directContact.displayName}`}><Phone size={19} /></button>}</div></header>
          {messageSearchOpen && <div className="message-search-bar"><Search size={18} /><input value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Поиск по сообщениям" autoFocus /><button className="icon-button" onClick={() => { setMessageSearch(''); setMessageSearchOpen(false) }} title="Закрыть поиск"><X size={17} /></button></div>}
          {callError && <div className="chat-call-error">{callError}</div>}
          <div className="message-scroll">
            <div className="message-date"><span>Сегодня</span></div>
            {visibleMessages.map((message) => {
              const own = message.senderId === user?.id
              const callMetadata = message.kind === 'system' && isCallMetadata(message.metadata)
                ? message.metadata
                : null
              const analysisMetadata = message.kind === 'system' && isMeetingAnalysisMetadata(message.metadata)
                ? message.metadata
                : null
              if (callMetadata) {
                const hasAttachments = message.attachments.length > 0 || callMetadata.analysisPending
                return <div className="call-history-message" key={message.id}><span><Phone size={18} /></span><div><strong>{own ? 'Исходящий звонок' : 'Входящий звонок'}</strong><small>{message.body || 'Звонок'}</small>{hasAttachments && <button className="call-materials-button" type="button" onClick={() => setAttachmentMessage(message)} title="Материалы встречи" aria-label="Материалы встречи"><Paperclip size={16} />{message.attachments.length > 0 && <span>{message.attachments.length}</span>}</button>}</div><time>{shortTime(message.createdAt)}</time></div>
              }
              if (analysisMetadata) {
                return null
              }
              const attachments = message.attachments ?? []
              const hasVisualAttachment = attachments.some((attachment) => (
                !isAudioChatAttachment(message, attachment)
                && (attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('video/'))
              ))
              const hasAudioOnlyAttachment = !message.body && attachments.length > 0
                && attachments.every((attachment) => isAudioChatAttachment(message, attachment))
              const messageBodyClass = [
                'message-body',
                hasVisualAttachment ? 'message-body-media' : '',
                hasAudioOnlyAttachment ? 'message-body-audio' : '',
              ].filter(Boolean).join(' ')
              return <div className={`message ${own ? 'own' : ''}`} key={message.id}>
                {!own && <Avatar name={message.senderName || 'User'} src={message.senderAvatarUrl} size="small" />}
                <div className={messageBodyClass}>
                  {!own && <strong>{message.senderName}</strong>}
                  {message.body && <p>{message.body}</p>}
                  {attachments.map((attachment) => {
                    if (isAudioChatAttachment(message, attachment)) {
                      return <audio className="audio-attachment" controls src={attachment.url} key={attachment.id} />
                    }
                    if (attachment.mimeType.startsWith('image/')) {
                      return <button className="image-attachment-link" type="button" onClick={() => setPreviewAttachment(attachment)} key={attachment.id}><img className="image-attachment" src={attachment.url} alt={attachment.originalName} loading="lazy" /></button>
                    }
                    if (attachment.mimeType.startsWith('video/')) {
                      return <video className="video-attachment" controls preload="metadata" src={attachment.url} key={attachment.id} />
                    }
                    return <button className="file-attachment" type="button" onClick={() => openAttachmentExternal(attachment)} key={attachment.id}><span><FileText size={20} /></span><div><strong>{attachment.originalName}</strong><small>{attachmentSize(attachment.byteSize)}</small></div></button>
                  })}
                  <span className="message-meta"><time>{shortTime(message.createdAt)}</time>{own && (message.deliveryStatus === 'read' ? <CheckCheck aria-label="Прочитано" /> : <Check aria-label="Доставлено" />)}</span>
                </div>
              </div>
            })}
            <div ref={bottomRef} />
          </div>
          <footer className="composer"><input ref={fileRef} hidden type="file" onChange={(event) => event.target.files?.[0] && void uploadFile(event.target.files[0])} /><button className="icon-button" onClick={() => fileRef.current?.click()}><Paperclip size={20} /></button><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="Напишите сообщение..." rows={1} /><button className={`icon-button record-button ${recording ? 'recording' : ''}`} onClick={() => void toggleRecording()}>{recording ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}</button><button className="send-button" onClick={() => void send()} disabled={!draft.trim()}><Send size={19} /></button></footer>
        </> : <EmptyState icon={<Users />} title="Выберите чат" text="Переписки и файлы появятся здесь." />}
      </section>
    </div>
    <Modal open={Boolean(attachmentMessage)} onClose={() => setAttachmentMessage(null)} title="Вложения встречи" width={440}>
      <div className="call-attachments-list">
        {attachmentMessage?.attachments.map((attachment) => (
          <div
            role="button"
            tabIndex={0}
            className="call-attachment-row"
            key={attachment.id}
            onClick={() => {
              if (isInlinePreviewAttachment(attachment)) setPreviewAttachment(attachment)
              else openAttachmentExternal(attachment)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                if (isInlinePreviewAttachment(attachment)) setPreviewAttachment(attachment)
                else openAttachmentExternal(attachment)
              }
            }}
          >
            <span><FileText size={18} /></span>
            <div>
              <strong>{attachment.originalName}</strong>
              <small>{isInlinePreviewAttachment(attachment) ? 'Просмотр и скачивание' : 'Открытие и скачивание'} - {attachmentSize(attachment.byteSize)}</small>
            </div>
            <button
              type="button"
              className="attachment-row-download"
              title="Скачать"
              aria-label="Скачать"
              onClick={(event) => {
                event.stopPropagation()
                void downloadCallAttachment(attachment)
              }}
            >
              <Download size={16} />
            </button>
          </div>
        ))}
        {attachmentMessage && isCallMetadata(attachmentMessage.metadata) && attachmentMessage.metadata.analysisPending && (
          <button type="button" className="call-attachment-row pending" disabled>
            <span><FileText size={18} /></span>
            <div>
              <strong>Конспект встречи</strong>
              <small>Алефа формирует конспект, файл появится здесь автоматически.</small>
            </div>
            <Download size={16} />
          </button>
        )}
        {attachmentMessage && isCallMetadata(attachmentMessage.metadata) && attachmentMessage.metadata.analysisError && (
          <p className="form-error">{attachmentMessage.metadata.analysisError}</p>
        )}
        {attachmentMessage && !attachmentMessage.attachments.length && !(isCallMetadata(attachmentMessage.metadata) && attachmentMessage.metadata.analysisPending) && (
          <p className="soft-empty">Вложений пока нет.</p>
        )}
      </div>
    </Modal>
    <Modal open={Boolean(previewAttachment)} onClose={() => setPreviewAttachment(null)} title={previewAttachment?.originalName ?? 'Вложение'} width={780}>
      {previewAttachment && (
        <div className="attachment-preview">
          {renderAttachmentPreview(previewAttachment)}
          <footer>
            <span>{previewAttachment.mimeType || 'application/octet-stream'} - {attachmentSize(previewAttachment.byteSize)}</span>
            <button className="button primary" type="button" onClick={() => void downloadCallAttachment(previewAttachment)}>
              <Download size={16} />Скачать
            </button>
          </footer>
        </div>
      )}
    </Modal>
    <Modal open={createDirectOpen} onClose={() => setCreateDirectOpen(false)} title="Создать чат" width={560} className="participant-picker-modal">
      <div className="form-stack">
        <ParticipantPicker
          label="Собеседник"
          contacts={contacts}
          contactsLoading={contactsLoading}
          contactOnly
          excludeUserIds={currentUserIds}
          max={1}
          placeholder="Начните вводить имя, телефон или email"
          value={directMembers}
          onChange={setDirectMembers}
        />
        {!contactsLoading && !contacts.length && <p className="group-empty">Сначала добавьте пользователей в контакты.</p>}
        {directError && <p className="form-error">{directError}</p>}
        <footer className="modal-actions">
          <button className="button secondary" onClick={() => setCreateDirectOpen(false)}>Отмена</button>
          <button className="button primary" onClick={() => void createDirectChat()} disabled={!participantUserIds(directMembers).length || directSaving}>{directSaving ? 'Создание...' : 'Создать'}</button>
        </footer>
      </div>
    </Modal>
    <Modal open={createGroupOpen} onClose={() => setCreateGroupOpen(false)} title="Создать групповой чат" width={560} className="participant-picker-modal">
      <div className="form-stack">
        <label><span>Название группы</span><input value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} maxLength={150} autoFocus placeholder="Например, Команда проекта" /></label>
        <ParticipantPicker
          contacts={contacts}
          contactsLoading={contactsLoading}
          contactOnly
          excludeUserIds={currentUserIds}
          placeholder="Начните вводить имя, телефон или email"
          value={groupParticipants}
          onChange={(participants) => setGroupMemberIds(participantUserIds(participants))}
        />
        {!contactsLoading && !contacts.length && <p className="group-empty">Сначала добавьте пользователей в контакты.</p>}
        {groupError && <p className="form-error">{groupError}</p>}
        <footer className="modal-actions"><button className="button secondary" onClick={() => setCreateGroupOpen(false)}>Отмена</button><button className="button primary" onClick={() => void createGroup()} disabled={!groupTitle.trim() || !groupMemberIds.length || groupSaving}>{groupSaving ? 'Создание...' : 'Создать'}</button></footer>
      </div>
    </Modal>
    <Modal open={manageGroupOpen} onClose={() => setManageGroupOpen(false)} title="Управление группой" width={560} className="participant-picker-modal">
      {selected?.kind === 'group' && <div className="form-stack">
        <label><span>Название группы</span><div className="group-title-editor"><input value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} maxLength={150} /><button className="button secondary" onClick={() => void renameGroup()} disabled={!groupTitle.trim() || groupSaving}>Сохранить</button></div></label>
        <div className="group-management-list"><strong>Участники</strong>{selected.members.map((member) => <div className="group-management-row" key={member.id}><div className="group-member-avatar"><Avatar name={member.displayName} src={member.avatarUrl} size="small" /></div><span className="group-member-copy">{member.displayName}<small>{member.role === 'owner' ? 'Владелец' : member.email || member.phone || 'Контакт Aleph ID'}</small></span>{member.role !== 'owner' && <button className="icon-button danger" onClick={() => void removeGroupMember(member.id)} title="Удалить участника"><UserMinus size={17} /></button>}</div>)}</div>
        <div className="group-management-list">
          <ParticipantPicker
            label="Добавить участника"
            contacts={contacts}
            contactsLoading={contactsLoading}
            contactOnly
            excludeUserIds={groupMemberExcludeIds}
            placeholder="Начните вводить имя, телефон или email"
            value={groupAddParticipants}
            onChange={(participants) => setGroupAddMemberIds(participantUserIds(participants))}
          />
          {!contactsLoading && !contacts.length && <p className="group-empty">Сначала добавьте пользователей в контакты.</p>}
          {contacts.length > 0 && contacts.every((contact) => selected.members.some((member) => member.id === contact.id)) && <p className="group-empty">Все контакты уже добавлены.</p>}
          <button className="button secondary" onClick={() => void addGroupMembers()} disabled={!groupAddMemberIds.length}>Добавить выбранных</button>
        </div>
        {groupError && <p className="form-error">{groupError}</p>}
      </div>}
    </Modal>
    </>
  )
}
