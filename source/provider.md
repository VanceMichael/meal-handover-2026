# 供餐结账回执

登记在原浏览器服务操作，查看出勤和领餐记录都走可见视图。餐商处理的异步回执通过 `GET /kitchen/receipts?batch=批号` 查询，每一行有 `accepted`、`duplicate` 或 `needs-review`。受理并不把整批一律改成接受。 `GET /kitchen/shift` 给餐次、地点和相应的关单状态。 `GET /kitchen/adjustments` 给稍后财务核对补单的入账事实。只有餐商的 actual 行事实可用于结账，变更视图可能先于财务回执。
演练由 `before-close` 到 `after-close`，`settled` 档出现实际补单回执。

两页的资料变更先后独立，可在餐台把资料改到 r2 后另将本接口改到 after-close。浏览器表格的领取号与回执 person 对应。现场流水 K5 涉及 M2，与 M1 已确认行无关。原页一次办理一行，反映的接收处理仍按本批各行的财务事实分别回读。

浏览器值班台“责任点与餐型”的字段写法为地点:餐型，例如 B:regular。受保护的时点为该点同一餐，源页面的校验不跨两点检查。实际关单和补单仍由餐商财务回执说明。
