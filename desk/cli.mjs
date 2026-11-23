#!/usr/bin/env node
// 值班台：对托管登记页与餐商接口做采录、对账、录入、回读的本地演练。
// 用法：node desk/cli.mjs <命令> [参数]
//   collect                 采录出勤/现场流水/已提交三视图（自动翻页），登记资料版
//   reconcile               按人及餐次对账（责任点按实际领餐分钟生效）
//   plan                    查看待录入计划（按各点关单状态）
//   enter                   逐行录入：暂存 -> 校验 -> 确认（同一批可以只接一部分）
//   readback                回读各行接收结果、批号回执、补单入账，刷新待办
//   queue list              人工队列
//   queue resolve <id> ...  处理队列：--pick <流水> | --drop | --meal-type <餐型> | --adjust
//   todos                   待办（等回执 / 重复行 / 补单 / 关单后事项）
//   settle                  结账（只计餐商回执确认的行与已到账补单）
//   status                  台账总览
// 环境：DESK_SOURCE（默认 http://127.0.0.1:8700）DESK_KITCHEN（默认 http://127.0.0.1:8701）
//       DESK_BOOKS（默认 desk/state/books.json）DESK_SESSION（默认 lunch）
import { loadBooks, saveBooks } from './books.mjs'
import { reconcileBooks, resolveQueue } from './reconcile.mjs'
import { applyCollected, readback, entryPlan, applyEntries, settlement } from './ops.mjs'
import { collectViews, enterRows } from './browser.mjs'

const SOURCE = process.env.DESK_SOURCE || 'http://127.0.0.1:8700'
const KITCHEN = process.env.DESK_KITCHEN || 'http://127.0.0.1:8701'
const BOOKS = process.env.DESK_BOOKS || new URL('./state/books.json', import.meta.url).pathname
const SESSION = process.env.DESK_SESSION || 'lunch'

const MEAL_TYPE_LABEL = { regular: '普通餐', special: '特殊餐' }
const label = t => MEAL_TYPE_LABEL[t] || t

function show(line = '') {
  process.stdout.write(line + '\n')
}

function showLine(l) {
  const g = l.genuine
  const parts = [`${l.person} ${l.session}`]
  if (g) parts.push(`-> ${g.point} ${label(g.mealType)}（流水 ${g.serveId} @${g.minute}${g.manual ? '，人工核定' : ''}）`)
  parts.push(`[${l.status}]`)
  if (l.dupes?.length) parts.push(`去重 ${l.dupes.map(d => `${d.serveId}(${d.reason})`).join('、')}`)
  if (l.receipt) parts.push(`凭据 ${l.receipt}`)
  if (l.booked?.kitchenReceipt) parts.push(`餐商回执 ${l.booked.kitchenReceipt}`)
  show('  ' + parts.join(' '))
}

function showQueue(q) {
  show(`  ${q.id} [${q.kind}] ${q.person} ${q.session}（${q.status}）`)
  if (q.kind === 'unmatched-pickup') {
    show('    现场流水与当时责任点对不上，疑似缺交班记录：')
    for (const c of q.detail.candidates) {
      const eff = c.eff ? `${c.eff.point}（生效 ${c.eff.minute}）` : '无出勤记录'
      show(`    - 流水 ${c.serve.id}：${c.serve.point} @${c.serve.minute} ${label(c.serve.mealType)}，当时责任点 ${eff}`)
    }
    show(`    处理：queue resolve ${q.id} --pick <流水号>（已线下核实交班）或 --drop（旧菜单残留）`)
  } else if (q.kind === 'meal-type-mismatch') {
    show(`    流水 ${q.detail.serve.id} 实发 ${label(q.detail.issued)}，当时有效餐型 ${label(q.detail.planned)}`)
    show('    特殊餐已实际发出但类型不匹配，需人工核对计费餐型，不能自动按普通餐：')
    show(`    处理：queue resolve ${q.id} --meal-type special|regular`)
  } else if (q.kind === 'attribution-conflict') {
    const b = q.detail.booked
    const g = q.detail.genuine
    show(`    餐商已确认 ${b.point} ${label(b.mealType)}（回执 ${b.kitchenReceipt || b.receipt || '无'}），按当时分钟核出应在 ${g.point}`)
    show('    确认项保留，归属调整须凭旧回执走补单（退旧点补新点）：')
    show(`    处理：queue resolve ${q.id} --adjust`)
  }
}

function showTodo(t) {
  show(`  ${t.id} [${t.kind}] ${t.label}（${t.status}）`)
}

export async function run(argv, env = {}) {
  const books = await loadBooks(env.books || BOOKS)
  books.session = env.session || SESSION
  const [command, ...args] = argv
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
    else positional.push(args[i])
  }

  if (command === 'collect') {
    const collected = await collectViews(env.source || SOURCE)
    const r = applyCollected(books, collected)
    await saveBooks(env.books || BOOKS, books)
    show(`已采录资料版 ${r.current}：出勤 ${collected.attendance.length} 行，现场流水 ${collected.serves.length} 行，已提交 ${collected.submitted.length} 行`)
    if (r.switched) show(`出勤批次已更换（${r.previous} -> ${r.current}），旧版数据保留，可接着对账`)
    return 0
  }

  if (command === 'reconcile') {
    const out = reconcileBooks(books, books.session)
    await saveBooks(env.books || BOOKS, books)
    show(`对账完成（资料版 ${books.currentEdition}，餐次 ${books.session}）：`)
    for (const l of out.lines) showLine(l)
    if (out.queued.length) show(`人工队列新增/更新 ${out.queued.length} 项，用 queue list 查看`)
    return 0
  }

  if (command === 'plan') {
    const plan = entryPlan(books, books.session)
    if (!plan.length) show('没有待录入的行')
    for (const p of plan) {
      show(`  ${p.person} ${p.session} -> ${p.point}:${p.mealType}（流水 ${p.serveId} @${p.minute}${p.manual ? '，人工核定' : ''}）该点状态 ${p.pointState}`)
    }
    return 0
  }

  if (command === 'enter') {
    const plan = entryPlan(books, books.session)
    const open = plan.filter(p => p.pointState !== 'closed')
    const blocked = plan.filter(p => p.pointState === 'closed')
    for (const p of blocked) {
      show(`  ${p.person} ${p.point}:${p.mealType} 该点已关单，过截止只收补单，请走补单流程`)
    }
    if (!open.length) {
      show('没有可录入的行')
      return 0
    }
    const results = await enterRows(env.source || SOURCE, open)
    const notes = applyEntries(books, results, open, books.currentEdition)
    await saveBooks(env.books || BOOKS, books)
    show(`录入完成（本批 ${open.length} 行，逐行处理，可以只接一部分）：`)
    for (const n of notes) show('  ' + n)
    return 0
  }

  if (command === 'readback') {
    const changes = await readback(books, env.kitchen || KITCHEN)
    await saveBooks(env.books || BOOKS, books)
    show('回读结果：')
    for (const c of changes) show('  ' + c)
    if (!changes.length) show('  （无新变化）')
    return 0
  }

  if (command === 'queue') {
    const [sub, ...rest] = [positional[0], ...positional.slice(1)]
    if (sub === 'resolve') {
      const id = positional[1]
      const q = resolveQueue(books, id, {
        pick: flags.pick, drop: Boolean(flags.drop), mealType: flags['meal-type'], adjust: Boolean(flags.adjust)
      })
      await saveBooks(env.books || BOOKS, books)
      show(`已处理 ${q.id}：${q.resolution}`)
      const line = books.lines[q.session + '|' + q.person]
      if (line) showLine(line)
      return 0
    }
    const open = books.queue.filter(q => q.status === 'open')
    if (!open.length) show('人工队列为空')
    for (const q of open) showQueue(q)
    return 0
  }

  if (command === 'todos') {
    const open = books.todos.filter(t => t.status === 'open')
    if (!open.length) show('待办为空')
    for (const t of open) showTodo(t)
    return 0
  }

  if (command === 'settle') {
    const s = settlement(books, books.session)
    show(`结账（餐次 ${s.session}，只计餐商回执确认的行）：`)
    for (const p of s.points) {
      show(`  ${p.point} 点（${p.state}）：${Object.entries(p.byMealType).map(([t, n]) => `${label(t)} ${n}`).join('，')}`)
      for (const r of p.rows) show(`    ${r.person} ${label(r.mealType)} 批次 ${r.batch} 回执 ${r.receipt}`)
    }
    if (s.adjustments.length) {
      show('  已到账补单：')
      for (const a of s.adjustments) show(`    ${a.person} ${a.site} 基于 ${a.base}，回执 ${a.receipt}`)
    }
    if (s.pending.length) {
      show(`  未计入（待办 ${s.pending.length} 项）：`)
      for (const t of s.pending) show('    ' + t.label)
    }
    return 0
  }

  if (command === 'status') {
    show(`资料版 ${books.currentEdition || '（未采录）'}，餐次 ${books.session}`)
    show(`对账行 ${Object.keys(books.lines).length}，录入 ${books.entries.length}，餐商侧事实 ${books.booked.length}`)
    show(`人工队列 ${books.queue.filter(q => q.status === 'open').length} 项，待办 ${books.todos.filter(t => t.status === 'open').length} 项`)
    for (const l of Object.values(books.lines)) showLine(l)
    return 0
  }

  show('未知命令：' + (command || '（空）'))
  return 1
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  run(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
