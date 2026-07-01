import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildExchangeDeleteItemXml,
  buildExchangeUpdateItemXml,
  buildEwsRequestConfig,
  buildRequiredAttendeesXml,
  normalizeEwsUrl,
  normalizeExchangeBody,
  normalizeExchangeAttendees,
  normalizeNtlmCredentials,
  parseExchangeCalendarItem,
} from './exchange.js'

const credentials = {
  serverUrl: 'https://mail.example.com/owa',
  email: 'user@example.com',
  username: 'EXAMPLE\\user',
  password: 'secret',
  domain: '',
  authMethod: 'ntlm' as const,
  verifyTls: true,
}

test('converts an OWA address to the EWS endpoint', () => {
  assert.equal(
    normalizeEwsUrl('https://mail.example.com/owa/auth/logon.aspx'),
    'https://mail.example.com/EWS/Exchange.asmx',
  )
})

test('keeps an explicit EWS endpoint', () => {
  assert.equal(
    normalizeEwsUrl('https://mail.example.com/EWS/Exchange.asmx'),
    'https://mail.example.com/EWS/Exchange.asmx',
  )
})

test('normalizes a DOMAIN\\username NTLM login', () => {
  assert.deepEqual(normalizeNtlmCredentials(credentials), {
    domain: 'EXAMPLE',
    username: 'user',
    password: 'secret',
  })
})

test('keeps 401 responses available to the NTLM interceptor', () => {
  const config = buildEwsRequestConfig(credentials, '<m:GetFolder />')
  assert.equal(config.validateStatus, undefined)
  assert.equal((config.httpsAgent as { options: { keepAlive?: boolean } }).options.keepAlive, true)
  assert.equal(config.headers?.['X-AnchorMailbox'], credentials.email)
})

test('normalizes Exchange attendee emails', () => {
  assert.deepEqual(
    normalizeExchangeAttendees([' User@Example.com ', 'user@example.com', '', 'other@example.com']),
    ['user@example.com', 'other@example.com'],
  )
})

test('builds RequiredAttendees XML for Exchange events', () => {
  const xml = buildRequiredAttendeesXml(['User@Example.com', 'other@example.com'])
  assert.match(xml, /<t:RequiredAttendees>/)
  assert.match(xml, /<t:EmailAddress>user@example.com<\/t:EmailAddress>/)
  assert.match(xml, /<t:EmailAddress>other@example.com<\/t:EmailAddress>/)
})

test('parses attendees from Exchange calendar items', () => {
  const event = parseExchangeCalendarItem({
    ItemId: { '@_Id': 'event-id', '@_ChangeKey': 'change-key' },
    Subject: 'Planning',
    Body: 'Body',
    Location: 'Room',
    Start: '2026-06-29T08:00:00Z',
    End: '2026-06-29T09:00:00Z',
    RequiredAttendees: {
      Attendee: [
        { Mailbox: { EmailAddress: 'First@Example.com' } },
        { Mailbox: { EmailAddress: 'second@example.com' } },
      ],
    },
    OptionalAttendees: {
      Attendee: { Mailbox: { EmailAddress: 'first@example.com' } },
    },
  })
  assert.deepEqual(event.attendees, ['first@example.com', 'second@example.com'])
})

test('builds a compatible UpdateItem XML for meeting attendees', () => {
  const withAttendees = buildExchangeUpdateItemXml('event-id', 'change-key', {
    subject: 'Planning',
    body: 'Body',
    location: 'Room',
    startsAt: '2026-06-29T08:00:00Z',
    endsAt: '2026-06-29T09:00:00Z',
    attendees: ['user@example.com'],
  })
  assert.match(withAttendees, /MessageDisposition="SaveOnly"/)
  assert.match(withAttendees, /SendMeetingInvitationsOrCancellations="SendOnlyToChanged"/)
  assert.match(withAttendees, /FieldURI="calendar:RequiredAttendees"/)

  const withoutAttendees = buildExchangeUpdateItemXml('event-id', undefined, {
    subject: 'Planning',
    startsAt: '2026-06-29T08:00:00Z',
    endsAt: '2026-06-29T09:00:00Z',
    attendees: [],
  })
  assert.match(withoutAttendees, /SendMeetingInvitationsOrCancellations="SendToNone"/)
  assert.doesNotMatch(withoutAttendees, /DeleteItemField/)
  assert.doesNotMatch(withoutAttendees, /FieldURI="calendar:RequiredAttendees"/)
})

test('normalizes Outlook HTML bodies to readable plain text', () => {
  assert.equal(
    normalizeExchangeBody({
      '@_BodyType': 'HTML',
      '#text': '&lt;html&gt;&lt;head&gt;&lt;style&gt;.x{color:red}&lt;/style&gt;&lt;/head&gt;&lt;body&gt;&lt;p class="MsoNormal"&gt;Ежемесячный контроль оплат&lt;/p&gt;&lt;p&gt;&amp;nbsp;&lt;/p&gt;&lt;/body&gt;&lt;/html&gt;',
    }),
    'Ежемесячный контроль оплат',
  )
})

test('builds DeleteItem XML that cancels Exchange meetings', () => {
  const xml = buildExchangeDeleteItemXml('event-id', 'change-key')
  assert.match(xml, /<m:DeleteItem /)
  assert.match(xml, /DeleteType="MoveToDeletedItems"/)
  assert.match(xml, /SendMeetingCancellations="SendToAllAndSaveCopy"/)
  assert.match(xml, /<t:ItemId Id="event-id" ChangeKey="change-key" \/>/)
})
