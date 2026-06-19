import { ArrowLeft, LockKeyhole, MessageSquareText, Phone } from 'lucide-react'
import { useState } from 'react'
import { useApp } from '../state/AppContext'
import { BrandMark } from '../components/BrandMark'
import { WindowControls } from '../components/WindowControls'

export function LoginPage(): React.JSX.Element {
  const { loading, error: sessionError, requestLoginCode, verifyLoginCode } = useApp()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendCode = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await requestLoginCode(phone)
      setStep('code')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось отправить SMS.')
    } finally {
      setSubmitting(false)
    }
  }

  const verify = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await verifyLoginCode(phone, code)
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
          <label className="auth-field"><span>Номер телефона</span><input value={phone} onChange={(event) => setPhone(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void sendCode()} inputMode="tel" autoComplete="tel" autoFocus placeholder="+7 999 123-45-67" /></label>
        ) : (
          <label className="auth-field"><span>Код подтверждения</span><input className="auth-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 10))} onKeyDown={(event) => event.key === 'Enter' && code.length >= 5 && void verify()} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="000000" /></label>
        )}
        {(error || sessionError) && <p className="form-error">{error || sessionError}</p>}
        {step === 'phone' ? (
          <button className="button primary full auth-submit" onClick={() => void sendCode()} disabled={phone.replace(/\D/g, '').length < 10 || submitting}>{submitting ? 'Отправка...' : 'Получить код'}</button>
        ) : <>
          <button className="button primary full auth-submit" onClick={() => void verify()} disabled={code.length < 5 || submitting}>{submitting ? 'Проверка...' : 'Войти'}</button>
          <div className="auth-secondary-actions"><button onClick={() => { setStep('phone'); setCode(''); setError(null) }}><ArrowLeft size={15} />Изменить номер</button><button onClick={() => void sendCode()}>Отправить повторно</button></div>
        </>}
        <small className="auth-security"><LockKeyhole size={14} />Сессия хранится в зашифрованном хранилище системы.</small>
      </main>
    </div>
  )
}
