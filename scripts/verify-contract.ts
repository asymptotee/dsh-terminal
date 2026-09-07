/**
 * Contract gate: read the installed version of every blessed package from the
 * resolved dependency tree and compare against src/dsh-adapter/contract.ts.
 * Runs in CI; startup callers use contractDrift for a warning-level check.
 */
import { createRequire } from 'node:module'
import { contractDrift } from '../src/dsh-adapter/contract.ts'
import { BLESSED_PACKAGES } from '../src/dsh-adapter/contract.ts'

const require = createRequire(import.meta.url)
const installed = new Map<string, string>()
for (const { name } of BLESSED_PACKAGES) {
  try {
    const manifest = require(`${name}/package.json`) as { version: string }
    installed.set(name, manifest.version)
  } catch {
    // Missing packages are reported by contractDrift as contract violations.
  }
}

const drift = contractDrift(installed)
if (drift.length > 0) {
  console.error('verify-contract: upstream drift detected:')
  for (const line of drift) console.error(`  ${line}`)
  process.exit(1)
}
console.log(`verify-contract: all ${BLESSED_PACKAGES.length} blessed packages match the pinned line`)
