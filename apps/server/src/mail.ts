import nodemailer from 'nodemailer'
import { config } from './config.js'

export type MeetingMaterialLink = {
  name: string
  url: string
  mimeType?: string | null
}

export type MeetingMaterialsEmail = {
  recipients: string[]
  meetingTitle: string
  meetingRoomName: string
  materials: MeetingMaterialLink[]
}

function uniqueEmails(emails: readonly string[]): string[] {
  return [...new Set(
    emails
      .map((email) => email.trim().toLowerCase())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
  )]
}

export function isMailConfigured(): boolean {
  return Boolean(config.smtpHost && config.smtpFrom)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function sendMeetingMaterialsEmail(input: MeetingMaterialsEmail): Promise<boolean> {
  const recipients = uniqueEmails(input.recipients)
  if (!isMailConfigured() || !recipients.length || !input.materials.length) return false

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser
      ? { user: config.smtpUser, pass: config.smtpPassword }
      : undefined,
    tls: { rejectUnauthorized: config.smtpRejectUnauthorized },
  })

  const materialLines = input.materials.map((material) => `- ${material.name}: ${material.url}`)
  const htmlMaterials = input.materials.map((material) => (
    `<li><a href="${escapeHtml(material.url)}">${escapeHtml(material.name)}</a></li>`
  )).join('')

  await transporter.sendMail({
    from: config.smtpFrom,
    to: recipients,
    subject: `Материалы встречи: ${input.meetingTitle}`,
    text: [
      'AlephMeets',
      '',
      `Встреча: ${input.meetingTitle}`,
      `Идентификатор: ${input.meetingRoomName}`,
      '',
      'Материалы:',
      ...materialLines,
      '',
    ].join('\n'),
    html: [
      '<p><strong>AlephMeets</strong></p>',
      `<p>Встреча: <strong>${escapeHtml(input.meetingTitle)}</strong><br>`,
      `Идентификатор: ${escapeHtml(input.meetingRoomName)}</p>`,
      `<p>Материалы:</p><ul>${htmlMaterials}</ul>`,
    ].join(''),
  })
  return true
}
