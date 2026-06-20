import https from 'node:https'
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { NtlmClient } from 'axios-ntlm'
import { XMLParser } from 'fast-xml-parser'

export interface ExchangeCredentials {
  serverUrl: string
  email: string
  username: string
  password: string
  domain: string
  authMethod: 'basic' | 'ntlm'
  verifyTls: boolean
}

export interface ExchangeEvent {
  externalEventId: string
  changeKey?: string
  subject: string
  body: string
  location: string
  startsAt: string
  endsAt: string
  organizer?: string
}

export interface ExchangeEventInput {
  subject: string
  body?: string
  location?: string
  startsAt: string
  endsAt: string
  attendees?: string[]
}

interface NtlmCredentials {
  username: string
  password: string
  domain: string
}

export class ExchangeIntegrationError extends Error {
  constructor(
    public readonly code:
      | 'exchange_auth_failed'
      | 'exchange_endpoint_not_found'
      | 'exchange_connection_failed'
      | 'exchange_response_error',
    message: string,
  ) {
    super(message)
    this.name = 'ExchangeIntegrationError'
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
})

export function normalizeEwsUrl(input: string): string {
  const url = new URL(input.trim())
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ExchangeIntegrationError('exchange_endpoint_not_found', 'Адрес Exchange должен начинаться с http:// или https://.')
  }
  if (/\/ews\/exchange\.asmx\/?$/i.test(url.pathname)) {
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  }
  return `${url.origin}/EWS/Exchange.asmx`
}

function xml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function envelope(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header><t:RequestServerVersion Version="Exchange2013_SP1" /></soap:Header>
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`
}

export function normalizeNtlmCredentials(credentials: ExchangeCredentials): NtlmCredentials {
  const slashIndex = credentials.username.indexOf('\\')
  if (slashIndex > 0) {
    return {
      domain: credentials.domain || credentials.username.slice(0, slashIndex),
      username: credentials.username.slice(slashIndex + 1),
      password: credentials.password,
    }
  }
  return {
    domain: credentials.domain,
    username: credentials.username,
    password: credentials.password,
  }
}

export function buildEwsRequestConfig(
  credentials: ExchangeCredentials,
  body: string,
): AxiosRequestConfig {
  return {
    url: normalizeEwsUrl(credentials.serverUrl),
    method: 'POST',
    data: envelope(body),
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      Accept: 'text/xml',
      'X-AnchorMailbox': credentials.email,
    },
    timeout: 20_000,
    maxRedirects: 0,
    httpsAgent: new https.Agent({
      keepAlive: true,
      rejectUnauthorized: credentials.verifyTls,
    }),
  }
}

function getText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object' && '#text' in value) return String((value as { '#text': unknown })['#text'])
  return String(value)
}

function collectByKey(value: unknown, key: string, result: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return result
  for (const [currentKey, child] of Object.entries(value)) {
    if (currentKey === key) {
      const items = Array.isArray(child) ? child : [child]
      for (const item of items) if (item && typeof item === 'object') result.push(item as Record<string, unknown>)
    } else {
      collectByKey(child, key, result)
    }
  }
  return result
}

function responseError(data: unknown): ExchangeIntegrationError | null {
  const responseCodes = collectByKey(data, 'ResponseCode').map((item) => getText(item))
  const directCodes: string[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ResponseCode' && typeof child !== 'object') directCodes.push(String(child))
      else visit(child)
    }
  }
  visit(data)
  const failed = [...responseCodes, ...directCodes].find((code) => code && code !== 'NoError')
  return failed
    ? new ExchangeIntegrationError('exchange_response_error', `Exchange вернул ошибку ${failed}.`)
    : null
}

async function requestEws(credentials: ExchangeCredentials, body: string): Promise<Record<string, unknown>> {
  const request = buildEwsRequestConfig(credentials, body)
  let response: AxiosResponse<string>
  try {
    if (credentials.authMethod === 'ntlm') {
      response = await NtlmClient(normalizeNtlmCredentials(credentials)).request<string>(request)
    } else {
      response = await axios.request<string>({
        ...request,
        auth: {
          username: credentials.domain && !credentials.username.includes('\\')
            ? `${credentials.domain}\\${credentials.username}`
            : credentials.username,
          password: credentials.password,
        },
      })
    }
  } catch (error) {
    if (axios.isAxiosError<string>(error) && error.response) {
      response = error.response
    } else {
      const message = error instanceof Error ? error.message : String(error)
      throw new ExchangeIntegrationError(
        'exchange_connection_failed',
        `Не удалось подключиться к серверу Exchange ${new URL(String(request.url)).host}: ${message}`,
      )
    }
  }
  if (response.status >= 300 && response.status < 400) {
    const redirect = typeof response.headers.location === 'string'
      ? response.headers.location
      : 'другой адрес'
    throw new ExchangeIntegrationError(
      'exchange_endpoint_not_found',
      `Exchange перенаправил EWS-запрос на ${redirect}. Укажите конечный HTTPS-адрес EWS без редиректа.`,
    )
  }
  if (response.status === 401 || response.status === 403) {
    const authenticate = String(response.headers['www-authenticate'] ?? '')
    const schemes = [...new Set(authenticate.match(/(?:^|,\s*)(Basic|NTLM|Negotiate|Bearer)(?=\s|,|$)/gi)?.map((value) => value.trim()) ?? [])]
    const advertised = schemes.length ? ` Сервер предлагает: ${schemes.join(', ')}.` : ''
    const selected = credentials.authMethod === 'ntlm' ? 'NTLM' : 'Basic'
    throw new ExchangeIntegrationError(
      'exchange_auth_failed',
      `Exchange отклонил учетные данные для ${selected}.${advertised}`,
    )
  }
  if (response.status === 404) {
    throw new ExchangeIntegrationError(
      'exchange_endpoint_not_found',
      'EWS endpoint не найден. Проверьте адрес OWA или укажите полный путь /EWS/Exchange.asmx.',
    )
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ExchangeIntegrationError(
      'exchange_connection_failed',
      `Exchange вернул HTTP ${response.status}.`,
    )
  }
  const contentType = String(response.headers['content-type'] ?? '')
  if (contentType.includes('text/html') || /<(?:!doctype\s+html|html)[\s>]/i.test(response.data)) {
    throw new ExchangeIntegrationError(
      'exchange_endpoint_not_found',
      'Вместо EWS сервер вернул HTML-страницу OWA. Укажите конечный адрес /EWS/Exchange.asmx.',
    )
  }
  let data: Record<string, unknown>
  try {
    data = parser.parse(response.data) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ExchangeIntegrationError(
      'exchange_response_error',
      `Exchange вернул некорректный XML: ${message}`,
    )
  }
  const ewsError = responseError(data)
  if (ewsError) throw ewsError
  return data
}

export async function testExchangeConnection(credentials: ExchangeCredentials): Promise<void> {
  await requestEws(credentials, `<m:GetFolder>
    <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
    <m:FolderIds><t:DistinguishedFolderId Id="calendar" /></m:FolderIds>
  </m:GetFolder>`)
}

export async function listExchangeEvents(
  credentials: ExchangeCredentials,
  from: Date,
  to: Date,
): Promise<ExchangeEvent[]> {
  const data = await requestEws(credentials, `<m:FindItem Traversal="Shallow">
    <m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape>
    <m:CalendarView StartDate="${from.toISOString()}" EndDate="${to.toISOString()}" MaxEntriesReturned="1000" />
    <m:ParentFolderIds><t:DistinguishedFolderId Id="calendar" /></m:ParentFolderIds>
  </m:FindItem>`)
  return collectByKey(data, 'CalendarItem').map((item) => {
    const itemId = item.ItemId as Record<string, unknown> | undefined
    const organizer = item.Organizer as Record<string, unknown> | undefined
    const mailbox = organizer?.Mailbox as Record<string, unknown> | undefined
    return {
      externalEventId: String(itemId?.['@_Id'] ?? ''),
      changeKey: itemId?.['@_ChangeKey'] ? String(itemId['@_ChangeKey']) : undefined,
      subject: getText(item.Subject) || 'Встреча Exchange',
      body: getText(item.Body),
      location: getText(item.Location),
      startsAt: getText(item.Start),
      endsAt: getText(item.End),
      organizer: getText(mailbox?.EmailAddress),
    }
  }).filter((event) => event.externalEventId && event.startsAt && event.endsAt)
}

export async function createExchangeEvent(
  credentials: ExchangeCredentials,
  event: ExchangeEventInput,
): Promise<{ externalEventId: string; changeKey?: string }> {
  const attendees = event.attendees?.length
    ? `<t:RequiredAttendees>${event.attendees.map((email) => `<t:Attendee><t:Mailbox><t:EmailAddress>${xml(email)}</t:EmailAddress></t:Mailbox></t:Attendee>`).join('')}</t:RequiredAttendees>`
    : ''
  const data = await requestEws(credentials, `<m:CreateItem SendMeetingInvitations="SendToNone">
    <m:SavedItemFolderId><t:DistinguishedFolderId Id="calendar" /></m:SavedItemFolderId>
    <m:Items><t:CalendarItem>
      <t:Subject>${xml(event.subject)}</t:Subject>
      <t:Body BodyType="Text">${xml(event.body)}</t:Body>
      <t:Start>${xml(event.startsAt)}</t:Start><t:End>${xml(event.endsAt)}</t:End>
      <t:Location>${xml(event.location)}</t:Location>${attendees}
    </t:CalendarItem></m:Items>
  </m:CreateItem>`)
  const itemId = collectByKey(data, 'ItemId')[0]
  const externalEventId = itemId?.['@_Id'] ? String(itemId['@_Id']) : ''
  if (!externalEventId) {
    throw new ExchangeIntegrationError('exchange_response_error', 'Exchange не вернул идентификатор созданной встречи.')
  }
  return {
    externalEventId,
    changeKey: itemId?.['@_ChangeKey'] ? String(itemId['@_ChangeKey']) : undefined,
  }
}
