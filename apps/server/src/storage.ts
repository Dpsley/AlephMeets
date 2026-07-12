import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import axios from 'axios'
import FormData from 'form-data'
import { config } from './config.js'

export interface UploadedStorageFile {
  storageName: string
  storageKey: string
  storageUrl: string
  storageBucket: string
  storageProvider: 's3'
  byteSize: number
}

interface UploadStreamInput {
  stream: Readable
  originalName: string
  mimeType: string
  scopePath: string
  storageName?: string
}

export function randomStorageSuffix(length = 16): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function sanitizeFilenamePart(value: string, fallback: string): string {
  const sanitized = value
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .trim()
    .slice(0, 140)
  return sanitized || fallback
}

function splitFilename(filename: string): { name: string; extension: string } {
  const cleaned = filename
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .trim()
  const dotIndex = cleaned.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === cleaned.length - 1) {
    return { name: sanitizeFilenamePart(cleaned, 'file'), extension: '' }
  }
  return {
    name: sanitizeFilenamePart(cleaned.slice(0, dotIndex), 'file'),
    extension: cleaned.slice(dotIndex).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 24).toLowerCase(),
  }
}

function sanitizePathSegment(value: string): string {
  return sanitizeFilenamePart(value, 'item').replace(/\./g, '-')
}

export function buildStorageScope(...segments: string[]): string {
  return [config.s3RootPath, ...segments.map(sanitizePathSegment)]
    .map(trimSlashes)
    .filter(Boolean)
    .join('/')
}

export function attachmentStorageName(originalName: string, suffix = randomStorageSuffix()): string {
  const { name, extension } = splitFilename(originalName)
  return `${name}-${suffix}${extension}`
}

export function recordingStorageName(
  originalName: string,
  startsAt: Date | string | null | undefined,
  suffix = randomStorageSuffix(),
): string {
  const { extension } = splitFilename(originalName)
  const date = startsAt ? new Date(startsAt) : new Date()
  const stamp = Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString()
  const safeStamp = stamp.replace('T', '_').replace(/[:.]/g, '-').replace(/Z$/, '')
  return `${safeStamp}-${suffix}${extension || '.webm'}`
}

export function buildStoragePublicUrl(bucket: string, storageKey: string): string {
  const encodedBucket = encodeURIComponent(bucket)
  const encodedKey = storageKey.split('/').map(encodeURIComponent).join('/')
  return `${config.s3PublicBaseUrl}/${encodedBucket}/${encodedKey}`
}

function strictEncodeUrlSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  let byteSize = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteSize += buffer.length
    if (byteSize > config.maxUploadBytes) {
      throw Object.assign(new Error('Upload file is too large'), { statusCode: 413 })
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, byteSize)
}

function formContentLength(form: FormData): Promise<number> {
  return new Promise((resolve, reject) => {
    form.getLength((error, length) => {
      if (error) reject(error)
      else resolve(length)
    })
  })
}

function retryableS3Status(status: number | undefined): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

function truncateS3Response(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value ?? null)
  return text.length > 700 ? `${text.slice(0, 700)}...` : text
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function uploadStreamToS3(input: UploadStreamInput): Promise<UploadedStorageFile> {
  if (!config.s3UploadAuth) {
    throw Object.assign(new Error('S3_UPLOAD_AUTH is not configured'), { statusCode: 500 })
  }

  const storageName = input.storageName ?? attachmentStorageName(input.originalName)
  const scopePath = trimSlashes(input.scopePath)
  const storageKey = `${scopePath}/${storageName}`
  const body = await streamToBuffer(input.stream)

  const uploadUrl = `${config.s3UploadBaseUrl}/upload-by-path/${strictEncodeUrlSegment(config.s3Bucket)}/${strictEncodeUrlSegment(storageName)}/0`

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const form = new FormData()
    form.append('file', body, {
      filename: storageName,
      contentType: input.mimeType || 'application/octet-stream',
      knownLength: body.length,
    })
    form.append('path', `/${scopePath}`)
    const contentLength = await formContentLength(form)

    try {
      await axios.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
          'Content-Length': String(contentLength),
          auth: config.s3UploadAuth,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120_000,
      })
      break
    } catch (error) {
      if (!axios.isAxiosError(error)) throw error
      const status = error.response?.status
      if (attempt < 3 && retryableS3Status(status)) {
        await wait(250 * attempt)
        continue
      }
      const suffix = status ? ` (${status})` : ''
      const responseBody = truncateS3Response(error.response?.data)
      throw Object.assign(new Error(`S3 upload failed${suffix}: ${responseBody}`), {
        statusCode: 502,
        s3StatusCode: status,
        s3Url: uploadUrl,
        storageName,
        storageKey,
        byteSize: body.length,
        attempt,
      })
    }
  }

  return {
    storageName,
    storageKey,
    storageUrl: buildStoragePublicUrl(config.s3Bucket, storageKey),
    storageBucket: config.s3Bucket,
    storageProvider: 's3',
    byteSize: body.length,
  }
}
