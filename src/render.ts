/**
 * M2 plain-text rendering of folded frames: the line view the driver writes
 * before the ink-based renderer replaces it. Every function here is a pure
 * function of its frame or payload — replay reproduces the same lines.
 * @module dsh-terminal/src/render
 */

import type { ContentBlock, TodoItem } from './dsh-adapter/types.ts'
import type { Frame } from './frames.ts'

/**
 * Join the text blocks of a content sequence; non-text blocks are dropped.
 * @param content - the content blocks to extract text from.
 * @param joinWith - the separator between block payloads; empty by default, one newline for notice bodies whose blocks are paragraphs.
 * @returns the concatenated text-block payloads.
 */
export function contentToText(content: readonly ContentBlock[], joinWith = ''): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(joinWith)
}

/**
 * Strip one outer markdown code fence. Tool presentations wrap model-facing
 * output in fences (the bash tool fences error/background output as
 * ```console); a markdown viewer renders the fence, but the terminal card
 * shows the content bare — so the fence pair leaves before display. Text
 * without a matching open/close pair passes through unchanged.
 * @param text - the raw presentation text.
 * @returns the text without its outer fence pair, if it had one.
 */
export function stripOuterCodeFence(text: string): string {
  const lines = text.split('\n')
  if (!/^```/.test(lines[0]?.trim() ?? '')) return text
  let last = lines.length - 1
  while (last > 0 && lines[last]?.trim() === '') last--
  if (last <= 0 || lines[last]?.trim() !== '```') return text
  return lines.slice(1, last).join('\n')
}

/**
 * The submitted user line, echoed with the Claude Code-style prompt marker.
 * @param text - the submitted line text.
 * @returns the echoed line, newline-terminated.
 */
export function renderUserLine(text: string): string {
  return `❯ ${text}\n`
}

/**
 * One pending tool call as terminal lines (the call card).
 * @param frame - the pending tool frame.
 * @returns the newline-terminated lines for the call card.
 */
export function renderToolCallLines(frame: Extract<Frame, { kind: 'tool' }>): readonly string[] {
  const call = frame.call
  switch (call.card) {
    case 'terminal':
      return [`$ ${call.title}\n`]
    case 'diff':
      return [
        `[diff] ${call.title}\n`,
        ...call.diffs.map(diff => `  ${diff.path}${diff.oldText === null ? ' (new)' : ''}\n`),
      ]
    case 'generic':
      return [`[tool] ${call.title}\n`]
  }
}

/** Ensure a text block ends on a newline before the next line renders. */
function terminated(text: string): string {
  return text.endsWith('\n') ? text : text + '\n'
}

/**
 * One completed tool call as terminal lines (the result card).
 * @param frame - the completed tool frame.
 * @returns the newline-terminated lines for the result card.
 */
export function renderToolResultLines(frame: Extract<Frame, { kind: 'tool' }>): readonly string[] {
  const result = frame.result
  if (result === undefined) {
    const text = stripOuterCodeFence(contentToText(frame.resultContent ?? []))
    return text === '' ? [] : [terminated(text)]
  }
  switch (result.card) {
    case 'terminal': {
      const lines: string[] = []
      if (result.output !== undefined && result.output !== '') lines.push(terminated(result.output))
      if (result.exitCode !== undefined) lines.push(`exit ${result.exitCode}\n`)
      if (result.signal !== undefined) lines.push(`killed by ${result.signal}\n`)
      return lines
    }
    case 'diff':
      return result.diffs.flatMap(diff => [
        `  ${diff.path}${diff.oldText === null ? ' (new)' : ''}\n`,
        ...renderInlineDiff(diff.oldText ?? '', diff.newText),
      ])
    case 'generic': {
      const text = stripOuterCodeFence(contentToText(result.content ?? frame.resultContent ?? []))
      return text === '' ? [] : [terminated(text)]
    }
    // search/read/web views carry no text payload; fall back to the raw result content.
    case 'search':
    case 'read':
    case 'web': {
      const text = contentToText(frame.resultContent ?? [])
      return text === '' ? [] : [terminated(text)]
    }
  }
}

/** Split newline-terminated content without a phantom trailing empty line. */
function splitLines(text: string): readonly string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** A minimal old/new line listing; the ink renderer owns real diff rendering. */
function renderInlineDiff(oldText: string, newText: string): readonly string[] {
  return [
    ...splitLines(oldText).map(line => `- ${line}\n`),
    ...splitLines(newText).map(line => `+ ${line}\n`),
  ]
}

/**
 * The user-interruption marker line appended at a user-cancelled turn end.
 * @returns the newline-terminated marker line.
 */
export function renderInterruptedLine(): string {
  return '[interrupted] Interrupted\n'
}

/**
 * The main-agent turn-failure marker as one plain-text line.
 * @param frame - the error frame carrying the readable message and code.
 * @returns the newline-terminated error line.
 */
export function renderErrorLine(frame: Extract<Frame, { kind: 'error' }>): string {
  return `[error] Error: ${frame.message} (code: ${frame.code})\n`
}

/**
 * One slash-command invocation as a terminal line.
 * @param frame - the pending command frame.
 * @returns the newline-terminated command line.
 */
export function renderCommandLine(frame: Extract<Frame, { kind: 'command' }>): string {
  return `/${frame.name}${frame.args === undefined ? '' : frame.args}\n`
}

/**
 * One terminal-visible injection (a settlement notice or an agent report) as
 * terminal lines: the account line, then the indented remainder.
 * @param frame - the notice frame.
 * @returns the newline-terminated notice lines.
 */
export function renderNoticeLines(frame: Extract<Frame, { kind: 'notice' }>): readonly string[] {
  return [
    `[notice] ${frame.summary}\n`,
    ...(frame.body === undefined ? [] : splitLines(frame.body).map(line => `  ${line}\n`)),
    ...(frame.error === undefined ? [] : [`  Error: ${frame.error.message} (code: ${frame.error.code})\n`]),
  ]
}

/**
 * The standing todo plan as a checklist block: a heading line, then the items
 * in an indented block whose first line carries the `⎿` connector.
 * @param todos - the plan items to render.
 * @returns the newline-terminated plan lines.
 */
export function renderPlanLines(todos: readonly TodoItem[]): readonly string[] {
  const lines = ['● todolist进行中...\n']
  todos.forEach((todo, index) => {
    const mark = todo.status === 'completed' ? '✔' : todo.status === 'in_progress' ? '◼' : '◻'
    const prefix = index === 0 ? '  ⎿  ' : '     '
    lines.push(`${prefix}${mark} ${todo.content}\n`)
  })
  return lines
}

