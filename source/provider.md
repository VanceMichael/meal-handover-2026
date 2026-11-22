# 供餐结账回执

登记在原浏览器服务操作，查看出勤和领餐记录都走可见视图。餐商处理的异步回执通过 `GET /kitchen/receipts?batch=批号` 查询，每一行有 `accepted`、`duplicate` 或 `needs-review`。受理并不把整批一律改成接受。 `GET /kitchen/shift` 给餐次、地点和相应的关单状态。 `GET /kitchen/adjustments` 给稍后财务核对补单的入账事实。只有餐商的 actual 行事实可用于结账，变更视图可能先于财务回执。
演练由 `before-close` 到 `after-close`，`settled` 档出现实际补单回执。
