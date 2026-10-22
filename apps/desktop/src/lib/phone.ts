export function formatLoginPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (!digits) return ''
  const national = (/^[78]/.test(digits) ? digits.slice(1) : digits).slice(0, 10)
  let formatted = '+7'
  if (national.length) formatted += ` (${national.slice(0, 3)}`
  if (national.length >= 3) formatted += ')'
  if (national.length > 3) formatted += ` ${national.slice(3, 6)}`
  if (national.length > 6) formatted += `-${national.slice(6, 8)}`
  if (national.length > 8) formatted += `-${national.slice(8, 10)}`
  return formatted
}

export function loginPhoneForIdp(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  return /^7\d{10}$/.test(digits) ? digits : null
}

export function phoneCaretAfterEdit(raw: string, caret: number, formatted: string): number {
  const digits = raw.replace(/\D/g, '')
  let remaining = raw.slice(0, caret).replace(/\D/g, '').length
  if (digits && !/^[78]/.test(digits)) remaining += 1
  if (!remaining) return Math.min(2, formatted.length)
  for (let index = 0; index < formatted.length; index += 1) {
    if (/\d/.test(formatted[index]!) && --remaining === 0) return index + 1
  }
  return formatted.length
}
