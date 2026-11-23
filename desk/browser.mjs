import { chromium } from 'playwright'

// 托管/登记页面仅浏览器可操作，这里用 Chromium 实际打开页面采录与录入。
// 餐商只接收用于这一餐的匿名领餐号、责任点和餐型：
// 录入时只填 餐次 / 领餐号 / 责任点:餐型 三项，不带任何其他身份信息。

const VIEWS = {
  attendance: {
    columns: 5,
    map: ([person, group, point, minute, mealType]) => ({ person, group, point, minute: Number(minute), mealType })
  },
  serves: {
    columns: 6,
    map: ([id, person, point, minute, session, mealType]) => ({ id, person, point, minute: Number(minute), session, mealType })
  },
  submitted: {
    columns: 6,
    map: ([session, point, batch, person, mealType, state]) => ({ session, point, batch, person, mealType, state })
  }
}

function chunk(cells, size) {
  const rows = []
  for (let i = 0; i + size <= cells.length; i += size) rows.push(cells.slice(i, i + size))
  return rows
}

async function collectView(page, root, name, spec) {
  await page.goto(root + '/desk?view=' + name)
  const cells = []
  for (;;) {
    cells.push(...await page.locator(`table[aria-label="${name}"] td`).allTextContents())
    const next = page.getByRole('link', { name: '下一页' })
    if (!await next.count()) break
    await next.click()
  }
  return chunk(cells, spec.columns).map(spec.map)
}

// 采录：读出当前资料版及三个业务视图（自动翻页）。
export async function collectViews(root) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.goto(root + '/desk')
    const edition = (await page.locator('output[aria-label="资料版"]').textContent()).trim()
    const out = { edition }
    for (const [name, spec] of Object.entries(VIEWS)) {
      out[name] = await collectView(page, root, name, spec)
    }
    return out
  } finally {
    await browser.close()
  }
}

async function confirmedReceipt(page, row, value) {
  const rows = page.locator('table[aria-label="本次门户操作"] tr')
  for (const tr of await rows.all()) {
    const cells = await tr.locator('td').allTextContents()
    if (cells.length === 5 && cells[1] === row.person && cells[2] === value && cells[3] === 'confirmed') {
      return cells[4]
    }
  }
  return null
}

async function enterOne(page, root, row) {
  const value = row.point + ':' + row.mealType
  const out = { person: row.person, session: row.session, value, steps: [] }
  for (const action of ['暂存', '校验', '确认']) {
    await page.goto(root + '/desk')
    await page.getByLabel('餐次').fill(row.session)
    await page.getByLabel('领餐号').fill(row.person)
    await page.getByLabel('责任点与餐型').fill(value)
    await page.getByRole('button', { name: action, exact: true }).click()
    const body = await page.locator('body').textContent()
    out.steps.push(action)
    if (/资料版已更换/.test(body)) { out.error = 'edition-changed'; return out }
    if (/暂存或校验已失效/.test(body)) { out.error = 'stale'; return out }
    if (/已经由业务方确认/.test(body)) { out.locked = true; return out }
    if (/已有确认回执/.test(body)) { out.alreadyConfirmed = true; return out }
    if (/资料不全|格式为地点:餐型/.test(body)) { out.error = 'invalid'; return out }
  }
  out.receipt = await confirmedReceipt(page, row, value)
  out.ok = Boolean(out.receipt)
  return out
}

// 逐行录入，返回每行结果（含页面回执号）。
export async function enterRows(root, rows) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    const results = []
    for (const row of rows) results.push(await enterOne(page, root, row))
    return results
  } finally {
    await browser.close()
  }
}
