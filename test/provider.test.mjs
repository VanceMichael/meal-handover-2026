import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('本批实际回执分行，关单和补单分别变化', async t => {
  const root = await listen(t)
  const first = await (await fetch(root + '/kitchen/receipts?batch=M1')).json()
  assert.deepEqual(first.map(row => row.state), ['accepted', 'needs-review'])
  await post(root, '/lab?stage=after-close')
  assert.equal((await (await fetch(root + '/kitchen/shift')).json())[1].state, 'open')
  assert.equal((await (await fetch(root + '/kitchen/adjustments')).json())[0].state, 'received')
  await post(root, '/lab?stage=settled')
  assert.equal((await (await fetch(root + '/kitchen/adjustments')).json())[0].receipt, 'K-3')
})
