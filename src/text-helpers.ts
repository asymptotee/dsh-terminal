/**
 * Pure string-formatting helpers shared by the view modules: display-width
 * padding/truncation/wrapping (CJK- and emoji-aware via string-width), the
 * elapsed-time and token-count formats, and small content transforms. No
 * React or ink here — these are plain functions of their inputs.
 * @module dsh-terminal/src/text-helpers
 */

import os from 'node:os'
import stringWidth from 'string-width'

/**
 * Pad content with spaces to exactly `width` display columns, so a background
 * color spans the whole row. Width is measured with string-width, so CJK and
 * emoji (double-width) pad to the true terminal column count; content already
 * at or past `width` is returned unchanged (never negative padding).
 * @param content - the text to pad.
 * @param width - the target display width in terminal columns.
 * @returns the content padded to `width` columns.
 */
export function padToWidth(content: string, width: number): string {
  return content + ' '.repeat(Math.max(0, width - stringWidth(content)))
}

/**
 * Truncate text to fit `maxWidth` display columns, appending `…` when cut.
 * Width is measured with string-width so CJK and emoji count correctly; text
 * already within budget is returned unchanged.
 * @param text - the text to truncate.
 * @param maxWidth - the maximum display width, including the ellipsis.
 * @returns the text, truncated to `maxWidth` columns with a trailing `…` if cut.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  let width = 0
  let out = ''
  for (const char of text) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 1) break
    out += char
    width += charWidth
  }
  return out + '…'
}

/**
 * Wrap text into lines of at most `maxWidth` display columns, measured with
 * string-width so CJK and emoji wrap at their true width. Existing newlines
 * are honored; words are never hyphenated — a chunk longer than the budget
 * breaks at the budget like truncateToWidth's ellipsis point.
 * @param text - the text to wrap.
 * @param maxWidth - the column budget per line.
 * @returns the wrapped lines (at least one).
 */
export function wrapToWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text]
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    let width = 0
    for (const char of paragraph) {
      const charWidth = stringWidth(char)
      if (width + charWidth > maxWidth && line !== '') {
        out.push(line)
        line = ''
        width = 0
      }
      line += char
      width += charWidth
    }
    out.push(line)
  }
  return out
}

/**
 * Fold a possibly multiline invocation title into one physical line:
 * newlines become `; ` (shell one-liner reading), blank lines drop, ends
 * trim. Shared by the call line, the approval panel's detail row, and the
 * panel activity — raw newlines are zero-width to stringWidth and would
 * survive every width clamp, splitting one-row layouts.
 * @param title - the invocation title, possibly multiline.
 * @returns the one-line fold (possibly empty).
 */
export function foldInvocationLine(title: string): string {
  return title
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .join('; ')
}

/** Split newline-terminated content without a phantom trailing empty line. */
export function splitLines(text: string): readonly string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Strip a single trailing newline; other newlines are untouched. */
export function trimNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/** Minimal old/new line listing; real diff rendering stays a later milestone. */
export function inlineDiffLines(oldText: string, newText: string): readonly { sign: '+' | '-'; text: string }[] {
  return [
    ...splitLines(oldText).map(line => ({ sign: '-' as const, text: line })),
    ...splitLines(newText).map(line => ({ sign: '+' as const, text: line })),
  ]
}

/** Shorten a home-directory path to `~`: `/home/x/repo` -> `~/repo`. */
export function shortenCwd(cwd: string): string {
  const home = os.homedir()
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

/** Compact token count: 63_000 -> `63k`, 786_400 -> `786.4k`. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${parseFloat((n / 1000).toFixed(1))}k`
}

/** `63k/786.4k (8%)` — used over the model window, with the fraction. */
export function formatContext(context: { used: number; window: number }): string {
  const percent = Math.round((context.used / context.window) * 100)
  return `${compactTokens(context.used)}/${compactTokens(context.window)} (${percent}%)`
}

/** A wall-clock duration as `45s`, `1m 26s`, or `2h 5m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A token count as `812` or `11.1k`. */
export function formatTokenCount(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

/** The tool's display label, capitalized like Claude Code's tool names. */
export function toolLabel(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}
