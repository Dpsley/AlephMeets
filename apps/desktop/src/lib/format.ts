import { format, formatDistanceToNow, isToday, isTomorrow } from 'date-fns'
import { ru } from 'date-fns/locale'

export function meetingDate(value: string): string {
  const date = new Date(value)
  if (isToday(date)) return `Сегодня, ${format(date, 'HH:mm')}`
  if (isTomorrow(date)) return `Завтра, ${format(date, 'HH:mm')}`
  return format(date, 'd MMMM, HH:mm', { locale: ru })
}

export function shortTime(value: string): string {
  return format(new Date(value), 'HH:mm')
}

export function relativeTime(value: string): string {
  return formatDistanceToNow(new Date(value), { addSuffix: true, locale: ru })
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

function decodeHtmlEntities(value: unknown): string {
  const text = String(value ?? '')
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function plainTextFromRichText(value: unknown): string {
  const decoded = decodeHtmlEntities(decodeHtmlEntities(value ?? ''))
  if (decoded.trim() === '[object Object]') return ''
  if (!/<\/?[a-z][\s\S]*>/i.test(decoded)) return normalizeText(decoded)
  return normalizeText(decodeHtmlEntities(
    decoded
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ))
}
