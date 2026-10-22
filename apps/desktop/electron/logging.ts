import { app } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { redactLogValue, writableLogPath } from './log-utils'

export { log }

export function initializeLogging(): void {
  const preferred = process.platform === 'darwin'
    ? join(app.getPath('home'), 'Library', 'Logs', 'AlephMeets', 'main.log')
    : join(app.getPath('appData'), 'AlephMeets', 'logs', 'main.log')
  const fallback = join(tmpdir(), 'AlephMeets', 'logs', 'main.log')
  let activePath = writableLogPath([preferred, fallback])
  log.transports.file.level = activePath ? 'debug' : false
  log.transports.file.fileName = 'main.log'
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.writeOptions = { flag: 'a', mode: 0o600, encoding: 'utf8' }
  log.transports.file.resolvePathFn = () => activePath ?? fallback
  // Packaged GUI apps may have detached/broken stdout and stderr pipes.
  // Keep file-transport failure reporting from recursively writing to them.
  log.transports.console.level = false
  log.transports.console.writeFn = () => {}
  log.transports.ipc.level = false
  log.hooks.push((message) => ({ ...message, data: message.data.map((item) => redactLogValue(item)) }))

  const observeFileErrors = (): void => {
    log.transports.file.getFile().on('error', () => {
      if (activePath === fallback) {
        log.transports.file.level = false
        return
      }
      activePath = writableLogPath([fallback])
      log.transports.file.level = activePath ? 'debug' : false
      if (activePath) {
        observeFileErrors()
        log.warn('Log file moved to temporary directory after a write failure', activePath)
      }
    })
  }
  if (activePath) observeFileErrors()
  log.initialize()
  log.errorHandler.startCatching({ showDialog: false })
  Object.assign(console, log.functions)
  log.info('Application starting', {
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    electron: process.versions.electron, packaged: app.isPackaged, logPath: activePath,
  })
  if (activePath !== preferred) log.warn('Primary log path is unavailable; using fallback', { logPath: activePath })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-fail-load', (_loadEvent, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) log.error('Page failed to load', { code, description, url })
    })
    contents.on('console-message', (_consoleEvent, level, message) => {
      if (level === 3) log.error('Renderer console', message)
    })
  })
  app.on('render-process-gone', (_event, _contents, details) => log.error('Renderer process exited', details))
  app.on('child-process-gone', (_event, details) => log.error('Child process exited', details))
  app.on('before-quit', () => log.info('Application quitting'))
}
