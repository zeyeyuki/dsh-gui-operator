/**
 * Browser half of the plugin: reads and operates pages that are already logged
 * in, through the Chrome DevTools Protocol.
 *
 * Why CDP instead of a fresh automation browser: the page must be the user's own
 * browser session (cookies, SSO, 2FA, extensions), so the plugin attaches to a
 * browser the user started with --remote-debugging-port and reuses its profile.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import {
  CdpSession, activateTab, closeTab, listTabs, openTab, pickTab, probeBrowser,
} from './cdp.js'

/** Default debugging port; overridable per call. */
export const DEFAULT_PORT = 9222

/** Where the persistent browser profile lives, so logins survive restarts. */
export const PROFILE_DIR = path.join(homedir(), '.dsh-gui-operator', 'browser-profile')

/** Compiled page reader; serialized into the page, so it must stay self-contained. */
function pageSnapshot(options) {
  const maxText = options.maxText
  const maxItems = options.maxItems
  const scopeSelector = options.selector

  const clip = (value, limit) => {
    const text = String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()
    return text.length > limit ? text.slice(0, limit) + '…' : text
  }
  const cssPath = (element) => {
    if (element.id) return '#' + CSS.escape(element.id)
    const parts = []
    let node = element
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      let part = node.tagName.toLowerCase()
      const name = node.getAttribute('name')
      if (name) {
        parts.unshift(part + '[name="' + name.replace(/"/g, '\\"') + '"]')
        break
      }
      const parent = node.parentElement
      if (parent) {
        const index = Array.prototype.indexOf.call(parent.children, node) + 1
        part += ':nth-child(' + index + ')'
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const scope = scopeSelector ? document.querySelector(scopeSelector) : document.body
  if (!scope) {
    return {
      url: location.href,
      title: document.title,
      error: scopeSelector ? 'selector matched nothing' : 'this document has no body (frameset, XML, or a viewer page)',
    }
  }

  const fields = []
  const clickables = []
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

  const nodes = scope.querySelectorAll('input, textarea, select, button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]')
  for (let i = 0; i < nodes.length && (fields.length + clickables.length) < maxItems * 2; i++) {
    const element = nodes[i]
    if (skip.has(element.tagName)) continue
    const tag = element.tagName.toLowerCase()

    if (tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable) {
      if (fields.length >= maxItems) continue
      const type = (element.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase()
      const entry = {
        tag,
        type,
        selector: cssPath(element),
        placeholder: clip(element.getAttribute('placeholder'), 60) || undefined,
        label: clip(element.getAttribute('aria-label') || element.labels?.[0]?.innerText, 60) || undefined,
        name: element.getAttribute('name') || undefined,
        disabled: element.disabled === true || undefined,
      }
      if (type !== 'password' && type !== 'hidden' && tag !== 'select') {
        entry.value = clip(element.value, 120) || undefined
      }
      if (type === 'password') entry.password = true
      if (type === 'checkbox' || type === 'radio') entry.checked = Boolean(element.checked)
      fields.push(entry)
      continue
    }

    if (clickables.length >= maxItems) continue
    const text = clip(element.innerText || element.value || element.getAttribute('aria-label') || element.title, 90)
    if (text.length === 0 && tag !== 'button') continue
    const entry = {
      tag,
      text,
      selector: cssPath(element),
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true' || undefined,
    }
    if (element.href && !element.href.startsWith('javascript:')) entry.href = clip(element.href, 200)
    clickables.push(entry)
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY) },
    text: clip(scope.innerText, maxText),
    fields,
    clickables,
  }
}

/** Locate one element by CSS selector or by visible text; serialized into the page. */
function locate(options) {
  const clip = (value, limit) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
    return text.length > limit ? text.slice(0, limit) + '…' : text
  }
  let element = null
  if (options.selector) {
    try { element = document.querySelector(options.selector) } catch (error) { return { error: 'bad selector: ' + error.message } }
    if (!element) return { error: 'selector matched nothing' }
  } else {
    const needle = String(options.text || '').replace(/\s+/g, ' ').trim()
    if (!needle) return { error: 'needs a selector or text' }
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input, textarea, select, [contenteditable="true"]'))
    const describe = (node) => clip(node.innerText || node.value || node.getAttribute('aria-label') || node.title, 200)
    element = candidates.find((node) => describe(node) === needle)
      || candidates.find((node) => describe(node).includes(needle))
  }
  if (!element) return { error: 'no element matched; call browser_observe for current selectors' }

  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    w: rect.width,
    h: rect.height,
    visible: rect.width > 0 && rect.height > 0,
    tag: element.tagName.toLowerCase(),
    text: clip(element.innerText || element.value, 120),
  }
}

/** Focus one element and put the caret at the end of its text. */
function focusElement(options) {
  let element = null
  if (options.selector) {
    try { element = document.querySelector(options.selector) } catch { return false }
  } else {
    element = document.activeElement
  }
  if (!element) return false
  element.focus()
  if (typeof element.setSelectionRange === 'function' && typeof element.value === 'string') {
    const end = options.append === false ? 0 : element.value.length
    try { element.setSelectionRange(end, end) } catch { /* inputs such as email reject it */ }
  }
  return true
}

/**
 * Start (or reuse) the browser with the debugging port and the persistent profile.
 * @param {{ port?: number, url?: string }} options
 * @returns {Promise<Record<string, unknown>>} launch result plus the tab list.
 */
export async function openBrowser(options = {}) {
  const port = options.port ?? DEFAULT_PORT
  const existing = await probeBrowser(port)
  if (existing) {
    return { alreadyRunning: true, port, browser: existing.Browser, tabs: await tabListing(port) }
  }

  const executable = findBrowserExecutable()
  if (!executable) {
    throw new Error('neither Microsoft Edge nor Google Chrome was found in Program Files or LocalAppData')
  }

  mkdirSync(PROFILE_DIR, { recursive: true })
  const url = options.url || 'about:blank'
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    url,
  ]
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
  // Without this listener a failed launch (EPERM, deleted executable) raises an
  // uncaught 'error' event, which would end the Harness process, not this call.
  let spawnError = null
  child.on('error', (error) => { spawnError = error })
  child.unref()

  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`cannot start ${executable}: ${spawnError.message}`)
    const ready = await probeBrowser(port)
    if (ready) {
      return {
        alreadyRunning: false,
        port,
        browser: ready.Browser,
        executable,
        profile: PROFILE_DIR,
        tabs: await tabListing(port),
      }
    }
    await delay(400)
  }
  if (spawnError) throw new Error(`cannot start ${executable}: ${spawnError.message}`)
  throw new Error(`the browser did not open its debugging port ${port} within 25s`)
}

/**
 * Read one page: URL, title, visible text, form fields, and clickable elements.
 * @param {{ port?: number, tab?: number | string, maxText?: number, maxItems?: number, selector?: string }} options
 */
export async function observePage(options = {}) {
  const port = options.port ?? DEFAULT_PORT
  const tabs = await listTabs(port)
  const tab = pickTab(tabs, options.tab)
  const session = await new CdpSession(tab.webSocketDebuggerUrl).ready()
  try {
    const expression = `(${pageSnapshot.toString()})(${JSON.stringify({
      maxText: clamp(options.maxText ?? 6000, 200, 40_000),
      maxItems: clamp(options.maxItems ?? 80, 5, 300),
      selector: options.selector ?? null,
    })})`
    const snapshot = await session.evaluate(expression)
    return { tab: { id: tab.id, title: tab.title, url: tab.url }, snapshot, tabs: tabListingFrom(tabs) }
  } finally {
    session.close()
  }
}

/**
 * Perform one page action.
 * @param {{ port?: number, tab?: number | string, action: string, selector?: string, text?: string,
 *           url?: string, key?: string, script?: string, amount?: number, append?: boolean }} options
 */
export async function actOnPage(options = {}) {
  const port = options.port ?? DEFAULT_PORT
  const action = String(options.action || '').toLowerCase()

  if (action === 'list') return { tabs: await tabListing(port) }
  if (action === 'new_tab') {
    if (!options.url) throw new Error('new_tab needs a url')
    const created = await openTab(port, options.url)
    return { created: { id: created.id, url: created.url }, tabs: await tabListing(port) }
  }
  if (action === 'activate') {
    const tab = pickTab(await listTabs(port), options.tab)
    await activateTab(port, tab.id)
    return { activated: { id: tab.id, title: tab.title, url: tab.url } }
  }
  if (action === 'close_tab') {
    const tab = pickTab(await listTabs(port), options.tab)
    await closeTab(port, tab.id)
    return { closed: { id: tab.id, url: tab.url }, tabs: await tabListing(port) }
  }

  const tabs = await listTabs(port)
  const tab = pickTab(tabs, options.tab)
  const session = await new CdpSession(tab.webSocketDebuggerUrl).ready()
  try {
    switch (action) {
      case 'goto': {
        if (!options.url) throw new Error('goto needs a url')
        await session.send('Page.enable')
        const navigation = await session.send('Page.navigate', { url: options.url })
        // CDP reports a failed navigation in the result instead of throwing.
        if (navigation && navigation.errorText) {
          throw new Error(`navigation to ${options.url} failed: ${navigation.errorText}`)
        }
        const ready = await waitForReady(session, 20_000)
        return {
          requested: options.url,
          url: await session.evaluate('location.href'),
          readyState: ready,
          tabTitle: await session.evaluate('document.title'),
        }
      }
      case 'click': {
        const target = await session.evaluate(`(${locate.toString()})(${JSON.stringify({ selector: options.selector ?? null, text: options.text ?? null })})`)
        if (target.error) throw new Error(target.error)
        if (!target.visible) {
          // Hidden element: fall back to a synthetic DOM click.
          const clicked = await session.evaluate(`(${domClick.toString()})(${JSON.stringify({ selector: options.selector ?? null, text: options.text ?? null })})`)
          return { clicked: clicked, mode: 'dom' }
        }
        await dispatchClick(session, target.x, target.y)
        return { clicked: { tag: target.tag, text: target.text }, x: Math.round(target.x), y: Math.round(target.y) }
      }
      case 'type': {
        if (typeof options.text !== 'string') throw new Error('type needs text')
        const focused = await session.evaluate(`(${focusElement.toString()})(${JSON.stringify({
          selector: options.selector ?? null,
          append: options.append !== false,
        })})`)
        if (!focused) throw new Error('could not focus the target field; pass selector')
        await session.send('Input.insertText', { text: options.text })
        const current = await session.evaluate(`(${readValue.toString()})(${JSON.stringify({ selector: options.selector ?? null })})`)
        return { typed: options.text.length, value: current }
      }
      case 'press': {
        const keys = String(options.key || '').trim()
        if (!keys) throw new Error('press needs key, e.g. Enter or ctrl+a')
        await pressCombo(session, keys)
        return { pressed: keys }
      }
      case 'scroll': {
        const amount = clamp(options.amount ?? 600, -20_000, 20_000)
        await session.evaluate(`window.scrollBy({ top: ${amount}, behavior: 'instant' })`)
        return { scrolled: amount, scrollY: await session.evaluate('Math.round(window.scrollY)') }
      }
      case 'eval': {
        if (!options.script) throw new Error('eval needs script')
        const value = await session.evaluate(`(async () => { ${options.script} })()`)
        return { value: value === undefined ? null : value }
      }
      case 'screenshot': {
        const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        const directory = path.join(tmpdir(), 'dsh-gui-operator')
        mkdirSync(directory, { recursive: true })
        const file = path.join(directory, `page-${Date.now()}.png`)
        writeFileSync(file, Buffer.from(shot.data, 'base64'))
        pruneOldFiles(directory, /^page-\d+\.png$/, 2 * 60 * 60 * 1000)
        return { path: file, url: await session.evaluate('location.href') }
      }
      case 'back': {
        await session.evaluate('history.back()')
        const ready = await waitForReady(session, 10_000)
        return { readyState: ready, url: await session.evaluate('location.href') }
      }
      default:
        throw new Error(`unknown browser action "${action}"`)
    }
  } finally {
    session.close()
  }
}

// --------------------------------------------------------------------- helpers

/** Synthetic click fallback for elements with no layout box. */
function domClick(options) {
  let element = null
  if (options.selector) element = document.querySelector(options.selector)
  else if (options.text) {
    const needle = String(options.text).replace(/\s+/g, ' ').trim()
    element = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]'))
      .find((node) => String(node.innerText || '').replace(/\s+/g, ' ').trim().includes(needle))
  }
  if (!element) return false
  element.click()
  return true
}

/** Read back the value of the field just typed into. */
function readValue(options) {
  let element = document.activeElement
  if (options && options.selector) element = document.querySelector(options.selector) || element
  if (!element) return null
  // Never echo a password or one-time-code field into the transcript.
  if (String(element.type || '').toLowerCase() === 'password') return '[password]'
  if (element.getAttribute && element.getAttribute('autocomplete') === 'one-time-code') return '[one-time-code]'
  if (typeof element.value === 'string') return element.value.slice(0, 200)
  return String(element.innerText || '').slice(0, 200)
}

/** Real mouse press through CDP so the page sees a trusted event. */
async function dispatchClick(session, x, y) {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await delay(250)
}

const KEY_TABLE = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

/** Send one key combination such as Enter, ctrl+a, shift+Tab. */
async function pressCombo(session, combo) {
  const tokens = combo.split('+').map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 0) throw new Error('empty key combination')

  let modifiers = 0
  let last = null
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') modifiers |= 2
    else if (lower === 'shift') modifiers |= 8
    else if (lower === 'alt') modifiers |= 1
    else if (lower === 'meta' || lower === 'win' || lower === 'cmd') modifiers |= 4
    else last = token
  }
  if (!last) throw new Error('key combination needs a non-modifier key')

  const entry = KEY_TABLE[last.toLowerCase()]
  const parameters = entry
    ? { key: entry.key, code: entry.code, windowsVirtualKeyCode: entry.windowsVirtualKeyCode, modifiers }
    : (last.length === 1
      ? { key: last, code: /[a-z]/i.test(last) ? `Key${last.toUpperCase()}` : `Digit${last}`, windowsVirtualKeyCode: last.toUpperCase().charCodeAt(0), modifiers }
      : null)
  if (!parameters) throw new Error(`unsupported key "${last}"`)

  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...parameters })
  if (entry?.text) await session.send('Input.dispatchKeyEvent', { type: 'char', text: entry.text, modifiers })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...parameters })
  await delay(120)
}

/** Poll document.readyState until complete or the deadline passes. */
async function waitForReady(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let state = 'loading'
  while (Date.now() < deadline) {
    try {
      state = await session.evaluate('document.readyState')
    } catch {
      state = 'loading'
    }
    if (state === 'complete' || state === 'interactive') return state
    await delay(250)
  }
  return state
}

/** Find an installed Chromium browser. */
export function findBrowserExecutable() {
  const roots = [
    process.env['PROGRAMFILES(X86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ].filter(Boolean)
  const candidates = []
  for (const root of roots) {
    candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

async function tabListing(port) {
  return tabListingFrom(await listTabs(port))
}

function tabListingFrom(tabs) {
  return tabs.map((tab, index) => ({ index: index + 1, id: tab.id, title: tab.title, url: tab.url }))
}

function clamp(value, low, high) {
  const number = Number(value)
  if (!Number.isFinite(number)) return low
  return Math.min(Math.max(Math.round(number), low), high)
}

/**
 * Delete screenshot files matching a pattern once they are older than maxAgeMs.
 * Failures are ignored: a stale file must never break an observation.
 * @param {string} directory
 * @param {RegExp} pattern
 * @param {number} maxAgeMs
 */
function pruneOldFiles(directory, pattern, maxAgeMs) {
  try {
    const cutoff = Date.now() - maxAgeMs
    for (const name of readdirSync(directory)) {
      if (!pattern.test(name)) continue
      const file = path.join(directory, name)
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
      } catch {
        // file vanished or is locked; skip it
      }
    }
  } catch {
    // folder missing or unreadable; nothing to prune
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}