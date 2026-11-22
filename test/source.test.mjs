import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createSource } from '../source/source.mjs'

async function listen(t) {
  const server = createSource()
  server.listen(0, '127.0.0.1')
  await once(server,'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return { root: 'http://127.0.0.1:' + server.address().port }
}

import { chromium } from 'playwright'
test('浏览器能读取分页资料并识别过期暂存', async t => {
  const { root } = await listen(t)
  const browser = await chromium.launch({args:['--no-sandbox']})
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(root + '/desk')
  const oldEdition = await page.getByRole('status',{name:'资料版'}).count() ?
    await page.getByRole('status',{name:'资料版'}).textContent() :
    await page.locator('output').textContent()
  assert.equal(oldEdition, 'r1')
  await fetch(root + '/control?edition=r2', {method:'POST'})
  const labels = ["餐次", "领餐号", "责任点与餐型"]
  for (const [i, label] of labels.entries()) await page.getByLabel(label).fill(['lunch','M2','B:regular'][i])
  await page.getByRole('button',{name: "暂存", exact:true}).click()
  assert.match(await page.locator('body').textContent(), /资料版已更换/)
  await page.goto(root + '/desk?view=' + "serves")
  let cells = []
  for (;;) {
    cells = cells.concat(await page.getByRole('table',{name:"serves",exact:true}).locator('td').allTextContents())
    const next = page.getByRole('link',{name:'下一页'})
    if (!await next.count()) break
    await next.click()
  }
  assert.ok(cells.includes("K5"))
  for (const [i, label] of labels.entries()) await page.getByLabel(label).fill(['lunch','M2','B:regular'][i])
  await page.getByRole('button',{name: "暂存", exact:true}).click()
  assert.match(await page.getByRole('table',{name:'本次门户操作'}).textContent(), /draft/)
})

test('柜台操作逐行回读，确认后的记录不会由重办覆盖', async t => {
  const { root } = await listen(t)
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(root + '/desk')
  async function send(person, meal, action) {
    await page.getByLabel('餐次').fill('lunch')
    await page.getByLabel('领餐号').fill(person)
    await page.getByLabel('责任点与餐型').fill(meal)
    await page.getByRole('button', { name: action, exact: true }).click()
  }
  await send('M1', 'A:special', '暂存')
  assert.match(await page.locator('p[role="status"]').textContent(), /已由业务方确认/)
  await send('M2', 'B:regular', '暂存')
  await send('M2', 'B:regular', '校验')
  await send('M2', 'B:regular', '确认')
  assert.match(await page.getByRole('table', { name: '本次门户操作' }).textContent(), /B:regularconfirmedRC-/)
  await send('M2', 'B:special', '暂存')
  assert.match(await page.locator('p[role="status"]').textContent(), /已有确认回执/)
  assert.match(await page.getByRole('table', { name: '本次门户操作' }).textContent(), /B:regular/)
})
