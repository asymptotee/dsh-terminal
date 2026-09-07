#!/usr/bin/env node
/**
 * dsh-terminal — one-shot launcher for the dsh-terminal profile.
 *
 *   1. Verify the official dsh CLI is installed.
 *   2. Verify pnpm is available (dsh plugin delegates profile installs to it).
 *   3. If the profile is not initialized, bootstrap it with
 *      `dsh plugin --profile dsh-terminal add dsh-terminal@<own version>`;
 *      when the package is not published yet, the bootstrap fails and the
 *      message points at the local-path/tarball add command instead.
 *   4. Hand through all arguments and start `dsh --profile dsh-terminal`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-terminal'
const PROFILE = 'dsh-terminal'
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const ownVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (spawnSync('dsh', ['--version'], { stdio: 'ignore' }).status !== 0) {
  fail(`[dsh-terminal] dsh CLI not found. Install the official client first:\n  npm install -g @deepseek-ai/dsh`)
}
if (spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status !== 0) {
  fail(`[dsh-terminal] First-time setup needs pnpm (dsh plugin delegates installs to it):\n  npm install -g pnpm   (or via corepack: corepack enable pnpm)`)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)
if (!existsSync(profileDir)) {
  console.log(`[dsh-terminal] First run — initializing the ${PROFILE} profile (${PACKAGE}@${ownVersion})…`)
  const bootstrap = spawnSync(
    'dsh',
    ['plugin', '--profile', PROFILE, 'add', `${PACKAGE}@${ownVersion}`],
    { stdio: 'inherit' },
  )
  if (bootstrap.status !== 0) {
    fail(
      `[dsh-terminal] Profile bootstrap failed (the package may not be published yet).\n`
      + `Add it manually from a local path or tarball, then re-run:\n`
      + `  dsh plugin --profile ${PROFILE} add file:<path-to-${PACKAGE}>\n`
      + `  dsh plugin --profile ${PROFILE} add ./${PACKAGE}-${ownVersion}.tgz`,
    )
  }
}

const child = spawn('dsh', ['--profile', PROFILE, ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 130 : (code ?? 0))
})
