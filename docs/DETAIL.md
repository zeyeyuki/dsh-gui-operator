# Desktop operator

This plugin gives the agent two capabilities that DeepSeek Harness does not have
by itself:

**Desktop** — a screenshot of every display, the window list, the UI Automation
control tree of one window (button and menu names, edit boxes with their current
value, and the text of documents and pages), plus real mouse and keyboard input.
The agent decides one step at a time from what it sees; nothing is recorded into
a replayable macro.

**Browser** — attaches to Microsoft Edge or Google Chrome over the DevTools
Protocol, using a private persistent profile. That is what makes content behind a
login readable: the page is the user's own session, and the plugin reads URLs,
visible text, form fields and clickable elements from it, then clicks and types
into it. Only the first run needs an interactive login.

## Tools

| Tool | Purpose |
| --- | --- |
| `desktop_observe` | Screenshot, window list, and the control tree of one window. |
| `desktop_act` | Click, double-click, right-click, move, drag, scroll, key combination, type text, focus a window, wait. |
| `browser_open` | Start Edge/Chrome with `--remote-debugging-port` and a persistent profile. |
| `browser_observe` | Read the current page: URL, title, text, fields with values, clickable elements with selectors. |
| `browser_act` | Navigate, click, type, press keys, scroll, run page script, screenshot, manage tabs. |

## Coordinates

All desktop coordinates are physical screen pixels. The screenshot is taken at
physical resolution and reported with its scale, so image pixels and click
coordinates are the same numbers when no `maxWidth` was requested. Clicking by
element reference (`ref`, e.g. `e12`) is preferred: the helper re-checks the
control's type and name before clicking, and reports a stale reference instead of
clicking something else.

## Limits

- Windows only (UI Automation, `SendInput`-style input, Edge/Chrome).
- UIA sees nothing in apps that draw their own UI, or when a window runs elevated
  and the harness does not. Fall back to the screenshot and coordinates.
- A UAC secure-desktop prompt, the lock screen, and full-screen exclusive games
  cannot be observed or operated.
- Password fields are reported as present but never read.
- `browser_observe` reads the top-level frame only; cross-origin iframe content
  is not visible to it.
- The browser must be the one started by `browser_open` (or started by hand with
  the same debugging port); an ordinary browser window cannot be attached to.
- Typing uses Unicode key events and leaves the clipboard alone. Very long text
  (over 1500 characters) and emoji fall back to pasting, which restores the
  previous clipboard text; when the clipboard holds no text, the fallback is
  skipped instead of overwriting it.