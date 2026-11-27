# 更新日志 / Changelog

## 0.7.0

会话感知与授权加固，含一处行为升级。

### 问题

- 宿主按「当前活动页签」路由命令：会话 A 发起的工具调用会落到会话 B 的浏览器页签上；两个会话同时开着浏览器时，
  命令可能进错页面。
- 宿主的 HTTP 路由只做同源检查：同机其它进程、或伪造 `Host` / `Origin` 的页面，可以不经过 DSH 的会话认证直接调用
  `/command`、`/report` 等路由。
- 工具参数 `tabId` 只用于外部通道（`ext:`）路由，内置页签的命令仍然落到当前活动页签。

### 改动

- `lib/client.cjs`：`onCommand` 单槽改为按 `tabId` 的 `commandHandlers` 映射；`dispatch()` 按报文里的 `session`
  解析页签（显式 `tabId` 优先），页签上报带 `session`，并新增按会话记录的 `activeBySession`。
- `lib/bridge.mjs`：`Hub` 接收会话提供者，命令报文带 `session`；有会话时不再回落到全局活动页签。新增
  `authorize()`：先做插件自己的 `Host` / `Origin` 同源检查，再调用 DSH 连接服务的 `requestRejection()`；
  连接服务缺失时返回 503 并拒绝（fail-closed）。
- `index.js`：工具执行用 `AsyncLocalStorage` 携带调用会话，`bb_status` 返回 `session`；8 条 HTTP 路由改用
  `authorize(ctx.get('connection'), …)`；`run()` 把显式 `tabId` 合并进命令选项。
- 文档：README / README_en 增加「会话与授权」一节；版本升到 0.7.0。

### 影响

- 行为升级：本会话没有浏览器页签、且右侧栏显示的是别的会话时，`bb_open` 报错而不再跨会话开页签。
- 安全性：未认证的 HTTP 调用返回 401，缺少连接服务的载体返回 503；插件自身的同源检查保留为第二道防线。
- 兼容性：没有新增依赖；工具数量与名称不变（28 个），`bb_tabs` 列表每项多一个 `session` 字段，
  `bb_status` 多一个 `session` 字段。

### 升级注意

升级后请在**每个要用浏览器的会话**里各打开一次浏览器页签；只有发起调用的会话正在显示时，`bb_open` 才能新建页签。

## 0.6.13

- 上一稳定版。
