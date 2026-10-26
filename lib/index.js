/**
 * dsh-better-quark-drive — cordis plugin entry.
 *
 * The plugin only needs one host service: `tools`. Everything else (where the
 * CLI lives, which account is logged in) is discovered lazily at call time, so
 * installing the plugin before installing the CLI never breaks DSH startup.
 */

import { locateCli } from './cli.js'
import { DEFAULTS, registerQuarkTools } from './tools.js'

export const name = 'dsh-better-quark-drive'

/** Host services this plugin consumes. */
export const inject = ['tools']

/** Merged configuration (see cordis.patch.yml for the shipped defaults). */
export function resolveConfig(config = {}) {
  const merged = { ...DEFAULTS, ...(config || {}) }
  merged.shareUrlType = Number(merged.shareUrlType) === 2 ? 2 : 1
  merged.shareExpireDays = Number.isFinite(Number(merged.shareExpireDays)) ? Number(merged.shareExpireDays) : 7
  merged.maxRows = Number.isFinite(Number(merged.maxRows)) ? Number(merged.maxRows) : DEFAULTS.maxRows
  return merged
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  if (cfg.enabled === false) return { enabled: false, tools: [] }

  const result = registerQuarkTools(ctx, cfg)

  // Diagnostics only: never log paths of user files or any credential.
  try {
    const cli = locateCli(cfg)
    ctx.logger?.info?.(
      `[better-quark-drive] ${result.tools.length} tools ready; CLI ${cli ? 'found' : 'not found (run quark_setup)'}`,
    )
  } catch {
    /* logging must never break mounting */
  }

  return { enabled: true, ...result }
}
