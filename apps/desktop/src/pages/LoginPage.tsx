import { ArrowLeft, LockKeyhole, MessageSquareText, Phone } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { version as bundledVersion } from '../../package.json'
import { useApp } from '../state/AppContext'
import { BrandMark } from '../components/BrandMark'
import { WindowControls } from '../components/WindowControls'
import { formatLoginPhone, loginPhoneForIdp, phoneCaretAfterEdit } from '../lib/phone'

export function LoginPage(): React.JSX.Element {
  const { loading, error: sessionError, requestLoginCode, verifyLoginCode } = useApp()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(bundledVersion)
  const phoneInput = useRef<HTMLInputElement>(null)
  const phoneCaret = useRef<number | null>(null)
  const idpPhone = loginPhoneForIdp(phone)

  useEffect(() => {
    let active = true
    void window.alephDesktop?.getVersion().then((value) => {
      if (active) setVersion(value)
    }).catch(() => { /* Keep the version embedded in the build. */ })
    return () => { active = false }
  }, [])

  useLayoutEffect(() => {
    if (phoneCaret.current !== null && phoneInput.current) {
      phoneInput.current.setSelectionRange(phoneCaret.current, phoneCaret.current)
      phoneCaret.current = null
    }
  })

  const updatePhone = (raw: string, caret: number): void => {
    const formatted = formatLoginPhone(raw)
    phoneCaret.current = phoneCaretAfterEdit(raw, caret, formatted)
    setPhone(formatted)
  }

  const sendCode = async (): Promise<void> => {
    if (submitting || !idpPhone) return
    setSubmitting(true)
    setError(null)
    try {
      await requestLoginCode(idpPhone)
      setStep('code')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось отправить SMS.')
    } finally {
      setSubmitting(false)
    }
  }

  const verify = async (): Promise<void> => {
    if (submitting || !idpPhone || code.length < 5) return
    setSubmitting(true)
    setError(null)
    try {
      await verifyLoginCode(idpPhone, code)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Неверный код.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="auth-page"><header><BrandMark /><strong>AlephMeets</strong><WindowControls /></header><span className="spinner" /></div>

  return (
    <div className="auth-page">
      <header><BrandMark /><strong>AlephMeets</strong><WindowControls /></header>
      <main className="auth-card">
        <span className="auth-icon">{step === 'phone' ? <Phone /> : <MessageSquareText />}</span>
        <p className="eyebrow">Aleph ID</p>
        <h1>{step === 'phone' ? 'Вход по телефону' : 'Введите код из SMS'}</h1>
        <p>{step === 'phone' ? 'Используйте номер, зарегистрированный в Aleph ID.' : `Код отправлен на номер ${phone}.`}</p>
        {step === 'phone' ? (
          <label className="auth-field"><span>Номер телефона</span><input
            ref={phoneInput}
            type="tel"
            name="phone"
            value={phone}
            onChange={(event) => updatePhone(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { void sendCode(); return }
              if (event.key !== 'Backspace' && event.key !== 'Delete') return
              const input = event.currentTarget
              const start = input.selectionStart ?? 0
              if (start !== input.selectionEnd) return
              // Delete the adjacent digit, skipping mask punctuation and the country code.
              const direction = event.key === 'Backspace' ? -1 : 1
              let index = direction === -1 ? start - 1 : start
              while (index >= 2 && index < phone.length && !/\d/.test(phone[index]!)) index += direction
              if (index < 2 || index >= phone.length) return
              event.preventDefault()
              updatePhone(phone.slice(0, index) + phone.slice(index + 1), index)
            }}
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            placeholder="+7 (999) 123-45-67"
          /></label>
        ) : (
          <label className="auth-field"><span>Код подтверждения</span><input className="auth-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 10))} onKeyDown={(event) => event.key === 'Enter' && code.length >= 5 && void verify()} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="000000" /></label>
        )}
        {(error || sessionError) && <p className="form-error">{error || sessionError}</p>}
        {step === 'phone' ? (
          <button className="button primary full auth-submit" onClick={() => void sendCode()} disabled={!idpPhone || submitting}>{submitting ? 'Отправка...' : 'Получить код'}</button>
        ) : <>
          <button className="button primary full auth-submit" onClick={() => void verify()} disabled={code.length < 5 || submitting}>{submitting ? 'Проверка...' : 'Войти'}</button>
          <div className="auth-secondary-actions"><button disabled={submitting} onClick={() => { setStep('phone'); setCode(''); setError(null) }}><ArrowLeft size={15} />Изменить номер</button><button disabled={submitting} onClick={() => void sendCode()}>Отправить повторно</button></div>
        </>}
        <small className="auth-security"><LockKeyhole size={14} />Для сохранения сессии используется защищённое хранилище системы.</small>
        <small className="auth-version">Версия {version}</small>
      </main>
    </div>
  )
}
