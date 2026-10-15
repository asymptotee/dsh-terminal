/**
 * The chrome band's fixed components: the standing footer, the welcome splash,
 * the approval question, optimistic submission echoes, the todo plan, the goal
 * strip, and the step heartbeat. None of these take keyboard focus — they are
 * standing context rendered between the transcript window and the input bar.
 * @module dsh-terminal/src/chrome
 */

// Classic-JSX source launch needs the React namespace in scope.
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import type { FrameState } from '../frames.ts'
import type { GoalPanelInfo, Overlay, PendingUserEcho, StatusInfo } from './view-types.ts'
import { formatContext, formatElapsed, formatTokenCount, shortenCwd, toolLabel, wrapToWidth } from '../text-helpers.ts'

/** How long the task board lingers after its last task completes, before the
 *  whole section disappears at once — enough time to read the final state. */
export const COMPLETED_BOARD_LINGER_MS = 5_000

/** The fixed footer: model, session, working state, context usage, and scrollback hint. */
export function StatusBar({
  status,
  hint,
}: {
  status: StatusInfo | undefined
  /** Panel key hints trailing the permission row (workflow navigation). */
  hint?: string
}): React.JSX.Element {
  if (status === undefined) return <></>
  return (
    // The two-column lead aligns the footer under the panels' header column
    // (the Workflow run header's indent); the right-aligned effort keeps its
    // own right padding, so only the left edge moves.
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box flexDirection="row">
        <Text dimColor>
          {status.model} · {shortenCwd(status.cwd)}
          {status.context !== undefined ? ` · context: ${formatContext(status.context)}` : ''}
        </Text>
        <Box flexGrow={1} />
        <Box paddingRight={1}>
          <Text dimColor>
            {status.effort !== undefined ? `● effort: ${status.effort}` : ''}
          </Text>
        </Box>
      </Box>
      {status.mode !== undefined || hint !== undefined
        ? (
          <Text dimColor>
            {status.mode ?? ''}
            {status.mode !== undefined && hint !== undefined ? ' · ' : ''}
            {hint !== undefined ? `(${hint})` : ''}
          </Text>
        )
        : null}
    </Box>
  )
}

/** The persistent welcome block: title, model, and cwd. */
export function WelcomeBlock({
  status,
}: {
  status: StatusInfo | undefined
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#a5d8ff" paddingX={1} marginBottom={1}>
      <Text bold>DeepSeek Harness — Terminal</Text>
      <Text dimColor>model: {status?.model ?? '?'}</Text>
      <Text dimColor>cwd: {status === undefined ? '' : shortenCwd(status.cwd)}</Text>
    </Box>
  )
}

/**
 * The approval question as the screen-bottom panel: while it waits it replaces
 * the input box, the status bar, and the side panels (the bar stays mounted
 * but renders nothing — it owns the single stdin listener and routes the
 * question's keys). The leading rule and the `<Tool> command` title wear the
 * shared highlight tint; the invocation leads and the asker's reason follows,
 * hanging-indented to one column; the selected option sits behind a ❯ marker
 * in the same tint, every other row dim. No closing rule at the screen
 * bottom — a marginBottom row keeps the Esc hint off the last line.
 */
export function ApprovalPanel({
  overlay,
  selected,
  width,
}: {
  overlay: Extract<Overlay, { kind: 'approval' }>
  /** The arrow-selected option: 0 = Yes, 1 = No. */
  selected: number
  width: number
}): React.JSX.Element {
  const options = ['1. Yes', '2. No']
  // The invocation leads, the asker's reason follows — both hanging-indented
  // to the same column, wrapped by display width so CJK reasons stay aligned.
  const indent = '   '
  const budget = Math.max(0, width - stringWidth(indent))
  const detailLines = overlay.detail === undefined ? [] : wrapToWidth(overlay.detail, budget)
  const reasonLines = overlay.reason === undefined ? [] : wrapToWidth(overlay.reason, budget)
  // The bottom margin keeps the Esc hint off the very last screen row, the
  // same one-row gap the status bar's marginBottom provides when it is up.
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
      <Text color="#a5d8ff"> {toolLabel(overlay.toolName)} command</Text>
      {/* Breathing room between the title and the invocation block, matching
          the discovery-panel convention. */}
      <Text> </Text>
      {detailLines.map((line, index) => <Text key={`detail-${index}`}>{indent}{line}</Text>)}
      {reasonLines.map((line, index) => <Text key={`reason-${index}`} dimColor>{indent}{line}</Text>)}
      <Text> </Text>
      <Text> Do you want to proceed?</Text>
      {options.map((label, index) => index === selected
        ? <Text key={label} color="#a5d8ff"> ❯ {label}</Text>
        : <Text key={label} dimColor>   {label}</Text>)}
      <Text> </Text>
      <Text dimColor> Esc to cancel</Text>
    </Box>
  )
}

/** Lines one queued echo shows before eliding the rest with a hint row. */
const ECHO_MAX_LINES = 3

/**
 * The optimistic echoes of messages submitted while a step was in flight.
 * Rendered dimmed and without the committed user background so a steered
 * message reads as pending; each is removed once its durable user/message
 * frame lands in the transcript above. Echoes cap at ECHO_MAX_LINES so a
 * pasted message cannot squeeze the transcript window.
 */
export function PendingUserEchoes({ items }: { items: readonly PendingUserEcho[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map(item => {
        const lines = item.text.split('\n')
        const hidden = Math.max(0, lines.length - ECHO_MAX_LINES)
        const visible = lines.slice(0, ECHO_MAX_LINES)
        return (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            {visible.map((line, index) => (
              <Text key={index} dimColor>{index === 0 ? '❯ ' : '  '}{line}</Text>
            ))}
            {hidden > 0 ? <Text dimColor>  … {hidden} more lines</Text> : null}
            <Text dimColor>  (steering — runs at the next step boundary)</Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** Todos beyond this cap are elided with a hint row, keeping the chrome band
 *  bounded so the transcript window always keeps a usable height. */
const PLAN_MAX_TODOS = 10

/** The standing todo plan as a checklist panel above the stream; the tail
 *  (most recent) todos win when the list exceeds the cap. */
export function PlanPanel({ todos }: { todos: FrameState['plan'] & object }): React.JSX.Element {
  const hidden = Math.max(0, todos.length - PLAN_MAX_TODOS)
  const visible = todos.slice(-PLAN_MAX_TODOS)
  return (
    // The two-column lead puts the Todos header on the panels' shared header
    // column (Teammates / Tasks / Workflow / Goal).
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text>Todos · {todos.length}</Text>
      {hidden > 0 ? <Text dimColor>⎿  … {hidden} earlier</Text> : null}
      {visible.map((todo, index) => {
        const mark = todo.status === 'completed'
          ? <Text color="green">✔</Text>
          : todo.status === 'in_progress'
            ? <Text color="#a5d8ff">◼</Text>
            : <Text dimColor>◻</Text>
        // The first line carries the `⎿` connector at column two —
        // absolutely aligned with the transcript's tool output connectors
        // (the panel's padding supplies the indent); continuations align
        // under its text (`⎿  ` is three display columns). The connector is
        // dim like every other connector in the project; dim is scoped to
        // its own Text so it does not mute the colored status markers, and
        // the content text takes its own dim wrapper.
        const prefix = index === 0 && hidden === 0 ? '⎿  ' : '   '
        return <Text key={index}><Text dimColor>{prefix}</Text>{mark} <Text dimColor>{todo.content}</Text></Text>
      })}
    </Box>
  )
}

/** The header's state word: the phase fused with the continuation switch,
 *  the web client's English dictionary — an active goal reads `ongoing` only
 *  while armed; disarmed it is `inactive` (someone must resume it), and the
 *  bare armed/disarmed jargon never reaches the screen. */
function goalStateLabel(goal: GoalPanelInfo): string {
  if (goal.phase === 'active') return goal.activation === 'armed' ? 'ongoing' : 'inactive'
  if (goal.phase === 'paused') return 'paused'
  if (goal.phase === 'blocked') return 'blocked'
  return 'complete'
}

/** The glyph trailing the state word — the task board's vocabulary: ◼ light
 *  blue while the goal runs unattended, ⊘ dim once the switch is off (the
 *  inactive/paused pair, inert rather than failed), ✘ red when blocked, ✔
 *  green once complete. */
function goalStateGlyph(goal: GoalPanelInfo): React.JSX.Element {
  if (goal.phase === 'active') return goal.activation === 'armed' ? <Text color="#a5d8ff">◼</Text> : <Text dimColor>⊘</Text>
  if (goal.phase === 'paused') return <Text dimColor>⊘</Text>
  if (goal.phase === 'blocked') return <Text color="red">✘</Text>
  return <Text color="green">✔</Text>
}

/** The standing goal as a two-row strip right above the input bar: a header
 *  carrying the fused state word, its glyph, and the round progress, then the
 *  objective on a `⎿` connector. Blocked goals add a reason row. Purely
 *  display — the goal strip takes no keys and never joins panel navigation. */
export function GoalPanel({ goal }: { goal: GoalPanelInfo }): React.JSX.Element {
  return (
    // Same two-column lead as the plan: the goal header joins the panels'
    // shared header column, its `⎿` objective row shifting with it.
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text>
        Goal · {goalStateLabel(goal)} {goalStateGlyph(goal)}
        {' · round '}
        {goal.roundsStarted}/{goal.maxGoalRounds}
      </Text>
      {/* The objective's `⎿` sits at column two — absolutely aligned with the
          bash tool output connector in the transcript; dim is scoped to the
          connector and the text so it does not mute the header's glyph. The
          blocked-reason `⊘` keeps its place under the objective text. */}
      <Text><Text dimColor>⎿  </Text><Text dimColor>{goal.objective}</Text></Text>
      {goal.phase === 'blocked' && goal.blockedReason !== undefined
        ? <Text dimColor>   ⊘ {goal.blockedReason.code}: {goal.blockedReason.message}</Text>
        : null}
    </Box>
  )
}

/** Braille-dot spinner cycled to animate the working marker: the terminal
 *  world's canonical busy indicator, a clockwise dot sweep. */
const HEARTBEAT_FRAMES = ['⠋', '⠙', '⠉', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const HEARTBEAT_INTERVAL_MS = 80

/** The step heartbeat: one label for the whole step — the model call and its tool executions. */
export function HeartbeatLine({ startedAt, tokens }: { startedAt: number; tokens: number | undefined }): React.JSX.Element {
  // Self-driven animation: cycle the spinner frame on an interval so the heartbeat
  // pulses — and the elapsed clock ticks — even while no session event arrives.
  // The timer is unref'd so it never holds the event loop open (tests exit cleanly).
  const [tick, setTick] = useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => setTick(current => current + 1), HEARTBEAT_INTERVAL_MS)
    timer.unref()
    return () => { clearInterval(timer) }
  }, [])
  const glyph = HEARTBEAT_FRAMES[tick % HEARTBEAT_FRAMES.length]
  // The token figure is this turn's generated output, summed across its steps
  // (dsh only reports usage at step end), so it steps up per completed step and
  // resets when the next turn starts. The `↓` matches the panel's token marker.
  const tokenNote = tokens !== undefined && tokens > 0 ? ` · ↓ ${formatTokenCount(tokens)} tokens` : ''
  // One blank row of breathing room between the heartbeat and the input bar.
  return (
    <Box marginBottom={1}>
      <Text>
        <Text color="#a5d8ff">{glyph} Working…</Text> <Text dimColor>({formatElapsed(Date.now() - startedAt)}{tokenNote})</Text>
      </Text>
    </Box>
  )
}
