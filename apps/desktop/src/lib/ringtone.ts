export type RingtoneMode = 'classic' | 'soft' | 'digital' | 'silent'

export const RINGTONE_OPTIONS: Array<{ value: RingtoneMode; label: string }> = [
  { value: 'classic', label: 'Классический' },
  { value: 'soft', label: 'Мягкий' },
  { value: 'digital', label: 'Цифровой' },
  { value: 'silent', label: 'Без звука' },
]

const validModes = new Set<RingtoneMode>(RINGTONE_OPTIONS.map((option) => option.value))

export function storedRingtone(): RingtoneMode {
  const stored = localStorage.getItem('aleph-ringtone') as RingtoneMode | null
  return stored && validModes.has(stored) ? stored : 'classic'
}

export function startRingtone(mode: RingtoneMode, loop = true): () => void {
  if (mode === 'silent') return () => undefined
  const audioContext = new AudioContext()
  let active = true
  let interval: ReturnType<typeof setInterval> | undefined

  const pulse = (offset: number, duration: number, frequencies: number[], volume = 0.05): void => {
    if (!active || audioContext.state === 'closed') return
    const start = audioContext.currentTime + offset
    const gain = audioContext.createGain()
    gain.connect(audioContext.destination)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.025)
    gain.gain.setValueAtTime(volume, start + Math.max(0.03, duration - 0.08))
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    for (const frequency of frequencies) {
      const oscillator = audioContext.createOscillator()
      oscillator.frequency.setValueAtTime(frequency, start)
      oscillator.connect(gain)
      oscillator.start(start)
      oscillator.stop(start + duration + 0.02)
    }
  }

  const ring = (): void => {
    if (mode === 'classic') {
      pulse(0, 1.15, [440, 480], 0.055)
      return
    }
    if (mode === 'soft') {
      pulse(0, 0.45, [523, 659], 0.04)
      pulse(0.62, 0.45, [587, 698], 0.04)
      return
    }
    pulse(0, 0.22, [784], 0.045)
    pulse(0.32, 0.22, [659], 0.045)
    pulse(0.64, 0.32, [880], 0.05)
  }

  void audioContext.resume().then(() => {
    if (!active) return
    ring()
    if (loop) interval = setInterval(ring, mode === 'digital' ? 2_100 : 2_800)
  })

  return () => {
    active = false
    if (interval) clearInterval(interval)
    if (audioContext.state !== 'closed') void audioContext.close()
  }
}
