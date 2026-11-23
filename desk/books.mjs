import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

// 值班台账本：采录到的各资料版、对账行、录入凭据、人工队列、待办。
// 换一批出勤（资料版切换）后账本保留，可接着对账。
export function emptyBooks() {
  return {
    session: 'lunch',
    currentEdition: null,
    editions: {},   // 资料版 -> { collectedAt, attendance, serves, submitted }
    lines: {},      // `${session}|${person}` -> 对账行
    entries: [],    // 本台在登记页确认的行 { person, session, point, mealType, state, receipt, edition, at }
    booked: [],     // 餐商侧事实 { person, session, point, mealType, batch, submittedState, kitchenState, kitchenReceipt, source }
    queue: [],      // 人工队列（缺交班、餐型不符、归属冲突）
    todos: [],      // 待办（等回执、重复行、补单、点已关单）
    adjustments: [],// 餐商补单入账事实
    receipts: {},   // 批号 -> 最近读到的回执行
    shift: []       // 最近读到的各点关单状态
  }
}

export async function loadBooks(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return emptyBooks()
  }
}

export async function saveBooks(path, books) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(books, null, 2))
}

let seq = 0
export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${seq++}`
}
