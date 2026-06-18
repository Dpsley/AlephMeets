import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeEwsUrl } from './exchange.js'

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
