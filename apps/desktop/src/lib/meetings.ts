import type { Meeting } from '../types'

export function isPastMeeting(meeting: Meeting, now = new Date()): boolean {
  return meeting.status === 'ended' || meeting.status === 'cancelled' || new Date(meeting.endsAt) < now
}

export function isScheduledMeeting(meeting: Meeting, now = new Date()): boolean {
  return meeting.status === 'scheduled' && !isPastMeeting(meeting, now)
}
