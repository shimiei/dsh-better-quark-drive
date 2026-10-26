#!/usr/bin/env node
/**
 * Offline smoke test for dsh-better-quark-drive.
 *
 *   node scripts/smoke.mjs          # offline: mount the plugin against a stub
 *                                   # tools service and validate every spec
 *   node scripts/smoke.mjs --live   # additionally run `get-user-info` through
 *                                   # the real CLI and report auth + capacity
 *
 * Nothing here uploads, shares, downloads or prints account identifiers.
 */

import { apply, resolveConfig } from '../lib/index.js'
import { QuarkCliError, locateCli, runQuark } from '../lib/cli.js'

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
  console.log(`${condition ? '  ✓' : '  ✗'} ${message}`)
}

function stubContext() {
  const registered = []
  return {
    ctx: { tools: { register: (tool) => registered.push(tool) }, logger: { info: () => {} } },
    registered,
  }
}

console.log('== 1. plugin mounts against a stub tools service ==')
const { ctx, registered } = stubContext()
const mounted = apply(ctx, {})
check(mounted.enabled === true, 'apply() reports enabled')
check(registered.length === 12, `12 tools registered (got ${registered.length})`)

console.log('\n== 2. every tool spec is well formed ==')
const seen = new Set()
for (const tool of registered) {
  const name = tool.name
  check(/^quark_[a-z_]+$/.test(name || ''), `${name || '(missing)'} uses the quark_ prefix`)
  check(!seen.has(name), `${name} is unique`)
  seen.add(name)
  check(typeof tool.description === 'string' && tool.description.length > 20, `${name} has a usable description`)
  check(tool.parameters && tool.parameters.type === 'object', `${name} has an object parameter schema`)
  check(typeof tool.execute === 'function', `${name} implements execute()`)
  const required = tool.parameters?.required ?? []
  check(Array.isArray(required), `${name} required list is an array`)
  const output = tool.output?.schema
  check(output?.type === 'object' && output.properties?.summary, `${name} returns a text summary`)
}

console.log('\n== 3. config normalisation ==')
const cfg = resolveConfig({ shareUrlType: '2', shareExpireDays: '30', maxRows: '5' })
check(cfg.shareUrlType === 2, 'shareUrlType coerces to 2')
check(cfg.shareExpireDays === 30, 'shareExpireDays coerces to 30')
check(cfg.maxRows === 5, 'maxRows coerces to 5')
check(resolveConfig({}).shareUrlType === 1, 'default share link is public')

console.log('\n== 4. CLI discovery ==')
const cli = locateCli(cfg)
check(cli === null || typeof cli === 'string', 'locateCli() returns a path or null')
console.log(`  · CLI: ${cli ?? 'not installed (quark_setup will explain how to install)'}`)

if (process.argv.includes('--live')) {
  console.log('\n== 5. live CLI (read-only) ==')
  if (!cli) {
    console.log('  - skipped: CLI missing')
  } else {
    try {
      const res = await runQuark(['get-user-info'], { config: cfg, sessionKey: 'smoke', sessionInput: 'smoke test' })
      const vip = res.result?.data?.vipInfo ?? {}
      const gb = (bytes) => `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)} GB`
      check(res.result?.code === 0, 'get-user-info returns code 0 (account authorized)')
      console.log(`  · 会员: ${vip.vipType ?? '普通用户'}`)
      console.log(`  · 容量: ${gb(vip.used)} / ${gb(vip.capacity)}`)
    } catch (error) {
      const text = error instanceof QuarkCliError ? error.toText() : String(error)
      check(false, `live call failed: ${text.split('\n')[0]}`)
    }
  }
}

console.log('')
if (failures.length > 0) {
  console.error(`FAILED (${failures.length})`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('PASS — plugin is loadable and every tool spec is valid.')
