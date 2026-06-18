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
