import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function writableLogPath(candidates: string[]): string | null {
  for (const path of candidates) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, '', { mode: 0o600 })
      return path
    } catch { /* Try a per-user temporary directory instead. */ }
  }
  return null
}

function redactText(value: string): string {
  return value.slice(0, 16_384)
    .replace(/\bBearer\s+[^\s,'";]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie|sms[_-]?code|phone|code)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/((?:https?|wss?):\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/((?:https?|wss?):\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[REDACTED]')
    .replace(/\b\d{5,15}\b/g, '[REDACTED]')
}

export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) return { name: value.name, message: redactText(value.message), stack: redactText(value.stack ?? '') }
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, seen))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(?:access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie|set-cookie|phone|sms[_-]?code|body|headers|requestBody)$/i.test(key)
      || (key === 'code' && /^\d{5,10}$/.test(String(item)))
      ? '[REDACTED]'
      : redactLogValue(item, seen),
  ]))
}
