import { uid } from './books.mjs'
import { fetchShift, fetchReceipts, fetchAdjustments } from './kitchen.mjs'

// 采录落账：登记新资料版，已提交视图并入餐商侧事实。
// 换一批出勤（资料版切换）时旧版数据保留，队列与待办不动，接着对账。
export function applyCollected(books, collected) {
  const previous = books.currentEdition
  books.editions[collected.edition] = {
    collectedAt: new Date().toISOString(),
    attendance: collected.attendance,
    serves: collected.serves,
    submitted: collected.submitted
  }
  books.currentEdition = collected.edition
  for (const row of collected.submitted.filter(r => r.session === books.session)) {
    let fact = books.booked.find(b => b.person === row.person && b.session === row.session)
    if (!fact) {
      fact = { person: row.person, session: row.session }
      books.booked.push(fact)
    }
    fact.point = row.point
    fact.mealType = row.mealType
    fact.batch = row.batch
    fact.submittedState = row.state
    if (row.state === 'confirmed' && !fact.kitchenState) fact.source = 'business-confirmed'
  }
  return { previous, current: collected.edition, switched: previous !== null && previous !== collected.edition }
}

function ensureTodo(books, item) {
  const existing = books.todos.find(t => t.kind === item.kind && t.person === item.person &&
    t.session === item.session && t.status === 'open' && (item.point === undefined || t.point === item.point))
  if (existing) {
    existing.label = item.label
    return existing
  }
  const todo = { id: uid('t'), status: 'open', createdAt: new Date().toISOString(), ...item }
  books.todos.push(todo)
  return todo
}

function closeTodos(books, predicate, note) {
  const closed = []
  for (const t of books.todos) {
    if (t.status === 'open' && predicate(t)) {
      t.status = 'done'
      t.closedAt = new Date().toISOString()
      t.note = note
      closed.push(t)
    }
  }
  return closed
}

// 回读：各点关单状态 + 各批号实际回执 + 补单入账事实。
// 只有餐商回执确认的行才计入结账；补单待办在读到到账（settled）回执时才销掉。
export async function readback(books, kitchenRoot) {
  const changes = []
  const shift = await fetchShift(kitchenRoot)
  if (shift) {
    books.shift = shift
    changes.push(`关单状态：${shift.map(s => `${s.site}/${s.meal}=${s.state}`).join('，')}`)
  }
  const batches = [...new Set(books.booked.map(b => b.batch).filter(Boolean))]
  for (const batch of batches) {
    const rows = await fetchReceipts(kitchenRoot, batch)
    if (!rows) continue
    books.receipts[batch] = rows
    for (const row of rows) {
      const fact = books.booked.find(b => b.person === row.person && b.session === books.session)
      if (!fact) continue
      fact.kitchenState = row.state
      if (row.receipt) fact.kitchenReceipt = row.receipt
      const line = books.lines[books.session + '|' + row.person]
      if (row.state === 'accepted') {
        fact.source = fact.source || 'kitchen'
        // 只有与当前核定行同点同餐型时，才把对账行标记为已入账；
        // 旧归属点的回执不动新点录入的行。
        if (line && line.genuine && line.genuine.point === fact.point && line.genuine.mealType === fact.mealType) {
          line.status = 'booked'
          line.booked = fact
        }
        for (const t of closeTodos(books, t => t.person === row.person && t.point === fact.point && ['await-receipt', 'await-review'].includes(t.kind), `批次 ${batch} 回执 ${row.receipt} 已接受`)) {
          changes.push(`销待办：${t.label}`)
        }
        changes.push(`${row.person}：批次 ${batch} 回执 ${row.receipt} accepted，计入结账`)
      } else if (row.state === 'needs-review') {
        const t = ensureTodo(books, {
          kind: 'await-review', person: row.person, session: books.session, point: fact.point,
          label: `${row.person} 批次 ${batch} 回执 needs-review，等餐商复核，暂不计入结账`
        })
        changes.push(`待办：${t.label}`)
      } else if (row.state === 'duplicate') {
        if (line && line.genuine && line.genuine.point === fact.point) line.status = 'rejected'
        for (const t of closeTodos(books, t => t.person === row.person && t.point === fact.point && ['await-receipt', 'await-review'].includes(t.kind), `批次 ${batch} 判为 duplicate`)) {
          changes.push(`销待办：${t.label}`)
        }
        const t = ensureTodo(books, {
          kind: 'duplicate', person: row.person, session: books.session, point: fact.point,
          label: `${row.person} 在 ${fact.point} 的行被批次 ${batch} 判为 duplicate（回执 ${row.receipt}），等补单入账事实核销`
        })
        changes.push(`待办：${t.label}`)
      }
    }
  }
  const adjustments = await fetchAdjustments(kitchenRoot)
  if (adjustments) {
    for (const adj of adjustments) {
      let seen = books.adjustments.find(a => a.person === adj.person && a.site === adj.site && a.base === adj.base)
      if (!seen) {
        seen = { person: adj.person, site: adj.site, base: adj.base }
        books.adjustments.push(seen)
      }
      seen.state = adj.state
      if (adj.receipt) seen.receipt = adj.receipt
      if (adj.state === 'settled') {
        // 补单到账：销掉该人该点的补单/重复行待办。
        for (const t of closeTodos(books,
          t => t.person === adj.person && (t.point === adj.site || t.from === adj.site) && ['duplicate', 'supplement'].includes(t.kind),
          `补单回执 ${adj.receipt} 已到账（基于 ${adj.base}）`)) {
          changes.push(`销待办：${t.label}`)
        }
        changes.push(`${adj.person} 在 ${adj.site} 的补单已到账（回执 ${adj.receipt}）`)
      } else {
        changes.push(`${adj.person} 在 ${adj.site} 的补单状态 ${adj.state}（基于 ${adj.base}），未到账不销待办`)
      }
    }
  }
  return changes
}

// 待录入计划：对账为 ready 且责任点未关单的行。
export function entryPlan(books, session = books.session) {
  const shift = new Map(books.shift.filter(s => s.meal === session).map(s => [s.site, s.state]))
  return Object.values(books.lines)
    .filter(l => l.session === session && l.status === 'ready' && l.genuine)
    .map(l => ({
      person: l.person,
      session,
      point: l.genuine.point,
      mealType: l.genuine.mealType,
      serveId: l.genuine.serveId,
      minute: l.genuine.minute,
      manual: Boolean(l.genuine.manual),
      pointState: shift.get(l.genuine.point) || 'unknown'
    }))
}

// 录入结果落账。
export function applyEntries(books, results, plan, edition) {
  const notes = []
  for (const res of results) {
    const row = plan.find(p => p.person === res.person && p.point + ':' + p.mealType === res.value)
    if (res.ok) {
      books.entries.push({
        person: res.person, session: res.session, point: row.point, mealType: row.mealType,
        state: 'confirmed', receipt: res.receipt, edition, at: new Date().toISOString()
      })
      const line = books.lines[res.session + '|' + res.person]
      if (line) {
        line.status = 'entered'
        line.receipt = res.receipt
      }
      ensureTodo(books, {
        kind: 'await-receipt', person: res.person, session: res.session, point: row.point,
        label: `${res.person} ${res.value} 已在登记页确认（凭据 ${res.receipt}），等餐商批次回执，未计入结账`
      })
      notes.push(`${res.person} ${res.value} 确认，凭据 ${res.receipt}`)
    } else if (res.locked) {
      let fact = books.booked.find(b => b.person === res.person && b.session === res.session)
      if (!fact) {
        fact = { person: res.person, session: res.session }
        books.booked.push(fact)
      }
      Object.assign(fact, { point: row.point, mealType: row.mealType, submittedState: 'confirmed', source: 'business-confirmed' })
      const line = books.lines[res.session + '|' + res.person]
      if (line) line.status = 'booked'
      notes.push(`${res.person} ${res.value} 页面拒绝：业务方已确认，按已入账保留`)
    } else if (res.alreadyConfirmed) {
      const line = books.lines[res.session + '|' + res.person]
      if (line) line.status = 'entered'
      notes.push(`${res.person} ${res.value} 已有确认回执，不重复录入`)
    } else if (res.error === 'edition-changed') {
      notes.push(`${res.person} ${res.value} 被拒绝：资料版已更换，请重新 collect 后再录入`)
    } else {
      notes.push(`${res.person} ${res.value} 录入失败：${res.error || '页面未给回执'}`)
    }
  }
  return notes
}

// 结账：只算餐商 actual 行事实（accepted 回执）与已到账补单；
// 待回执、待复核、重复行、未到账补单一律不计入。
export function settlement(books, session = books.session) {
  const accepted = books.booked.filter(b => b.session === session && b.kitchenState === 'accepted')
  const byPoint = new Map()
  for (const fact of accepted) {
    if (!byPoint.has(fact.point)) byPoint.set(fact.point, [])
    byPoint.get(fact.point).push(fact)
  }
  const points = [...byPoint].sort().map(([point, facts]) => ({
    point,
    state: (books.shift.find(s => s.site === point && s.meal === session) || {}).state || 'unknown',
    rows: facts.map(f => ({ person: f.person, mealType: f.mealType, batch: f.batch, receipt: f.kitchenReceipt })),
    byMealType: facts.reduce((acc, f) => ({ ...acc, [f.mealType]: (acc[f.mealType] || 0) + 1 }), {})
  }))
  return {
    session,
    points,
    adjustments: books.adjustments.filter(a => a.state === 'settled'),
    pending: books.todos.filter(t => t.status === 'open')
  }
}
