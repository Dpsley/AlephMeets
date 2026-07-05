import { Crown } from 'lucide-react'
import type { Attendee } from '../types'
import { Avatar } from './ui'

export interface MeetingOwnerInfo {
  userId?: string | null
  email?: string | null
  displayName?: string | null
  avatarUrl?: string | null
}

function attendeeLabel(attendee: Attendee): string {
  return attendee.displayName || attendee.email || 'Участник'
}

function attendeeMeta(attendee: Attendee): string {
  return attendee.email && attendee.displayName ? attendee.email : ''
}

function attendeePosition(attendee: Attendee): string {
  return attendee.position?.trim() ?? ''
}

function attendeeDepartment(attendee: Attendee): string {
  return attendee.department?.trim() ?? ''
}

function ownerToAttendee(owner: MeetingOwnerInfo | undefined): Attendee | null {
  if (!owner || (!owner.userId && !owner.email && !owner.displayName)) return null
  return {
    userId: owner.userId ?? undefined,
    email: owner.email ?? null,
    displayName: owner.displayName,
    avatarUrl: owner.avatarUrl,
    response: 'accepted',
  }
}

function sameParticipant(left: Attendee, right: Attendee): boolean {
  if (left.userId && right.userId && left.userId === right.userId) return true
  const leftEmail = left.email?.trim().toLowerCase()
  const rightEmail = right.email?.trim().toLowerCase()
  return Boolean(leftEmail && rightEmail && leftEmail === rightEmail)
}

function participantsWithOwner(attendees: Attendee[], owner: MeetingOwnerInfo | undefined): Attendee[] {
  const ownerAttendee = ownerToAttendee(owner)
  if (!ownerAttendee) return attendees
  const withoutOwner = attendees.filter((attendee) => !sameParticipant(attendee, ownerAttendee))
  return [ownerAttendee, ...withoutOwner]
}

export function meetingParticipantsCount(attendees: Attendee[], owner?: MeetingOwnerInfo): number {
  return participantsWithOwner(attendees, owner).length
}

export function MeetingParticipantsPopover({
  attendees,
  owner,
}: {
  attendees: Attendee[]
  owner?: MeetingOwnerInfo
}): React.JSX.Element {
  const ownerAttendee = ownerToAttendee(owner)
  const participants = participantsWithOwner(attendees, owner)
  return (
    <span className="meeting-participants-popover" role="tooltip">
      <strong>Участники</strong>
      {participants.length ? participants.map((attendee, index) => {
        const isOwner = ownerAttendee ? sameParticipant(attendee, ownerAttendee) : false
        return (
          <span className="meeting-participant-row" key={`${attendee.userId ?? attendee.email ?? index}`}>
            <Avatar name={attendeeLabel(attendee)} src={attendee.avatarUrl} size="small" />
            <span className="meeting-participant-copy">
              <span>
                {attendeeLabel(attendee)}
                {isOwner && <Crown className="meeting-owner-crown" size={14} aria-label="Создатель встречи" />}
              </span>
              {attendeeMeta(attendee) && <small>{attendeeMeta(attendee)}</small>}
              {attendeePosition(attendee) && <small>{attendeePosition(attendee)}</small>}
              {attendeeDepartment(attendee) && <small>{attendeeDepartment(attendee)}</small>}
            </span>
          </span>
        )
      }) : <small>Участники не указаны</small>}
    </span>
  )
}
