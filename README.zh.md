# dsh-shared-browser

给 **DeepSeek Harness 桌面版**加一套 Playwright 工具，直接驱动它**自带的 Browser 页签**（右侧栏按 `Ctrl+T` 打开的那个）。

- **原生像素** —— 就是用户眼前那个页签，不是视频投影、不是截图流；面板多大，页面就多清晰、多大。
- **可操作** —— `bb_*` 工具通过 CDP 用 Playwright 操作同一个页面：`goto / click / type / press / wait / text /
  eval / screenshot`，中文输入正常。
- **共享** —— 用户可以在同一个页签里登录、过人机验证、随手点；Agent 看到的是同一个页面、同一份登录态。

```
Agent ──► bb_* 工具 ──► playwright-core ──connectOverCDP──► DSH 桌面版（Electron 44 / Chrome 152）
                                                                └── Browser 页签 = WebContentsView
用户  ──► 同一个页签，实时可见
```

## 环境要求

| 项目 | 取值 |
| --- | --- |
| 操作系统 | Windows 10/11 x64 |
| 目标应用 | DeepSeek Harness 桌面版 **0.2.2-rc.5**（Electron 44.7.0 / Chrome 152.0.7977.130） |
| `engines.dsh` | `>=0.2.2-rc.5 <0.3.0` —— 其它桌面版本需要重新核对 asar 布局 |
| Node（随桌面版运行时） | `>= 20`（插件调用桌面版自带的 `node.exe`） |
| 依赖 | `playwright-core ^1.65.1`（不下载浏览器） |

## 安装

```bash
# 市场 / 插件管理器
plugin_manager install_bundle target=dsh-shared-browser@0.4.0
# 或安装本地 tarball
plugin_manager install_bundle target=file:C:\path\dsh-shared-browser-0.4.0.tgz
```

然后**重启一次 DSH**（托盘右键 → 退出）。这就是全部——不需要启动器、不需要参数、不需要改快捷方式。

这次重启里发生的事：

1. 插件加载时自动布防（日志 `[dsh-shared-browser] auto-armed watchdog …`，
   `%TEMP%\dsh-shared-browser\arm-status.json` 变 `armed`）。
2. 应用退出后，看门狗关掉仍占着 `app.asar` 的残留子进程 → 备份为 `app.asar.bak-<时间>` → 对副本打补丁 →
   校验（20056 条目全量读 + 400 项内容对拍）→ 替换 → 自动拉起应用 → 等 CDP 就绪。
3. 此后每次正常启动都自带 `--remote-debugging-port=9223`，`bb_*` 直接可用。

失败自动回滚：CDP 等不到就还原备份再启动，**补丁失败不会留下坏安装**。桌面版升级会覆盖 `app.asar`（补丁丢失），
插件下次启动会重新布防，再重启一次即可。

## 原理

内置 Browser 页签**不是** DOM 里的 `<iframe>`，而是主进程持有的 `WebContentsView`（CDP 里报 `type: "webview"`），
渲染层拿不到它的 DOM，所以**唯一通道是 CDP**。

1. **让应用带调试口**：补丁写入归档 `package.json#main` 指向的入口模块（当前是 `lib/main.js`），位置在模块
   **最后一条顶层 `import` 之后**：

   ```js
   /*DSH_SHARED_BROWSER_CDP v2*/import{app as __dshCdpApp}from'electron';
   try{const p=process.env.DSH_CDP_PORT||'9223';
       if(!process.argv.some(a=>String(a).startsWith('--remote-debugging-port')))
         __dshCdpApp.commandLine.appendSwitch('remote-debugging-port',p);}catch{}
   ```

2. **让 Playwright 认这个目标**：`playwright-core` 会把非 `page` 类型的 CDP 目标 detach 掉
   （`lib/coreBundle.js` → `treatOtherAsPage`）。插件加一行受环境变量门控的判断
   （`DSH_BUILTIN_WEBVIEW_AS_PAGE=1`），把 `webview` 当成 `page`；原文件保留为 `coreBundle.js.orig`。

3. **驱动**：`bb_*` 就是对这些页面的普通 Playwright 调用，外加 `bb_snapshot` 给可交互元素打稳定引用
   （`data-bbref`）。

### 与其它同样改 app.asar 的插件共存

- 目标文件来自 `package.json#main`，**不硬编码** `lib/main.js`。
- 补丁插在 import 块之后，别的插件 prepend 的 banner/注释保持原样。
- 标记是 `/*DSH_SHARED_BROWSER_CDP v2*/`，允许出现在文件任意位置（不再假设 byte 0）。
- 若入口模块里**已经存在** `appendSwitch('remote-debugging-port', …)`（别的插件已开端口），补丁器
  **一字节都不改**，返回 `foreignSwitch: true`。
- 重复打补丁是幂等的：返回 `already: true`，归档不变。

## 工具

| 工具 | 作用 |
| --- | --- |
| `bb_status` | CDP 端点、playwright 补丁状态、应用/归档位置、归档状态（是否已打/端口/大小）、连接状态、已开页面 |
| `bb_enable` | 布防看门狗（默认 `mode: 'patch'`），或改写启动器（`mode: 'shortcut'`、`undo: true`） |
| `bb_open` | 打开/跳转页签；若还没有页签，则通过侧栏地址栏新建（返回 `createdTab: true`） |
| `bb_snapshot` | 列出可交互元素（引用、角色、标签、文本） |
| `bb_click` / `bb_type` / `bb_press` / `bb_wait` | 按引用或 CSS 选择器交互；`submit: true` 回车提交 |
| `bb_text` | 读取页面文本（可指定选择器） |
| `bb_eval` | 在页面内执行 JS |
| `bb_screenshot` | 原生像素截图到文件（`-Path`） |
| `bb_reconnect` | 断开并重连 CDP |

典型流程：`bb_status` →（未打补丁则 `bb_enable`，然后重启）→ `bb_open <url>` → `bb_snapshot` →
`bb_click` / `bb_type` → `bb_screenshot`。

## 环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `DSH_CDP` | `http://127.0.0.1:9223` | `bb_*` 使用的 CDP 端点 |
| `DSH_CDP_PORT` | `9223` | 补丁注入、看门狗等待的端口 |
| `DSH_AUTO_ARM` | 开 | 设为 `off` 关闭加载时自动布防 |
| `DSH_NODE` | – | 指定看门狗用的 `node.exe`（默认用桌面版运行时） |
| `DSH_APP_EXE` / `DSH_ASAR_PATH` | 自动识别 | 覆盖应用与归档路径 |

## 安全

- 绝不在应用运行时改归档：替换只在应用退出后进行；替换失败会还原备份并重启应用。
- 替换前校验：完整结构读取 + marker/开关/端口检查 + 与原文件 400 项内容对拍。
- 归档旁保留 `app.asar.bak-<时间>`，确认健康后可自行删除。
- 不想碰二进制可用 `shortcut` 模式。

## 卸载

1. 卸载插件即可（不需要先跑 `bb_enable`）。
2. 还原归档：`resources\app.asar.bak-<时间>` → `app.asar`（或重装桌面版，同样会还原补丁）。
3. 可选：`playwright-core\lib\coreBundle.js.orig` → `coreBundle.js`。

## 许可

MIT。
