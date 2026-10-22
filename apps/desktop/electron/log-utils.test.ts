import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import log from 'electron-log/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { redactLogValue, writableLogPath } from './log-utils'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'aleph-log-test-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('packaged application log files', () => {
  it('creates a log directory and verifies that the file is writable', () => {
    const path = join(directory, 'new', 'logs', 'main.log')
    expect(writableLogPath([path])).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('falls back when the main log directory cannot be created', () => {
    const blocked = join(directory, 'blocked')
    writeFileSync(blocked, 'not a directory')
    const fallback = join(directory, 'temporary', 'logs', 'main.log')
    expect(writableLogPath([join(blocked, 'main.log'), fallback])).toBe(fallback)
  })

  it('does not throw if every log location is unwritable', () => {
    const blocked = join(directory, 'blocked')
    writeFileSync(blocked, 'not a directory')
    expect(writableLogPath([join(blocked, 'main.log')])).toBeNull()
  })

  it('writes actual log entries and rotates the previous file', () => {
    const path = join(directory, 'main.log')
    const logger = log.create({ logId: directory })
    logger.transports.console.level = false
    logger.transports.file.resolvePathFn = () => path
    logger.transports.file.maxSize = 256
    logger.hooks.push((message) => ({ ...message, data: message.data.map((value) => redactLogValue(value)) }))
    logger.info('First entry', 'x'.repeat(300))
    logger.error('Second entry', { accessToken: 'test-secret', status: 404 })
    const current = readFileSync(path, 'utf8')
    expect(current).toContain('Second entry')
    expect(current).toContain('404')
    expect(current).not.toContain('test-secret')
    expect(readFileSync(join(directory, 'main.old.log'), 'utf8')).toContain('First entry')
  })

  it('preserves existing logs instead of truncating them on startup', () => {
    mkdirSync(join(directory, 'logs'))
    const path = join(directory, 'logs', 'main.log')
    writeFileSync(path, 'Previous session\n')
    writableLogPath([path])
    expect(readFileSync(path, 'utf8')).toBe('Previous session\n')
  })
})

describe('diagnostic data redaction', () => {
  it('removes authentication fields, SMS codes, phone numbers, bodies and headers', () => {
    expect(redactLogValue({
      accessToken: 'access', refresh_token: 'refresh', nested: { password: 'password', code: '123456', phone: '79991234567' },
      body: '{"code":"123456"}', headers: { Authorization: 'Bearer secret' },
      status: 404, path: '/api/auth/sms/request', code: 'ERR_UPDATER_INVALID_SIGNATURE',
    })).toEqual({
      accessToken: '[REDACTED]', refresh_token: '[REDACTED]', nested: { password: '[REDACTED]', code: '[REDACTED]', phone: '[REDACTED]' },
      body: '[REDACTED]', headers: '[REDACTED]', status: 404, path: '/api/auth/sms/request', code: 'ERR_UPDATER_INVALID_SIGNATURE',
    })
  })

  it('redacts secrets in error messages and URL queries while keeping useful details', () => {
    const result = JSON.stringify(redactLogValue(new Error('HTTP 404 Bearer test-token accessToken=opaque smsCode=123456 https://api.test/path?secret=value')))
    expect(result).toContain('HTTP 404')
    for (const secret of ['test-token', 'opaque', '123456', 'secret=value']) expect(result).not.toContain(secret)
  })

  it('handles circular diagnostic objects without breaking the application', () => {
    const value: Record<string, unknown> = { status: 500 }
    value.self = value
    expect(redactLogValue(value)).toEqual({ status: 500, self: '[Circular]' })
  })
})
