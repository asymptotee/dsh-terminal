/**
 * The adapter boundary gate: official @deepseek-ai packages may only be
 * imported inside src/dsh-adapter/. Any other src file importing upstream
 * directly fails the gate. Tests are exempt — they exercise the published
 * packages on purpose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const srcDir = path.join(root, 'src')
const adapterDir = path.join(srcDir, 'dsh-adapter')
const upstreamPattern = /(?:from\s+|import\s+)['"]@deepseek-ai\//

function collectFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (path.resolve(full) !== adapterDir) out.push(...collectFiles(full))
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

const violations = []
for (const file of collectFiles(srcDir)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (upstreamPattern.test(line)) {
      violations.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`)
    }
  })
}

if (violations.length > 0) {
  console.error('verify-boundary: upstream imports outside src/dsh-adapter/:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('verify-boundary: adapter boundary intact')
