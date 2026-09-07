/**
 * M5 ink renderer: the frame stream, the multiline input bar, the status bar,
 * and the overlay slot (notices and approval questions) as an ink component
 * tree. Pure presentation — every prop is plain data from the fold or the
 * driver, and the ink view is the only subscriber to those values.
 * @module dsh-terminal/src/renderer
 */

// The source-launch tsx hook compiles with the launcher's tsconfig (classic
// JSX), so the React namespace must be imported even though the package's own
// tsc build uses react-jsx; React.useRef below keeps the import used.
import os from 'node:os'
import React, { useState } from 'react'
import { Box, Static, Text, render, useInput, useStdout } from 'ink'
import type { Frame, FrameState } from './frames.ts'
import { createFrameState } from './frames.ts'
import { contentToText } from './render.ts'

/** Callbacks the input bar hands to the driver. */
export interface InputHandlers {
  /** Submit one user line (Enter on a non-empty buffer). */
  onCommit(text: string): void
  /** Clear the buffer (Ctrl+C with content), or interrupt the turn when empty. */
  onInterrupt(): void
  /** Answer a pending approval request (y/n keys). */
  onApproval(allow: boolean): void
  /** Request a clean exit (Ctrl+D or a second Ctrl+C). */
  onExit(): void
  /** Move keyboard focus from the input bar into the subagent panel (`↓`). */
  onPanelOpen(): void
  /** Move the panel selection by `delta` rows. */
  onPanelMove(delta: number): void
  /** Enter the selected panel row's view (the main row returns to the input bar). */
  onPanelEnter(): void
  /** Return keyboard focus one level up: the child view to the input bar, the panel to the input bar. */
  onPanelBack(): void
}

/** A transient surface message or question shown above the input bar. */
export type Overlay =
  | { kind: 'notice'; text: string }
  | { kind: 'approval'; toolName: string; reason?: string }

/** The always-visible footer facts. */
export interface StatusInfo {
  /** The active model name. */
  model: string
  /** The working directory, shown home-shortened. */
  cwd: string
  /** The sandbox permission mode (`read-only`/`workspace-write`/...), on its own row. */
  mode?: string
  /** Current context usage from the latest step's token report. */
  context?: { used: number; window: number }
  /** The reasoning effort, shown right-aligned with the `/effort` hint. */
  effort?: string
}

/** One unfinished direct subagent as a panel row. */
export interface SubagentRow {
  /** The child session id; entering the row opens this session's transcript. */
  childId: string
  /** The child's display label (its delegation description, or a shortened id until the descriptor arrives). */
  label: string
  /** The child's latest visible activity; absent before its first frame. */
  activity?: string
  /** When the child's run began; the panel shows the elapsed time against the current clock. */
  startedAt: number
  /** Accumulated input and cache-read tokens reported by the child. */
  inputTokens: number
  /** True while the post-settlement fade countdown runs. */
  fading: boolean
}

/** The child transcript the driver opens from the panel. */
export interface OpenSubagent {
  /** The child session id. */
  childId: string
  /** The child's display label, shown in the view header. */
  label: string
  /** The child's folded frames, rebuilt through the same fold as the main stream. */
  state: FrameState
}

/** Everything the driver renders besides the frame state. */
export interface RenderView {
  overlay?: Overlay
  status?: StatusInfo
  /** The unfinished direct subagents; absent or empty hides the panel. */
  subagents?: readonly SubagentRow[]
  /** The panel's selected row (0 = the main agent row); absent means the input bar holds focus. */
  subagentSelected?: number
  /** The child transcript opened from the panel; replaces the input region while set. */
  openSubagent?: OpenSubagent
}

/** The presentation seam the driver drives; driver suites substitute a capture. */
export interface TuiRenderer {
  /** Adopt a new frame state (rebuilt or live) plus the transient view. */
  render(state: FrameState, view?: RenderView): void
  /** Bind the input callbacks the renderer's input bar invokes. */
  setHandlers(handlers: InputHandlers): void
  /** Tear the renderer down (unmount ink) so the process can exit naturally. */
  dispose(): void
}

/** The pre-driver placeholder: nothing renders until the first driven render, so the full surface appears once. */
function LoadingScreen(): React.JSX.Element {
  return <Box />
}

/** The ink terminal view the driver drives: stream, status, and input bar. */
export function createInkRenderer(): TuiRenderer {
  let state = createFrameState()
  let view: RenderView | undefined
  let handlers: InputHandlers = {
    onCommit: () => {},
    onInterrupt: () => {},
    onApproval: () => {},
    onExit: () => {},
    onPanelOpen: () => {},
    onPanelMove: () => {},
    onPanelEnter: () => {},
    onPanelBack: () => {},
  }
  const props = (): { state: FrameState; handlers: InputHandlers; view?: RenderView } => ({
    state,
    handlers,
    ...view === undefined ? {} : { view },
  })
  const app = render(
    React.createElement(LoadingScreen),
    { exitOnCtrlC: false },
  )
  return {
    render(next: FrameState, nextView?: RenderView): void {
      state = next
      view = nextView
      app.rerender(React.createElement(TuiApp, props()))
    },
    setHandlers(next: InputHandlers): void {
      handlers = next
      app.rerender(React.createElement(TuiApp, props()))
    },
    dispose(): void {
      app.unmount()
    },
  }
}

/** The whole terminal surface: appended stream, overlay, status bar, input bar. */
export function TuiApp({
  state,
  handlers,
  view,
}: {
  state: FrameState
  handlers: InputHandlers
  view?: RenderView
}): React.JSX.Element {
  const [expandedOutput, setExpandedOutput] = useState(false)
  // The arrow-selected approval option; resets per question via the overlay key.
  const [approvalIndex, setApprovalIndex] = useState(0)
  const onApprovalSelect = (delta: number): void => {
    setApprovalIndex(current => Math.min(1, Math.max(0, current + delta)))
  }
  const frames = state.frames
  // The arrow-browsed history: the session's submitted user lines, so a
  // resumed session restores its past inputs from the replayed log.
  const history = frames
    .filter((frame): frame is Extract<Frame, { kind: 'user' }> => frame.kind === 'user')
    .map(frame => frame.text)
  // Settled frames (and the welcome block) append once into the terminal
  // scrollback — never redrawn, so the scrollback survives. A frame enters the
  // scrollback only once it can no longer change: a pending tool call settled
  // while a sibling frame runs in parallel would otherwise stay frozen without
  // its result, because Static never redraws an appended frame. The latest
  // frame stays live above the input bar even when settled, so streaming
  // output and the expand key can redraw it.
  const lastLiveIndex = Math.max(0, frames.length - 1)
  const firstMutable = frames.findIndex(frameMutable)
  const liveStart = firstMutable === -1 ? lastLiveIndex : Math.min(firstMutable, lastLiveIndex)
  const settled = frames.slice(0, liveStart)
  const live = frames.slice(liveStart)
  const items: StreamItem[] = [{ kind: 'welcome', status: view?.status }, ...settled]
  const subagents = view?.subagents ?? []
  const opened = view?.openSubagent
  // The main scrollback stays mounted while the child view is open, so its
  // Static output is never re-emitted; the child transcript replaces only the
  // live region below it (input bar, panel, and status bar).
  const focusMode: 'input' | 'panel' | 'child' = opened !== undefined
    ? 'child'
    : view?.subagentSelected !== undefined ? 'panel' : 'input'

  return (
    <Box flexDirection="column">
      <SessionStream
        items={items}
        live={live}
        expandedOutput={expandedOutput}
      />
      {view?.overlay !== undefined
        ? <OverlayLine key={overlayKey(view.overlay)} overlay={view.overlay} selected={view.overlay.kind === 'approval' ? approvalIndex : 0} />
        : null}
      {opened !== undefined ? <ChildView opened={opened} /> : null}
      {/* The standing plan stays pinned directly above the input bar for its
          whole lifetime; the child view shows the child's own plan instead. */}
      {opened === undefined && state.plan !== undefined ? <PlanPanel todos={state.plan} /> : null}
      {/* The step heartbeat sits below the plan and above the input bar:
          shown throughout a step — its tool executions included — while an
          approval overlay waits on the user and the child view, which
          replaces this region entirely, hides it. */}
      {opened === undefined && view?.overlay === undefined
        && state.activeStep !== undefined
        ? <HeartbeatLine startedAt={state.activeStep.startedAt} />
        : null}
      {/* The input bar stays mounted in every focus mode — it owns the single
          stdin listener; in the child view it renders nothing and only routes
          Esc back to the input focus. */}
      <InputBar
        handlers={handlers}
        approvalPending={view?.overlay?.kind === 'approval'}
        approvalSelected={approvalIndex}
        onToggleExpand={() => { setExpandedOutput(current => !current) }}
        onApprovalSelect={onApprovalSelect}
        history={history}
        focusMode={focusMode}
        panelAvailable={subagents.length > 0}
      />
      {opened === undefined ? (
        <>
          <StatusBar
            status={view?.status}
          />
          {subagents.length > 0
            ? <SubagentPanel rows={subagents} selected={view?.subagentSelected} />
            : null}
        </>
      ) : null}
    </Box>
  )
}

/** One unfinished direct subagent's row in the panel below the status bar. */
function SubagentPanel({
  rows,
  selected,
}: {
  rows: readonly SubagentRow[]
  /** The selected row index over [main, ...rows]; undefined keeps the input bar focused. */
  selected: number | undefined
}): React.JSX.Element {
  const width = useTerminalWidth()
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(width)}</Text>
      {[undefined, ...rows].map((row, index) => {
        const isSelected = selected === index
        const marker = isSelected ? '●' : '◯'
        return (
          <Box key={row === undefined ? 'main' : row.childId}>
            <Text>{isSelected ? <Text color="green">{marker}</Text> : <Text dimColor>{marker}</Text>}</Text>
            <Text> </Text>
            <Text bold={isSelected}>{row === undefined ? 'main' : row.label}</Text>
            {row !== undefined && row.activity !== undefined ? <Text dimColor>  {row.activity}</Text> : null}
            <Box flexGrow={1} />
            {row === undefined ? null : (
              <Text dimColor>{formatElapsed(Date.now() - row.startedAt)} · ↓ {formatTokenCount(row.inputTokens)} tokens</Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/** The read-only transcript of one child session opened from the panel. */
function ChildView({ opened }: { opened: OpenSubagent }): React.JSX.Element {
  const width = useTerminalWidth()
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(width)}</Text>
      <Text><Text color="green">●</Text> subagent: <Text bold>{opened.label}</Text> <Text dimColor>(Esc 返回)</Text></Text>
      {opened.state.plan !== undefined ? <PlanPanel todos={opened.state.plan} /> : null}
      {opened.state.frames.map((frame, index) => (
        <Box key={frameKey(frame)} flexDirection="column" marginBottom={index === opened.state.frames.length - 1 ? 0 : 1}>
          <FrameRow frame={frame} expandedOutput={false} />
        </Box>
      ))}
    </Box>
  )
}

/** A wall-clock duration as `45s`, `1m 26s`, or `2h 5m`. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A token count as `812` or `11.1k`. */
function formatTokenCount(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

/** The persistent welcome block: title, model, and cwd. */
function WelcomeBlock({
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

/** Remount the overlay per approval request so the selection resets. */
function overlayKey(overlay: Overlay): string {
  return overlay.kind === 'approval' ? `approval:${overlay.toolName}:${overlay.reason ?? ''}` : 'notice'
}

function OverlayLine({
  overlay,
  selected,
}: {
  overlay: Overlay
  /** The arrow-selected option index; only an approval question uses it. */
  selected: number
}): React.JSX.Element {
  switch (overlay.kind) {
    case 'notice':
      return <Text color="red">{overlay.text}</Text>
    case 'approval':
      return (
        <Box flexDirection="column">
          <Text>
            <Text color="yellow">Allow </Text>
            {toolLabel(overlay.toolName)}? (y/esc)
          </Text>
          {overlay.reason !== undefined ? <Text dimColor>  ─ {overlay.reason}</Text> : null}
          <Text> Do you want to proceed?</Text>
          <Text>{selected === 0 ? ' ❯ ' : '   '}{selected === 0 ? <Text color="#a5d8ff">1. Yes</Text> : '1. Yes'}</Text>
          <Text>{selected === 1 ? ' ❯ ' : '   '}{selected === 1 ? <Text color="#a5d8ff">2. No</Text> : '2. No'}</Text>
        </Box>
      )
  }
}

/** The fixed footer: model, session, working state, context usage, and scrollback hint. */
function StatusBar({
  status,
}: {
  status: StatusInfo | undefined
}): React.JSX.Element {
  if (status === undefined) return <></>
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text dimColor>
          {status.model} · {shortenCwd(status.cwd)}
          {status.context !== undefined ? ` · context: ${formatContext(status.context)}` : ''}
        </Text>
        <Box flexGrow={1} />
        <Box paddingRight={1}>
          <Text dimColor>
            {status.effort !== undefined ? `◈ ${status.effort} · ` : ''}/effort
          </Text>
        </Box>
      </Box>
      {status.mode !== undefined ? <Text dimColor>{status.mode}</Text> : null}
    </Box>
  )
}

/** Shorten a home-directory path to `~`: `/home/x/repo` -> `~/repo`. */
function shortenCwd(cwd: string): string {
  const home = os.homedir()
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

/** Compact token count: 63_000 -> `63k`, 786_400 -> `786.4k`. */
function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${parseFloat((n / 1000).toFixed(1))}k`
}

/** `63k/786.4k (8%)` — used over the model window, with the fraction. */
function formatContext(context: { used: number; window: number }): string {
  const percent = Math.round((context.used / context.window) * 100)
  return `${compactTokens(context.used)}/${compactTokens(context.window)} (${percent}%)`
}

/** The seq-ordered frame window: settled scrollback plus the live frames. */
/** One append-once stream entry: the welcome block or a settled frame. */
type StreamItem = Frame | { kind: 'welcome'; status: StatusInfo | undefined }

export function SessionStream({
  items,
  live,
  expandedOutput,
}: {
  /** The welcome block and settled frames, appended once into the terminal scrollback. */
  items: StreamItem[]
  /** The frames awaiting updates (plus the latest frame), redrawn above the input bar. */
  live: readonly Frame[]
  /** Whether truncated tool outputs render in full. */
  expandedOutput: boolean
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {item => item.kind === 'welcome'
          ? (
            <Box key="welcome" flexDirection="column" marginBottom={1}>
              <WelcomeBlock status={item.status} />
            </Box>
          )
          : (
            <Box key={frameKey(item)} flexDirection="column" marginBottom={1}>
              <FrameRow frame={item} expandedOutput={false} />
            </Box>
          )}
      </Static>
      {live.map(frame => (
        <Box key={frameKey(frame)} flexDirection="column" marginBottom={1}>
          <FrameRow frame={frame} expandedOutput={expandedOutput} />
        </Box>
      ))}
    </Box>
  )
}

/** Whether a frame can still receive updates and must stay out of the append-only scrollback. */
function frameMutable(frame: Frame): boolean {
  switch (frame.kind) {
    case 'user':
    case 'notice':
      return false
    case 'assistant':
      return frame.streaming
    case 'tool':
      return frame.result === undefined && frame.resultContent === undefined
    case 'command':
      return frame.done === undefined
  }
}

function frameKey(frame: Frame): string {
  switch (frame.kind) {
    case 'user':
    case 'assistant':
    case 'notice':
      return `${frame.kind}:${frame.seq}`
    case 'tool':
      return `${frame.kind}:${frame.callId}`
    case 'command':
      return `${frame.kind}:${frame.commandId}`
  }
}

function FrameRow({ frame, expandedOutput }: { frame: Frame; expandedOutput: boolean }): React.JSX.Element {
  switch (frame.kind) {
    case 'user':
      return <Text><Text color="magenta">❯ </Text>{frame.text}</Text>
    case 'notice':
      return (
        <Box flexDirection="column">
          <Text><Text color="green">●</Text> {frame.summary}</Text>
          {frame.body === undefined ? null : <IndentedBlock text={trimNewline(frame.body)} expanded={expandedOutput} />}
        </Box>
      )
    case 'assistant': {
      const lines = frame.text.split('\n')
      // The marker sits on the first non-empty line; leading empty lines
      // (models often open a stream with a newline) render nothing at all.
      const first = lines.findIndex(line => line !== '')
      return (
        <Box flexDirection="column">
          {frame.thinking !== undefined ? <ThinkingBlock thinking={frame.thinking} /> : null}
          {first === -1 ? null : lines.slice(first).map((line, index) => {
            const heading = headingText(line)
            const content = heading ?? line
            return (
              <Text key={index}>
                {index === 0 ? '● ' : '  '}
                {heading !== undefined
                  ? <Text bold>{content}</Text>
                  : inlineSegments(content).map((segment, i) => segment.bold
                    ? <Text key={i} bold>{segment.text}</Text>
                    : segment.code
                      ? <Text key={i} color="#a5d8ff">{segment.text}</Text>
                      : segment.text)}
              </Text>
            )
          })}
        </Box>
      )
    }
    case 'tool':
      return <ToolRow frame={frame} expandedOutput={expandedOutput} />
    case 'command':
      return <CommandRow frame={frame} />
  }
}

/** How many reasoning lines the fixed thought window shows (the latest ones). */
const THOUGHT_WINDOW_LINES = 5

/** Wrap a line into physical rows of at most `width` columns; short lines pass through. */
function wrapLine(line: string, width: number): readonly string[] {
  if (line.length <= width) return [line]
  const rows: string[] = []
  for (let offset = 0; offset < line.length; offset += width) {
    rows.push(line.slice(offset, offset + width))
  }
  return rows
}

/** The fixed reasoning window: `● Thought for Ns`, then a bordered box with the latest rows, kept after thinking ends. */
function ThinkingBlock({
  thinking,
}: {
  thinking: Extract<Frame, { kind: 'assistant' }>['thinking'] & object
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
      <Text>● Thought for {thinking.seconds}s</Text>
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

/** The standing todo plan as a checklist panel above the stream. */
function PlanPanel({ todos }: { todos: FrameState['plan'] & object }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text><Text color="green">●</Text> todolist进行中...</Text>
      {todos.map((todo, index) => {
        const mark = todo.status === 'completed'
          ? <Text color="green">✔</Text>
          : todo.status === 'in_progress'
            ? <Text color="#a5d8ff">◼</Text>
            : <Text dimColor>◻</Text>
        // The first line carries the `⎿` connector; continuations align under
        // its text (`⎿` is one cell wide, so `  ⎿  ` is five display columns).
        // Dim covers only the content text: dim inherits into nested Text, so
        // a dim row wrapper would also mute the colored status markers.
        const prefix = index === 0 ? '  ⎿  ' : '     '
        return <Text key={index}>{prefix}{mark} <Text dimColor>{todo.content}</Text></Text>
      })}
    </Box>
  )
}

/** The step heartbeat: one label for the whole step — the model call and its tool executions. */
function HeartbeatLine({ startedAt }: { startedAt: number }): React.JSX.Element {
  // One blank row of breathing room between the heartbeat and the input bar.
  return (
    <Box marginBottom={1}>
      <Text>
        <Text color="#a5d8ff">✢</Text> Running… <Text dimColor>({formatElapsed(Date.now() - startedAt)})</Text>
      </Text>
    </Box>
  )
}

/** One tool call card: the pending call view, then the completed result view. */
function ToolRow({ frame, expandedOutput }: { frame: Extract<Frame, { kind: 'tool' }>; expandedOutput: boolean }): React.JSX.Element {
  const completed = frame.result !== undefined || frame.resultContent !== undefined
  return (
    <Box flexDirection="column">
      <ToolCallView frame={frame} />
      {completed ? <ToolResultView frame={frame} expandedOutput={expandedOutput} /> : null}
    </Box>
  )
}

/** The Claude Code-style call line: a green dot, then the tool name in the default foreground. */
function ToolCallView({ frame }: { frame: Extract<Frame, { kind: 'tool' }> }): React.JSX.Element {
  const call = frame.call
  const label = toolLabel(frame.name)
  const invocation = call.card === 'diff'
    ? call.diffs.map(diff => `${diff.path}${diff.oldText === null ? ' (new)' : ''}`).join(', ')
    // Generic titles often start with the tool name (`Read /tmp/test.txt`);
    // strip it so the label on the left is not repeated.
    : call.title.startsWith(`${label} `) ? call.title.slice(label.length + 1) : call.title
  return (
    <Text>
      <Text color="green">●</Text> {label}
      ({invocation})
    </Text>
  )
}

function ToolResultView({
  frame,
  expandedOutput,
}: {
  frame: Extract<Frame, { kind: 'tool' }>
  expandedOutput: boolean
}): React.JSX.Element {
  const result = frame.result
  if (result === undefined) {
    const text = contentToText(frame.resultContent ?? [])
    return text === '' ? <></> : <IndentedBlock text={trimNewline(text)} expanded={expandedOutput} />
  }
  switch (result.card) {
    case 'terminal':
      return result.output !== undefined && result.output !== ''
        ? <IndentedBlock text={trimNewline(result.output)} expanded={expandedOutput} />
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
          {visible.map(row => row.sign === undefined
            ? <Text key={row.key} dimColor>  {row.text}</Text>
            : <Text key={row.key} color={row.sign === '+' ? 'green' : 'red'}>  {row.sign} {row.text}</Text>)}
          {!expandedOutput && hidden > 0 ? <Text dimColor>  … {hidden} more lines (ctrl+o to expand)</Text> : null}
        </Box>
      )
    }
    case 'generic': {
      const text = contentToText(result.content ?? frame.resultContent ?? [])
      return text === '' ? <></> : <IndentedBlock text={trimNewline(text)} expanded={expandedOutput} />
    }
    case 'read': {
      const endOfFile = result.lines.at(-1)?.number === result.totalLines
      const hidden = result.lines.length - TRUNCATED_OUTPUT_LINES
      const visible = expandedOutput || hidden <= 0 ? result.lines : result.lines.slice(0, TRUNCATED_OUTPUT_LINES)
      return (
        <Box flexDirection="column">
          {visible.map(line => (
            <Text key={line.number} dimColor>  {line.number}: {line.text}</Text>
          ))}
          {!expandedOutput && hidden > 0 ? <Text dimColor>  … {hidden} more lines (ctrl+o to expand)</Text> : null}
          {endOfFile && (expandedOutput || hidden <= 0) ? <Text dimColor>  (End of file)</Text> : null}
        </Box>
      )
    }
    // search/web views carry no text payload; fall back to the raw result content.
    case 'search':
    case 'web': {
      const text = contentToText(frame.resultContent ?? [])
      return text === '' ? <></> : <IndentedBlock text={trimNewline(text)} expanded={expandedOutput} />
    }
  }
}

/** The tool's display label, capitalized like Claude Code's tool names. */
function toolLabel(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/** How many output lines render before truncation with an expand hint. */
const TRUNCATED_OUTPUT_LINES = 6

/** The Claude Code-style output block: one `⎿` connector, then aligned lines, truncated with an expand hint. */
function IndentedBlock({ text, expanded }: { text: string; expanded: boolean }): React.JSX.Element {
  const lines = text.split('\n')
  const hidden = lines.length - TRUNCATED_OUTPUT_LINES
  if (!expanded && hidden > 0) {
    const visible = lines.slice(0, TRUNCATED_OUTPUT_LINES)
    return (
      <Box flexDirection="column">
        {visible.map((line, index) => <Text key={index} dimColor>{connector(index, line)}</Text>)}
        <Text dimColor>     … {hidden} more lines (ctrl+o to expand)</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => <Text key={index} dimColor>{connector(index, line)}</Text>)}
    </Box>
  )
}

/**
 * The first output line carries the `⎿` connector; continuation lines align
 * under its text. `⎿` renders one cell wide, so `  ⎿  ` is five display
 * columns and continuations take five spaces.
 */
function connector(index: number, line: string): string {
  return index === 0 ? `  ⎿  ${line}` : `     ${line}`
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

/** Split newline-terminated content without a phantom trailing empty line. */
function splitLines(text: string): readonly string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Minimal old/new line listing; real diff rendering stays a later milestone. */
function inlineDiffLines(oldText: string, newText: string): readonly { sign: '+' | '-'; text: string }[] {
  return [
    ...splitLines(oldText).map(line => ({ sign: '-' as const, text: line })),
    ...splitLines(newText).map(line => ({ sign: '+' as const, text: line })),
  ]
}

function trimNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

/** The multiline input editor: typing, cursor, history, Enter/Ctrl+J/Ctrl+C/Ctrl+D. */
export function InputBar({
  handlers,
  approvalPending,
  approvalSelected,
  onToggleExpand,
  onApprovalSelect,
  history = [],
  focusMode = 'input',
  panelAvailable = false,
}: {
  handlers: InputHandlers
  approvalPending: boolean
  /** The arrow-selected approval option, committed by Enter. */
  approvalSelected: number
  /** Toggle long tool outputs between truncated and full (the `l` key). */
  onToggleExpand: () => void
  /** Move the arrow selection of the pending approval question. */
  onApprovalSelect: (delta: number) => void
  /** The session's submitted lines; the arrows browse them (log-restored on resume). */
  history?: readonly string[]
  /** Which surface owns the keys; the panel and child view borrow them from the editor. */
  focusMode?: 'input' | 'panel' | 'child'
  /** Whether the subagent panel has rows, so `↓` from an empty editor can enter it. */
  panelAvailable?: boolean
}): React.JSX.Element {
  // A ref mirror keeps the key handler's reads fresh even when several keys
  // land inside one render cycle (ink throttles re-renders).
  const bufferRef = React.useRef({ value: '', cursor: 0 })
  const [buffer, setBufferState] = useState(bufferRef.current)
  const historyRef = React.useRef<readonly string[]>(history)
  // The session log is the authority: the driver mounts this bar before the
  // replay folds, so the effect adopts the restored lines as they land in the
  // frames (live commits are already in the log by the time frames change).
  React.useEffect(() => {
    historyRef.current = history
  }, [history])
  const [historyIndex, setHistoryIndex] = useState(-1)
  // Two Ctrl+C presses within a second (with an empty buffer) quit.
  const lastInterruptRef = React.useRef(0)

  const setBuffer = (next: { value: string; cursor: number }): void => {
    bufferRef.current = next
    setBufferState(next)
  }

  useInput((input, key) => {
    const { value, cursor } = bufferRef.current
    if (approvalPending) {
      // The pending question owns the keys: y allows, n and Esc reject, the
      // arrows move the selection, Enter commits it; everything else waits.
      if (input === 'y') handlers.onApproval(true)
      if (input === 'n') handlers.onApproval(false)
      if (key.escape) handlers.onApproval(false)
      if (key.upArrow) onApprovalSelect(-1)
      if (key.downArrow) onApprovalSelect(1)
      if (key.return) handlers.onApproval(approvalSelected === 0)
      return
    }
    if (focusMode === 'child') {
      // The child transcript is read-only: Esc returns to the input bar.
      if (key.escape) handlers.onPanelBack()
      return
    }
    if (focusMode === 'panel') {
      // The panel owns the arrows, Enter (open the selected row), and Esc.
      if (key.upArrow) handlers.onPanelMove(-1)
      else if (key.downArrow) handlers.onPanelMove(1)
      else if (key.return) handlers.onPanelEnter()
      else if (key.escape) handlers.onPanelBack()
      return
    }
    if (key.escape) {
      // Esc interrupts the running turn; it never quits.
      handlers.onInterrupt()
      return
    }
    if (key.ctrl && input === 'c') {
      if (value !== '') {
        setBuffer({ value: '', cursor: 0 })
        return
      }
      const now = Date.now()
      if (now - lastInterruptRef.current < 1000) {
        handlers.onExit()
      } else {
        lastInterruptRef.current = now
        handlers.onInterrupt()
      }
      return
    }
    if (key.ctrl && input === 'd') {
      handlers.onExit()
      return
    }
    if (key.return) {
      const text = value.trim()
      if (text === '') return
      historyRef.current = [...historyRef.current, text]
      setHistoryIndex(-1)
      setBuffer({ value: '', cursor: 0 })
      handlers.onCommit(text)
      return
    }
    if (input === '\n') {
      // Ctrl+J: a literal newline. Alt+Enter is not distinguishable from
      // Enter on common terminals, so the newline key is the multiline input.
      setBuffer({ value: value.slice(0, cursor) + '\n' + value.slice(cursor), cursor: cursor + 1 })
      return
    }
    if (key.leftArrow) { setBuffer({ value, cursor: Math.max(0, cursor - 1) }); return }
    if (key.rightArrow) { setBuffer({ value, cursor: Math.min(value.length, cursor + 1) }); return }
    if (key.home) { setBuffer({ value, cursor: 0 }); return }
    if (key.end) { setBuffer({ value, cursor: value.length }); return }
    if (key.backspace) {
      if (cursor > 0) setBuffer({ value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 })
      return
    }
    if (key.delete) {
      if (cursor < value.length) setBuffer({ value: value.slice(0, cursor) + value.slice(cursor + 1), cursor })
      return
    }
    if (key.ctrl && input === 'o') {
      // Ctrl+O toggles truncated outputs between truncated and full.
      onToggleExpand()
      return
    }
    const history = historyRef.current
    if (key.upArrow) {
      if (history.length === 0) return
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      const recalled = history[next]
      if (recalled !== undefined) setBuffer({ value: recalled, cursor: recalled.length })
      return
    }
    if (key.downArrow) {
      if (historyIndex < 0) {
        // An empty editor's `↓` enters the subagent panel when it has rows.
        if (value === '' && panelAvailable) handlers.onPanelOpen()
        return
      }
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(-1)
        setBuffer({ value: '', cursor: 0 })
      } else {
        setHistoryIndex(next)
        const recalled = history[next]
        if (recalled !== undefined) setBuffer({ value: recalled, cursor: recalled.length })
      }
      return
    }
    if (input !== '') {
      setBuffer({ value: value.slice(0, cursor) + input + value.slice(cursor), cursor: cursor + input.length })
    }
  })

  const { value, cursor } = buffer
  const lines = value.split('\n')
  const beforeCursor = value.slice(0, cursor)
  const cursorLine = beforeCursor.split('\n').length - 1
  const cursorColumn = beforeCursor.length - beforeCursor.lastIndexOf('\n') - 1
  const width = useTerminalWidth()
  // The child transcript view is read-only: the bar keeps routing Esc but
  // renders nothing, leaving the child transcript as the visible surface.
  if (focusMode === 'child') return <Box />

  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(width)}</Text>
      {lines.map((line, index) => {
        const marked = index === cursorLine
          ? `${line.slice(0, cursorColumn)}▏${line.slice(cursorColumn)}`
          : line
        return (
          <Text key={index}>
            {index === lines.length - 1 ? <Text color="magenta">❯ </Text> : null}
            {marked}
          </Text>
        )
      })}
      <Text dimColor>{'─'.repeat(width)}</Text>
    </Box>
  )
}

/** The terminal columns, with a sane non-TTY fallback. */
function useTerminalWidth(fallback = 80): number {
  const { stdout } = useStdout()
  return typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : fallback
}
