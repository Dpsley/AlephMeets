import brandIcon from '../assets/featherIcon.svg'

export function BrandMark({ small = false }: { small?: boolean }): React.JSX.Element {
  return <img className={`brand-mark${small ? ' small' : ''}`} src={brandIcon} alt="" aria-hidden="true" />
}
