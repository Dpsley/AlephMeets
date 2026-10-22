import { spawnSync } from 'node:child_process'

export function supportsMacAutoUpdate(executable: string): boolean {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', executable], {
    encoding: 'utf8', timeout: 5_000,
  })
  // Ad-hoc signatures pass codesign --verify but cannot establish a stable
  // signing identity between releases for Squirrel.Mac.
  return result.status === 0
    && !/Signature=adhoc/.test(result.stderr)
    && /^TeamIdentifier=(?!not set\s*$)\S+/m.test(result.stderr)
}
