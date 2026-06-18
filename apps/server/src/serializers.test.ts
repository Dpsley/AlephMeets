import assert from 'node:assert/strict'
import test from 'node:test'
import { camelizeRow } from './serializers.js'

test('camelizeRow maps database column names', () => {
  assert.deepEqual(camelizeRow({ display_name: 'Aleph', created_at: 1 }), {
    displayName: 'Aleph',
    createdAt: 1,
  })
})
