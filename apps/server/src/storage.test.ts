import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachmentStorageName,
  buildStoragePublicUrl,
  buildStorageScope,
  recordingStorageName,
} from './storage.js'

test('attachmentStorageName keeps original name and appends 16-character suffix', () => {
  assert.equal(attachmentStorageName('invoice.final.pdf', '1234567890abcdef'), 'invoice.final-1234567890abcdef.pdf')
})

test('recordingStorageName uses meeting start date and source extension', () => {
  assert.equal(
    recordingStorageName('call.webm', '2026-06-29T10:15:30.000Z', 'fedcba0987654321'),
    '2026-06-29_10-15-30-000-fedcba0987654321.webm',
  )
})

test('buildStorageScope nests objects under alephmeets root', () => {
  assert.equal(buildStorageScope('chats', 'chat/with/slash', 'attachments'), 'alephmeets/chats/chat-with-slash/attachments')
})

test('buildStoragePublicUrl encodes storage key segments', () => {
  const url = buildStoragePublicUrl('bucket', 'alephmeets/chats/chat-1/файл 1.png')
  assert.ok(url.endsWith('/bucket/alephmeets/chats/chat-1/%D1%84%D0%B0%D0%B9%D0%BB%201.png'))
})
