import { describe, expect, it, vi } from 'vitest'

const codesign = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync: codesign }))
import { supportsMacAutoUpdate } from './mac-update-support'

describe('macOS automatic update support', () => {
  it('requires a stable signing identity, even if ad-hoc verification succeeds', () => {
    codesign.mockReturnValue({ status: 0, stderr: 'Signature=adhoc\nTeamIdentifier=not set\n' })
    expect(supportsMacAutoUpdate('/Applications/AlephMeets.app/Contents/MacOS/AlephMeets')).toBe(false)
  })

  it('allows an application signed with a team identity', () => {
    codesign.mockReturnValue({ status: 0, stderr: 'Authority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\n' })
    expect(supportsMacAutoUpdate('/Applications/AlephMeets.app/Contents/MacOS/AlephMeets')).toBe(true)
  })

  it('uses manual installation if signature inspection fails', () => {
    codesign.mockReturnValue({ status: 1, stderr: 'code object is not signed at all' })
    expect(supportsMacAutoUpdate('/Applications/AlephMeets.app/Contents/MacOS/AlephMeets')).toBe(false)
  })
})
