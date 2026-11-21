// Verifies that the plugin's JavaScript entry point and its modules load and
// expose the shape the Harness expects. No Harness process is needed: the tool
// definitions are plain objects and the imports are Node builtins only.
//
//   node test/modules-check.cjs

const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const root = path.join(__dirname, '..')
  // Windows absolute paths must be turned into file:// URLs for dynamic import().
  const plugin = await import(pathToFileURL(path.join(root, 'index.js')).href)

  assert.strictEqual(plugin.name, 'gui-operator', 'unexpected plugin name')
  assert.deepStrictEqual([...plugin.inject], ['tools', 'systemPrompt'], 'the plugin must inject the tools and systemPrompt services')
  assert.strictEqual(typeof plugin.apply, 'function', 'apply() must be exported')

  // Every source file must parse as an ES module.
  const files = ['index.js', 'lib/operator.js', 'lib/cdp.js', 'lib/browser.js']
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' })
    assert.strictEqual(result.status, 0, `${file} does not parse: ${result.stderr}`)
  }

  console.log(`modules-check: ok (${files.length} files)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})