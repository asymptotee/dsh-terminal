/**
 * The interactive app's command-line provider: it parses `--resume`, `--cwd`,
 * and `--help`, then publishes {@link TUI_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module dsh-terminal/startup
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from './dsh-adapter/types.ts'
import { parseCmdline } from './dsh-adapter/services.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the startup values can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Persisted session id to resume; undefined starts a fresh session. */
  resume: string | undefined
  /** Resume this working directory's most recent session (`-c`/`--continue`). */
  continueLatest: boolean
  /** Resolved absolute working directory from `--cwd`; undefined keeps the
   *  launch directory. The runner records it as the new session's project
   *  (the rc.3 working-directory service owns it from there on) — the
   *  process directory itself is never changed. */
  cwd: string | undefined
}

/**
 * This app's command: the resume/working-directory options and help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh-terminal')
    .description('Interactive terminal UI: chat with a coding agent in your terminal.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <id>', 'resume the persisted session with this id')
    .option('-c, --continue', "resume this working directory's most recent session")
    .option('--cwd <dir>', 'work in this directory instead of the launch directory')
    .addHelpText('after', `
Examples:
  dsh-terminal                  start a new session
  dsh-terminal --resume <id>    resume the session with the given id
  dsh-terminal -c               resume this directory's most recent session
  dsh-terminal --cwd <dir>      start a new session working in <dir>
  dsh-terminal --cwd <dir> -c   resume <dir>'s most recent session
`)
}

/**
 * Parse the invocation and publish the startup values as an ordinary Cordis
 * service; `--help` and usage errors publish nothing. A bad `--cwd` fails the
 * same way: the runner must never start a session in the wrong place because
 * the requested directory does not exist.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const opts = program.opts<{ resume?: string; continue?: boolean; cwd?: string }>()
    let cwd: string | undefined
    if (opts.cwd !== undefined) {
      // The shell expands an unquoted `--cwd ~/x` itself, but a quoted value
      // (`--cwd '~/x'`) reaches us literally — expand the leading `~` the
      // same way, so both spellings work.
      const expanded = opts.cwd === '~'
        ? homedir()
        : opts.cwd.startsWith('~/')
          ? join(homedir(), opts.cwd.slice(2))
          : opts.cwd
      const target = resolve(expanded)
      let isDirectory = false
      try {
        isDirectory = statSync(target).isDirectory()
      } catch {
        program.error(`--cwd: no such directory: ${target}`)
      }
      if (!isDirectory) program.error(`--cwd: not a directory: ${target}`)
      cwd = target
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      resume: opts.resume,
      continueLatest: opts.continue === true,
      cwd,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
