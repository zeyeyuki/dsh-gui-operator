# dsh-gui-operator

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加「看见并操作这台 Windows 电脑」的能力：截图 + UI Automation 控件树（含文档与输入框正文）、真实鼠标键盘输入，以及**通过 CDP 读取你已登录浏览器里的页面**并对其操作。

它不生成、不录制自动化脚本：每次先观察，再做一个动作，再观察。跟人用电脑的节奏一样。

**原生部分零依赖**：一个用 Windows 自带 `csc.exe` 编译的 C# 控制台程序，浏览器部分只用运行时内置的 `fetch` / `WebSocket`，不需要 npm 包。

A DeepSeek Harness plugin that lets the agent **see and operate this Windows desktop**, including browser pages that only render after a login: physical-pixel screenshots, UI Automation trees with readable text, real mouse and keyboard input, and Chrome DevTools Protocol access to the user's own browser session.

No scripts are recorded or replayed: the agent observes, takes one action, then observes again — the loop a person uses. The native half is a single C# executable compiled by the `csc.exe` that ships with Windows; the browser half uses only the runtime's built-in `fetch` and `WebSocket`, so there is no npm dependency.

---

## 能力 / What it adds

| 工具 / Tool | 作用 / Purpose |
| --- | --- |
| `desktop_observe` | 截图、窗口列表、某个窗口的控件树：按钮/菜单名称、输入框当前值、文档与页面的正文。Screenshot, window list, and the UI Automation tree of one window. |
| `desktop_act` | 点击 / 双击 / 右键 / 移动 / 拖拽 / 滚轮 / 组合键 / 输入文字 / 聚焦窗口 / 等待。Click, double-click, right-click, move, drag, scroll, key combinations, typing, focus, wait. |
| `browser_open` | 用调试端口 + 独立持久 profile 启动 Edge/Chrome。Start Edge or Chrome with a debugging port and a private persistent profile. |
| `browser_observe` | 读当前页面：URL、标题、可见正文、表单字段（密码永不打码为值）、可点元素与 CSS 选择器。Read the page: URL, title, visible text, form fields, clickable elements with selectors. |
| `browser_act` | 导航、点击、输入、按键、滚动、执行页面脚本、截图、管理标签页。Navigate, click, type, press keys, scroll, run page script, screenshot, manage tabs. |

## 要求 / Requirements

- Windows 10/11 x64。
- 构建 helper 时需要 Windows PowerShell 5.1 / .NET Framework 4.x（系统自带）。
- 浏览器功能需要 Microsoft Edge 或 Google Chrome。
- 无 npm 依赖。

Windows 10/11 x64; PowerShell 5.1 and .NET Framework 4.x (both ship with Windows) only for the one-time build; Edge or Chrome for the browser tools; no npm dependencies.

## 构建 / Build

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build.ps1
```

脚本会在 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319` 找 `csc.exe`，从 GAC 解析 UI Automation 程序集，生成 `native\gui-operator.exe`。编译产物不入库（见 `.gitignore`），克隆后跑一次即可；缺 helper 时插件会带着这条命令报错。

The script finds `csc.exe`, resolves the UI Automation assemblies from the GAC and writes `native\gui-operator.exe`. The binary is not committed; run this once after cloning. A missing helper is reported by the plugin together with this exact command.

> 为什么不用 PowerShell 的 `Add-Type` 直接写输入？Defender/AMSI 会把「剪贴板 + 键盘/鼠标 API」同时出现的脚本判为 `ScriptContainedMaliciousContent` 并整段拒绝。同样的代码放进普通控制台程序就没事，而且启动比 `powershell.exe` 快一个数量级。
>
> Why a separate executable instead of an inline `Add-Type` block? Defender/AMSI blocks scripts that combine clipboard and input APIs (`ScriptContainedMaliciousContent`), while the same code as a console program runs — and starts about 20x faster than `powershell.exe`.

## 安装 / Install

需要 DeepSeek Harness 的 Bundles / 插件安装能力（桌面版或 `dsh` CLI 都可以）。

```bash
git clone https://github.com/zeyeyuki/dsh-gui-operator.git
```

- 桌面版：**插件** → **添加插件**，选择克隆下来的目录。
- 或把目录路径作为 `plugin_manager` 的 `install_bundle` 目标。

Requires the Harness plugin/bundle install path: **Plugins → Add plugin** with the cloned directory, or `plugin_manager` `action: install_bundle` pointing at it.

## 使用 / Usage

1. 先 `browser_open` 打开要登录的站点，在弹出的独立窗口里**自己**登录（模型不需要、也不应该拿到你的密码）。
2. `browser_observe` 读页面，`browser_act` 点/填/翻页；能选择器就别用坐标。
3. 原生软件：`desktop_observe`（可带 `window` 过滤）→ `desktop_act` 用 `ref` 点 → 再 observe 复核。
4. 桌面坐标是物理像素；截图默认原始分辨率，因此图像像素与点击坐标一致。

1. Run `browser_open`, then sign in **yourself** in that window.
2. Read with `browser_observe`, act with `browser_act`; prefer selectors over coordinates.
3. Native apps: `desktop_observe`, click by `ref`, observe again to verify.
4. Desktop coordinates are physical pixels; the screenshot is captured at native resolution, so image pixels and click coordinates agree.

示例 / Examples：

```
browser_open    { "url": "https://mail.example.com" }
browser_observe { "maxText": 8000 }
browser_act     { "action": "type",  "selector": "#search", "text": "季度报表" }
browser_act     { "action": "click", "text": "搜索" }

desktop_observe { "window": "Notepad", "maxElements": 60 }
desktop_act     { "action": "click", "ref": "e12" }
desktop_act     { "action": "type",  "text": "第一行" }
desktop_act     { "action": "key",   "keys": "ctrl+s" }
```

## 设计取舍 / Design notes

- **常驻路由提示**：插件会注册一段系统提示（`gui-operator-routing`），明确"看屏幕 / 点软件 / 登录后才能看到的页面"这类请求该用这些工具，而不是让模型自己想起工具列表里还有它。工具描述开头也写明了触发场景。
  A routing prompt section names the situations that should select these tools, so the capability is discoverable without the user knowing it exists.
- **元素引用带身份**：`ref` = hwnd + 控件路径 + 类型 + 名称；动作前重新解析并校验，过期返回 `STALE_ELEMENT`，最小化/离屏/窗口不在前台分别拒绝，不会"点到邻居"。
  Refs carry identity (window handle, control path, type, name) and are re-validated before acting; stale, minimized, offscreen and unfocused targets fail loudly.
- **前台校验**：`SetForegroundWindow` 可能被 Windows 拒绝；现在会先试 Alt 解锁，仍失败就报 `FOCUS_REJECTED`，避免文字打进别的窗口。
  Foreground activation is verified; otherwise typing could land in another app.
- **输入不碰剪贴板**：常规文本用 `SendInput` Unicode 直打；超长（>1500 字）或 emoji 才粘贴，并恢复原剪贴板文本。
  Typing uses Unicode key events; only very long text or emoji falls back to paste, restoring the previous clipboard text.
- **串行 + 原子**：单动作串行，`focus → resolve → click → type` 复合动作整体加锁，避免两个会话互相抢鼠标。
  One action at a time, and composite sequences hold a lock.

## 限制 / Limits

- 仅 Windows。
- UI Automation 看不到自绘界面（游戏、部分 Electron 窗口）和权限更高的进程窗口；此时退回截图 + 坐标。
- UAC 安全桌面、锁屏、独占全屏游戏无法观察或操作。
- 密码框只报"存在"，永不读取其值。
- `browser_observe` 只读顶层 frame，跨域 iframe 不在内。
- 浏览器必须是带调试端口启动的那个（`browser_open`）；普通浏览器窗口无法附着。
- Windows only; UIA cannot see self-drawn UIs or higher-integrity windows; the secure desktop, lock screen and exclusive full-screen games are out of reach; password values are never read; cross-origin iframes are not included; the browser must be the one started with the debugging port.

## 安全 / Security

- 插件没有命令执行、文件读写、注册表、进程管理工具，误操作半径小。
- 但 `browser_act eval` 等价于在已登录站点里执行任意同源 JS，`desktop_act` 也能点到"删除"——破坏性操作前请让它先说明再执行。
- No shell, filesystem, registry or process tools; but `browser_act eval` is arbitrary same-origin JS and desktop clicks can be destructive — ask for intent before destructive steps.

## License

MIT。见 [LICENSE](LICENSE)。