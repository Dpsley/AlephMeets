import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { WindowControls } from './WindowControls'

describe('WindowControls', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('renders all actions when the Electron bridge is available', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        alephDesktop: {
          platform: 'win32',
          minimize: () => undefined,
          maximize: () => undefined,
          close: () => undefined,
          isMaximized: async () => false,
          onMaximizedChanged: () => () => undefined,
        },
      },
    })

    const markup = renderToStaticMarkup(<WindowControls />)

    expect(markup).toContain('aria-label="Свернуть"')
    expect(markup).toContain('aria-label="Развернуть"')
    expect(markup).toContain('aria-label="Закрыть"')
  })
})
