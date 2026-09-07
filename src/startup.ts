/**
 * The interactive app's command-line provider: it parses `--resume` and
 * `--help`, then publishes {@link TUI_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module dsh-terminal/startup
 */

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
}

/**
 * This app's command: the resume option and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh-terminal')
    .description('Interactive terminal UI: chat with a coding agent in your terminal.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <id>', 'resume the persisted session with this id')
    .addHelpText('after', `
Examples:
  dsh-terminal                  start a new session
  dsh-terminal --resume <id>    resume the session with the given id
`)
}

/**
 * Parse the invocation and publish the startup values as an ordinary Cordis
 * service; `--help` and usage errors publish nothing.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const opts = program.opts<{ resume?: string }>()
    ctx.provide(TUI_STARTUP_SERVICE, { resume: opts.resume } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
