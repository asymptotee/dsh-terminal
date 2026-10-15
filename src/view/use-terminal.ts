/**
 * Terminal-size hooks shared by the view modules, with sane non-TTY fallbacks
 * so tests (ink-testing-library exposes `columns` but not `rows`) and piped
 * output degrade the same way ink's own viewport logic does.
 * @module dsh-terminal/src/use-terminal
 */

import { useStdout } from 'ink'

/** The terminal columns, with a sane non-TTY fallback. */
export function useTerminalWidth(fallback = 80): number {
  const { stdout } = useStdout()
  return typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : fallback
}

/**
 * The terminal size with sane non-TTY fallbacks. `rows` sizes the fullscreen
 * root layout; the fallback matches ink's own non-TTY default so tests and
 * piped output degrade the same way ink's viewport logic does.
 */
export function useTerminalSize(fallbackColumns = 80, fallbackRows = 24): { columns: number; rows: number } {
  const { stdout } = useStdout()
  const columns = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : fallbackColumns
  const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : fallbackRows
  return { columns, rows }
}
