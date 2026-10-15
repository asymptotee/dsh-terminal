/**
 * The transcript's frame views: one component per frame kind (user echo,
 * assistant prose with markdown tables, notice, tool call/result cards,
 * slash-command row, interruption, error) plus the shared leaf renderers
 * (the reasoning window, the blinking in-flight dot, the `⎿` output block).
 * Pure presentation over a folded Frame.
 * @module dsh-terminal/src/transcript
 */

// The source-launch tsx hook compiles with classic JSX, so the React namespace
// must be imported even though the tsc build uses react-jsx; React.useEffect
// and React.JSX.Element below keep the import used.
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import type { Frame } from '../fold/frames.ts'
import { contentToText, stripOuterCodeFence } from '../fold/render.ts'
import { foldInvocationLine, inlineDiffLines, padToWidth, toolLabel, trimNewline, truncateToWidth } from './text-helpers.ts'
import { useTerminalWidth } from './use-terminal.ts'

/** Fraction of the terminal width a tool call line may occupy before its
 *  invocation is truncated with an ellipsis (ctrl+o reveals the full text). */
const CALL_WIDTH_RATIO = 0.6

/** How many output lines render before truncation with an expand hint. */
const TRUNCATED_OUTPUT_LINES = 6

/** How many reasoning lines the fixed thought window shows (the latest ones). */
const THOUGHT_WINDOW_LINES = 5

/** The in-flight dot's blink period: it toggles on/off every half second. */
const BLINK_DOT_INTERVAL_MS = 500

/** The React key of one frame: its identity across re-renders. */
export function frameKey(frame: Frame): string {
  switch (frame.kind) {
    case 'user':
    case 'assistant':
    case 'notice':
    case 'interrupted':
    case 'error':
      return `${frame.kind}:${frame.seq}`
    case 'tool':
      return `${frame.kind}:${frame.callId}`
    case 'command':
      return `${frame.kind}:${frame.commandId}`
  }
}

/** One transcript frame, dispatched to its kind's view. */
export function FrameRow({ frame, expandedOutput, approvalCallId }: { frame: Frame; expandedOutput: boolean; approvalCallId: string | undefined }): React.JSX.Element {
  // The user echo pads each line to the full terminal width so its background
  // spans the row; every other frame renders its natural width.
  const width = useTerminalWidth()
  switch (frame.kind) {
    case 'user': {
      // Echo the submitted message with the same prompt style as the input bar:
      // the marker leads the first line, later lines indent two columns so a
      // multi-line submission stays aligned. A dark-gray background spans the
      // full row (each line is space-padded to the terminal width, measured by
      // display columns so CJK and emoji pad correctly) so the user's own input
      // reads as a distinct block. This styles only the scroll-region echo; the
      // live InputBar is untouched.
      const echoLines = frame.text.split('\n')
      return (
        <Box flexDirection="column">
          {echoLines.map((line, index) => (
            <Text key={index} backgroundColor="#3a3a3a">
              {padToWidth((index === 0 ? '❯ ' : '  ') + line, width)}
            </Text>
          ))}
        </Box>
      )
    }
    case 'notice':
      return (
        <Box flexDirection="column">
          <Text><Text color="#51cf66">●</Text> {frame.summary}</Text>
          {frame.body === undefined ? null : <IndentedBlock text={trimNewline(frame.body)} expanded={expandedOutput} />}
          {frame.error === undefined ? null : (
            <Text>
              <Text dimColor>  ⎿  </Text>
              <Text color="red">Error: {frame.error.message}</Text>
              <Text dimColor> (code: {frame.error.code})</Text>
            </Text>
          )}
        </Box>
      )
    case 'assistant': {
      const lines = frame.text.split('\n')
      // The marker sits on the first non-empty line; leading empty lines
      // (models often open a stream with a newline) render nothing at all.
      const first = lines.findIndex(line => line !== '')
      // Trailing empties collapse the same way — models often close a stream
      // with newlines before a tool call, and rendering them stacks blank
      // lines on top of the frame wrapper's own one-line margin. Paragraph
      // breaks inside the message are untouched.
      let last = lines.length - 1
      while (last >= 0 && lines[last] === '') last--
      const hasText = first !== -1
      return (
        <Box flexDirection="column">
          {/* The reasoning is live while the frame still streams and no visible
              text has arrived — the first text delta ends the thinking span. */}
          {frame.thinking !== undefined
            ? <ThinkingBlock thinking={frame.thinking} live={frame.streaming && frame.text === ''} />
            : null}
          {/* The breathing row belongs to the box-text pair: with no text in
              the frame the box ends it, and the frame wrapper's own margin is
              the single blank line to the next frame. */}
          {frame.thinking !== undefined && hasText ? <Text> </Text> : null}
          {hasText ? assistantContent(lines.slice(first, last + 1)) : null}
        </Box>
      )
    }
    case 'tool':
      return <ToolRow frame={frame} expandedOutput={expandedOutput} awaitingApproval={frame.callId === approvalCallId} />
    case 'command':
      return <CommandRow frame={frame} />
    case 'interrupted':
      return <Text color="#ffd43b">● Interrupted · What should dsh do instead?</Text>
    case 'error':
      return (
        <Text>
          <Text color="red">● Error: {frame.message}</Text> <Text dimColor>(code: {frame.code})</Text>
        </Text>
      )
  }
}

/** Wrap a line into physical rows of at most `width` columns; short lines pass through. */
function wrapLine(line: string, width: number): readonly string[] {
  if (line.length <= width) return [line]
  const rows: string[] = []
  for (let offset = 0; offset < line.length; offset += width) {
    rows.push(line.slice(offset, offset + width))
  }
  return rows
}

/** The fixed reasoning window: `● Thought for Ns` — the dot blinks dim while
 *  the reasoning is still live — then a bordered box with the latest rows,
 *  kept after thinking ends. */
function ThinkingBlock({
  thinking,
  live,
}: {
  thinking: Extract<Frame, { kind: 'assistant' }>['thinking'] & object
  /** The reasoning stream is still open: the header dot blinks until it ends. */
  live: boolean
}): React.JSX.Element {
  // Reasoning lines are long prose; each wraps into full-width physical rows
  // (never clipped), and the window scrolls over those rows so the border
  // height stays at the cap instead of growing with the reasoning.
  // The row budget: left margin (2) plus border (2) plus inner padding (2).
  const contentWidth = Math.max(1, useTerminalWidth() - 6)
  const physical = thinking.text.split('\n').flatMap(line => wrapLine(line, contentWidth))
  const windowed = physical.slice(-THOUGHT_WINDOW_LINES)
  return (
    <Box flexDirection="column">
      <Text>{live ? <BlinkingDot /> : '●'} Thought for {thinking.seconds}s</Text>
      <Box flexDirection="column" marginLeft={2} borderStyle="round" borderColor="gray" paddingX={1}>
        {windowed.map((line, index) => <Text key={index} dimColor>{line === '' ? ' ' : line}</Text>)}
      </Box>
    </Box>
  )
}

/** One slash-command invocation: the line, then the settled outcome. */
function CommandRow({ frame }: { frame: Extract<Frame, { kind: 'command' }> }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text><Text color="magenta">/</Text>{frame.name}{frame.args ?? ''}</Text>
      {frame.done !== undefined
        ? <Text color={frame.done.kind === 'error' ? 'red' : 'dim'}>
          {frame.done.text ?? (frame.done.kind === 'error' ? 'command failed' : '')}
        </Text>
        : null}
    </Box>
  )
}

/** One tool call card: the pending call view, then the completed result view. */
function ToolRow({ frame, expandedOutput, awaitingApproval }: { frame: Extract<Frame, { kind: 'tool' }>; expandedOutput: boolean; awaitingApproval: boolean }): React.JSX.Element {
  const completed = frame.result !== undefined || frame.resultContent !== undefined
  return (
    <Box flexDirection="column">
      <ToolCallView frame={frame} expandedOutput={expandedOutput} awaitingApproval={awaitingApproval} />
      {completed ? <ToolResultView frame={frame} expandedOutput={expandedOutput} /> : null}
    </Box>
  )
}

/** A dim ● that blinks twice per second, marking in-flight work — live
 *  reasoning, a bash run, or a wait_agent block on the team. The blank frame
 *  keeps the dot's one-cell width so the row never shifts while it pulses. */
function BlinkingDot(): React.JSX.Element {
  const [on, setOn] = useState(true)
  React.useEffect(() => {
    const timer = setInterval(() => setOn(current => !current), BLINK_DOT_INTERVAL_MS)
    timer.unref()
    return () => { clearInterval(timer) }
  }, [])
  return on ? <Text dimColor>●</Text> : <Text> </Text>
}

/** The Claude Code-style call line: a green dot (static dim while the call
 *  waits on an approval decision, blinking dim while a long-running bash or
 *  wait_agent call is still open), then the tool name in the default
 *  foreground. */
function ToolCallView({ frame, expandedOutput, awaitingApproval }: { frame: Extract<Frame, { kind: 'tool' }>; expandedOutput: boolean; awaitingApproval: boolean }): React.JSX.Element {
  const call = frame.call
  const label = toolLabel(frame.name)
  const full = call.card === 'diff'
    ? call.diffs.map(diff => `${diff.path}${diff.oldText === null ? ' (new)' : ''}`).join(', ')
    // Generic titles often start with the tool name (`Read /tmp/test.txt`);
    // strip it so the label on the left is not repeated.
    : call.title.startsWith(`${label} `) ? call.title.slice(label.length + 1) : call.title
  // Every invocation is one logical line: a multiline script (handed to bash)
  // folds its newlines into `; ` first — shell one-liner reading, the same
  // fold the panel activity uses — then the width clamp applies uniformly.
  const folded = foldInvocationLine(full)
  // The long-running calls — a bash execution, or a wait_agent block on the
  // team — blink their dot dim while still open, distinct from a settled
  // call's green dot and an approval wait's static dim dot.
  const waiting = frame.result === undefined && frame.resultContent === undefined
    && (frame.name === 'wait_agent' || frame.name === 'bash')
  const dot = awaitingApproval
    ? <Text dimColor>●</Text>
    : waiting
      ? <BlinkingDot />
      : <Text color="#51cf66">●</Text>
  // Keep the call line on one row: clamp the invocation to CALL_WIDTH_RATIO
  // of the terminal width, minus the `● Label(…)` overhead. ctrl+o
  // (expandedOutput) reveals the full folded invocation, which then wraps
  // normally.
  const budget = Math.floor(useTerminalWidth() * CALL_WIDTH_RATIO) - (stringWidth(label) + 4)
  const invocation = expandedOutput ? folded : truncateToWidth(folded, budget)
  return <Text>{dot} {label}({invocation})</Text>
}

/** The tool result card: a terminal/diff/read/generic/search/web view, or the
 *  raw result content when the card carries no text payload. */
function ToolResultView({
  frame,
  expandedOutput,
}: {
  frame: Extract<Frame, { kind: 'tool' }>
  expandedOutput: boolean
}): React.JSX.Element {
  const result = frame.result
  if (result === undefined) {
    const text = stripOuterCodeFence(contentToText(frame.resultContent ?? []))
    return text === '' ? <></> : <IndentedBlock text={trimNewline(text)} expanded={expandedOutput} {...(frame.isError ? { error: true } : {})} />
  }
  switch (result.card) {
    case 'terminal':
      return result.output !== undefined && result.output !== ''
        ? <IndentedBlock text={trimNewline(result.output)} expanded={expandedOutput} {...(frame.isError ? { error: true } : {})} />
        : <></>
    case 'diff': {
      // Flatten the diffs into one row list (path lines and +/- lines) so the
      // card folds like a terminal output.
      const rows: { key: string; sign: '+' | '-' | undefined; text: string }[] = []
      for (const diff of result.diffs) {
        rows.push({ key: `path:${diff.path}`, sign: undefined, text: diff.path + (diff.oldText === null ? ' (new)' : '') })
        for (const line of inlineDiffLines(diff.oldText ?? '', diff.newText)) {
          rows.push({ key: `line:${rows.length}`, sign: line.sign, text: line.text })
        }
      }
      const hidden = rows.length - TRUNCATED_OUTPUT_LINES
      const visible = expandedOutput || hidden <= 0 ? rows : rows.slice(0, TRUNCATED_OUTPUT_LINES)
      return (
        <Box flexDirection="column">
          {visible.map((row, index) => {
            const prefix = index === 0 ? '  ⎿  ' : '     '
            return row.sign === undefined
              ? <Text key={row.key} dimColor>{prefix}{row.text}</Text>
              : (
                <Text key={row.key}>
                  <Text dimColor>{prefix}</Text>
                  <Text color={row.sign === '+' ? 'green' : 'red'}>{row.sign} {row.text}</Text>
                </Text>
              )
          })}
          {!expandedOutput && hidden > 0 ? <Text dimColor>     … {hidden} more lines (ctrl+o to expand)</Text> : null}
        </Box>
      )
    }
    case 'generic': {
      const text = stripOuterCodeFence(contentToText(result.content ?? frame.resultContent ?? []))
      return text === '' ? <></> : <IndentedBlock text={trimNewline(text)} expanded={expandedOutput} {...(frame.isError ? { error: true } : {})} />
    }
    case 'read': {
      const hidden = result.lines.length - TRUNCATED_OUTPUT_LINES
      const visible = expandedOutput || hidden <= 0 ? result.lines : result.lines.slice(0, TRUNCATED_OUTPUT_LINES)
      return (
        <Box flexDirection="column">
          {visible.map((line, index) => (
            <Text key={line.number} dimColor>{index === 0 ? '  ⎿  ' : '     '}{line.number}: {line.text}</Text>
          ))}
          {!expandedOutput && hidden > 0 ? <Text dimColor>     … {hidden} more lines (ctrl+o to expand)</Text> : null}
        </Box>
      )
    }
    // search/web views carry no text payload; fall back to the raw result content.
    case 'search':
    case 'web': {
      const text = stripOuterCodeFence(contentToText(frame.resultContent ?? []))
      return text === '' ? <></> : <IndentedBlock text={trimNewline(text)} expanded={expandedOutput} {...(frame.isError ? { error: true } : {})} />
    }
  }
}

/** The Claude Code-style output block: one `⎿` connector, then aligned lines, truncated with an expand hint; a failed result renders red instead of dim. */
function IndentedBlock({ text, expanded, error }: { text: string; expanded: boolean; error?: boolean }): React.JSX.Element {
  const lines = text.split('\n')
  const hidden = lines.length - TRUNCATED_OUTPUT_LINES
  // The `⎿` connector is always dim across the whole project, whether or not
  // the result is an error; only the content text takes the error color.
  const row = (line: string, index: number): React.JSX.Element => (
    <Text key={index}>
      <Text dimColor>{index === 0 ? '  ⎿  ' : '     '}</Text>
      {error ? <Text color="red">{line}</Text> : <Text dimColor>{line}</Text>}
    </Text>
  )
  if (!expanded && hidden > 0) {
    const visible = lines.slice(0, TRUNCATED_OUTPUT_LINES)
    return (
      <Box flexDirection="column">
        {visible.map(row)}
        <Text dimColor>     … {hidden} more lines (ctrl+o to expand)</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {lines.map(row)}
    </Box>
  )
}

/** Split a line into styled runs: bold `**` spans and pale-blue `` `code` `` spans, Claude Code-style. */
function inlineSegments(line: string): readonly { bold: boolean; code: boolean; text: string }[] {
  const segments: { bold: boolean; code: boolean; text: string }[] = []
  let bold = false
  let code = false
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') segments.push({ bold, code, text: buffer })
    buffer = ''
  }
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i)
    if (!code && char === '*' && line.charAt(i + 1) === '*') {
      flush()
      bold = !bold
      i++
    } else if (!bold && char === '`') {
      flush()
      code = !code
    } else {
      buffer += char
    }
  }
  flush()
  return segments
}

/** Strip a leading `# ` heading prefix; undefined when the line is not a heading. */
function headingText(line: string): string | undefined {
  const match = /^#{1,6} /.exec(line)
  return match === null ? undefined : line.slice(match[0].length)
}

/** Whether a line is a markdown table separator row such as `| --- | :---: |`. */
function isTableSeparator(line: string): boolean {
  const t = line.trim()
  return /^[\s|:-]+$/.test(t) && t.includes('-') && t.includes('|')
}

/** Whether the line at `index` opens a markdown table: a `|`-led row followed by a separator row. */
function isTableStart(lines: readonly string[], index: number): boolean {
  const line = lines[index]
  if (line === undefined || !line.trim().startsWith('|')) return false
  return isTableSeparator(lines[index + 1] ?? '')
}

/** Split one `|`-delimited table row into trimmed cell strings. */
function tableCells(row: string): string[] {
  let t = row.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map(cell => cell.trim())
}

/**
 * Render one markdown table block (header row, separator, body rows) as
 * box-bordered lines. Columns are padded to their widest cell measured by
 * display width, so CJK and emoji align correctly.
 */
function renderTable(tableLines: readonly string[]): string[] {
  const header = tableCells(tableLines[0])
  const body = tableLines.slice(2).map(tableCells)
  const columnCount = Math.max(header.length, ...body.map(row => row.length))
  const widths: number[] = []
  for (let col = 0; col < columnCount; col++) {
    let max = 0
    for (const cell of [header[col], ...body.map(row => row[col])]) {
      if (cell !== undefined) max = Math.max(max, stringWidth(cell))
    }
    widths.push(max)
  }
  const pad = (cell: string | undefined, width: number): string => {
    const text = cell ?? ''
    return text + ' '.repeat(Math.max(0, width - stringWidth(text)))
  }
  const rule = (left: string, joint: string, right: string): string =>
    left + widths.map(w => '─'.repeat(w + 2)).join(joint) + right
  const rowLine = (cells: readonly string[]): string =>
    '│' + widths.map((w, col) => ` ${pad(cells[col], w)} `).join('│') + '│'
  return [
    rule('┌', '┬', '┐'),
    rowLine(header),
    rule('├', '┼', '┤'),
    // A rule between every body row keeps adjacent rows visually separated.
    ...body.flatMap((row, idx) =>
      idx < body.length - 1 ? [rowLine(row), rule('├', '┼', '┤')] : [rowLine(row)],
    ),
    rule('└', '┴', '┘'),
  ]
}

/**
 * Render the visible lines of an assistant message. Consecutive `|`-led lines
 * that form a markdown table are grouped and drawn as one bordered block; every
 * other line renders as before. The first visible line carries the `●` marker.
 */
function assistantContent(lines: readonly string[]): React.JSX.Element[] {
  const elements: React.JSX.Element[] = []
  let markedFirst = false
  let i = 0
  while (i < lines.length) {
    if (isTableStart(lines, i)) {
      let end = i
      while (end < lines.length && lines[end].trim().startsWith('|')) end++
      const tableRows = renderTable(lines.slice(i, end))
      tableRows.forEach((row, r) => {
        const isFirst = !markedFirst && r === 0
        elements.push(<Text key={`table-${i}-${r}`}>{isFirst ? '● ' : '  '}{row}</Text>)
      })
      markedFirst = true
      i = end
      continue
    }
    const line = lines[i]
    const heading = headingText(line)
    const content = heading ?? line
    elements.push(
      <Text key={`line-${i}`}>
        {markedFirst ? '  ' : '● '}
        {heading !== undefined
          ? <Text bold>{content}</Text>
          : inlineSegments(content).map((segment, s) => segment.bold
            ? <Text key={s} bold>{segment.text}</Text>
            : segment.code
              ? <Text key={s} color="#a5d8ff">{segment.text}</Text>
              : segment.text)}
      </Text>,
    )
    markedFirst = true
    i++
  }
  return elements
}
