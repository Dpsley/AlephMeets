import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { config } from './config.js'
import { pool } from './db.js'
import {
  authenticateAccessToken,
  decryptIdpPayload,
  encryptAdServicePayload,
  encryptIdpPayload,
  findIdpContact,
  findIdpUserByEmail,
  issueSession,
  logoutSession,
  requestSms,
  refreshSession,
  userCanLoadAdContacts,
  verifySms,
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

test('uses the AD service envelope from the PHP example', () => {
  const secret = 'sixteen-byte-key'
  const encrypted = encryptAdServicePayload({ control_string: 'abc' }, secret)
  assert.deepEqual(decryptIdpPayload(encrypted, secret), { control_string: 'abc' })
  const envelope = Buffer.from(encrypted, 'base64')
  const delimiter = envelope.indexOf(Buffer.from('::'))
  const iv = envelope.subarray(delimiter + 2).toString('ascii')
  assert.match(iv, /^[0-9a-f]{16}$/)
})

test('loads AD contacts only for department users or alephtrade mailboxes', () => {
  assert.equal(userCanLoadAdContacts({ department: 'Sales', email: null }), true)
  assert.equal(userCanLoadAdContacts({ department: null, email: 'person@alephtrade.com' }), true)
  assert.equal(userCanLoadAdContacts({ department: null, email: 'person@corp.alephtrade.com' }), true)
  assert.equal(userCanLoadAdContacts({ department: null, email: 'person@example.com' }), false)
})

test('uses phone_probe, sms/send, sms/validate and user_info in order', async () => {
  const originalFetch = globalThis.fetch
  const testId = '90000000-0000-4000-8000-000000000001'
  const paths: string[] = []
  const requestPayloads: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { string: string }
      requestPayloads.push(decryptIdpPayload(body.string, config.idpEncodeKey))
    }
    let payload: unknown
    if (url.pathname.endsWith('/phone_probe')) {
      payload = { status: true, message: testId }
    } else if (url.pathname.endsWith('/sms/send')) {
      payload = {
        headers: {},
        original: { status: true, message: true },
        exception: null,
      }
    } else if (url.pathname.endsWith('/sms/validate')) {
      payload = { status: true, message: 'Move on' }
    } else if (url.pathname.endsWith('/user_info')) {
      assert.equal(new Headers(init?.headers).get('AUID'), testId)
      payload = {
        status: true,
        message: {
          id: testId,
          phone: '79990000009',
          name: 'Test',
          second_name: 'User',
          email: 'idp-flow-test@aleph.local',
          time_zone: 'Europe/Moscow',
        },
      }
    } else {
      throw new Error(`Unexpected IDP path: ${url.pathname}`)
    }
    return new Response(JSON.stringify([
      encryptIdpPayload(payload, config.idpDecodeKey),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    await requestSms('+7 999 000-00-09')
    const challenge = await pool.query(
      'SELECT auid, attempts FROM auth_login_challenges WHERE phone = $1',
      ['79990000009'],
    )
    assert.deepEqual(challenge.rows[0], { auid: testId, attempts: 0 })

    const result = await verifySms('+7 999 000-00-09', '123456')
    assert.equal(result.user.id, testId)
    assert.equal((await authenticateAccessToken(result.tokens.accessToken)).id, testId)
    assert.deepEqual(paths, [
      '/id/service/phone_probe',
      '/id/service/sms/send',
      '/id/service/sms/validate',
      '/id/service/user_info',
    ])
    assert.deepEqual(requestPayloads, [
      { phone: '79990000009' },
      { phone: '79990000009', message: ' - код входа в AlephMeets. Никому не сообщайте его.' },
      { phone: '79990000009', code: '123456' },
    ])
    assert.equal((await pool.query(
      'SELECT 1 FROM auth_login_challenges WHERE phone = $1',
      ['79990000009'],
    )).rowCount, 0)
  } finally {
    globalThis.fetch = originalFetch
    await pool.query('DELETE FROM users WHERE id = $1', [testId])
    await pool.query('DELETE FROM auth_login_challenges WHERE phone = $1', ['79990000009'])
  }
})

test('keeps the code-entry flow open during the IDP resend cooldown', async () => {
  const originalFetch = globalThis.fetch
  const testId = '90000000-0000-4000-8000-000000000002'
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    const payload = path.endsWith('/phone_probe')
      ? { status: true, message: testId }
      : {
          headers: {},
          original: { status: false, message: 'Send Timeout' },
          exception: null,
        }
    return new Response(JSON.stringify([
      encryptIdpPayload(payload, config.idpDecodeKey),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await requestSms('+7 999 000-00-08')
    assert.equal((await pool.query(
      'SELECT auid FROM auth_login_challenges WHERE phone = $1',
      ['79990000008'],
    )).rows[0]?.auid, testId)
  } finally {
    globalThis.fetch = originalFetch
    await pool.query('DELETE FROM auth_login_challenges WHERE phone = $1', ['79990000008'])
  }
})

test('merges first IDP sign-in into an AD-created user by email', async () => {
  const originalFetch = globalThis.fetch
  const adUserId = '90000000-0000-4000-8000-000000000020'
  const idpUserId = '90000000-0000-4000-8000-000000000021'
  const email = 'ad-merge@alephtrade.com'
  const phone = '79990000020'
  await pool.query(
    `INSERT INTO users (id, phone, email, display_name, department, timezone, locale)
     VALUES ($1,NULL,$2,$3,$4,'Europe/Moscow','ru-RU')`,
    [adUserId, email, 'AD Merge User', 'Trading'],
  )

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    let payload: unknown
    if (path.endsWith('/phone_probe')) {
      payload = { status: true, message: idpUserId }
    } else if (path.endsWith('/sms/send')) {
      payload = { headers: {}, original: { status: true, message: true }, exception: null }
    } else if (path.endsWith('/sms/validate')) {
      payload = { status: true, message: 'Move on' }
    } else if (path.endsWith('/user_info')) {
      payload = {
        status: true,
        message: {
          id: idpUserId,
          phone: null,
          name: 'IDP',
          second_name: 'Merge',
          email,
          department: null,
          time_zone: 'Europe/Moscow',
        },
      }
    } else {
      throw new Error(`Unexpected IDP path: ${path}`)
    }
    return new Response(JSON.stringify([
      encryptIdpPayload(payload, config.idpDecodeKey),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    await requestSms('+7 999 000-00-20')
    const result = await verifySms('+7 999 000-00-20', '123456')
    assert.equal(result.user.id, adUserId)
    assert.equal(result.user.phone, phone)
    assert.equal(result.user.department, 'Trading')
    const users = await pool.query(
      'SELECT id, phone, department FROM users WHERE lower(email) = $1 ORDER BY id',
      [email],
    )
    assert.equal(users.rowCount, 1)
    assert.deepEqual(users.rows[0], { id: adUserId, phone, department: 'Trading' })
    assert.equal((await authenticateAccessToken(result.tokens.accessToken)).id, adUserId)
  } finally {
    globalThis.fetch = originalFetch
    await pool.query('DELETE FROM auth_login_challenges WHERE phone = $1', [phone])
    await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [adUserId])
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[adUserId, idpUserId]])
  }
})

test('resolves a contact through email/get/user and user_info', async () => {
  const originalFetch = globalThis.fetch
  const testId = '90000000-0000-4000-8000-000000000003'
  const paths: string[] = []
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path.endsWith('/email/get/user')) {
      const body = JSON.parse(String(init?.body)) as { string: string }
      assert.deepEqual(decryptIdpPayload(body.string, config.idpEncodeKey), {
        email: 'contact-test@aleph.local',
      })
    }
    const payload = path.endsWith('/email/get/user')
      ? { status: true, message: 'Engineering', aleph_id: testId }
      : {
          status: true,
          message: {
            id: testId,
            phone: '79990000007',
            name: 'Contact',
            second_name: 'Test',
            email: 'contact-test@aleph.local',
            time_zone: 'Europe/Moscow',
          },
        }
    return new Response(JSON.stringify([
      encryptIdpPayload(payload, config.idpDecodeKey),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const user = await findIdpUserByEmail('CONTACT-TEST@aleph.local')
    assert.equal(user.id, testId)
    assert.deepEqual(paths, ['/id/service/email/get/user', '/id/service/user_info'])
  } finally {
    globalThis.fetch = originalFetch
    await pool.query('DELETE FROM users WHERE id = $1', [testId])
  }
})

test('resolves a contact through phone_probe and user_info', async () => {
  const originalFetch = globalThis.fetch
  const testId = '90000000-0000-4000-8000-000000000004'
  const paths: string[] = []
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path.endsWith('/phone_probe')) {
      const body = JSON.parse(String(init?.body)) as { string: string }
      assert.deepEqual(decryptIdpPayload(body.string, config.idpEncodeKey), {
        phone: '79990000006',
      })
    }
    const payload = path.endsWith('/phone_probe')
      ? { status: true, message: testId }
      : {
          status: true,
          message: {
            id: testId,
            phone: '79990000006',
            name: 'Phone',
            second_name: 'Contact',
            time_zone: 'Europe/Moscow',
          },
        }
    return new Response(JSON.stringify([
      encryptIdpPayload(payload, config.idpDecodeKey),
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const user = await findIdpContact('8 (999) 000-00-06')
    assert.equal(user.id, testId)
    assert.equal(user.email, null)
    assert.deepEqual(paths, ['/id/service/phone_probe', '/id/service/user_info'])
  } finally {
    globalThis.fetch = originalFetch
    await pool.query('DELETE FROM users WHERE id = $1', [testId])
  }
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
