import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export function WindowControls({ theme = 'light' }: { theme?: 'light' | 'dark' }): React.JSX.Element | null {
  const desktop = window.alephDesktop
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!desktop) return
    void desktop.isMaximized().then(setMaximized)
    return desktop.onMaximizedChanged(setMaximized)
  }, [desktop])

  if (!desktop || desktop.platform === 'darwin') return null

  return (
    <div className={`window-controls window-controls-${theme}`} role="group" aria-label="Управление окном">
      <button className="window-minimize" type="button" onClick={() => desktop.minimize()} title="Свернуть" aria-label="Свернуть">
        <Minus size={17} strokeWidth={2} aria-hidden="true" />
      </button>
      <button className="window-maximize" type="button" onClick={() => desktop.maximize()} title={maximized ? 'Восстановить' : 'Развернуть'} aria-label={maximized ? 'Восстановить' : 'Развернуть'}>
        {maximized
          ? <Copy className="window-restore-icon" size={14} strokeWidth={1.8} aria-hidden="true" />
          : <Square size={13} strokeWidth={1.8} aria-hidden="true" />}
      </button>
      <button className="window-close" type="button" onClick={() => desktop.close()} title="Закрыть" aria-label="Закрыть">
        <X size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  )
}
