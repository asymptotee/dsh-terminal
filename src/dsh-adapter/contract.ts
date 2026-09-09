/**
 * The upstream contract: the published @deepseek-ai version line this package
 * is built against, and the blessed package list the adapter may import.
 * Version drift is detected at startup (warning) and fails CI through
 * `scripts/verify-contract.ts`. Every dependency is pinned exactly so the
 * contract and the installed tree cannot silently diverge.
 * @module dsh-terminal/src/dsh-adapter/contract
 */

/** The harness package version line all @deepseek-ai/dsh-* dependencies pin to. */
export const DSH_VERSION_LINE = '0.1.2-rc.1'

/** One blessed upstream package and its pinned version. */
export interface BlessedPackage {
  /** The npm package name. */
  readonly name: string
  /** The exact version the contract requires. */
  readonly version: string
}

/**
 * The blessed upstream packages. Harness packages are pinned to the version
 * line; the framework layer (cordis, loader, schemastery) is pinned to the
 * published versions closest to the vendored snapshot the harness line was
 * built against.
 */
export const BLESSED_PACKAGES: readonly BlessedPackage[] = [
  { name: '@deepseek-ai/cordis', version: '4.0.2' },
  { name: '@deepseek-ai/cordis-plugin-loader', version: '1.0.3' },
  { name: '@deepseek-ai/schemastery', version: '3.18.2' },
  { name: '@deepseek-ai/dsh-agent', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-agent-default-model', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-cmdline', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-commands', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-invariants', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-llm', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-session', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-session-projection', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-subagent', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-tool-todo', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-tools', version: DSH_VERSION_LINE },
  { name: '@deepseek-ai/dsh-user-approval', version: DSH_VERSION_LINE },
]

/**
 * Compare the installed upstream versions against the contract.
 * @param installed - the installed version per package name, read from the dependency tree.
 * @returns one human-readable drift line per mismatched or missing package; empty when the tree matches the contract.
 */
export function contractDrift(installed: ReadonlyMap<string, string>): readonly string[] {
  return BLESSED_PACKAGES.flatMap((blessed) => {
    const version = installed.get(blessed.name)
    if (version === undefined) return [`${blessed.name}: required by the contract but not installed`]
    return version === blessed.version ? [] : [`${blessed.name}: contract ${blessed.version}, installed ${version}`]
  })
}
