/**
 * Runner for native/gui-operator.exe.
 *
 * Every desktop observation and input action goes through this module so there
 * is exactly one place that knows the executable's argument format, the timeout
 * policy, and the serialization rule that keeps concurrent actions from
 * fighting over the cursor.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path of the helper executable shipped with this plugin. */
export const operatorPath = path.join(here, '..', 'native', 'gui-operator.exe')

/** Default budget for one helper invocation. Bounded because UIA can hang on a stuck app. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Cap on captured stdout/stderr so a malformed run cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/** Serializes helper invocations: two clicks must never interleave. */
let tail = Promise.resolve()

/** Nesting depth of withDesktopLock; calls inside the lock bypass the queue. */
let lockDepth = 0

/**
 * Run several helper calls as one uninterrupted sequence.
 *
 * A single click is atomic by itself, but composite actions (focus window ->
 * resolve element -> click -> type) are not: without this lock another session's
 * helper call could land between "focus" and "type" and receive the keystrokes.
 * While the lock is held, runOperator executes immediately instead of queueing.
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export function withDesktopLock(work) {
  const task = tail.then(async () => {
    lockDepth += 1
    try {
      return await work()
    } finally {
      lockDepth -= 1
    }
  })
  tail = task.then(() => undefined, () => undefined)
  return task
}

/**
 * Run one helper command and parse its JSON result.
 * @param {string[]} args - helper arguments, passed without a shell.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, unknown>>} the parsed JSON object.
 */
export function runOperator(args, options = {}) {
  if (lockDepth > 0) return spawnAndParse(args, options)
  const task = tail.then(() => spawnAndParse(args, options))
  // Keep the chain alive even when one call rejects.
  tail = task.then(() => undefined, () => undefined)
  return task
}

/**
 * Spawn the helper, enforce the timeout, and decode its single JSON line.
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
function spawnAndParse(args, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    if (!existsSync(operatorPath)) {
      reject(new Error(`helper is missing: ${operatorPath}. Run: powershell -ExecutionPolicy Bypass -File native/build.ps1`))
      return
    }

    const child = spawn(operatorPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timer

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }

    timer = setTimeout(() => {
      child.kill()
      finish(new Error(`helper timed out after ${timeoutMs}ms (command: ${args[0]})`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_CAPTURE_BYTES) {
        child.kill()
        finish(new Error('helper produced too much output'))
        return
      }
      stdout.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      // stderr is diagnostic only; keep a bounded tail.
      if (stderrBytes <= MAX_CAPTURE_BYTES) stderr.push(chunk)
    })

    child.on('error', (error) => {
      finish(new Error(`cannot start helper: ${error.message}`))
    })

    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim()
      const err = Buffer.concat(stderr).toString('utf8').trim()
      if (out.length === 0) {
        finish(new Error(`helper returned nothing (exit ${code})${err ? `: ${err.slice(0, 800)}` : ''}`))
        return
      }
      let parsed
      try {
        parsed = JSON.parse(out)
      } catch {
        finish(new Error(`helper returned non-JSON output (exit ${code}): ${out.slice(0, 400)}`))
        return
      }
      if (parsed && parsed.ok === true) {
        finish(undefined, parsed)
        return
      }
      const message = parsed && typeof parsed.error === 'string' ? parsed.error : 'unknown helper failure'
      const error = new Error(message)
      if (parsed && typeof parsed.code === 'string') error.code = parsed.code
      finish(error)
    })
  })
}

/**
 * Encode text as base64 so any Unicode content (CJK, emoji, quotes) survives the
 * command line unchanged.
 * @param {string} text
 * @returns {string}
 */
export function encodeText(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}