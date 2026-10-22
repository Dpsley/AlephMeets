import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateInstallation } from './update-installation'

let updater: EventEmitter
let native: EventEmitter
let application: EventEmitter
let installation: UpdateInstallation

beforeEach(() => {
  vi.useFakeTimers()
  updater = new EventEmitter()
  native = new EventEmitter()
  application = new EventEmitter()
  installation = new UpdateInstallation(updater, native, application)
})
afterEach(() => { installation.dispose(); vi.useRealTimers() })

describe('macOS update preparation and installation', () => {
  it('does not equate a completed ZIP download with native readiness', async () => {
    await installation.watch(Promise.resolve(['update.zip']))
    const ready = vi.fn()
    const waiting = installation.waitUntilReady().then(ready)
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    native.emit('update-downloaded')
    await waiting
    expect(ready).toHaveBeenCalledOnce()
  })

  it('remembers native readiness received before the download promise resolves', async () => {
    native.emit('update-downloaded')
    await installation.watch(Promise.resolve(['update.zip']))
    await installation.waitUntilReady()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports signature errors emitted after downloading rather than waiting forever', async () => {
    await installation.watch(Promise.resolve([]))
    const waiting = expect(installation.waitUntilReady()).rejects.toThrow('signature verification failed')
    updater.emit('error', new Error('signature verification failed'))
    await waiting
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out native preparation and offers a manual installation path', async () => {
    const waiting = expect(installation.waitUntilReady(100)).rejects.toThrow('вручную из DMG')
    await vi.advanceTimersByTimeAsync(100)
    await waiting
  })

  it('waits for application shutdown after starting the installer', async () => {
    const finished = vi.fn()
    const start = vi.fn()
    const waiting = installation.install(start).then(finished)
    expect(start).toHaveBeenCalledOnce()
    expect(finished).not.toHaveBeenCalled()
    application.emit('before-quit')
    await waiting
    expect(finished).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports late installer errors', async () => {
    const waiting = expect(installation.install(() => {})).rejects.toThrow('Cannot install')
    updater.emit('error', new Error('Cannot install'))
    await waiting
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out when quitAndInstall returns without quitting', async () => {
    const waiting = expect(installation.install(() => {}, 100)).rejects.toThrow('не смогло перезапуститься')
    await vi.advanceTimersByTimeAsync(100)
    await waiting
  })

  it('cleans up when the installer throws synchronously', async () => {
    await expect(installation.install(() => { throw new Error('Installer failed') })).rejects.toThrow('Installer failed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not invoke the installer after an error was already received', async () => {
    const start = vi.fn()
    updater.emit('error', new Error('Invalid signature'))
    await expect(installation.install(start)).rejects.toThrow('Invalid signature')
    expect(start).not.toHaveBeenCalled()
  })

  it('removes observers when retrying, without leaving pending timers', () => {
    installation.dispose()
    expect(updater.listenerCount('error')).toBe(0)
    expect(native.listenerCount('update-downloaded')).toBe(0)
    expect(application.listenerCount('before-quit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not wait for a macOS event on Windows', async () => {
    installation.dispose()
    installation = new UpdateInstallation(updater, null, application)
    await installation.waitUntilReady()
    await installation.install(() => application.emit('before-quit'))
    expect(vi.getTimerCount()).toBe(0)
  })
})
