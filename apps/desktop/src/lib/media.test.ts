import { describe, expect, it } from 'vitest'
import { isMissingDeviceError, isRetryableMediaError, mediaErrorMessage } from './media'

describe('media device errors', () => {
  it('recognizes Chromium requested-device errors', () => {
    expect(isMissingDeviceError(new DOMException('Requested device not found', 'NotFoundError'))).toBe(true)
    expect(mediaErrorMessage('video', new Error('Requested device not found'))).toContain('Камера не найдена')
  })

  it('retries transient device access errors', () => {
    expect(isRetryableMediaError(new DOMException('Could not start audio source', 'NotReadableError'))).toBe(true)
    expect(isRetryableMediaError(new DOMException('Permission denied', 'NotAllowedError'))).toBe(false)
  })
})
