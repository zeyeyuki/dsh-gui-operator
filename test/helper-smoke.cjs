// Smoke-tests the native helper without touching the desktop: invoked with no
// command it must answer with one JSON object and a NO_COMMAND error code.
// Run native/build.ps1 first.
//
//   node test/helper-smoke.cjs

const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const helper = path.join(__dirname, '..', 'native', 'gui-operator.exe')

if (!existsSync(helper)) {
  console.error(`helper-smoke: ${helper} is missing; run native/build.ps1 first`)
  process.exit(1)
}

const result = spawnSync(helper, [], { encoding: 'utf8', timeout: 20000 })
assert.strictEqual(result.status, 1, 'a command-less call must exit 1')

const payload = JSON.parse(result.stdout)
assert.strictEqual(payload.ok, false)
assert.strictEqual(payload.code, 'NO_COMMAND')
assert.ok(typeof payload.error === 'string' && payload.error.length > 0)

console.log('helper-smoke: ok')