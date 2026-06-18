import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptCredential, encryptCredential } from './credentials.js'

test('encrypts calendar credentials with authenticated encryption', () => {
  const encrypted = encryptCredential('secret-password')
  assert.notEqual(encrypted, 'secret-password')
  assert.equal(decryptCredential(encrypted), 'secret-password')
})
