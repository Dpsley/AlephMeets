import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEwsRequestConfig, normalizeEwsUrl, normalizeNtlmCredentials } from './exchange.js'

const credentials = {
  serverUrl: 'https://mail.example.com/owa',
  email: 'user@example.com',
  username: 'EXAMPLE\\user',
  password: 'secret',
  domain: '',
  authMethod: 'ntlm' as const,
  verifyTls: true,
}

test('converts an OWA address to the EWS endpoint', () => {
  assert.equal(
    normalizeEwsUrl('https://mail.example.com/owa/auth/logon.aspx'),
    'https://mail.example.com/EWS/Exchange.asmx',
  )
})

test('keeps an explicit EWS endpoint', () => {
  assert.equal(
    normalizeEwsUrl('https://mail.example.com/EWS/Exchange.asmx'),
    'https://mail.example.com/EWS/Exchange.asmx',
  )
})

test('normalizes a DOMAIN\\username NTLM login', () => {
  assert.deepEqual(normalizeNtlmCredentials(credentials), {
    domain: 'EXAMPLE',
    username: 'user',
    password: 'secret',
  })
})

test('keeps 401 responses available to the NTLM interceptor', () => {
  const config = buildEwsRequestConfig(credentials, '<m:GetFolder />')
  assert.equal(config.validateStatus, undefined)
  assert.equal((config.httpsAgent as { options: { keepAlive?: boolean } }).options.keepAlive, true)
  assert.equal(config.headers?.['X-AnchorMailbox'], credentials.email)
})
