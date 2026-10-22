import type { EventEmitter } from 'node:events'

// electron-updater's download promise resolves before Squirrel.Mac finishes
// unpacking and verifying the app. Observe native readiness before downloading.
export class UpdateInstallation {
  private readonly failed: Promise<Error>
  private readonly ready: Promise<void>
  private readonly quitting: Promise<void>
  private failure: Error | null = null
  private onError!: (error: Error) => void
  private onReady!: () => void
  private onQuit!: () => void

  constructor(
    private readonly updater: EventEmitter,
    private readonly nativeUpdater: EventEmitter | null,
    private readonly application: EventEmitter,
  ) {
    this.failed = new Promise((resolve) => {
      this.onError = (error) => { this.failure = error; resolve(error) }
    })
    this.ready = new Promise((resolve) => { this.onReady = resolve })
    this.quitting = new Promise((resolve) => { this.onQuit = resolve })
    updater.on('error', this.onError)
    nativeUpdater?.on('update-downloaded', this.onReady)
    application.on('before-quit', this.onQuit)
  }

  async watch<T>(operation: Promise<T>): Promise<T> {
    if (this.failure) {
      void operation.catch(() => {})
      throw this.failure
    }
    return Promise.race([operation, this.failed.then((error) => { throw error })])
  }

  private async withTimeout(operation: Promise<void>, timeoutMs: number, message: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.watch(Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
      ]))
    } finally {
      clearTimeout(timer)
    }
  }

  async waitUntilReady(timeoutMs = 180_000): Promise<void> {
    if (!this.nativeUpdater) return
    await this.withTimeout(this.ready, timeoutMs,
      'macOS не завершила подготовку обновления. Установите новую версию вручную из DMG в папку «Программы».')
  }

  async install(start: () => void, timeoutMs = 30_000): Promise<void> {
    if (this.failure) throw this.failure
    const result = this.withTimeout(this.quitting, timeoutMs,
      'Приложение не смогло перезапуститься для установки обновления. Установите новую версию вручную.')
    // Attach rejection handling before invoking the installer, which can throw.
    try {
      start()
      await result
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)))
      await result.catch(() => {})
      throw error
    }
  }

  dispose(): void {
    this.updater.removeListener('error', this.onError)
    this.nativeUpdater?.removeListener('update-downloaded', this.onReady)
    this.application.removeListener('before-quit', this.onQuit)
  }
}
