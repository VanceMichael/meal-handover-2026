import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBooks } from '../desk/books.mjs'
import { reconcileBooks, resolveQueue, effectiveAt } from '../desk/reconcile.mjs'
import { applyCollected } from '../desk/ops.mjs'

const att = (person, point, minute, mealType = 'regular') => ({ person, group: 'red', point, minute, mealType })
const serve = (id, person, point, minute, mealType = 'regular', session = 'lunch') => ({ id, person, point, minute, session, mealType })

function booksWith(attendance, serves, submitted = []) {
  const books = emptyBooks()
  applyCollected(books, { edition: 'r1', attendance, serves, submitted })
  return books
}

test('责任点按实际领餐分钟生效', () => {
  const books = booksWith([att('M1', 'A', 675, 'special'), att('M1', 'B', 710, 'special')], [])
  const attendance = books.editions.r1.attendance
  assert.equal(effectiveAt(attendance, 'M1', 709).point, 'A')
  assert.equal(effectiveAt(attendance, 'M1', 710).point, 'B')
  assert.equal(effectiveAt(attendance, 'M1', 720).mealType, 'special')
})

test('并桌重复去重，同一孩子另一餐次真实发生', () => {
  const books = booksWith(
    [att('M1', 'A', 400), att('M1', 'A', 675)],
    [serve('K1', 'M1', 'A', 700), serve('K2', 'M1', 'A', 705), serve('K3', 'M1', 'A', 480, 'regular', 'breakfast')]
  )
  reconcileBooks(books, 'lunch')
  const lunch = books.lines['lunch|M1']
  assert.equal(lunch.genuine.serveId, 'K1')
  assert.deepEqual(lunch.dupes.map(d => d.serveId), ['K2'])
  assert.equal(lunch.dupes[0].reason, '并桌重复')
  reconcileBooks(books, 'breakfast')
  assert.equal(books.lines['breakfast|M1'].genuine.serveId, 'K3')
})

test('A 点菜单残留不与 B 点实领重复计', () => {
  const books = booksWith(
    [att('M1', 'A', 675), att('M1', 'B', 695)],
    [serve('K1', 'M1', 'A', 700), serve('K2', 'M1', 'B', 720)]
  )
  reconcileBooks(books, 'lunch')
  const line = books.lines['lunch|M1']
  assert.equal(line.genuine.point, 'B')
  assert.equal(line.genuine.serveId, 'K2')
  assert.deepEqual(line.dupes.map(d => d.serveId), ['K1'])
  assert.equal(line.dupes[0].reason, '非当时责任点记录')
})

test('缺交班记录进人工队列，不自动入账', () => {
  const books = booksWith([att('M1', 'A', 675)], [serve('K1', 'M1', 'B', 700)])
  reconcileBooks(books, 'lunch')
  const line = books.lines['lunch|M1']
  assert.equal(line.status, 'queued')
  assert.ok(!line.genuine)
  const q = books.queue.find(x => x.kind === 'unmatched-pickup' && x.status === 'open')
  assert.ok(q)
  resolveQueue(books, q.id, { pick: 'K1' })
  assert.equal(books.lines['lunch|M1'].status, 'ready')
  assert.equal(books.lines['lunch|M1'].genuine.point, 'B')
  assert.ok(books.lines['lunch|M1'].genuine.manual)
})

test('特殊餐实发与计划不符须人工核对，不能自动按普通餐', () => {
  const books = booksWith([att('M1', 'A', 675, 'special')], [serve('K1', 'M1', 'A', 700, 'regular')])
  reconcileBooks(books, 'lunch')
  const line = books.lines['lunch|M1']
  assert.equal(line.status, 'queued')
  assert.ok(!line.genuine)
  const q = books.queue.find(x => x.kind === 'meal-type-mismatch' && x.status === 'open')
  assert.equal(q.detail.planned, 'special')
  assert.equal(q.detail.issued, 'regular')
  resolveQueue(books, q.id, { mealType: 'special' })
  assert.equal(books.lines['lunch|M1'].genuine.mealType, 'special')
})

test('换一批出勤后接着对账：确认项保留，归属冲突走补单待办', () => {
  const submitted = [{ session: 'lunch', point: 'A', batch: 'DA', person: 'M1', mealType: 'special', state: 'confirmed' }]
  const books = booksWith(
    [att('M1', 'A', 675, 'special'), att('M1', 'B', 710, 'special')],
    [serve('K1', 'M1', 'A', 700, 'special'), serve('K2', 'M1', 'B', 720, 'special')],
    submitted
  )
  reconcileBooks(books, 'lunch')
  assert.equal(books.lines['lunch|M1'].status, 'booked')
  assert.equal(books.lines['lunch|M1'].genuine.point, 'A')
  applyCollected(books, {
    edition: 'r2',
    attendance: [att('M1', 'A', 675, 'special'), att('M1', 'B', 695, 'special')],
    serves: [serve('K1', 'M1', 'A', 700, 'special'), serve('K2', 'M1', 'B', 720, 'special')],
    submitted
  })
  reconcileBooks(books, 'lunch')
  const line = books.lines['lunch|M1']
  assert.equal(line.status, 'conflict')
  assert.equal(line.genuine.point, 'B')
  assert.equal(books.booked[0].point, 'A')
  books.booked[0].kitchenReceipt = 'K-1'
  const q = books.queue.find(x => x.kind === 'attribution-conflict' && x.status === 'open')
  resolveQueue(books, q.id, { adjust: true })
  const todo = books.todos.find(t => t.kind === 'supplement' && t.status === 'open')
  assert.equal(todo.from, 'A')
  assert.equal(todo.to, 'B')
  assert.equal(todo.baseReceipt, 'K-1')
  assert.equal(books.lines['lunch|M1'].status, 'ready')
})
