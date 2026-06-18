import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { pool } from './db.js'
import {
  authenticateAccessToken,
  decryptIdpPayload,
  encryptIdpPayload,
  issueSession,
  logoutSession,
  refreshSession,
} from './idp.js'

const testUserId = '10000000-0000-4000-8000-000000000001'

after(async () => {
  await pool.end()
})

test('uses the IDP base64(ciphertext::IV) envelope', () => {
  const secret = 'sixteen-byte-key'
  const encrypted = encryptIdpPayload({ phone: '79990000001' }, secret)
  assert.deepEqual(decryptIdpPayload(encrypted, secret), { phone: '79990000001' })
  const envelope = Buffer.from(encrypted, 'base64')
  const delimiter = envelope.indexOf(Buffer.from('::'))
  assert.ok(delimiter > 0)
  assert.equal(envelope.subarray(delimiter + 2).length, 16)
})

test('rotates and revokes AlephMeets sessions', async () => {
  const tokens = await issueSession(testUserId)
  try {
    const user = await authenticateAccessToken(tokens.accessToken)
    assert.equal(user.id, testUserId)

    const rotated = await refreshSession(tokens.refreshToken)
    await assert.rejects(() => authenticateAccessToken(tokens.accessToken))
    assert.equal((await authenticateAccessToken(rotated.accessToken)).id, testUserId)

    await logoutSession(rotated.accessToken)
    await assert.rejects(() => authenticateAccessToken(rotated.accessToken))
  } finally {
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [testUserId])
  }
})
