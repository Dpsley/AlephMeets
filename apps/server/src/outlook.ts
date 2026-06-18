import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { rootDir } from './config.js'

const execFileAsync = promisify(execFile)
const bridgePath = resolve(rootDir, 'scripts/outlook-calendar.ps1')

export interface OutlookEvent {
  externalEventId: string
  subject: string
  body: string
  location: string
  startsAt: string
  endsAt: string
  organizer?: string
}

interface OutlookPayload {
  externalEventId?: string
  subject: string
  body?: string
  location?: string
  startsAt: string
  endsAt: string
  attendees?: string[]
}

async function invokeOutlook(args: string[]): Promise<unknown> {
  if (process.platform !== 'win32') {
    throw new Error('Outlook COM synchronization is available only on Windows')
  }
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath, ...args],
    { maxBuffer: 10 * 1024 * 1024 },
  )
  return JSON.parse(stdout.trim()) as unknown
}

export async function getOutlookStatus(): Promise<{ available: boolean; version?: string }> {
  return (await invokeOutlook(['-Action', 'status'])) as {
    available: boolean
    version?: string
  }
}

export async function listOutlookEvents(from: Date, to: Date): Promise<OutlookEvent[]> {
  return (await invokeOutlook([
    '-Action',
    'list',
    '-From',
    from.toISOString(),
    '-To',
    to.toISOString(),
  ])) as OutlookEvent[]
}

export async function upsertOutlookEvent(payload: OutlookPayload): Promise<OutlookEvent> {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return (await invokeOutlook(['-Action', 'upsert', '-PayloadBase64', encoded])) as OutlookEvent
}
