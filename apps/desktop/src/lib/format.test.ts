import { describe, expect, it } from 'vitest'
import { initials } from './format'

describe('initials', () => {
  it('uses at most two name parts', () => {
    expect(initials('Dmitry Aleph Meets')).toBe('DA')
  })
})
