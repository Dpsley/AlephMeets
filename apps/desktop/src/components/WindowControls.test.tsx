import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { WindowControls } from './WindowControls'

describe('WindowControls', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('keeps all window actions visible when the platform bridge is unavailable', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { alephDesktop: undefined },
    })

    const markup = renderToStaticMarkup(<WindowControls />)

    expect(markup).toContain('aria-label="Свернуть"')
    expect(markup).toContain('aria-label="Развернуть"')
    expect(markup).toContain('aria-label="Закрыть"')
  })
})
