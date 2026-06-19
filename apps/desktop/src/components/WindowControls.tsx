import { useEffect, useState } from 'react'

export function WindowControls({ theme = 'light' }: { theme?: 'light' | 'dark' }): React.JSX.Element | null {
  const desktop = window.alephDesktop
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (desktop?.platform !== 'win32') return
    void desktop.isMaximized().then(setMaximized)
    return desktop.onMaximizedChanged(setMaximized)
  }, [desktop])

  if (desktop?.platform !== 'win32') return null

  return (
    <div className={`window-controls ${theme}`}>
      <button className="window-minimize" type="button" onClick={() => desktop.minimize()} title="Свернуть" aria-label="Свернуть">
        <span aria-hidden="true" />
      </button>
      <button className="window-maximize" type="button" onClick={() => desktop.maximize()} title={maximized ? 'Восстановить' : 'Развернуть'} aria-label={maximized ? 'Восстановить' : 'Развернуть'}>
        <span className={maximized ? 'restore' : ''} aria-hidden="true" />
      </button>
      <button className="window-close" type="button" onClick={() => desktop.close()} title="Закрыть" aria-label="Закрыть">
        <span aria-hidden="true" />
      </button>
    </div>
  )
}
