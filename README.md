# dsh-gui-operator

A DeepSeek Harness plugin that lets the agent **see and operate this Windows
desktop**, including browser pages that only render after a login.

It does not record, generate, or replay automation scripts. The agent looks,
decides one step, acts, and looks again — the same loop a person uses.

## What it adds

| Tool | What it does |
| --- | --- |
| `desktop_observe` | Screenshot of every display, window list, and the UI Automation tree of one window: button/menu names, edit-box values, and the text of documents and pages. |
| `desktop_act` | Click, double-click, right-click, move, drag, scroll, key combinations, typing (CJK/emoji safe), focus a window, wait. |
| `browser_open` | Starts Edge or Chrome with `--remote-debugging-port` and a persistent private profile. |
| `browser_observe` | Reads the current page: URL, title, visible text, form fields with values, clickable elements with CSS selectors. |
| `browser_act` | Navigate, click, type, press keys, scroll, run page script, screenshot, manage tabs. |

## Requirements

- Windows 10/11, x64.
- Windows PowerShell 5.1 / .NET Framework 4.x (both ship with Windows) only for
  the one-time build of the helper.
- A Chromium browser for the browser tools: Microsoft Edge or Google Chrome.
- No npm dependency. The helper is plain C# compiled by `csc.exe`.

## Build the helper

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build.ps1
```

The script finds `csc.exe` in `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319`,
resolves the UI Automation assemblies from the GAC, and writes
`native\gui-operator.exe`. The compiled executable is not committed (see
`.gitignore`), so run this once after cloning; the plugin reports a missing
helper with exactly this command.

> PowerShell is used **only at build time**. Input is not implemented as an
> inline `Add-Type` block because Defender/AMSI blocks scripts that combine
> clipboard and input APIs (`ScriptContainedMaliciousContent`); the same code as
> a console program is fine, and it starts far faster.

## Install into the harness

**Plugins > Add plugin** in the DeepSeek Harness window, pointing at this
directory; or from an agent session, `plugin_manager` with
`action: install_bundle` and this absolute directory as the target. The bundle is
inserted by `cordis.patch.yml` as the plugin row `gui-operator`.

## First run

1. `browser_open` with the site you want (for example
   `https://mail.example.com`). A separate browser window opens with its own
   profile at `%USERPROFILE%\.dsh-gui-operator\browser-profile`.
2. Sign in **yourself** in that window. The agent can see the page but should
   never be given your password to type.
3. Ask the agent to do the task; it will call `browser_observe` and
   `browser_act`, or `desktop_observe` / `desktop_act` for native apps.

## Examples

Read a logged-in page and act on it:

```
browser_observe  {}
browser_act      { "action": "type",  "selector": "#search", "text": "季度报表" }
browser_act      { "action": "click", "text": "搜索" }
browser_observe  { "maxText": 8000 }
```

Drive a native app:

```
desktop_observe  { "window": "Notepad", "maxElements": 60 }
desktop_act      { "action": "click", "ref": "e12" }
desktop_act      { "action": "type",  "text": "第一行" }
desktop_act      { "action": "key",   "keys": "ctrl+s" }
```

Coordinates are physical screen pixels; the screenshot is captured at physical
resolution, so image pixels and click coordinates agree when `maxWidth` is
omitted. Prefer `ref` over raw coordinates: the helper re-checks the control's
type and name before clicking and reports a stale reference instead of clicking
the wrong thing.

## Files

```
index.js              plugin entry: registers the five tools, validation, refs
lib/operator.js       runs the helper, serializes actions, enforces timeouts
lib/cdp.js            Chrome DevTools Protocol client over the global WebSocket
lib/browser.js        page reading and page actions, browser launch
native/gui-operator.cs  screenshot, UI Automation tree, mouse/keyboard input
native/build.ps1      builds native/gui-operator.exe with csc
locale/*.json         plugin title/description for the Plugins page
docs/DETAIL.md        the detail page shown in Plugins
```

## Limits

- Windows only.
- UI Automation sees nothing in apps that draw their own UI (games, some Electron
  windows) and in windows owned by a more privileged process. Fall back to the
  screenshot and coordinates.
- The UAC secure desktop, the lock screen, and exclusive full-screen games cannot
  be observed or operated.
- Password fields are reported as present but their values are never read.
- `browser_observe` reads the top-level frame only; cross-origin iframes are not
  included.
- The browser must be one started with the debugging port (`browser_open`); an
  ordinary browser window cannot be attached to.
- Typing uses Unicode key events and does not touch the clipboard. Very long
  text (over 1500 characters) and emoji fall back to pasting through the
  clipboard, which restores the previous text afterwards; if the clipboard held
  no text at that moment, the fallback is skipped.

## License

MIT. See [LICENSE](LICENSE).