import type { DirectCallContext, Meeting } from '../types'

export interface MeetingWindowContext {
  meeting?: Meeting
  callContext?: DirectCallContext
  autoJoin?: boolean
}

export async function openMeetingWindow(
  meetingId: string,
  context?: MeetingWindowContext,
): Promise<boolean> {
  if (!window.alephDesktop) return false
  await window.alephDesktop.openMeeting(meetingId, context as Record<string, unknown> | undefined)
  return true
}

export async function getMeetingWindowContext(): Promise<MeetingWindowContext | null> {
  if (!window.alephDesktop) return null
  return await window.alephDesktop.getMeetingContext() as MeetingWindowContext | null
}
