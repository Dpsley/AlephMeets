import { describe, expect, it } from 'vitest'
import { isScheduledMeeting } from './meetings'
import type { Meeting } from '../types'

const meeting = {
  id: 'meeting',
  hostId: 'user',
  title: 'Meeting',
  description: '',
  roomName: 'room',
  startsAt: '2030-01-01T10:00:00.000Z',
  endsAt: '2030-01-01T11:00:00.000Z',
  timezone: 'UTC',
  waitingRoom: false,
  muteOnEntry: false,
  allowJoinBeforeHost: true,
  attendees: [],
} satisfies Omit<Meeting, 'status'>

describe('meeting lists', () => {
  it('shows only explicitly scheduled meetings as upcoming', () => {
    expect(isScheduledMeeting({ ...meeting, status: 'scheduled' }, new Date('2029-01-01'))).toBe(true)
    expect(isScheduledMeeting({ ...meeting, status: 'live' }, new Date('2029-01-01'))).toBe(false)
    expect(isScheduledMeeting({ ...meeting, status: 'ended' }, new Date('2029-01-01'))).toBe(false)
  })
})
