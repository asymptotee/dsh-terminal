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
import { foldInvocationLine, formatClock, formatElapsed, inlineDiffLines, padToWidth, toolLabel, trimNewline, truncateToWidth, wrapToWidth } from './text-helpers.ts'
import { useTerminalWidth } from './use-terminal.ts'

/** Fraction of the terminal width a tool call line may occupy before its
 *  invocation is truncated with an ellipsis (ctrl+o reveals the full text). */
const CALL_WIDTH_RATIO = 0.6

/** How many output lines render before truncation with an expand hint. */
const TRUNCATED_OUTPUT_LINES = 6

/** How many reasoning lines the fixed thought window shows (the latest ones). */
const THOUGHT_WINDOW_LINES = 5

/** The opened episode's band: one shade below the user echo's `#3a3a3a`, so
 *  the model's revealed work never reads as the user's own input. */
const EPISODE_BODY_BACKGROUND = '#303030'

/** The in-flight dot's blink period: it toggles on/off every half second. */
const BLINK_DOT_INTERVAL_MS = 500

/** The React key of one frame: its identity across re-renders. */
export function frameKey(frame: Frame): string {
  switch (frame.kind) {
    case 'user':
    case 'assistant':
    case 'notice':
    case 'interrupted':
    case 'completed':
    case 'error':
      return `${frame.kind}:${frame.seq}`
    case 'tool':
      return `${frame.kind}:${frame.callId}`
    case 'command':
      return `${frame.kind}:${frame.commandId}`
  }
}

/** One transcript frame, dispatched to its kind's view. */
export function FrameRow({ frame, expandedOutput, approvalCallId, thinkingExpanded, thinkingHovered, thinkingRef }: {
  frame: Frame
  expandedOutput: boolean
  approvalCallId: string | undefined
  /** This frame's settled thinking block was clicked back open. */
  thinkingExpanded: boolean
  /** The pointer rests on this frame's settled thinking header. */
  thinkingHovered: boolean
  /** Registers the thinking block's element for the renderer's hit-test
   *  measurements; frames without thinking never call it. */
  thinkingRef?: (el: unknown) => void
}): React.JSX.Element {
  // The user and command echoes pad each line to the full terminal width so
  // their background spans the row; every other frame renders its natural width.
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
          {frame.tone === 'warn'
            ? <Text color="#ffd43b">● {frame.summary}</Text>
            : <Text><Text color="#51cf66">●</Text> {frame.summary}</Text>}
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
            ? <ThinkingBlock thinking={frame.thinking} live={frame.streaming && frame.text === ''} expanded={thinkingExpanded} hovered={thinkingHovered} blockRef={thinkingRef} />
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
      return <CommandRow frame={frame} expandedOutput={expandedOutput} width={width} />
    case 'interrupted':
      return <Text color="#ffd43b">● Interrupted · What should dsh do instead?</Text>
    case 'completed':
      // The Claude Code completion summary: one dim line stating how long the
      // turn worked and when it landed, closing out the turn's frames.
      return <Text dimColor>  Worked for {formatElapsed(frame.durationMs)} · done {formatClock(frame.completedAt)}</Text>
    case 'error':
      return (
        <Text>
          <Text color="red">● Error: {frame.message}</Text> <Text dimColor>(code: {frame.code})</Text>
        </Text>
      )
  }
}

/** The reasoning window. Live, the header dot blinks above a `│` rule —
 *  aligned onto the header's text column — carrying a fixed-height window over
 *  the latest rows, so the streaming surface stays compact however long the
 *  thought runs. Once thinking ends the block collapses to the one dim
 *  `Thought for Ns` row, lifting out of the dim under the pointer's hover; a
 *  click swaps the row for the reasoning in full — the open block is content
 *  alone, no header — and a click on the content collapses it back. Toggle and
 *  hover both hit-test in the renderer. */
function ThinkingBlock({
  thinking,
  live,
  expanded,
  hovered,
  blockRef,
}: {
  thinking: Extract<Frame, { kind: 'assistant' }>['thinking'] & object
  /** The reasoning stream is still open: the header dot blinks until it ends. */
  live: boolean
  /** A settled block the click swapped open: the content replaces the header. */
  expanded: boolean
  /** The pointer rests on the collapsed header row: it drops the dim. */
  hovered: boolean
  /** Registers the whole block's element so the renderer can measure its
   *  height — the click target is the collapsed header or the open content. */
  blockRef?: ((el: unknown) => void) | undefined
}): React.JSX.Element {
  const showBody = live || expanded
  // Reasoning lines are long prose; each wraps into full-width physical rows
  // (never clipped). The live box is a fixed-height window scrolling over the
  // latest rows so the streaming surface stays compact; the settled block the
  // user clicked open shows the reasoning in full — the live window always
  // scrolled past more than it held, and the deliberate expand should not
  // hand back less than the stream showed.
  // The row budget: the body's two-column indent, plus the live rule's own
  // two columns (`│ `) riding inside the same indent. Wrapping is by display
  // width (CJK rows occupy two columns) — a char-count wrap would overflow
  // the budget and ink's own re-wrap would strand the excess on the rule's
  // column, fusing content onto the line.
  const contentWidth = Math.max(1, useTerminalWidth() - (live ? 4 : 2))
  const physical = showBody ? wrapToWidth(thinking.text, contentWidth) : []
  const windowed = live ? physical.slice(-THOUGHT_WINDOW_LINES) : physical
  return (
    <Box flexDirection="column" {...(blockRef === undefined ? {} : { ref: blockRef })}>
      {/* The open block is the reasoning alone: the header only leads the
          collapsed row and the live stream. */}
      {live
        ? <Text><BlinkingDot /> Thinking for {thinking.seconds}s</Text>
        : expanded
          ? null
          : hovered
            ? <Text>  Thought for {thinking.seconds}s</Text>
            : <Text dimColor>  Thought for {thinking.seconds}s</Text>}
      {showBody
        ? (
          /* The body indents two columns onto the header's text column; live,
             a `│ ` rule leads each row there, marking the reasoning as an
             in-flight stream. The settled block the click opens stays plain. */
          <Box flexDirection="column" marginLeft={2}>
            {/* An empty paragraph still occupies its row: a zero-width Text
                collapses to zero height, which would both drop the paragraph
                break and desynchronize the toggle's predicted height delta. */}
            {windowed.map((line, index) => (
              <Text key={index} dimColor>{live ? `│ ${line === '' ? ' ' : line}` : (line === '' ? ' ' : line)}</Text>
            ))}
          </Box>
        )
        : null}
    </Box>
  )
}

/** The shell tools, counted as commands in an episode's sentence. */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'pwsh', 'terminal'])

/** The content search tools, counted as patterns searched. Their result is a
 *  set of matches across files, so "files" would misreport what was done. */
export const SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(['grep', 'glob'])

/** The file readers, counted as files read. */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'read_image'])

/**
 * The tools an episode absorbs. Everything else keeps its own card:
 *
 * - `write`, `edit`, `apply_patch` — the arguments are the interesting part
 *   (which file, which lines); behind a count a reader cannot tell what the
 *   model changed without opening every run.
 * - `exit_plan_mode` — its call carries the plan document the review panel
 *   anchors to, and once approved it becomes the `● User approved DSH's plan`
 *   verdict. Folding it would hide the plan.
 * - `todo_write`, `subagent`, `workflow`, the team tools, `web_*`, `skill`,
 *   `job_*`, `schedule_*`, the terminal-control tools — each is a distinct
 *   act whose own card says more than a count would, and some (a subagent
 *   hand-off, a spawned teammate) are the only visible trace of work running
 *   elsewhere.
 *
 * The five absorbed kinds are the ones a task spends its time in: thinking,
 * running commands, searching, reading files. They repeat, so they are the
 * ones worth counting.
 */
export const FOLDABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SHELL_TOOL_NAMES,
  ...SEARCH_TOOL_NAMES,
  ...READ_TOOL_NAMES,
])

/**
 * Whether one frame is a settled tool call that folds into an episode: one of
 * the five absorbed kinds (commands, searches, reads). An open call keeps its
 * own card (its dot is still blinking — the run is not over), and a failed one
 * does too (its red result is what a reader needs, so folding it behind a
 * count would hide the failure).
 * @param frame - the frame to test.
 * @returns whether the frame belongs in a collapsible run.
 */
export function isFoldableCall(frame: Frame): boolean {
  if (frame.kind !== 'tool') return false
  if (!FOLDABLE_TOOL_NAMES.has(frame.name)) return false
  if (frame.result === undefined && frame.resultContent === undefined) return false
  return frame.isError !== true
}

/** The count groupings a run can report, in the order the sentence lists them:
 *  search first (it is how a task usually starts), then commands, then reads.
 *  Each carries both tenses — a live run reports what it is doing, a settled
 *  one what it did. */
const RUN_GROUPS: readonly {
  readonly noun: string
  readonly past: string
  readonly present: string
  readonly matches: (name: string) => boolean
}[] = [
  { noun: 'pattern', past: 'searched for', present: 'searching for', matches: name => SEARCH_TOOL_NAMES.has(name) },
  { noun: 'shell command', past: 'ran', present: 'running', matches: name => SHELL_TOOL_NAMES.has(name) },
  { noun: 'file', past: 'read', present: 'reading', matches: name => READ_TOOL_NAMES.has(name) },
]

/** The bare count clause over a run, one clause per kind present, joined by
 *  commas: `searched for 1 pattern, ran 6 shell commands, read 1 file`.
 *  Kinds with no calls are omitted entirely. */
export function runClause(
  calls: readonly { readonly name: string }[],
  working = false,
): string {
  return RUN_GROUPS.flatMap(group => {
    const count = calls.filter(call => group.matches(call.name)).length
    if (count === 0) return []
    const noun = count === 1 ? group.noun : `${group.noun}s`
    return [`${working ? group.present : group.past} ${count} ${noun}`]
  }).join(', ')
}

/** The collapsed row's wording for a run of settled calls. The clauses carry
 *  their own verbs (`ran 2 shell commands`), so this is just the verb-cased
 *  form of the first clause joined to the rest. */
export function runLabel(calls: readonly { readonly name: string }[]): string {
  const clause = runClause(calls)
  if (clause === '') return ''
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`
}

/**
 * The episode row's sentence: both facts when the run thought and acted,
 * the bare count for a run of pure calls, and `Thought for Ns` when —
 * impossible for a rendered episode, but the function stays total — nothing
 * ran. The seconds are the run's total thinking time, so several steps of
 * think-act read as one episode rather than one row per step.
 *
 * The verb is tense-marked: a run still working says `running`, a settled one
 * says `ran`. The wording is the cheapest signal that the row is live — the
 * dot says so too, but the dot is a glyph the eye reads as decoration while
 * the verb is read as meaning.
 * @param seconds - summed reasoning seconds across the run.
 * @param calls - the run's settled calls, in log order (their tool names
 *   decide which clauses appear and in what order).
 * @param working - the episode is still running (live reasoning or a call in
 *   flight).
 * @returns the collapsed sentence.
 */
export function episodeLabel(
  seconds: number,
  calls: readonly { readonly name: string }[],
  working = false,
): string {
  // Present tense while the reasoning is live, past once it settles: the row
  // is the model's own report of what it is doing.
  const thinking = working ? 'Thinking' : 'Thought'
  // The calls' own clause already carries its verbs, in lower case so it can
  // follow a sentence opener. A run with no reasoning has no opener, so its
  // first word takes the capital.
  const callClause = runClause(calls, working)
  if (seconds === 0) {
    return callClause === '' ? '' : `${callClause.charAt(0).toUpperCase()}${callClause.slice(1)}`
  }
  return callClause === ''
    ? `${thinking} for ${seconds}s`
    : `${thinking} for ${seconds}s, ${callClause}`
}

/**
 * Whether a frame is reasoning with no visible answer text — the shape an
 * episode absorbs. A frame that carries an answer keeps its own row: merging
 * would skip the prose between the reasoning and the commands, breaking the
 * reading order.
 *
 * Reasoning that is still streaming counts: the episode grows in place while
 * the model thinks, so a running task never sprouts a second header row for
 * the work it is in the middle of. The reasoning's text and seconds keep
 * updating inside the episode it belongs to.
 * @param frame - the frame to test.
 * @returns whether the frame is in-progress or settled reasoning alone.
 */
export function isReasoningOnly(frame: Frame): boolean {
  if (frame.kind !== 'assistant') return false
  if (frame.thinking === undefined) return false
  return frame.text.trim() === ''
}

/** Whether a reasoning part is still being written: its episode renders the
 *  live window over the latest rows, and the count keeps growing. */
export function isLiveThinking(frame: Frame): boolean {
  return frame.kind === 'assistant' && frame.streaming && frame.text.trim() === ''
}

/**
 * Whether a frame is a foldable call that has started and not yet finished.
 * It rides inside the episode as a live line (the blinking dot and the
 * invocation) instead of waiting for a card: the whole point of the collapsed
 * run is that a reader can see what is happening right now without opening it.
 * Only the absorbed kinds ride here; everything else keeps its own card while
 * it runs.
 * @param frame - the frame to test.
 * @returns whether the frame is an in-flight foldable call.
 */
export function isRunningCall(frame: Frame): boolean {
  if (frame.kind !== 'tool') return false
  if (!FOLDABLE_TOOL_NAMES.has(frame.name)) return false
  if (frame.result !== undefined || frame.resultContent !== undefined) return false
  return frame.isError !== true
}

/** One part of an episode, in log order: a reasoning block, or a shell call. */
export type EpisodePart =
  | {
    readonly kind: 'thinking'
    readonly seq: number
    readonly thinking: NonNullable<Extract<Frame, { kind: 'assistant' }>['thinking']>
    /** The reasoning stream is still open: its node renders the live window
     *  (`│ ` rule, latest rows) under the episode's header row. */
    readonly live: boolean
  }
  | {
    readonly kind: 'tool'
    readonly frame: Extract<Frame, { kind: 'tool' }>
    /** The call is still running: its node renders the live call line (the
     *  blinking dot and the invocation) under the episode's header row. */
    readonly running: boolean
  }

/** The `⎿`-block rows one text payload occupies: each line wraps at the
 *  terminal width behind its five-column connector indent, and more than
 *  TRUNCATED_OUTPUT_LINES lines fold with a hint row. */
function blockRows(text: string, width: number): number {
  if (text === '') return 0
  const lines = text.split('\n')
  const hidden = lines.length - TRUNCATED_OUTPUT_LINES
  const visible = hidden > 0 ? lines.slice(0, TRUNCATED_OUTPUT_LINES) : lines
  let rows = 0
  for (const line of visible) rows += wrapToWidth(`${' '.repeat(5)}${line === '' ? ' ' : line}`, width).length
  return rows + (hidden > 0 ? 1 : 0)
}

/** The rows one settled tool call's card occupies, mirroring ToolResultView's
 *  every branch. `undefined` marks a shape the mirror does not cover, so the
 *  caller falls back to measuring after the fact. */
function toolCardRows(frame: Extract<Frame, { kind: 'tool' }>, width: number): number | undefined {
  if (frame.result === undefined && frame.resultContent === undefined) return 0
  const result = frame.result
  if (result === undefined) return blockRows(stripOuterCodeFence(contentToText(frame.resultContent ?? [])), width)
  switch (result.card) {
    case 'terminal':
      return result.output === undefined || result.output === '' ? 0 : blockRows(trimNewline(result.output), width)
    case 'diff': {
      let rows = 0
      for (const diff of result.diffs) rows += 1 + inlineDiffLines(diff.oldText ?? '', diff.newText).length
      return rows > TRUNCATED_OUTPUT_LINES ? TRUNCATED_OUTPUT_LINES + 1 : rows
    }
    case 'generic':
      return blockRows(stripOuterCodeFence(contentToText(result.content ?? frame.resultContent ?? [])), width)
    case 'read': {
      const lines = result.lines
      let rows = 0
      const visible = lines.length > TRUNCATED_OUTPUT_LINES ? lines.slice(0, TRUNCATED_OUTPUT_LINES) : lines
      for (const line of visible) rows += wrapToWidth(`${' '.repeat(5)}${line.number}: ${line.text}`, width).length
      return rows + (lines.length > TRUNCATED_OUTPUT_LINES ? 1 : 0)
    }
    case 'search':
    case 'web':
      return blockRows(stripOuterCodeFence(contentToText(frame.resultContent ?? [])), width)
  }
}

/**
 * The row count an EpisodeRow occupies, computed the way the component lays
 * itself out. The click toggle needs the number BEFORE the first paint: an
 * episode expands by swapping its one-line sentence for the whole body, and
 * without the exact delta staged up front the scroll correction lands one
 * frame late — the block visibly jumps and settles (worst at the live
 * bottom, where the whole window re-anchors).
 *
 * `undefined` means the shape is not mirrored (ctrl+o widening, or a card the
 * mirror does not cover); the caller then falls back to the post-commit
 * measure and accepts the one-frame jump.
 * @param parts - the episode's parts, in order.
 * @param expanded - whether the body renders.
 * @param expandedOutput - the ctrl+o widened-output state.
 * @param width - the terminal width in columns.
 * @returns the row count, or undefined when not computable.
 */
export function episodeRowHeight(
  parts: readonly EpisodePart[],
  expanded: boolean,
  expandedOutput: boolean,
  width: number,
): number | undefined {
  // ctrl+o lifts the call-line clamp and the output budget; the wrapped call
  // lines are not mirrored, so bail rather than guess.
  if (expandedOutput) return undefined
  if (expanded) {
    let rows = 0
    for (const [index, part] of parts.entries()) {
      const margin = index === 0 ? 0 : 1
      if (part.kind === 'thinking') {
        rows += margin + wrapToWidth(part.thinking.text, Math.max(1, width - 2)).length
        continue
      }
      const card = toolCardRows(part.frame, width)
      if (card === undefined) return undefined
      // The call line: one row (the invocation stays clamped without ctrl+o).
      rows += margin + 1 + card
    }
    return rows
  }
  // Collapsed: the sentence row plus whatever work is still live under it.
  const liveParts = parts.filter(part => part.kind === 'thinking' ? part.live : part.running)
  const seconds = parts.reduce((total, part) => total + (part.kind === 'thinking' ? part.thinking.seconds : 0), 0)
  const calls = parts.flatMap(part => (part.kind === 'tool' ? [{ name: part.frame.name }] : []))
  const sentence = episodeLabel(seconds, calls, liveParts.length > 0)
  let rows = sentence === '' ? 0 : 1
  for (const part of liveParts) {
    if (part.kind === 'thinking') {
      rows += wrapToWidth(part.thinking.text, Math.max(1, width - 4)).slice(-THOUGHT_WINDOW_LINES).length
    } else {
      rows += 1
    }
  }
  return rows
}

/**
 * One episode of think-act work, collapsed to a single sentence:
 * `● Thought for 7s, ran 3 shell commands`.
 *
 * The model reads, thinks, and runs a command — then repeats — and each repeat
 * arrives as its own step. Rendering one row per step turns a single task into
 * a column of near-identical counts; the episode folds the whole stretch into
 * the one fact a reader needs (how long it thought, how much it ran) and a
 * click reveals every part in order: reasoning as plain prose, then each
 * command's own card.
 */
export function EpisodeRow({
  parts,
  expandedOutput,
  expanded,
  hovered,
  blockRef,
}: {
  parts: readonly EpisodePart[]
  expandedOutput: boolean
  /** The click swapped the episode open: the parts replace the sentence. */
  expanded: boolean
  /** The pointer rests on the collapsed sentence: it drops the dim. */
  hovered: boolean
  /** Registers the whole block's element so the renderer can measure its
   *  height — the click target is the sentence or the revealed content. */
  blockRef?: ((el: unknown) => void) | undefined
}): React.JSX.Element {
  const width = useTerminalWidth()
  const contentWidth = Math.max(1, width - 2)
  const seconds = parts.reduce((total, part) => total + (part.kind === 'thinking' ? part.thinking.seconds : 0), 0)
  // Every call the episode covers is counted; the verb says which of them have
  // finished (`ran` once all have, `running` while one is still in flight).
  const calls = parts.flatMap(part => (part.kind === 'tool' ? [{ name: part.frame.name }] : []))
  // While the episode is still running, its in-flight work shows under the
  // header row even collapsed: the reasoning window and the command being
  // executed right now. The episode is where the work is happening, so a
  // reader sees it there rather than in a second block below.
  const liveParts = expanded ? [] : parts.filter(part => part.kind === 'thinking' ? part.live : part.running)
  // Still working counts the open reasoning stream too: the sentence says
  // `Thinking` and keeps the dot while the model is thinking, even before the
  // first command starts.
  const thinkingLive = parts.some(part => part.kind === 'thinking' && part.live)
  // The episode is still working: its header carries the in-progress dot, and
  // the settled state drops the dot entirely — a finished row is a plain
  // statement of what happened, not a status light. The working text is the
  // default foreground (white) rather than dim, so the row being worked on
  // reads as the live one.
  const working = liveParts.length > 0 || thinkingLive
  const sentence = episodeLabel(seconds, calls, working)
  // The settled row sits on the body text's column — two in, where a settled
  // `Thought for Ns` row already sits — instead of hugging the left edge.
  // The working row keeps the dot at the edge, so its label lands on that
  // same column by the dot's own two cells.
  const settledIndent = '  '
  return (
    <Box flexDirection="column" {...(blockRef === undefined ? {} : { ref: blockRef })}>
      {/* The open episode is its parts alone: the sentence only leads the
          collapsed state, matching the reasoning block's expand shape. A run
          with nothing settled yet has nothing to count — its one live line
          says more than an empty header would. */}
      {expanded || sentence === ''
        ? null
        : working
          ? <Text><BlinkingDot /> {sentence}</Text>
          : hovered
            ? <Text>{settledIndent}{sentence}</Text>
            : <Text dimColor>{settledIndent}{sentence}</Text>}
      {expanded
        ? (
          /* The revealed body sits on a dark band so the opened episode reads
             as one block against the surrounding transcript — the same
             device the user echo uses, one shade darker so the two never
             read as the same kind of row. */
          <Box flexDirection="column" width={width} backgroundColor={EPISODE_BODY_BACKGROUND}>
            {parts.map((part, index) => (
              part.kind === 'thinking'
                ? (
                  <Box key={`thinking:${part.seq}`} flexDirection="column" marginLeft={2} marginTop={index === 0 ? 0 : 1}>
                    {wrapToWidth(part.thinking.text, contentWidth).map((line, lineIndex) => (
                      <Text key={lineIndex} dimColor>{line === '' ? ' ' : line}</Text>
                    ))}
                  </Box>
                )
                : (
                  <Box key={part.frame.callId} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                    <ToolRow frame={part.frame} expandedOutput={expandedOutput} awaitingApproval={false} />
                  </Box>
                )
            ))}
          </Box>
        )
        : liveParts.map(part => part.kind === 'thinking'
          ? (
            /* Collapsed and still thinking: the latest reasoning rows ride
               under the header on the live `│ ` rule, scrolling over the last
               THOUGHT_WINDOW_LINES so the surface stays compact however long
               the thought runs. */
            <Box key={`live:${part.seq}`} flexDirection="column" marginLeft={2}>
              {wrapToWidth(part.thinking.text, Math.max(1, width - 4))
                .slice(-THOUGHT_WINDOW_LINES)
                .map((line, lineIndex) => (
                  <Text key={lineIndex} dimColor>{`│ ${line === '' ? ' ' : line}`}</Text>
                ))}
            </Box>
          )
          : (
            /* Collapsed and running a command: the command itself under the
               shared `⎿` connector, without the tool label — a shell run has
               one shape of work, so `Bash(…)` would only restate the row's own
               subject. It leaves this line the moment its card is built. */
            <Box
              key={`running:${part.frame.callId}`}
              flexDirection="column"
              marginTop={liveParts[0]?.kind === 'thinking' ? 1 : 0}
            >
              <Text>
                <Text dimColor>{'  ⎿  '}</Text>
                <Text dimColor>{shellInvocation(part.frame, expandedOutput, width)}</Text>
              </Text>
            </Box>
          ))}
    </Box>
  )
}

/** One slash-command invocation: the Claude Code style echo line — the `❯`
 *  marker and the full-width background band, the command's own submission —
 *  then the settled outcome under the shared `⎿` output block. A silent
 *  success (no text) renders the echo alone. */
function CommandRow({ frame, expandedOutput, width }: {
  frame: Extract<Frame, { kind: 'command' }>
  expandedOutput: boolean
  width: number
}): React.JSX.Element {
  const done = frame.done
  return (
    <Box flexDirection="column">
      <Text backgroundColor="#3a3a3a">
        {padToWidth(`❯ /${frame.name}${frame.args ?? ''}`, width)}
      </Text>
      {done !== undefined && (done.kind === 'error' || done.text !== undefined)
        ? <IndentedBlock
          text={done.text ?? 'command failed'}
          expanded={expandedOutput}
          bright
          alwaysExpanded
          {...(done.kind === 'error' ? { error: true } : {})}
        />
        : null}
    </Box>
  )
}

/** One tool call card: the pending call view, then the completed result view. */
function ToolRow({ frame, expandedOutput, awaitingApproval }: { frame: Extract<Frame, { kind: 'tool' }>; expandedOutput: boolean; awaitingApproval: boolean }): React.JSX.Element {
  const completed = frame.result !== undefined || frame.resultContent !== undefined
  // The reviewed plan is the exit_plan_mode call's own argument, so the frame
  // renders the plan itself instead of the generic call line — the web
  // client's submittedPlan() source, and the reason the plan survives the
  // answered overlay (and a session resume: the fold replays the same args).
  // Pending, it wears the review card ("Here is DSH's plan:"). Settled
  // approved, it collapses to the reference verdict reading: one ● line, then
  // the plan indented under the ⎿ connector, and the host's result text is
  // suppressed — the verdict line replaces it. A decline (the host throws, so
  // isError) keeps the review card with the red feedback result under it.
  const plan = planMarkdownOf(frame)
  if (plan !== undefined && completed && !frame.isError) {
    return (
      <Box flexDirection="column">
        <Text><Text color="#51cf66">●</Text> User approved DSH's plan</Text>
        {assistantContent(plan.split('\n'), '  ⎿  ', '     ')}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {plan === undefined
        ? <ToolCallView frame={frame} expandedOutput={expandedOutput} awaitingApproval={awaitingApproval} />
        : <PlanDocument plan={plan} />}
      {completed ? <ToolResultView frame={frame} expandedOutput={expandedOutput} /> : null}
    </Box>
  )
}

/**
 * Read a reviewed plan from untrusted logged call arguments — the terminal's
 * submittedPlan(): the frame is an `exit_plan_mode` invocation and its parsed
 * arguments carry the plan markdown. The web client additionally requires a
 * `# heading` (its card needs a title); the terminal renders the document
 * as-is, so a headingless plan still renders.
 * @param frame - the tool frame to inspect.
 * @returns the plan markdown, or undefined for any other call.
 */
export function planMarkdownOf(frame: Extract<Frame, { kind: 'tool' }>): string | undefined {
  if (frame.name !== 'exit_plan_mode') return undefined
  const args: unknown = frame.args
  if (typeof args !== 'object' || args === null) return undefined
  const plan = (args as Record<string, unknown>).plan
  return typeof plan === 'string' && plan !== '' ? plan : undefined
}

/**
 * The plan-review document card: a full-width rule, the "Here is DSH's plan:"
 * lead, one breathing row, then the plan markdown rendered as light assistant
 * content. The approve/keep-planning decision lives in the bottom control bar,
 * never here.
 */
export function PlanDocument({ plan }: { plan: string }): React.JSX.Element {
  const width = useTerminalWidth()
  return (
    <Box flexDirection="column">
      <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
      <Text> Here is DSH's plan:</Text>
      <Text> </Text>
      {assistantContent(plan.split('\n'), '  ')}
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

/**
 * A shell call's invocation on one readable line: the folded command, without
 * the `Bash(…)` wrapper. The episode's own sentence already names what the
 * row is doing, so the wrapper would restate it; the command is the fact a
 * reader wants. Long commands clamp unless ctrl+o has widened the view.
 * @param frame - the shell call.
 * @param expandedOutput - whether ctrl+o lifted the width clamp.
 * @param width - the terminal width.
 * @returns the command text for one line.
 */
export function shellInvocation(frame: Extract<Frame, { kind: 'tool' }>, expandedOutput: boolean, width: number): string {
  const label = toolLabel(frame.name)
  const title = frame.call.card === 'diff'
    ? frame.call.diffs.map(diff => `${diff.path}${diff.oldText === null ? ' (new)' : ''}`).join(', ')
    : frame.call.title.startsWith(`${label} `) ? frame.call.title.slice(label.length + 1) : frame.call.title
  const folded = foldInvocationLine(title)
  return expandedOutput ? folded : truncateToWidth(folded, Math.max(8, width - 6))
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

/** The Claude Code-style output block: one `⎿` connector, then aligned lines, truncated with an expand hint; a failed result renders red instead of dim, and a `bright` success renders white (the slash commands' results — tool outputs and notice bodies stay dim). */
function IndentedBlock({ text, expanded, error, bright, alwaysExpanded }: {
  text: string
  expanded: boolean
  error?: boolean
  bright?: boolean
  /** Show every line regardless of the truncation budget and the ctrl+o
   *  toggle. Command results use this: a report the user asked for should
   *  arrive whole rather than behind an expand hint. */
  alwaysExpanded?: boolean
}): React.JSX.Element {
  const lines = text.split('\n')
  const hidden = lines.length - TRUNCATED_OUTPUT_LINES
  // The `⎿` connector is always dim across the whole project, whether or not
  // the result is an error; only the content text takes the error color.
  const row = (line: string, index: number): React.JSX.Element => (
    <Text key={index}>
      <Text dimColor>{index === 0 ? '  ⎿  ' : '     '}</Text>
      {error
        ? <Text color="red">{line}</Text>
        : bright ? <Text color="#ffffff">{line}</Text> : <Text dimColor>{line}</Text>}
    </Text>
  )
  if (!alwaysExpanded && !expanded && hidden > 0) {
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
 * `marker` swaps that leading glyph (the plan-review card renders the plan
 * document with a plain two-space lead, or the approved plan with a `⎿`
 * connector whose `continuation` indent the later lines align under).
 */
export function assistantContent(lines: readonly string[], marker = '● ', continuation = '  '): React.JSX.Element[] {
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
        elements.push(<Text key={`table-${i}-${r}`}>{isFirst ? marker : continuation}{row}</Text>)
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
        {markedFirst ? continuation : marker}
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
