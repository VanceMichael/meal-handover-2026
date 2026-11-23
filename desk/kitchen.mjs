// 餐商（供餐商财务侧）接口。各演练档路由可能整体替换，
// 读不到（404）时返回 null，由账本保留最近一次读到的状态。
export async function fetchShift(root) {
  const r = await fetch(root + '/kitchen/shift')
  if (r.status === 404) return null
  if (!r.ok) throw new Error('关单状态读取失败 ' + r.status)
  return r.json()
}

export async function fetchReceipts(root, batch) {
  const r = await fetch(root + '/kitchen/receipts?batch=' + encodeURIComponent(batch))
  if (r.status === 404) return null
  if (!r.ok) throw new Error('批次回执读取失败 ' + r.status)
  return r.json()
}

export async function fetchAdjustments(root) {
  const r = await fetch(root + '/kitchen/adjustments')
  if (r.status === 404) return null
  if (!r.ok) throw new Error('补单入账读取失败 ' + r.status)
  return r.json()
}
