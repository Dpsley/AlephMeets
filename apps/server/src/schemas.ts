import { z } from 'zod'

export const meetingInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional().default(''),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string().min(1).max(100).default('UTC'),
  attendees: z.array(z.email()).max(200).default([]),
  attendeeUserIds: z.array(z.uuid()).max(200).default([]),
  waitingRoom: z.boolean().default(true),
  muteOnEntry: z.boolean().default(true),
  allowJoinBeforeHost: z.boolean().default(false),
})

export const meetingHostTransferSchema = z.object({
  newHostId: z.uuid(),
})

export const meetingInvitationSchema = z.object({
  userIds: z.array(z.uuid()).min(1).max(50),
})

export const messageInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  replyToId: z.uuid().nullable().optional(),
})

export const contactInputSchema = z.object({
  email: z.string().trim().min(5).max(254),
  alias: z.string().trim().max(100).optional(),
})

export const callLogStartSchema = z.object({
  meetingId: z.uuid(),
})

export const callLogFinishSchema = z.object({
  status: z.enum(['ended', 'declined', 'missed']),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).default(0),
})

export const conversationInputSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  memberIds: z.array(z.uuid()).min(1).max(200),
})

export const conversationTitleSchema = z.object({
  title: z.string().trim().min(1).max(150),
})

export const conversationMembersSchema = z.object({
  memberIds: z.array(z.uuid()).min(1).max(200),
})

export const exchangeSettingsSchema = z.object({
  serverUrl: z.url(),
  email: z.email(),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500).optional(),
  domain: z.string().trim().max(200).optional().default(''),
  authMethod: z.enum(['basic', 'ntlm']).default('ntlm'),
  verifyTls: z.boolean().default(true),
})
