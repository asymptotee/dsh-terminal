/**
 * The interactive app's ordinary command-line provider over a real Loader
 * tree: the resume option becomes injected runner config, while help and
 * usage errors leave the consumer pending.
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(args: string[]): Promise<{ startup: TuiStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-terminal-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__tuiStartupObserved.runnerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-runner',
    `  name: ${rowUrl}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    resume: !!js ctx.tuiStartup.resume',
    '    continueLatest: !!js ctx.tuiStartup.continueLatest === true',
    '- id: tui-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __tuiStartupApply: typeof apply
    __tuiStartupObserved: Observed
  }
  globals.__tuiStartupApply = apply
  globals.__tuiStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    startup: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('tui command-line provider', () => {
  it('passes the resume option into the runner config', async () => {
    const { startup, observed } = await bootStartup(['--resume', 'abc'])
    expect(startup).toEqual({ resume: 'abc', continueLatest: false })
    expect(observed.runnerConfig).toEqual({ resume: 'abc', continueLatest: false })
    expect(observed.exits).toEqual([])
  })

  it('provides an undefined resume when no option is given', async () => {
    const { startup, observed } = await bootStartup([])
    expect(startup).toEqual({ resume: undefined, continueLatest: false })
    expect(observed.runnerConfig).toEqual({ resume: undefined, continueLatest: false })
    expect(observed.exits).toEqual([])
  })

  it('passes -c and --continue into the runner config as continueLatest', async () => {
    for (const flag of ['-c', '--continue']) {
      const { startup, observed } = await bootStartup([flag])
      expect(startup).toEqual({ resume: undefined, continueLatest: true })
      expect(observed.runnerConfig).toEqual({ resume: undefined, continueLatest: true })
      expect(observed.exits).toEqual([])
    }
  })

  it('publishes both resume and continueLatest when given together', async () => {
    // The driver prefers the explicit id; startup only reports the flags.
    const { startup } = await bootStartup(['--resume', 'abc', '-c'])
    expect(startup).toEqual({ resume: 'abc', continueLatest: true })
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { startup, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh-terminal')
    expect(startup).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects an unknown option and leaves the runner pending', async () => {
    const { startup, observed } = await bootStartup(['--bogus'])
    expect(observed.out).toContain('unknown option')
    expect(startup).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('publishes an absolute --cwd without changing the process directory', async () => {
    // The rc.3-native seam: the value rides into the session header and the
    // working-directory service takes it over from there — the launch process
    // directory itself must stay untouched.
    const target = mkdtempSync(join(tmpdir(), 'dsh-terminal-cwd-'))
    const before = process.cwd()
    const { startup, observed } = await bootStartup(['--cwd', target])
    expect(startup).toEqual({ resume: undefined, continueLatest: false, cwd: realpathSync(target) })
    expect(observed.exits).toEqual([])
    expect(process.cwd()).toBe(before)
  })

  it('resolves a relative --cwd against the launch directory', async () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-terminal-cwd-'))
    const rel = relative(process.cwd(), target)
    const { startup, observed } = await bootStartup(['--cwd', rel, '-c'])
    expect(startup).toEqual({ resume: undefined, continueLatest: true, cwd: realpathSync(target) })
    expect(observed.exits).toEqual([])
  })

  it('rejects a missing --cwd directory and leaves the runner pending', async () => {
    const { startup, observed } = await bootStartup(['--cwd', join(tmpdir(), 'dsh-terminal-no-such-dir')])
    expect(observed.out).toContain('no such directory')
    expect(startup).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('expands a leading ~ in --cwd like the shell would', async () => {
    // A quoted '~/x' reaches the parser literally; the error must name the
    // home-expanded path, proving the expansion ran (no home-dir fixture
    // needed — the miss happens after expansion).
    const { observed } = await bootStartup(['--cwd', '~/dsh-terminal-no-such-dir'])
    expect(observed.out).toContain(join(homedir(), 'dsh-terminal-no-such-dir'))
    expect(observed.exits).toEqual([1])
  })

  it('rejects a --cwd that names a file and leaves the runner pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-terminal-cwd-'))
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, '')
    const { startup, observed } = await bootStartup(['--cwd', file])
    expect(observed.out).toContain('not a directory')
    expect(startup).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
