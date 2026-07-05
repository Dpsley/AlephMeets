import type { Meeting, User } from '../types'

export function isPastMeeting(meeting: Meeting, now = new Date()): boolean {
  return meeting.status === 'ended' || meeting.status === 'cancelled' || new Date(meeting.endsAt) < now
}

export function isScheduledMeeting(meeting: Meeting, now = new Date()): boolean {
  return meeting.status === 'scheduled' && !isPastMeeting(meeting, now)
}

function normalizedEmail(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

export function isMeetingOwner(meeting: Meeting, user: User | null | undefined): boolean {
  if (!user) return false
  const ownerEmail = normalizedEmail(meeting.ownerEmail)
  if (ownerEmail) return ownerEmail === normalizedEmail(user.email)
  return meeting.hostId === user.id
}

export function canManageScheduledMeeting(
  meeting: Meeting,
  user: User | null | undefined,
  now = new Date(),
): boolean {
  return isScheduledMeeting(meeting, now) && isMeetingOwner(meeting, user)
}
