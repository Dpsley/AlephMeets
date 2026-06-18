import { z } from 'zod'

export const meetingInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional().default(''),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string().min(1).max(100).default('UTC'),
  attendees: z.array(z.email()).max(200).default([]),
  waitingRoom: z.boolean().default(true),
  muteOnEntry: z.boolean().default(true),
  allowJoinBeforeHost: z.boolean().default(false),
})

export const messageInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  replyToId: z.uuid().nullable().optional(),
})

export const contactInputSchema = z.object({
  email: z.email(),
  alias: z.string().trim().max(100).optional(),
  favorite: z.boolean().default(false),
})

export const contactFavoriteSchema = z.object({
  favorite: z.boolean(),
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
