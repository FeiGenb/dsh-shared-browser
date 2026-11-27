# dsh-shared-browser

[简体中文](https://github.com/FeiGenb/dsh-shared-browser/blob/main/README.md) · [English](https://github.com/FeiGenb/dsh-shared-browser/blob/main/README_en.md)

把 **DeepSeek Harness 桌面版**右侧栏的浏览器页签升级成一台真正的集成浏览器：地址栏、缩放、页内查找、设备仿真、
历史/收藏、网站权限、清除存储、内置 DevTools 面板，外加 **截图 / 区域截图 / 元素评论 / 控制台日志直接进聊天**，
以及 28 个让 Agent 操作**同一个页面**的 `bb_*` 工具；遇到 Cloudflare 一类人机验证时，插件会明确让 Agent 停手并交还给你。

用户看到的就是 Agent 操作的那一个页面：同一份登录态、同一份页面状态，中途可以人工登录、过人机验证、随手点。

```
用户 ─┐
      ├─► 右侧栏 Browser 页签（Electron webview，按工作区隔离）
Agent ─┘        ▲
        bb_* 工具 ─┐
                    └─ 宿主插件 /dsh-shared-browser（SSE 命令通道）─► 客户端插件（页签本体）
```

## 开箱即用

1. 打开 **插件** → 添加插件，或 `plugin_manager install_bundle target=dsh-shared-browser`。
2. 重启一次 DSH。
3. 右侧栏点 **浏览器**（或 `Ctrl+T`）。工具栏、菜单、工具都已经在位。

**不需要**打补丁、不需要改 `app.asar`、不需要启动参数、不需要改快捷方式。关掉这个 bundle，
右侧栏就退回 DSH 自带的浏览器页签。

## 页签里有什么

| 能力 | 入口 |
| --- | --- |
| 前进 / 后退 / 刷新 / 停止 / 地址栏 | 工具栏左侧 |
| 缩放 50%–300% | `Ctrl+=` / `Ctrl+-` / `Ctrl+0`，或菜单「放大 / 缩小 / 重置缩放」 |
| 页内查找（命中计数 + 上下循环 + 原生高亮） | `Ctrl+F` |
| 设备仿真（iPhone 14 / Pixel 7 / Galaxy S23 / iPad mini / 桌面） | 菜单「设备仿真」 |
| 历史记录 / 收藏夹 | `Ctrl+H` / `Ctrl+D`，或菜单 |
| 网站权限、清除存储、浏览器设置 | 菜单 |
| 截图到聊天 | 工具栏 ⤓ 或菜单「截图」 |
| 区域截图到聊天 | 工具栏 ▣ 或菜单「区域截图」 |
| 选取元素到聊天 / 评论元素 | 工具栏 ⌖ / ✎ |
| 控制台日志到聊天 | 菜单「控制台日志」 |
| DevTools 面板：控制台 / 元素 / 网络 / 运行 JS | `F12` 或工具栏 ⚙ |
| 在外部浏览器中打开、复制地址、新建标签页 | 菜单 |

截图、区域截图、元素评论、控制台日志都会以「引用条 + 图片/文本」的形式落在**当前会话的输入框**里，
不会替你发送；你可以改完再发，Agent 也能直接读到元素的选择器、文本与你的评论。

## 双通道：内置页签 / 你的浏览器

内置页签是 Electron 的 `<webview>`：同屏、可截图、可评论，但**会话不持久**，且 Cloudflare 一类防护会拒绝它的 UA。需要真实浏览器时，插件可以把同一地址交给本机的 Edge/Chrome：

| 场景 | 做法 |
| --- | --- |
| 明确要用真浏览器 | `bb_open { url, channel: "external" }`，或 `bb_external { action: "launch", url }` |
| 让外部通道成为默认 | `bb_settings { action: "set", channel: "external" }` |
| 遇到人机验证自动切换 | 默认开启：内置页签识别到 CF 类挑战时，自动关掉它并在外部浏览器打开同一地址（`bb_settings { action: "set", autoLaunch: false }` 可关闭） |
| 查看 / 关闭外部通道 | `bb_external { action: "status" }` / `{ action: "close" }` |

外部通道的页签 id 形如 `ext:<id>`，其余工具（`bb_snapshot` / `bb_text` / `bb_click` / `bb_screenshot` / `bb_console` …）会按 id 自动路由；侧栏会出现一个「外部浏览器」镜面页签，实时显示画面并把点击、滚轮转发回真实窗口。

设置写在 `$DSH_HOME/shared-browser/settings.json`：`channel`、`browser`（`msedge`/`chrome`）、`profileDir`、`autoLaunch`。外部浏览器使用独立 profile（默认 `$DSH_HOME/shared-browser/profiles/<browser>`），登录态可跨 DSH 重启保留。

### 人机验证（Cloudflare / DataDome）

内置页签撞上挑战页时，工具会返回 `wall: true` 和一条固定提示：**不要**尝试完成或绕过人机验证、**不要**点验证控件，而是把页面交给用户。
`autoLaunch` 打开时，插件会自动关掉内置页签并在外部浏览器窗口打开同一地址，由你亲自完成验证；外部通道使用独立的持久 profile，验证结果会留在那里。

## Agent 工具（28 个）

| 工具 | 作用 |
| --- | --- |
| `bb_status` | 连接状态、页签、计数 |
| `bb_open` / `bb_navigate` | 打开网址 / 前进后退刷新停止 |
| `bb_tabs` | 列出、切换、新建、刷新、关闭页签 |
| `bb_snapshot` | 可交互元素树（`e12 <button> "登录"`） |
| `bb_text` | 页面文本 |
| `bb_click` / `bb_type` / `bb_press` / `bb_wait` | 点击、输入、按键、等待 |
| `bb_eval` | 在页面里执行 JavaScript |
| `bb_screenshot` / `bb_region_screenshot` | 截图 / 区域截图（落盘并给出附件 URL） |
| `bb_console` / `bb_network` | 控制台与网络请求缓存（宿主侧） |
| `bb_comment` / `bb_comments` | 给元素写评论 / 读取评论 |
| `bb_find` / `bb_zoom` / `bb_emulate` | 查找、缩放、设备仿真 |
| `bb_devtools` / `bb_open_devtools_native` | 内置面板状态 / 探测外部 CDP |
| `bb_storage` / `bb_permissions` / `bb_history` | 存储、权限策略、历史 |
| `bb_add_to_chat` | 把截图 / 区域 / 元素 / 控制台日志放进输入框 |
| `bb_external` | 探测 / 启动 / 关闭本机 Edge、Chrome（CDP，真实指纹） |
| `bb_settings` | 读改默认通道、外部浏览器、profile 目录、自动切换 |

工具与 UI 共用一条通路：宿主把命令经 SSE 下发给页签，页签执行后回传结果。用户不在页签上时，
工具会明确提示“先打开 Browser 页签”。评论一旦提交，Agent 用 `bb_comments` 就能读到
选择器、`ref`、文本、矩形与你的注释。

## 兼容性

- **不改 DSH 本身**：没有 `app.asar` 补丁、没有二进制改动、没有全局注入。
- 只用公开接口：页签类型注册（`priority: 'extension'` 接管 `kind: 'browser'`）、座位（slot）、
  `window.dshDesktop.browser` 租约桥、宿主 `webServer` 路由、`ctx.tools`。
- 只接管「浏览器」这一类页签；其它插件、其它页签类型不受影响。关闭 bundle 立即恢复内置浏览器。
- 在 Web 版（没有桌面桥的载体）里自动让位，保留内置浏览器，不会把 UI 弄坏。
- 样式统一挂在 `<style data-plugin="dsh-shared-browser">` 下，随插件卸载一起移除。

## 已知限制（来自桌面壳，不是本插件）

- 共享浏览器分区里**网站权限、下载、原生弹窗一律被拒绝**：这是 DSH 桌面壳对侧栏浏览器的固定策略。
- 打包版壳把 guest 的 `devTools` 关掉了，所以 `openDevTools()` 不可用；本插件提供**自绘的 DevTools 面板**
  （控制台 / 元素 / 网络 / 运行 JS）。想要原生 DevTools，用 `bb_open_devtools_native` 了解外部 CDP 方案。
- 分区按工作区隔离且**不持久**：重启 DSH 会丢登录态，与内置浏览器行为一致。
- 截图依赖窗口在前台：DSH 窗口被最小化或被完全遮挡时 `capturePage` 不会返回画面，插件会在约 6 秒后
  提示「截图失败：请把 DSH 窗口切到前台后重试」，而不是一直转圈。
- 尚未支持：多窗口、书签同步、下载管理、扩展。

## 环境

| 项目 | 取值 |
| --- | --- |
| 载体 | DSH **桌面版** 0.2.2-rc.5 及以上（Electron 44 / Chrome 152 上验证） |
| `engines.dsh` | `>=0.2.2-rc.5 <0.3.0` |
| 依赖 | 无（只用宿主与浏览器已有的能力） |

## 调试

- 宿主侧自带只读诊断路由 `GET /dsh-shared-browser/state`（连接状态、页签、计数）。
- 需要按名字直接跑工具时，用 `DSH_SHARED_BROWSER_DEV=1` 启动 DSH，会额外注册
  `POST /dsh-shared-browser/debug/command`（仅本机 loopback，且只在开发态存在）。
- 客户端诊断：控制台里 `window.__dshBrowserDebug`（`session()`、`probe()`、`lastMount`）。

## 许可

MIT
