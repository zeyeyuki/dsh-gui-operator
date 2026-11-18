/**
 * dsh-gui-operator - give the agent eyes and hands on this Windows desktop.
 *
 * The plugin exposes five tools:
 *   desktop_observe  screenshot + window list + UI Automation tree (with text)
 *   desktop_act      mouse and keyboard actions (click / drag / scroll / key / type)
 *   browser_open     start Edge/Chrome with a debugging port and a persistent profile
 *   browser_observe  read a logged-in page: URL, text, form fields, clickable elements
 *   browser_act      navigate, click, type, press keys, run page script, screenshot
 *
 * Nothing here generates automation scripts: the model decides one step at a
 * time from what it observes, exactly like a person using the computer.
 *
 * @module @local/dsh-gui-operator
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { probeBrowser } from './lib/cdp.js'
import { DEFAULT_PORT, PROFILE_DIR, actOnPage, observePage, openBrowser } from './lib/browser.js'
import { encodeText, runOperator, withDesktopLock } from './lib/operator.js'

export const name = 'gui-operator'
export const inject = ['tools']

/** Bound for a whole desktop action, including app-side hangs. */
const ACTION_TIMEOUT_MS = 20_000

/** Bound for observation: UIA can be slow on huge trees. */
const OBSERVE_TIMEOUT_MS = 45_000

/** Cap on remembered element references across snapshots. */
const MAX_REFS = 4000

/**
 * Element references handed to the model, keyed by a short id.
 * @type {Map<string, { hwnd: number, path: string, type: string, name: string }>}
 */
const refs = new Map()
let refCounter = 0

/** Render text as the model-facing content block. */
function text(value) {
  return [{ type: 'text', text: String(value) }]
}

/** Uniform output declaration: a text summary plus optional structured extras. */
function outputSchema(properties) {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['text'],
    properties: { text: { type: 'string' }, ...properties },
  }
}

/**
 * Drop undefined members before a value leaves the tool: the tool result must be
 * lossless JSON, and an absent optional field has to be absent rather than undefined.
 */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) result[key] = clean(member)
    }
    return result
  }
  return value
}

// ------------------------------------------------------------------ validation

function requireString(args, key, options = {}) {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${key}" is required and must be a non-empty string`)
  }
  const max = options.maxLength ?? 20_000
  if (value.length > max) throw new Error(`"${key}" is longer than ${max} characters`)
  return value
}

function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`)
  return value
}

function optionalInt(args, key, { min = -100_000, max = 100_000 } = {}) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${key}" must be a number`)
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) throw new Error(`"${key}" must be between ${min} and ${max}`)
  return rounded
}

function optionalBool(args, key, fallback) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be a boolean`)
  return value
}

function enumValue(args, key, allowed, fallback) {
  const value = args[key] ?? fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`"${key}" must be one of ${allowed.join(', ')}`)
  }
  return value
}

// ---------------------------------------------------------------- element refs

/** Forget one window's references, then record the new snapshot. */
function registerElements(hwnd, elements) {
  for (const [key, value] of refs) {
    if (value.hwnd === hwnd) refs.delete(key)
  }
  const added = []
  for (const element of elements) {
    refCounter += 1
    const id = `e${refCounter}`
    refs.set(id, {
      hwnd,
      path: element.p ?? '',
      type: element.t ?? '',
      name: element.n ?? '',
    })
    added.push({ id, element })
  }
  while (refs.size > MAX_REFS) {
    const oldest = refs.keys().next().value
    refs.delete(oldest)
  }
  return added
}

/** Look up a reference, or fail with an actionable message. */
function resolveRef(id) {
  const entry = refs.get(id)
  if (!entry) {
    throw new Error(`unknown element reference "${id}"; run desktop_observe and use a ref from that result`)
  }
  return entry
}

/** Ask the helper where an element is right now. */
async function resolveElement(entry) {
  const args = ['resolve', '--hwnd', String(entry.hwnd), '--path', entry.path]
  if (entry.type) args.push('--type', entry.type)
  if (entry.name) args.push('--name', entry.name)
  return runOperator(args, { timeoutMs: ACTION_TIMEOUT_MS })
}

/**
 * A resolved element is only safe to type into or click when its window is in
 * front; input goes to whatever window holds focus. Focus it, then re-resolve
 * because the control may have moved while the window came forward.
 */
async function ensureForeground(target, entry) {
  if (target.fg === true) return target
  await runOperator(['focus', String(entry.hwnd)], { timeoutMs: ACTION_TIMEOUT_MS })
  return resolveElement(entry)
}

/** Focus a window given a handle or a title substring. */
async function focusWindow(spec, timeoutMs = ACTION_TIMEOUT_MS) {
  const text = String(spec)
  if (/^\d+$/.test(text)) {
    await runOperator(['focus', text], { timeoutMs })
    return Number(text)
  }
  const resolved = await runOperator(['observe', '--window', text, '--no-shot', '--no-tree'], { timeoutMs })
  const hwnd = resolved.window?.hwnd
  if (!hwnd) throw new Error(`could not resolve window "${spec}"`)
  await runOperator(['focus', String(hwnd)], { timeoutMs })
  return hwnd
}

// ------------------------------------------------------------------- formatting

function formatWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return '(no visible windows)'
  return windows.map((window, index) => {
    const rect = Array.isArray(window.r) ? window.r.join(',') : '?'
    const flags = window.min ? ' [minimized]' : ''
    return `${index + 1}. hwnd=${window.hwnd} ${window.process || '?'} "${trim(window.title, 90)}" rect=${rect}${flags}`
  }).join('\n')
}

function formatElement(id, element) {
  const parts = [`${id} ${element.t || '?'}`, JSON.stringify(trim(element.n, 100))]
  if (element.aid) parts.push(`aid=${element.aid}`)
  if (Array.isArray(element.r)) parts.push(`@${element.r[0]},${element.r[1]} ${element.r[2]}x${element.r[3]}`)
  if (typeof element.v === 'string' && element.v.length > 0) parts.push(`value=${JSON.stringify(trim(element.v, 160))}`)
  if (element.pwd) parts.push('[password]')
  if (element.dis) parts.push('[disabled]')
  if (element.off) parts.push('[offscreen]')
  return parts.join(' ')
}

function trim(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Compose the model-facing observation summary. */
function describeObservation(result, added, options) {
  const lines = []
  const screen = result.screen ?? {}
  lines.push(`screen: ${screen.w}x${screen.h} physical px at ${screen.x},${screen.y} (${screen.count ?? 1} display(s))`)

  if (result.screenshot) {
    const shot = result.screenshot
    lines.push(`screenshot: ${shot.path} (${shot.w}x${shot.h}, scale ${shot.scale}) - call read_image on that path to look at the screen`)
    if (shot.scale !== 1) {
      lines.push(`note: the image is scaled by ${shot.scale}; screen x = ${screen.x} + imageX * ${1 / shot.scale}, screen y = ${screen.y} + imageY * ${1 / shot.scale}. Clicking by element ref avoids this arithmetic.`)
    }
  } else {
    lines.push('screenshot: skipped')
  }

  lines.push('windows (topmost first):')
  lines.push(formatWindows(result.windows))

  if (result.window) {
    lines.push(`target window: hwnd=${result.window.hwnd} "${trim(result.window.title, 90)}"`)
    if (result.window.min) {
      lines.push('this window is minimized: its control rectangles are not on screen. Call desktop_act action=focus on it, then observe again before clicking by ref.')
    }
    lines.push(`elements: ${added.length}${result.truncated ? ' (truncated; raise maxElements or focus a smaller window)' : ''}`)
    if (added.length === 0) {
      lines.push('(no interactive or text elements found; the app may draw its own UI - use the screenshot and x/y coordinates)')
    } else {
      for (const { id, element } of added) lines.push(formatElement(id, element))
    }
    if (result.passwordFields > 0) lines.push(`(${result.passwordFields} password field(s) present; their values are never read)`)
  } else {
    lines.push('elements: skipped (pass tree=true or a window spec)')
  }

  if (options.note) lines.push(options.note)
  return lines.join('\n')
}

// ----------------------------------------------------------------------- tools

const desktopObserve = {
  name: 'desktop_observe',
  description:
    'Look at this Windows desktop: capture a screenshot and list the top-level windows, then read one window\'s UI Automation tree (buttons, menus, edit boxes with their values, and text content). Use it before any desktop action and again after an action that changed the screen. Element refs such as e12 are only valid for the window they came from and only until the next desktop_observe of that window.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: {
        type: 'string',
        description: 'Window to read the tree of: a title or process-name substring (e.g. "Notepad", "计算器"), or a numeric hwnd. Omit for the foreground window.',
      },
      tree: { type: 'boolean', description: 'Read the control tree. Defaults to true; set false for a screenshot-only look.' },
      screenshot: { type: 'boolean', description: 'Capture the desktop. Defaults to true.' },
      maxElements: { type: 'integer', description: 'Maximum elements to return, 1-600. Defaults to 150.' },
      includeAll: { type: 'boolean', description: 'Include container/pane nodes too. Defaults to false (interactive and text nodes only).' },
      maxWidth: { type: 'integer', description: 'Downscale the screenshot to this pixel width. Omit for native pixels, which keeps image and screen coordinates identical.' },
    },
  },
  output: {
    schema: outputSchema({
      screenshotPath: { type: 'string' },
      hwnd: { type: 'integer' },
      elementCount: { type: 'integer' },
      truncated: { type: 'boolean' },
    }),
    render: (_args, value) => text(value.text),
  },
  async execute(args) {
    const window = optionalString(args, 'window')
    const tree = optionalBool(args, 'tree', true)
    const screenshot = optionalBool(args, 'screenshot', true)
    const includeAll = optionalBool(args, 'includeAll', false)
    const maxElements = optionalInt(args, 'maxElements', { min: 1, max: 600 })
    const maxWidth = optionalInt(args, 'maxWidth', { min: 320, max: 8192 })

    const command = ['observe', '--max', String(maxElements ?? 150)]
    if (window) command.push('--window', window)
    if (!tree) command.push('--no-tree')
    if (!screenshot) command.push('--no-shot')
    if (includeAll) command.push('--all')
    if (maxWidth) command.push('--max-width', String(maxWidth))

    const result = await runOperator(command, { timeoutMs: OBSERVE_TIMEOUT_MS })
    const elements = Array.isArray(result.elements) ? result.elements : []
    const added = result.window ? registerElements(result.window.hwnd, elements) : []

    const summary = describeObservation(result, added, {})
    return clean({
      text: summary,
      screenshotPath: result.screenshot?.path,
      hwnd: result.window?.hwnd,
      elementCount: added.length,
      truncated: Boolean(result.truncated),
    })
  },
}

const desktopAct = {
  name: 'desktop_act',
  description:
    'Operate this Windows desktop: click (by element ref or screen coordinates), double-click, right-click, move, drag, scroll, press a key combination, or type text. Coordinates are physical screen pixels, the same space desktop_observe reports. Typing pastes the text, so CJK and emoji work, and the previous clipboard content is restored afterwards. One action per call; observe again when you need to see the result.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'key', 'type', 'focus', 'wait'],
        description: 'What to do.',
      },
      ref: { type: 'string', description: 'Element reference from desktop_observe, e.g. e12. For type, the element is clicked first to focus it. Preferred over x/y because it is re-checked against the live control before acting.' },
      x: { type: 'integer', description: 'Screen x in physical pixels (click/move/drag/scroll anchor).' },
      y: { type: 'integer', description: 'Screen y in physical pixels.' },
      x2: { type: 'integer', description: 'Drag end x.' },
      y2: { type: 'integer', description: 'Drag end y.' },
      amount: { type: 'integer', description: 'Scroll wheel clicks, -20..20; negative scrolls down.' },
      keys: { type: 'string', description: 'Key combination such as "ctrl+s", "alt+tab", "enter", "win+r".' },
      text: { type: 'string', description: 'Text to type (pasted at the caret).' },
      focus: { type: 'string', description: 'Window title/process substring or hwnd to bring to the front before acting.' },
      delayMs: { type: 'integer', description: 'Wait after the action, 0-5000. Use when the app needs time to open a dialog.' },
    },
  },
  output: {
    schema: outputSchema({ action: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } }),
    render: (_args, value) => text(value.text),
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    // One uninterrupted sequence: focus, resolve, click, type must not interleave
    // with another session's helper call.
    return withDesktopLock(() => runDesktopAction(args))
  },
}

/**
 * Execute one validated desktop action.
 * @param {Record<string, unknown>} args
 */
async function runDesktopAction(args) {
  const action = enumValue(args, 'action', ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'key', 'type', 'focus', 'wait'], 'click')
  const ref = optionalString(args, 'ref')
  const focusSpec = optionalString(args, 'focus')
  const delayMs = optionalInt(args, 'delayMs', { min: 0, max: 5000 }) ?? 0

  if (focusSpec) await focusWindow(focusSpec)

  if (action === 'wait') {
    const ms = Math.min(Math.max(optionalInt(args, 'delayMs', { min: 0, max: 5000 }) ?? 500, 0), 5000)
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { text: `waited ${ms}ms`, action }
  }

  if (action === 'focus') {
    if (!focusSpec) throw new Error('focus needs "focus" (window title or hwnd)')
    return { text: `focused window "${focusSpec}"`, action }
  }

  if (action === 'move') {
    const x = optionalInt(args, 'x')
    const y = optionalInt(args, 'y')
    if (x === undefined || y === undefined) throw new Error('move needs x and y')
    const result = await runOperator(['move', String(x), String(y)], { timeoutMs: ACTION_TIMEOUT_MS })
    return clean({ text: `moved the pointer to ${result.x},${result.y}`, action, x: result.x, y: result.y })
  }

  if (action === 'drag') {
    const x = optionalInt(args, 'x')
    const y = optionalInt(args, 'y')
    const x2 = optionalInt(args, 'x2')
    const y2 = optionalInt(args, 'y2')
    if (x === undefined || y === undefined || x2 === undefined || y2 === undefined) {
      throw new Error('drag needs x, y, x2 and y2')
    }
    await runOperator(['drag', String(x), String(y), String(x2), String(y2)], { timeoutMs: ACTION_TIMEOUT_MS })
    return clean({ text: `dragged from ${x},${y} to ${x2},${y2}`, action, x, y })
  }

  if (action === 'scroll') {
    const amount = optionalInt(args, 'amount', { min: -20, max: 20 }) ?? 3
    const x = optionalInt(args, 'x')
    const y = optionalInt(args, 'y')
    const command = ['scroll', String(amount)]
    if (x !== undefined && y !== undefined) command.push(String(x), String(y))
    await runOperator(command, { timeoutMs: ACTION_TIMEOUT_MS })
    return clean({ text: `scrolled ${amount} click(s)${x !== undefined ? ` at ${x},${y}` : ''}`, action })
  }

  if (action === 'key') {
    const keys = requireString(args, 'keys', { maxLength: 120 })
    await runOperator(['key', keys], { timeoutMs: ACTION_TIMEOUT_MS })
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return clean({ text: `pressed ${keys}`, action })
  }

  if (action === 'type') {
    const content = args.text
    if (typeof content !== 'string') throw new Error('type needs "text"')
    // The text travels as base64 on the command line, which Windows caps at
    // 32767 characters; measure bytes, not characters, so CJK cannot overflow it.
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > 20_000) {
      throw new Error(`"text" is ${bytes} bytes; type at most 20000 bytes per call (about 6600 Chinese characters)`)
    }
    if (ref) {
      const entry = resolveRef(ref)
      const target = await ensureForeground(await resolveElement(entry), entry)
      await runOperator(['click', String(target.x), String(target.y), 'left', '1'], { timeoutMs: ACTION_TIMEOUT_MS })
    }
    await runOperator(['type', encodeText(content)], { timeoutMs: ACTION_TIMEOUT_MS })
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return clean({ text: `typed ${content.length} character(s)${ref ? ` into ${ref}` : ''}`, action })
  }

  // click / double_click / right_click
  const button = action === 'right_click' ? 'right' : 'left'
  const count = action === 'double_click' ? '2' : '1'
  let x = optionalInt(args, 'x')
  let y = optionalInt(args, 'y')
  let refNote = ''

  if (ref) {
    const entry = resolveRef(ref)
    const target = await ensureForeground(await resolveElement(entry), entry)
    x = target.x
    y = target.y
    refNote = ` (${ref})`
  }
  if (x === undefined || y === undefined) throw new Error('click needs either "ref" or both x and y')

  const result = await runOperator(['click', String(x), String(y), button, count], { timeoutMs: ACTION_TIMEOUT_MS })
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
  return clean({
    text: `${action.replace('_', '-')} at ${result.x},${result.y}${refNote}`,
    action,
    x: result.x,
    y: result.y,
  })
}

const browserOpen = {
  name: 'browser_open',
  description:
    'Start Microsoft Edge or Google Chrome with a debugging port and a private persistent profile, which is what lets the agent read pages that require a login. Log in once in that window and the session survives restarts. Reuses an already running debugging browser on the same port.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string', description: 'Page to open. Defaults to about:blank.' },
      port: { type: 'integer', description: 'Debugging port. Defaults to 9222.' },
    },
  },
  output: {
    schema: outputSchema({ port: { type: 'integer' }, profile: { type: 'string' }, tabs: { type: 'array' } }),
    render: (_args, value) => text(value.text),
  },
  async execute(args) {
    const url = optionalString(args, 'url')
    const port = optionalInt(args, 'port', { min: 1024, max: 65_535 }) ?? DEFAULT_PORT
    const result = await openBrowser({ port, url })
    const tabs = Array.isArray(result.tabs) ? result.tabs : []
    const lines = [
      result.alreadyRunning
        ? `a debugging browser is already listening on port ${port} (${result.browser})`
        : `started ${result.executable ?? result.browser} on port ${port}`,
      `profile: ${result.profile ?? PROFILE_DIR}`,
      'tabs:',
      ...tabs.map((tab) => `  ${tab.index}. ${trim(tab.title, 80)} - ${trim(tab.url, 120)}`),
      tabs.length === 0 ? '  (none yet)' : '',
      'If a page asks for a login, ask the user to sign in in that window, then call browser_observe again.',
    ].filter(Boolean)
    return { text: lines.join('\n'), port, profile: result.profile ?? PROFILE_DIR, tabs }
  },
}

const browserObserve = {
  name: 'browser_observe',
  description:
    'Read a page in the debugging browser: URL, title, visible text, form fields (with current values, never passwords), and clickable elements with CSS selectors. This works on pages behind a login because it reads the user\'s own browser session. Run browser_open first; if the port is not listening the call fails with that hint.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tab: { type: 'string', description: 'Tab to read: 1-based index, or a URL/title substring. Defaults to the first tab.' },
      maxText: { type: 'integer', description: 'Maximum characters of page text, 200-40000. Defaults to 6000.' },
      maxItems: { type: 'integer', description: 'Maximum fields and clickable elements each, 5-300. Defaults to 80.' },
      selector: { type: 'string', description: 'Restrict text and element collection to this CSS selector, e.g. "main" or "#content".' },
      port: { type: 'integer', description: 'Debugging port. Defaults to 9222.' },
    },
  },
  output: {
    schema: outputSchema({ url: { type: 'string' }, tabTitle: { type: 'string' } }),
    render: (_args, value) => text(value.text),
  },
  async execute(args) {
    const tab = optionalString(args, 'tab')
    const maxText = optionalInt(args, 'maxText', { min: 200, max: 40_000 })
    const maxItems = optionalInt(args, 'maxItems', { min: 5, max: 300 })
    const selector = optionalString(args, 'selector')
    const port = optionalInt(args, 'port', { min: 1024, max: 65_535 }) ?? DEFAULT_PORT

    await requireBrowser(port)
    const result = await observePage({ port, tab, maxText, maxItems, selector })
    const snapshot = result.snapshot ?? {}
    if (snapshot.error) throw new Error(`page read failed: ${snapshot.error}`)

    const lines = [
      `tab: ${trim(result.tab.title, 90)}`,
      `url: ${snapshot.url ?? result.tab.url}`,
      `readyState: ${snapshot.readyState ?? '?'}, viewport ${snapshot.viewport?.w}x${snapshot.viewport?.h} at scrollY ${snapshot.viewport?.scrollY ?? 0}`,
      '',
      'page text:',
      snapshot.text && snapshot.text.length > 0 ? snapshot.text : '(empty)',
    ]

    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : []
    lines.push('', `form fields (${fields.length}):`)
    for (const field of fields) {
      const bits = [`  ${field.tag}${field.type ? `[${field.type}]` : ''}`, `selector=${field.selector}`]
      if (field.label) bits.push(`label=${JSON.stringify(field.label)}`)
      if (field.placeholder) bits.push(`placeholder=${JSON.stringify(field.placeholder)}`)
      if (field.name) bits.push(`name=${field.name}`)
      if (typeof field.value === 'string') bits.push(`value=${JSON.stringify(field.value)}`)
      if (field.checked !== undefined) bits.push(`checked=${field.checked}`)
      if (field.password) bits.push('[password]')
      if (field.disabled) bits.push('[disabled]')
      lines.push(bits.join(' '))
    }
    if (fields.length === 0) lines.push('  (none)')

    const clickables = Array.isArray(snapshot.clickables) ? snapshot.clickables : []
    lines.push('', `clickable elements (${clickables.length}):`)
    for (const item of clickables) {
      const bits = [`  ${item.tag}`, JSON.stringify(trim(item.text, 80)), `selector=${item.selector}`]
      if (item.href) bits.push(`href=${trim(item.href, 100)}`)
      if (item.disabled) bits.push('[disabled]')
      lines.push(bits.join(' '))
    }
    if (clickables.length === 0) lines.push('  (none)')

    lines.push('', 'other tabs:', ...result.tabs.map((entry) => `  ${entry.index}. ${trim(entry.title, 70)}`))

    return { text: lines.join('\n'), url: snapshot.url ?? result.tab.url, tabTitle: result.tab.title }
  },
}

const browserAct = {
  name: 'browser_act',
  description:
    'Operate a page in the debugging browser: navigate, click, type, press keys, scroll, run page script, take a screenshot, or manage tabs. Clicking dispatches a real mouse event at the element center. After acting, call browser_observe to read the new state.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['goto', 'click', 'type', 'press', 'scroll', 'eval', 'screenshot', 'back', 'list', 'new_tab', 'activate', 'close_tab'],
        description: 'What to do.',
      },
      tab: { type: 'string', description: 'Target tab: 1-based index or URL/title substring.' },
      url: { type: 'string', description: 'URL for goto and new_tab.' },
      selector: { type: 'string', description: 'CSS selector of the element to click or type into. Preferred: it stays valid across observations.' },
      text: { type: 'string', description: 'For click: visible text to find the element by. For type: the text to insert.' },
      key: { type: 'string', description: 'For press: e.g. Enter, Tab, Escape, ctrl+a.' },
      script: { type: 'string', description: 'For eval: JavaScript body executed in the page, with await available. Return a value with `return`.' },
      amount: { type: 'integer', description: 'For scroll: pixels, negative scrolls up. Defaults to 600.' },
      port: { type: 'integer', description: 'Debugging port. Defaults to 9222.' },
    },
  },
  output: {
    schema: outputSchema({ action: { type: 'string' } }),
    render: (_args, value) => text(value.text),
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const action = enumValue(args, 'action', ['goto', 'click', 'type', 'press', 'scroll', 'eval', 'screenshot', 'back', 'list', 'new_tab', 'activate', 'close_tab'], 'list')
    const tab = optionalString(args, 'tab')
    const url = optionalString(args, 'url')
    const selector = optionalString(args, 'selector')
    const textValue = optionalString(args, 'text')
    const key = optionalString(args, 'key')
    const script = optionalString(args, 'script')
    const amount = optionalInt(args, 'amount', { min: -20_000, max: 20_000 })
    const port = optionalInt(args, 'port', { min: 1024, max: 65_535 }) ?? DEFAULT_PORT

    await requireBrowser(port)
    const result = await actOnPage({ port, tab, action, url, selector, text: textValue, key, script, amount })

    const lines = []
    if (action === 'list') {
      lines.push('tabs:', ...(result.tabs ?? []).map((entry) => `  ${entry.index}. ${trim(entry.title, 70)} - ${trim(entry.url, 110)}`))
    } else if (action === 'goto') {
      const redirected = result.url && result.url !== result.requested ? ` (redirected to ${result.url})` : ''
      lines.push(`navigated to ${result.requested}${redirected} (readyState ${result.readyState})`, `title: ${trim(result.tabTitle, 90)}`)
    } else if (action === 'click') {
      const clicked = result.clicked
      lines.push(result.mode === 'dom'
        ? `clicked element through the DOM (it had no layout box): ${JSON.stringify(clicked)}`
        : `clicked ${clicked.tag} ${JSON.stringify(trim(clicked.text, 80))} at ${result.x},${result.y}`)
    } else if (action === 'type') {
      lines.push(`typed ${result.typed} character(s); the field now reads ${JSON.stringify(trim(result.value, 120))}`)
    } else if (action === 'press') {
      lines.push(`pressed ${result.pressed}`)
    } else if (action === 'scroll') {
      lines.push(`scrolled ${result.scrolled}px; scrollY is now ${result.scrollY}`)
    } else if (action === 'eval') {
      lines.push(`script result: ${JSON.stringify(result.value)}`)
    } else if (action === 'screenshot') {
      lines.push(`page screenshot: ${result.path}`, 'call read_image on that path to look at it')
    } else if (action === 'back') {
      lines.push(`went back; now at ${result.url} (readyState ${result.readyState})`)
    } else if (action === 'new_tab') {
      lines.push(`opened ${result.created.url}`, 'tabs:', ...(result.tabs ?? []).map((entry) => `  ${entry.index}. ${trim(entry.title, 70)}`))
    } else if (action === 'activate') {
      lines.push(`activated tab ${result.activated.title}`)
    } else if (action === 'close_tab') {
      lines.push(`closed ${result.closed.url}`)
    }

    return { text: lines.join('\n'), action }
  },
}

/** Fail early with the fix when the debugging browser is not running. */
async function requireBrowser(port) {
  const info = await probeBrowser(port)
  if (!info) {
    throw new Error(`no browser is listening on the debugging port ${port}; call browser_open first (or open Edge/Chrome yourself with --remote-debugging-port=${port})`)
  }
}

// -------------------------------------------------------------------- lifecycle

/**
 * Register the five tools and remove them when the plugin unloads.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  mkdirSync(path.join(homedir(), '.dsh-gui-operator'), { recursive: true })
  const definitions = [desktopObserve, desktopAct, browserOpen, browserObserve, browserAct]
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}