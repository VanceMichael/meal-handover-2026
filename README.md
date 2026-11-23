# 托管跨班并桌后的餐次交接录入

这里的资料由本地来源模拟器提供，编号、参与方和历史业务记录全部为合成数据。运行环境为 Node.js 22.23.4，监听地址默认为 `127.0.0.1:8700`，可用 `PORT` 调整端口。

```sh
npm ci
npx playwright install chromium
npm run source
```

另开终端运行 `npm test` 可检查来源契约。测试以独立临时端口启动来源；浏览器资料由实际启动的 Chromium 读取。

两版业务记录和取件字段见 [资料格式](source/formats.md)。`POST /control?edition=r2` 模拟业务方更换当期资料，切回 `r1` 可重新查看初始来源。

本地演练还提供单独的外部接口。用 `npm run provider` 启动，默认地址为 `http://127.0.0.1:8701`，可用 `PROVIDER_PORT` 调整。来源语义、操作回执和演练档见[外部接口](source/provider.md)。

## 值班台（desk/）

值班员本地演练工具：对托管登记页采录、按人及餐次对账、向登记页录入、从餐商接口回读。台账保存在 `desk/state/books.json`，换一批出勤（资料版切换）后旧版数据保留，可接着对账。

```sh
npm run source &                 # 终端1：托管/登记页面 :8700
npm run provider &               # 终端2：餐商接口 :8701
node desk/cli.mjs collect        # 采录出勤/现场流水/已提交三视图（自动翻页）
node desk/cli.mjs reconcile      # 对账：责任点按实际领餐分钟生效
node desk/cli.mjs plan           # 待录入计划（按各点关单状态）
node desk/cli.mjs enter          # 逐行录入：暂存 -> 校验 -> 确认
node desk/cli.mjs readback       # 回读各行结果、批号回执、补单入账
node desk/cli.mjs queue list     # 人工队列（缺交班/餐型不符/归属冲突）
node desk/cli.mjs todos          # 待办（等回执/重复行/补单）
node desk/cli.mjs settle         # 结账（只计餐商回执确认的行与已到账补单）
```

对账规则：同一孩子同一餐次多条现场流水去重（并桌重复、旧菜单残留各记原因），同一天另一餐次独立成行；实领点与当时责任点对不上（疑似缺交班）或特殊餐实发类型不符，留人工队列，不自动入账；已确认项保留，归属调整凭旧回执走补单（退旧点补新点），补单待办在读到到账回执时才销掉。录入只带匿名领餐号、责任点和餐型；行内冲突或已入账项被页面拒绝时不影响同批其他行。

演练主线（与 `npm test` 的端到端用例一致）：

```sh
node desk/cli.mjs collect && node desk/cli.mjs reconcile && node desk/cli.mjs enter && node desk/cli.mjs readback
curl -XPOST 'http://127.0.0.1:8700/control?edition=r2'          # 换一批出勤
node desk/cli.mjs collect && node desk/cli.mjs reconcile
node desk/cli.mjs queue resolve <冲突id> --adjust               # 确认退 A 补 B
node desk/cli.mjs enter
curl -XPOST 'http://127.0.0.1:8701/lab?stage=after-close'       # 餐商关单后
node desk/cli.mjs readback
curl -XPOST 'http://127.0.0.1:8701/lab?stage=settled'           # 补单到账
node desk/cli.mjs readback && node desk/cli.mjs settle
```
