import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { run } from '../desk/cli.mjs'
import { loadBooks } from '../desk/books.mjs'
import { settlement } from '../desk/ops.mjs'

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

test('值班台端到端：采录、对账、录入、回读、换批接着对账、补单到账销待办', async t => {
  const source = await listen(t, createSource())
  const kitchen = await listen(t, provider())
  const dir = await mkdtemp(join(tmpdir(), 'desk-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const env = { source, kitchen, books: join(dir, 'books.json'), session: 'lunch' }
  const books = () => loadBooks(env.books)

  // 采录第一批出勤（r1）
  await run(['collect'], env)
  let b = await books()
  assert.equal(b.currentEdition, 'r1')
  assert.equal(b.editions.r1.attendance.length, 4)
  assert.equal(b.editions.r1.serves.length, 4)
  assert.equal(b.editions.r1.submitted.length, 3)

  // 对账：M1 在 A 已确认，M2/M3 待录入
  await run(['reconcile'], env)
  b = await books()
  assert.equal(b.lines['lunch|M1'].status, 'booked')
  assert.equal(b.lines['lunch|M1'].genuine.point, 'A')
  assert.equal(b.lines['lunch|M2'].status, 'ready')
  assert.equal(b.lines['lunch|M3'].status, 'ready')

  // 录入：暂存 -> 校验 -> 确认，逐行进行
  await run(['enter'], env)
  b = await books()
  assert.equal(b.entries.length, 2)
  assert.ok(b.entries.every(e => e.state === 'confirmed' && e.receipt.startsWith('RC-')))
  assert.equal(b.lines['lunch|M2'].status, 'entered')
  assert.equal(b.lines['lunch|M3'].status, 'entered')
  assert.equal(b.todos.filter(x => x.kind === 'await-receipt' && x.status === 'open').length, 2)

  // 回读（关单前）：M1 accepted/K-1，M2 needs-review 留待办
  await run(['readback'], env)
  b = await books()
  assert.equal(b.booked.find(x => x.person === 'M1').kitchenReceipt, 'K-1')
  assert.equal(b.booked.find(x => x.person === 'M2').kitchenState, 'needs-review')
  assert.ok(b.todos.some(x => x.kind === 'await-review' && x.person === 'M2' && x.status === 'open'))

  // 换一批出勤（r2），接着对账
  await fetch(source + '/control?edition=r2', { method: 'POST' })
  await run(['collect'], env)
  await run(['reconcile'], env)
  b = await books()
  assert.equal(b.currentEdition, 'r2')
  assert.ok(b.editions.r1)
  // M1：已确认的 A 与按当时分钟核出的 B 冲突，进人工队列；确认项保留
  const conflict = b.queue.find(q => q.kind === 'attribution-conflict' && q.person === 'M1' && q.status === 'open')
  assert.ok(conflict)
  assert.equal(b.booked.find(x => x.person === 'M1').point, 'A')
  // M2：K5(B 729) 为真，K3(A 710) 成旧菜单残留；M3 不受影响
  assert.equal(b.lines['lunch|M2'].genuine.point, 'B')
  assert.ok(b.lines['lunch|M2'].dupes.some(d => d.serveId === 'K3'))
  assert.equal(b.lines['lunch|M3'].genuine.point, 'B')
  assert.equal(b.lines['lunch|M3'].status, 'entered')

  // 归属冲突：确认退 A 补 B，凭旧回执 K-1 走补单
  await run(['queue', 'resolve', conflict.id, '--adjust'], env)
  b = await books()
  const sup = b.todos.find(x => x.kind === 'supplement' && x.person === 'M1' && x.status === 'open')
  assert.ok(sup)
  assert.equal(sup.from, 'A')
  assert.equal(sup.to, 'B')
  assert.equal(sup.baseReceipt, 'K-1')

  // 录入新行：M1 B:special、M2 B:regular
  await run(['enter'], env)
  b = await books()
  assert.ok(b.entries.some(e => e.person === 'M1' && e.point === 'B' && e.mealType === 'special'))
  assert.ok(b.entries.some(e => e.person === 'M2' && e.point === 'B' && e.mealType === 'regular'))

  // 餐商推进到关单后：A 关单 B 未关；M2 判 duplicate；补单 received 未到账不销待办
  await fetch(kitchen + '/lab?stage=after-close', { method: 'POST' })
  await run(['readback'], env)
  b = await books()
  assert.equal(b.shift.find(s => s.site === 'A').state, 'closed')
  assert.equal(b.shift.find(s => s.site === 'B').state, 'open')
  assert.equal(b.booked.find(x => x.person === 'M2').kitchenState, 'duplicate')
  const dup = b.todos.find(x => x.kind === 'duplicate' && x.person === 'M2')
  assert.ok(dup && dup.status === 'open')
  assert.equal(b.adjustments.find(a => a.person === 'M2').state, 'received')
  // B 点未受影响的行仍继续：M3 行保持已录入，等回执待办仍在
  assert.equal(b.lines['lunch|M3'].status, 'entered')
  assert.ok(b.todos.some(x => x.kind === 'await-receipt' && x.person === 'M3' && x.status === 'open'))

  // 补单到账（settled）：销掉 M2 重复行待办；M1 的补单无到账回执，待办仍在
  await fetch(kitchen + '/lab?stage=settled', { method: 'POST' })
  await run(['readback'], env)
  b = await books()
  assert.equal(b.adjustments.find(a => a.person === 'M2').receipt, 'K-3')
  assert.equal(b.todos.find(x => x.id === dup.id).status, 'done')
  assert.ok(b.todos.some(x => x.kind === 'supplement' && x.person === 'M1' && x.status === 'open'))

  // 结账：只计餐商回执确认的行（M1 K-1）与已到账补单（M2 K-3）
  const s = settlement(b, 'lunch')
  assert.deepEqual(s.points.map(p => p.point), ['A'])
  assert.deepEqual(s.points[0].rows.map(r => r.receipt), ['K-1'])
  assert.deepEqual(s.adjustments.map(a => a.receipt), ['K-3'])
  assert.ok(s.pending.length >= 4)
})
