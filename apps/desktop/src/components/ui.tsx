import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { initials } from '../lib/format'

export function Avatar({
  name,
  src,
  status,
  size = 'medium',
}: {
  name: string
  src?: string | null
  status?: string
  size?: 'small' | 'medium' | 'large'
}): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => setImageFailed(false), [src])

  return (
    <span className={clsx('avatar', `avatar-${size}`)} aria-label={name}>
      {src && !imageFailed
        ? <img src={src} alt="" onError={() => setImageFailed(true)} />
        : <span>{initials(name)}</span>}
      {status && <i className={clsx('presence', `presence-${status}`)} />}
    </span>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 520,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  width?: number
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal-card"
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode
  title: string
  text: string
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  )
}
