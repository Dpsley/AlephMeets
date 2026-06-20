import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import { appIconPath } from './app-icon'

const { autoUpdater } = electronUpdater

type GateStatus = {
  title: string
  detail: string
  progress?: number
}

class UpdateGate {
  private readonly window: BrowserWindow
  private released = false

  constructor() {
    this.window = new BrowserWindow({
      width: 500,
      height: 286,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      backgroundColor: '#f3f7fb',
      title: 'Обновление AlephMeets',
      icon: appIconPath(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    this.window.on('closed', () => {
      if (!this.released) app.quit()
    })
  }

  async show(): Promise<void> {
    await this.window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(updateGateHtml)}`)
    if (!this.window.isDestroyed()) this.window.show()
  }

  async setStatus({ title, detail, progress }: GateStatus): Promise<void> {
    if (this.window.isDestroyed()) return
    const normalizedProgress = progress === undefined
      ? null
      : Math.max(0, Math.min(100, Math.round(progress)))
    await this.window.webContents.executeJavaScript(`
      document.querySelector('[data-title]').textContent = ${JSON.stringify(title)};
      document.querySelector('[data-detail]').textContent = ${JSON.stringify(detail)};
      document.querySelector('[data-progress]').classList.toggle('indeterminate', ${normalizedProgress === null});
      document.querySelector('[data-progress-bar]').style.width = ${JSON.stringify(normalizedProgress === null ? '38%' : `${normalizedProgress}%`)};
      document.querySelector('[data-progress-label]').textContent = ${JSON.stringify(normalizedProgress === null ? '' : `${normalizedProgress}%`)};
    `)
  }

  async askToUpdate(version: string): Promise<boolean> {
    if (this.window.isDestroyed()) return false
    const result = await dialog.showMessageBox(this.window, {
      type: 'info',
      title: 'Обязательное обновление',
      message: `Доступна новая версия AlephMeets ${version}`,
      detail: 'Чтобы продолжить работу, необходимо установить обновление. Отказ закроет приложение.',
      buttons: ['Обновить', 'Закрыть приложение'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }

  async askToRetry(message: string): Promise<boolean> {
    if (this.window.isDestroyed()) return false
    const result = await dialog.showMessageBox(this.window, {
      type: 'error',
      title: 'Не удалось проверить обновление',
      message: 'Проверка обновлений обязательна',
      detail: message,
      buttons: ['Повторить', 'Закрыть приложение'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }

  closeApplication(): void {
    if (!this.window.isDestroyed()) this.window.close()
    else app.quit()
  }

  release(): void {
    this.released = true
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Неизвестная ошибка обновления.'
}

export async function enforceMandatoryUpdate(): Promise<boolean> {
  if (!app.isPackaged || !['win32', 'darwin'].includes(process.platform)) return true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = console
  autoUpdater.on('error', (error) => console.error('[updater]', error))

  const gate = new UpdateGate()
  await gate.show()

  while (true) {
    try {
      await gate.setStatus({
        title: 'Проверяем обновления',
        detail: `Установлена версия ${app.getVersion()}. Подключаемся к GitHub Releases...`,
      })
      const result = await autoUpdater.checkForUpdates()

      if (!result?.isUpdateAvailable) {
        gate.release()
        return true
      }

      await gate.setStatus({
        title: `Доступна версия ${result.updateInfo.version}`,
        detail: 'Обновление необходимо для продолжения работы.',
        progress: 0,
      })
      if (!await gate.askToUpdate(result.updateInfo.version)) {
        gate.closeApplication()
        return false
      }

      const onProgress = (info: { percent: number }): void => {
        void gate.setStatus({
          title: 'Загружаем обновление',
          detail: 'Не закрывайте приложение. После загрузки AlephMeets перезапустится.',
          progress: info.percent,
        })
      }
      autoUpdater.on('download-progress', onProgress)

      try {
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.removeListener('download-progress', onProgress)
      }

      await gate.setStatus({
        title: 'Устанавливаем обновление',
        detail: 'AlephMeets сейчас перезапустится.',
        progress: 100,
      })
      autoUpdater.quitAndInstall(true, true)
      return false
    } catch (reason) {
      console.error('[updater] mandatory update failed', reason)
      await gate.setStatus({
        title: 'Не удалось проверить обновление',
        detail: 'Для запуска AlephMeets требуется успешная проверка версии.',
      })
      if (!await gate.askToRetry(errorMessage(reason))) {
        gate.closeApplication()
        return false
      }
    }
  }
}

const updateGateHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { display: grid; place-items: center; padding: 34px; color: #202124; background: radial-gradient(circle at 50% 0, #e8f3ff 0, #f3f7fb 56%, #edf1f5 100%); font-family: Inter, "Segoe UI", Arial, sans-serif; user-select: none; -webkit-app-region: drag; }
    main { width: 100%; display: grid; justify-items: center; text-align: center; }
    .mark { width: 54px; height: 54px; display: grid; place-items: center; border-radius: 16px; color: white; background: linear-gradient(145deg, #2d8cff, #176dcc); box-shadow: 0 10px 25px rgba(45, 140, 255, .24); font-size: 22px; font-weight: 800; }
    h1 { margin: 18px 0 8px; font-size: 22px; letter-spacing: -.4px; }
    p { min-height: 38px; margin: 0; color: #747b87; font-size: 13px; line-height: 1.45; }
    .progress { width: 100%; height: 7px; margin-top: 25px; overflow: hidden; border-radius: 999px; background: #dce4ec; }
    .bar { width: 38%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #2d8cff, #65adff); transition: width .2s ease; }
    .progress.indeterminate .bar { animation: slide 1.15s ease-in-out infinite; }
    small { min-height: 17px; margin-top: 8px; color: #4588d5; font-size: 11px; font-weight: 700; }
    @keyframes slide { from { transform: translateX(-130%); } to { transform: translateX(340%); } }
  </style>
</head>
<body>
  <main>
    <div class="mark">A</div>
    <h1 data-title>Проверяем обновления</h1>
    <p data-detail>Подключаемся к GitHub Releases...</p>
    <div class="progress indeterminate" data-progress><div class="bar" data-progress-bar></div></div>
    <small data-progress-label></small>
  </main>
</body>
</html>`
