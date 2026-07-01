export interface User {
  id: string
  phone?: string | null
  email: string | null
  displayName: string
  firstName?: string
  lastName?: string
  department?: string | null
  avatarUrl: string | null
  timezone: string
  locale: string
  status: 'online' | 'away' | 'busy' | 'offline'
}

export interface Attendee {
  email: string | null
  userId?: string
  displayName?: string | null
  avatarUrl?: string | null
  response: 'invited' | 'accepted' | 'declined' | 'tentative'
}

export interface Meeting {
  id: string
  hostId: string
  hostDisplayName?: string
  hostAvatarUrl?: string | null
  title: string
  description: string
  roomName: string
  startsAt: string
  endsAt: string
  timezone: string
  status: 'scheduled' | 'live' | 'ended' | 'cancelled'
  waitingRoom: boolean
  muteOnEntry: boolean
  allowJoinBeforeHost: boolean
  attendees: Attendee[]
}

export interface Contact extends User {
  alias?: string
}

export interface CallMessageMetadata {
  type: 'call'
  meetingId: string
  status: 'started' | 'ended' | 'declined' | 'missed'
  startedAt: string
  endedAt?: string
  durationMs?: number
  recordingUrl?: string
  recordingName?: string
}

export interface Attachment {
  id: string
  originalName: string
  mimeType: string
  byteSize: number
  durationMs?: number
  url: string
  storageProvider?: string
  storageKey?: string
}

export interface Message {
  id: string
  conversationId: string
  senderId: string
  senderName: string
  senderAvatarUrl: string | null
  kind: 'text' | 'file' | 'audio' | 'system'
  body?: string
  createdAt: string
  editedAt?: string | null
  deliveryStatus: 'delivered' | 'read'
  metadata: CallMessageMetadata | Record<string, unknown>
  attachments: Attachment[]
}

export interface DirectCallContext {
  conversationId: string
  messageId: string
  startedAt: string
}

export interface Conversation {
  id: string
  kind: 'direct' | 'group' | 'meeting'
  title: string
  avatarUrl: string | null
  updatedAt: string
  members: Array<User & { role?: 'owner' | 'admin' | 'member' }>
  currentUserRole: 'owner' | 'admin' | 'member'
  lastMessage: Pick<Message, 'id' | 'body' | 'kind' | 'createdAt' | 'senderId'> | null
  unreadCount: number
}

export interface ExchangeSettings {
  id?: string
  serverUrl: string
  email: string
  username: string
  domain: string
  authMethod: 'basic' | 'ntlm'
  verifyTls: boolean
  syncEnabled?: boolean
  lastSyncedAt?: string | null
  lastSyncError?: string | null
  password?: string
}
