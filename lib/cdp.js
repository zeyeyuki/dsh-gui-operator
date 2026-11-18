/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Uses the runtime's built-in `fetch` (target discovery over HTTP) and
 * `WebSocket` (Node 22+/Electron ships it), so the plugin needs no npm
 * dependency. Only the methods this plugin actually calls are wrapped.
 */

/** Relative-path HTTP helper against the browser's debugging endpoint. */
async function httpJson(port, pathname, method = 'GET', timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`debugging endpoint returned HTTP ${response.status} for ${pathname}`)
    }
    const text = await response.text()
    return text.length === 0 ? null : JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a browser is already listening on the debugging port.
 * @param {number} port
 * @returns {Promise<{Browser: string, webSocketDebuggerUrl: string} | null>}
 */
export async function probeBrowser(port) {
  try {
    return await httpJson(port, '/json/version')
  } catch {
    return null
  }
}

/**
 * List open tabs (CDP "targets").
 * @param {number} port
 * @returns {Promise<Array<{id: string, title: string, url: string, type: string}>>}
 */
export async function listTabs(port) {
  const targets = await httpJson(port, '/json/list')
  if (!Array.isArray(targets)) throw new Error('unexpected /json/list payload')
  return targets
    .filter((target) => target && target.type === 'page')
    .map((target) => ({
      id: target.id,
      title: target.title ?? '',
      url: target.url ?? '',
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }))
}

/**
 * Open a new tab.
 * @param {number} port
 * @param {string} url
 * @returns {Promise<object>} the created target.
 */
export async function openTab(port, url) {
  // Newer Chromium requires PUT for /json/new.
  return httpJson(port, `/json/new?${encodeURIComponent(url)}`, 'PUT', 10_000)
}

/**
 * Activate one tab by target id.
 * @param {number} port
 * @param {string} targetId
 */
export async function activateTab(port, targetId) {
  return httpJson(port, `/json/activate/${targetId}`)
}

/**
 * Close one tab by target id.
 * @param {number} port
 * @param {string} targetId
 */
export async function closeTab(port, targetId) {
  return httpJson(port, `/json/close/${targetId}`, 'GET', 10_000)
}

/** One CDP connection to one page target. */
export class CdpSession {
  /**
   * @param {string} webSocketUrl - target's webSocketDebuggerUrl.
   * @param {number} [callTimeoutMs]
   */
  constructor(webSocketUrl, callTimeoutMs = 15_000) {
    this.callTimeoutMs = callTimeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    this.socket = null

    if (typeof WebSocket !== 'function') {
      throw new Error('this runtime has no global WebSocket; Node 22 or newer is required')
    }

    this.socket = new WebSocket(webSocketUrl)

    // The handshake must be bounded: Chromium closes the socket without an
    // 'error' when a tab is closed or reloaded between listing and connecting,
    // which would otherwise leave this promise pending forever.
    let settleOpened
    this.opened = new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('browser debugging socket did not open within 5s')), 5000)
      settleOpened = finish
      this.socket.addEventListener('open', () => finish(), { once: true })
      this.socket.addEventListener('error', () => finish(new Error('cannot connect to the browser debugging socket')), { once: true })
    })
    this.settleOpened = settleOpened

    this.socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (typeof message.id !== 'number') return // event, not a reply
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${message.error.message ?? 'protocol error'}`))
      else entry.resolve(message.result)
    })

    this.socket.addEventListener('close', () => {
      this.closed = true
      this.settleOpened?.(new Error('browser debugging socket closed before it opened'))
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('browser debugging socket closed'))
      }
      this.pending.clear()
    })
  }

  /** Wait until the socket handshake completed. */
  async ready() {
    await this.opened
    return this
  }

  /**
   * Send one protocol command and resolve its result.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('browser debugging socket is closed'))
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${this.callTimeoutMs}ms`))
      }, this.callTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.send(payload)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /**
   * Evaluate an expression in the page and return its value.
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: this.callTimeoutMs,
    })
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'evaluation failed'
      throw new Error(`page script failed: ${description}`)
    }
    return result.result?.value
  }

  /** Close the socket without waiting. */
  close() {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // already closing
    }
  }
}

/**
 * Pick one tab: by 1-based index, by URL/title substring, or the first tab.
 * @param {Array<{id: string, title: string, url: string}>} tabs
 * @param {number | string | undefined} wanted
 * @returns {{id: string, title: string, url: string}}
 */
export function pickTab(tabs, wanted) {
  if (tabs.length === 0) throw new Error('the browser has no open tabs; pass a url to browser_act action=goto')
  if (wanted === undefined || wanted === null || wanted === '') return tabs[0]

  // The tool schema types `tab` as a string, so an index arrives as "2"; accept
  // both forms instead of searching for the literal text "2" in URLs.
  const indexText = String(wanted).trim()
  if (typeof wanted === 'number' || /^\d+$/.test(indexText)) {
    const index = Number(indexText)
    const tab = tabs[index - 1]
    if (!tab) throw new Error(`no tab at index ${index}; there are ${tabs.length} tabs`)
    return tab
  }

  const needle = indexText.toLowerCase()
  const match = tabs.find((tab) => tab.url.toLowerCase().includes(needle))
    ?? tabs.find((tab) => tab.title.toLowerCase().includes(needle))
  if (!match) throw new Error(`no open tab matches "${wanted}"`)
  return match
}