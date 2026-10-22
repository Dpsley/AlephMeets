import { describe, expect, it } from 'vitest'
import { formatLoginPhone, loginPhoneForIdp, phoneCaretAfterEdit } from './phone'

describe('login phone mask', () => {
  it.each(['+7 (999) 123-45-67', '79991234567', '8 999 123 45 67', '9991234567'])(
    'formats a pasted number: %s', (value) => {
      expect(formatLoginPhone(value)).toBe('+7 (999) 123-45-67')
      expect(loginPhoneForIdp(formatLoginPhone(value))).toBe('79991234567')
    },
  )

  it('supports partial input and clearing without allowing an incomplete request', () => {
    expect(formatLoginPhone('')).toBe('')
    expect(formatLoginPhone('7')).toBe('+7')
    expect(formatLoginPhone('9')).toBe('+7 (9')
    expect(formatLoginPhone('+7 (999) 1')).toBe('+7 (999) 1')
    expect(loginPhoneForIdp('+7 (999) 123-45-6')).toBeNull()
    expect(loginPhoneForIdp('')).toBeNull()
    expect(loginPhoneForIdp('89991234567')).toBeNull()
    expect(loginPhoneForIdp('799912345678')).toBeNull()
  })

  it('keeps the caret next to the edited digit when formatting changes', () => {
    expect(phoneCaretAfterEdit('9', 1, '+7 (9')).toBe(5)
    expect(phoneCaretAfterEdit('+7 (9991', 8, '+7 (999) 1')).toBe(10)
    expect(phoneCaretAfterEdit('+7 (991) 123-45-67', 6, '+7 (991) 123-45-67')).toBe(6)
    expect(phoneCaretAfterEdit('', 0, '')).toBe(0)
  })
})
