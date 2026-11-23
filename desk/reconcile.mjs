import { uid } from './books.mjs'

// 出勤页上修改的责任点按实际领餐分钟生效：
// 某人在 minute 时刻的责任点与餐型，取生效分钟 <= minute 的最晚一条出勤记录。
export function effectiveAt(attendance, person, minute) {
  let best = null
  for (const row of attendance) {
    if (row.person !== person || row.minute > minute) continue
    if (!best || row.minute > best.minute) best = row
  }
  return best
}

// 按人及餐次核对现场流水。多个班并桌后同一人同一餐可能有多条流水：
// 只保留与当时责任点一致且最早的一条，其余记为重复；
// 同一天另一个餐次的流水互不影响（调用方已按餐次过滤）。
export function reconcilePerson(person, session, servesRows, attendance) {
  const scored = servesRows.map(serve => ({ serve, eff: effectiveAt(attendance, person, serve.minute) }))
  const matching = scored.filter(x => x.eff && x.serve.point === x.eff.point)
  if (!matching.length) {
    // 现场领取点与任何当时有效出勤记录都对不上：缺交班记录，留人工队列。
    return { problem: { kind: 'unmatched-pickup', person, session, candidates: scored } }
  }
  matching.sort((a, b) => a.serve.minute - b.serve.minute)
  const genuine = matching[0]
  const dupes = scored.filter(x => x !== genuine).map(x => ({
    serveId: x.serve.id,
    point: x.serve.point,
    minute: x.serve.minute,
    reason: x.eff && x.serve.point === x.eff.point ? '并桌重复' : '非当时责任点记录'
  }))
  if (genuine.serve.mealType !== genuine.eff.mealType) {
    // 特殊餐已实际发出但类型与当时有效餐型不匹配：留人工核对，不能自动当普通餐计费。
    return {
      problem: {
        kind: 'meal-type-mismatch', person, session,
        serve: genuine.serve, planned: genuine.eff.mealType, issued: genuine.serve.mealType
      },
      dupes
    }
  }
  return {
    genuine: {
      person, session,
      point: genuine.serve.point,
      mealType: genuine.serve.mealType,
      serveId: genuine.serve.id,
      minute: genuine.serve.minute
    },
    dupes
  }
}

// 已确认事实：餐商已接受（accepted）或业务方已确认的行。确认项保留，
// 不能见到最新点名页就把已确认的餐补到新点，只能走补单调整。
export function bookedFactFor(books, person, session) {
  return books.booked.find(b => b.person === person && b.session === session &&
    (b.kitchenState === 'accepted' || b.source === 'business-confirmed')) || null
}

function findOpenQueue(books, kind, person, session) {
  return books.queue.find(q => q.kind === kind && q.person === person &&
    q.session === session && (q.status === 'open' || q.status === 'recheck'))
}

function upsertQueue(books, item) {
  const existing = findOpenQueue(books, item.kind, item.person, item.session)
  if (existing) {
    existing.detail = item.detail
    existing.status = 'open'
    return existing
  }
  const row = { id: uid('q'), status: 'open', createdAt: new Date().toISOString(), ...item }
  books.queue.push(row)
  return row
}

const PICKUP_PROBLEMS = ['unmatched-pickup', 'meal-type-mismatch']

// 对当前资料版跑一轮对账。可重复执行：已处理的流水不会因重跑而重复入账。
export function reconcileBooks(books, session = books.session) {
  const ed = books.editions[books.currentEdition]
  if (!ed) throw new Error('尚未采录任何出勤批次')
  for (const q of books.queue) {
    if (q.status === 'open' && PICKUP_PROBLEMS.includes(q.kind)) q.status = 'recheck'
  }
  const byPerson = new Map()
  for (const s of ed.serves.filter(s => s.session === session)) {
    if (!byPerson.has(s.person)) byPerson.set(s.person, [])
    byPerson.get(s.person).push(s)
  }
  const out = { lines: [], queued: [], dupes: [] }
  for (const [person, rows] of [...byPerson].sort()) {
    const key = session + '|' + person
    const result = reconcilePerson(person, session, rows, ed.attendance)
    const line = books.lines[key] || { key, person, session }
    line.edition = books.currentEdition
    if (result.problem) {
      const q = upsertQueue(books, { kind: result.problem.kind, person, session, detail: result.problem })
      line.status = 'queued'
      line.problem = result.problem.kind
      out.queued.push(q)
    } else {
      line.genuine = { ...result.genuine, edition: books.currentEdition }
      line.dupes = result.dupes
      line.problem = null
      const booked = bookedFactFor(books, person, session)
      if (booked && (booked.point !== result.genuine.point || booked.mealType !== result.genuine.mealType)) {
        // 已入账事实与按当时分钟核出的归属不一致：归属冲突，留人工队列走补单。
        const q = upsertQueue(books, { kind: 'attribution-conflict', person, session, detail: { booked, genuine: line.genuine } })
        line.status = 'conflict'
        out.queued.push(q)
      } else if (booked) {
        line.status = 'booked'
        line.booked = booked
      } else {
        const entry = books.entries.find(e => e.person === person && e.session === session &&
          e.state === 'confirmed' && e.point === result.genuine.point && e.mealType === result.genuine.mealType)
        line.status = entry ? 'entered' : 'ready'
        if (entry) line.receipt = entry.receipt
      }
      out.dupes.push(...result.dupes.map(d => ({ person, ...d })))
    }
    books.lines[key] = line
    out.lines.push(line)
  }
  for (const q of books.queue) {
    if (q.status === 'recheck') {
      q.status = 'closed'
      q.resolution = '新批次下该问题已不存在'
    }
  }
  return out
}

// 人工队列处理。
export function resolveQueue(books, queueId, decision) {
  const q = books.queue.find(x => x.id === queueId && x.status === 'open')
  if (!q) throw new Error('没有该人工队列项（或已处理）')
  const key = q.session + '|' + q.person
  const line = books.lines[key] || { key, person: q.person, session: q.session }
  if (q.kind === 'unmatched-pickup') {
    if (decision.drop) {
      line.status = 'dropped'
      q.resolution = 'drop'
    } else {
      const serve = q.detail.candidates.map(c => c.serve).find(s => s.id === decision.pick)
      if (!serve) throw new Error('请用 --pick 指定一条现场流水（值班员已线下核实交班）')
      line.genuine = { person: q.person, session: q.session, point: serve.point, mealType: serve.mealType, serveId: serve.id, minute: serve.minute, manual: true }
      line.status = 'ready'
      q.resolution = 'pick ' + serve.id
    }
  } else if (q.kind === 'meal-type-mismatch') {
    if (!decision.mealType) throw new Error('请用 --meal-type 指定人工核对后的计费餐型')
    const serve = q.detail.serve
    line.genuine = { person: q.person, session: q.session, point: serve.point, mealType: decision.mealType, serveId: serve.id, minute: serve.minute, manual: true }
    line.status = 'ready'
    q.resolution = 'meal-type ' + decision.mealType
  } else if (q.kind === 'attribution-conflict') {
    if (!decision.adjust) throw new Error('请用 --adjust 确认退旧点补新点')
    const { booked, genuine } = q.detail
    const voucher = booked.kitchenReceipt || booked.receipt || ''
    books.todos.push({
      id: uid('t'), kind: 'supplement', person: q.person, session: q.session,
      from: booked.point, to: genuine.point, mealType: genuine.mealType,
      baseReceipt: voucher, status: 'open', createdAt: new Date().toISOString(),
      label: `退 ${booked.point} 补 ${genuine.point}（${q.person} ${q.session} ${genuine.mealType}），凭旧回执 ${voucher || '无'} 走补单，到账回执读出后才能销项`
    })
    line.genuine = genuine
    line.status = 'ready'
    q.resolution = 'adjust'
  } else {
    throw new Error('未知队列类型 ' + q.kind)
  }
  q.status = 'resolved'
  books.lines[key] = line
  return q
}
