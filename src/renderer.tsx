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
import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { Box, measureElement, Text, render, useInput, usePaste, useStdout } from 'ink'
import stringWidth from 'string-width'
import type { Frame, FrameState } from './frames.ts'
import { createFrameState } from './frames.ts'
import { contentToText, stripOuterCodeFence } from './render.ts'
import {
  containsMouseReport,
  createScrollState,
  CURSOR_HIDE,
  CURSOR_SHOW,
  ENTER_FULLSCREEN,
  EXIT_FULLSCREEN,
  MOUSE_OFF,
  MOUSE_ON,
  mouseEnabled,
  PRE_MEASURE_MARGIN,
  scrollReducer,
  transcriptMarginTop,
  wheelDeltaFromInput,
} from './terminal.ts'
import type { ScrollAction } from './terminal.ts'

/** The user's answer to a pending approval question. */
export type ApprovalChoice = 'allow' | 'reject' | 'cancel'

/** Callbacks the input bar hands to the driver. */
export interface InputHandlers {
  /** Submit one user line (Enter on a non-empty buffer). */
  onCommit(text: string): void
  /** Clear the buffer (Ctrl+C with content), or interrupt the turn when empty. */
  onInterrupt(): void
  /** Answer a pending approval request: y/Enter allow, n/Enter reject, Esc cancels. */
  onApproval(choice: ApprovalChoice): void
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

/** A transient surface message (above the input bar) or the bottom approval question. */
export type Overlay =
  | { kind: 'notice'; text: string }
  | {
    kind: 'approval'
    toolName: string
    reason?: string
    /** The invocation summary of the exact tool call being decided (the pending
     *  frame's card title — the command itself for terminal cards). */
    detail?: string
    /** The decided call's id, when the asker had one: the transcript dims that
     *  pending card's dot while the question waits. */
    callId?: string
  }

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
/** One Agent Teams member row for the team panel roster. */
export interface TeamMemberRow {
  name: string
  description: string
  /** The durable membership phase: provisioning, active, or failed. */
  phase: string
  /** The member's latest visible activity, enriched from its live child fold; absent when not running. */
  activity?: string
  /** When the member's run began; absent when it is not a live child. */
  startedAt?: number
  /** The member's reported input tokens; absent when it is not a live child. */
  inputTokens?: number
}

/** One shared task row for the team panel task board. */
export interface TeamTaskRow {
  subject: string
  /** The task status: pending, in_progress, or completed. */
  status: string
  /** The claiming member's name; absent when unowned. */
  ownerName?: string
  /** Whether an incomplete blocker keeps the task from being claimable. */
  blocked: boolean
}

/** The team roster and task board, read from the authoritative agentTeam projection. */
export interface TeamPanelInfo {
  members: readonly TeamMemberRow[]
  tasks: readonly TeamTaskRow[]
}

/** One registered slash command for the input bar's completion menu. */
export interface CommandInfo {
  /** Command name without the leading slash. */
  name: string
  /** Human-readable summary for the discovery menu. */
  description?: string
  /** Free-form input hint (e.g. `<preset>`), shown after the name. */
  hint?: string
}

export interface RenderView {
  overlay?: Overlay
  status?: StatusInfo
  /** Registered slash commands; drives the `/` completion menu. */
  commands?: readonly CommandInfo[]
  /** The unfinished direct subagents; absent or empty hides the panel. */
  subagents?: readonly SubagentRow[]
  /** The panel's selected row (0 = the main agent row); absent means the input bar holds focus. */
  subagentSelected?: number
  /** The child transcript opened from the panel; replaces the input region while set. */
  openSubagent?: OpenSubagent
  /** The Agent Teams roster and task board; absent hides the team panel. */
  team?: TeamPanelInfo
  /** The selected team-member row; absent means the team panel is not focused. */
  teamSelected?: number
  /** Follow-ups submitted while a step was in flight; shown immediately as queued until their durable echo lands. */
  pendingUser?: readonly PendingUserEcho[]
}

/** One follow-up submitted while the agent was busy: echoed at once, marked queued. */
export interface PendingUserEcho {
  /** The message id, used to drop the echo when its durable user/message event lands. */
  id: string
  /** The submitted text. */
  text: string
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

/**
 * Take over the terminal for the fullscreen surface: enter the alternate
 * screen and (unless opted out) enable SGR mouse tracking so the wheel scrolls
 * the transcript. Returns the idempotent restore, also wired to the process
 * `exit` event so a crash or an external kill never strands the user in the
 * alternate screen with mouse tracking on.
 */
function beginFullscreenTakeover(): (() => void) | undefined {
  if (!process.stdout.isTTY) return undefined
  // The cursor hide rides with the takeover instead of waiting for ink's
  // first flushed render: a slow session resume would otherwise leave the
  // shell cursor blinking on the blank alternate screen for seconds.
  process.stdout.write(ENTER_FULLSCREEN + CURSOR_HIDE)
  const mouse = mouseEnabled()
  if (mouse) process.stdout.write(MOUSE_ON)
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    if (mouse) process.stdout.write(MOUSE_OFF)
    process.stdout.write(CURSOR_SHOW + EXIT_FULLSCREEN)
  }
  process.on('exit', restore)
  return () => {
    process.off('exit', restore)
    restore()
  }
}

/** The ink terminal view the driver drives: stream, status, and input bar. */
export function createInkRenderer(): TuiRenderer {
  // The takeover precedes the first render so ink's initial frame already
  // paints inside the alternate screen.
  const restoreTerminal = beginFullscreenTakeover()
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
      // Unmount first: ink's teardown repaints once inside the alternate
      // screen, then the restore hands the terminal back to the user.
      app.unmount()
      restoreTerminal?.()
    },
  }
}

/** Transcript frames beyond this render cap are elided with a hint row. */
const MAX_RENDERED_FRAMES = 300

/** Keep the last `cap` frames, reporting how many earlier ones are elided. */
function windowFrames(frames: readonly Frame[]): { hidden: number; visible: readonly Frame[] } {
  const visible = frames.slice(-MAX_RENDERED_FRAMES)
  return { hidden: frames.length - visible.length, visible }
}

/**
 * The whole terminal surface: a scrollable transcript window filling the
 * viewport above a fixed chrome band. Everything renders inside the alternate
 * screen at exactly `rows` height — ink never overflows, so its clear-the-
 * scrollback fallback is structurally unreachable; wheel/PageUp scroll the
 * transcript through the measured `scrollTop` model in terminal.ts.
 */
export function TuiApp({
  state,
  handlers,
  view,
  viewportRows,
}: {
  state: FrameState
  handlers: InputHandlers
  view?: RenderView
  /** Viewport height override for tests (ink-testing-library has no rows). */
  viewportRows?: number
}): React.JSX.Element {
  const [expandedOutput, setExpandedOutput] = useState(false)
  // One-way latch: the welcome splash disappears as soon as typing starts and
  // never returns for the rest of this session.
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  // The arrow-selected approval option; resets per question via the overlay key.
  const [approvalIndex, setApprovalIndex] = useState(0)
  const onApprovalSelect = (delta: number): void => {
    setApprovalIndex(current => Math.min(1, Math.max(0, current + delta)))
  }
  const { columns, rows: termRows } = useTerminalSize()
  const rows = viewportRows ?? termRows
  const frames = state.frames
  // The arrow-browsed history: the session's submitted user lines, so a
  // resumed session restores its past inputs from the replayed log.
  const history = frames
    .filter((frame): frame is Extract<Frame, { kind: 'user' }> => frame.kind === 'user')
    .map(frame => frame.text)
  const subagents = view?.subagents ?? []
  const opened = view?.openSubagent
  // The pending approval question, when one owns the screen bottom: the input
  // bar, status bar, and side panels all yield to the ApprovalPanel below.
  const approvalOverlay = view?.overlay?.kind === 'approval' ? view.overlay : undefined
  const focusMode: 'input' | 'panel' | 'child' = opened !== undefined
    ? 'child'
    : view?.subagentSelected !== undefined || view?.teamSelected !== undefined ? 'panel' : 'input'

  // ---- Transcript scroll state ---------------------------------------
  // The transcript is the app's own data (no terminal scrollback): the
  // window clips a bottom-anchored content column, and `marginTop` slides it
  // through the window. Heights come from measureElement after layout — no
  // width/wrapping estimation anywhere. offset 0 = sticky at the live bottom.
  const [scroll, dispatch] = useReducer(scrollReducer, undefined, createScrollState)
  const windowRef = useRef<any>(null)
  const contentRef = useRef<any>(null)
  // Measure the laid-out window and content after every commit and adopt the
  // heights when they changed. A layout effect (not a passive one) so the
  // corrective render converges in the same tick instead of flashing a
  // mis-anchored frame; the reducer returns identical state on equal
  // measurements so this loop terminates.
  useLayoutEffect(() => {
    const win = windowRef.current
    const content = contentRef.current
    if (win === null || content === null) return
    const measuredWindow = measureElement(win)
    const measuredContent = measureElement(content)
    if (measuredContent.height !== scroll.contentRows || measuredWindow.height !== scroll.windowRows) {
      dispatch({ type: 'measure', contentRows: measuredContent.height, windowRows: measuredWindow.height })
    }
  })

  // The child view swaps the transcript source (header + the child's frames);
  // scroll position resets on enter/exit. The pinned plan in the chrome band
  // follows the active view — the main session's plan, or the opened child's.
  const mainWindowed = windowFrames(frames)
  const childWindowed = opened === undefined ? undefined : windowFrames(opened.state.frames)
  const activePlan = opened === undefined ? state.plan : opened.state.plan
  const transcriptKey = opened === undefined ? 'main' : opened.childId
  useLayoutEffect(() => {
    dispatch({ type: 'reset' })
  }, [transcriptKey])

  // The welcome block is the opening splash of a fresh session: centered in
  // the window while the transcript is empty, dismissed for good the moment
  // the user starts typing — it never returns this session, and a resumed
  // session (frames replayed) never shows it at all.
  const showWelcome = opened === undefined && frames.length === 0 && !welcomeDismissed
  // The window height for the splash's very first paint, before the measure
  // pass lands: a fresh session's chrome is exactly the input bar (two rules
  // plus one buffer row) and, once known, the status bar — so the splash is
  // centered from frame one instead of flashing above center until measured.
  const welcomeChromeRows = 3 + (view?.status !== undefined ? (view.status.mode !== undefined ? 2 : 1) + 1 : 0)
  const welcomeWindowRows = scroll.windowRows > 0 ? scroll.windowRows : Math.max(3, rows - welcomeChromeRows)
  const transcript = opened === undefined ? (
    showWelcome ? (
      <Box
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        minHeight={welcomeWindowRows}
      >
        <WelcomeBlock status={view?.status} />
      </Box>
    ) : (
      <>
        {mainWindowed.hidden > 0 ? <Text dimColor>… {mainWindowed.hidden} earlier frames</Text> : null}
        {mainWindowed.visible.map(frame => (
          <Box key={frameKey(frame)} flexDirection="column" marginBottom={1}>
            <FrameRow frame={frame} expandedOutput={expandedOutput} approvalCallId={approvalOverlay?.callId} />
          </Box>
        ))}
      </>
    )
  ) : (
    <>
      {(childWindowed?.hidden ?? 0) > 0 ? <Text dimColor>… {childWindowed?.hidden} earlier frames</Text> : null}
      {(childWindowed?.visible ?? []).map(frame => (
        <Box key={frameKey(frame)} flexDirection="column" marginBottom={1}>
          <FrameRow frame={frame} expandedOutput={expandedOutput} approvalCallId={approvalOverlay?.callId} />
        </Box>
      ))}
    </>
  )

  return (
    <Box flexDirection="column" height={rows}>
      {/* The scroll window: fixed height, overflow clipped; the content
          column slides through it via the measured marginTop. Before the
          first measurement the welcome splash centers through its static
          minHeight (margin 0), while a frames transcript parks above the
          window — it appears bottom-anchored directly instead of flashing
          top-aligned and jumping down when the measure pass lands. */}
      <Box ref={windowRef} flexGrow={1} minHeight={3} overflow="hidden" flexDirection="column">
        <Box
          ref={contentRef}
          flexDirection="column"
          flexShrink={0}
          marginTop={scroll.windowRows === 0 || scroll.contentRows === 0
            ? (showWelcome ? 0 : PRE_MEASURE_MARGIN)
            : transcriptMarginTop(scroll)}
        >
          {transcript}
        </Box>
      </Box>
      {/* The fixed chrome band below the transcript. */}
      <Box flexDirection="column" flexShrink={0}>
        {/* Follow-ups queued behind a running step echo immediately (dimmed, no
            committed background) so the submission is never silently swallowed;
            each is dropped once its durable user/message frame lands above. */}
        {view?.pendingUser !== undefined && view.pendingUser.length > 0
          ? <PendingUserEchoes items={view.pendingUser} />
          : null}
        {view?.overlay?.kind === 'notice'
          ? <Text color="red" key="notice">{view.overlay.text}</Text>
          : null}
        {/* The standing plan stays pinned above the input bar in every view;
            it follows the active transcript (main session or opened child). */}
        {activePlan !== undefined ? <PlanPanel todos={activePlan} /> : null}
        {/* The step heartbeat sits below the plan and above the input bar:
            shown throughout a step — its tool executions included — while an
            approval overlay waits on the user. */}
        {opened === undefined && view?.overlay === undefined
          && state.turnStartedAt !== undefined
          ? <HeartbeatLine startedAt={state.turnStartedAt} tokens={state.turnTokens} />
          : null}
        {/* The input bar stays mounted in every focus mode — it owns the single
            stdin listener; in the child view it renders nothing and only routes
            Esc back to the input focus. */}
        <InputBar
          handlers={handlers}
          approvalPending={approvalOverlay !== undefined}
          approvalSelected={approvalIndex}
          onToggleExpand={() => { setExpandedOutput(current => !current) }}
          onApprovalSelect={onApprovalSelect}
          onScroll={dispatch}
          onFirstInput={() => { setWelcomeDismissed(true) }}
          history={history}
          focusMode={focusMode}
          panelAvailable={subagents.length > 0 || (view?.team?.members.length ?? 0) > 0}
          commands={view?.commands ?? []}
          {...(view?.status === undefined ? {} : { status: view.status })}
        />
        {approvalOverlay !== undefined ? (
          /* The question owns the screen bottom: the bar above rendered
             nothing, and the side panels and child header wait it out. */
          <ApprovalPanel key={approvalKey(approvalOverlay)} overlay={approvalOverlay} selected={approvalIndex} width={columns} />
        ) : opened === undefined ? (
          <>
            {subagents.length > 0
              ? <SubagentPanel rows={subagents} selected={view?.subagentSelected} />
              : null}
            {view?.team !== undefined ? <TeamPanel team={view.team} selected={view.teamSelected} /> : null}
          </>
        ) : (
          /* The child view's identity header pins at the very bottom: it is
             standing context (which subagent, how to return), not transcript
             content — inside the window it would be clipped at the live bottom
             and covered by the scroll indicator at the top. */
          <>
            <Text dimColor>{'─'.repeat(columns)}</Text>
            <Box justifyContent="center">
              <Text>
                subagent: <Text bold>{opened.label}</Text> <Text dimColor>(Esc 返回)</Text>
              </Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  )
}

/** Panel rows beyond this cap are elided with a hint row, keeping the chrome
 *  band bounded; the window follows the arrow selection. */
const PANEL_MAX_ROWS = 8

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
  // The main row always shows; the subagent rows window around the selection
  // (latest rows when unselected) once they exceed the cap.
  const selectedSub = selected === undefined || selected === 0 ? undefined : selected - 1
  const start = rows.length <= PANEL_MAX_ROWS
    ? 0
    : selectedSub === undefined
      ? rows.length - PANEL_MAX_ROWS
      : Math.min(Math.max(0, selectedSub - Math.floor(PANEL_MAX_ROWS / 2)), rows.length - PANEL_MAX_ROWS)
  const visible = rows.slice(start, start + PANEL_MAX_ROWS)
  const hiddenAfter = rows.length - start - visible.length
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(width)}</Text>
      {start > 0 ? <Text dimColor>  … {start} more</Text> : null}
      {[undefined, ...visible].map((row, index) => {
        const isSelected = row === undefined ? selected === 0 : selected === start + index
        const marker = isSelected ? '●' : '◯'
        // Clamp the label so a long delegation description cannot wrap the
        // row past one physical line and eat the transcript window's height.
        const label = truncateToWidth(row === undefined ? 'main' : row.label, Math.max(4, Math.floor(width * 0.4)))
        const elapsed = row === undefined
          ? ''
          : `${formatElapsed(Date.now() - row.startedAt)} · ↓ ${formatTokenCount(row.inputTokens)} tokens`
        // Clamp the activity so the row stays on one line with a clear gap
        // before the right-aligned elapsed/tokens: the smaller of (terminal
        // width minus label/elapsed/spacing) and PANEL_ACTIVITY_RATIO of width.
        const budget = Math.min(width - stringWidth(label) - stringWidth(elapsed) - 5, Math.floor(width * PANEL_ACTIVITY_RATIO))
        const activity = row !== undefined && row.activity !== undefined
          ? truncateToWidth(row.activity, Math.max(0, budget))
          : undefined
        return (
          <Box key={row === undefined ? 'main' : row.childId}>
            <Text>{isSelected ? <Text color="#51cf66">{marker}</Text> : <Text dimColor>{marker}</Text>}</Text>
            <Text> </Text>
            <Text bold={isSelected}>{label}</Text>
            {activity !== undefined && activity !== '' ? <Text dimColor>  {activity}</Text> : null}
            <Box flexGrow={1} />
            {row === undefined ? null : <Text dimColor>{elapsed}</Text>}
          </Box>
        )
      })}
      {hiddenAfter > 0 ? <Text dimColor>  … {hiddenAfter} more</Text> : null}
    </Box>
  )
}

/** The Agent Teams roster and shared task board, read from the agentTeam projection. */
function TeamPanel({ team, selected }: { team: TeamPanelInfo; selected: number | undefined }): React.JSX.Element {
  const width = useTerminalWidth()
  // Members window around the selection (roster head when unselected); tasks
  // keep their reading order from the top. Both cap at PANEL_MAX_ROWS so the
  // chrome band stays bounded.
  const start = team.members.length <= PANEL_MAX_ROWS || selected === undefined
    ? 0
    : Math.min(Math.max(0, selected - Math.floor(PANEL_MAX_ROWS / 2)), team.members.length - PANEL_MAX_ROWS)
  const visibleMembers = team.members.slice(start, start + PANEL_MAX_ROWS)
  const hiddenMembers = team.members.length - visibleMembers.length
  const visibleTasks = team.tasks.slice(0, PANEL_MAX_ROWS)
  const hiddenTasks = team.tasks.length - visibleTasks.length
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(width)}</Text>
      <Text>
        Teammates · {team.members.length}
        {selected !== undefined ? <Text dimColor>  (↑↓ 选择 · Enter 打开 · ↑/Esc 返回)</Text> : null}
      </Text>
      {visibleMembers.map((member, index) => {
        const isSelected = selected === start + index
        const marker = isSelected ? '●' : '◯'
        // Clamp the name so a long member name cannot wrap the row past one line.
        const name = truncateToWidth(member.name, Math.max(4, Math.floor(width * 0.3)))
        const elapsed = member.startedAt !== undefined
          ? `${formatElapsed(Date.now() - member.startedAt)} · ↓ ${formatTokenCount(member.inputTokens ?? 0)} tokens`
          : ''
        // Clamp the activity so the row stays on one line with a clear gap
        // before the right-aligned elapsed/tokens: the smaller of (terminal
        // width minus name/elapsed/spacing) and PANEL_ACTIVITY_RATIO of width.
        const budget = Math.min(width - stringWidth(name) - stringWidth(elapsed) - 7, Math.floor(width * PANEL_ACTIVITY_RATIO))
        const activity = member.activity !== undefined
          ? truncateToWidth(member.activity, Math.max(0, budget))
          : undefined
        return (
          <Box key={member.name}>
            {/* Two-space indent aligns the member marker under the task marker. */}
            <Text>  </Text>
            <Text>{isSelected ? <Text color="#51cf66">{marker}</Text> : <Text dimColor>{marker}</Text>}</Text>
            <Text> </Text>
            {member.phase === 'failed'
              ? <Text bold={isSelected} color="red">{name}</Text>
              : member.phase === 'provisioning'
                ? <Text bold={isSelected} color="yellow">{name}</Text>
                : <Text bold={isSelected}>{name}</Text>}
            {activity !== undefined && activity !== '' ? <Text dimColor>  {activity}</Text> : null}
            <Box flexGrow={1} />
            {elapsed !== '' ? <Text dimColor>{elapsed}</Text> : null}
          </Box>
        )
      })}
      {hiddenMembers > 0 ? <Text dimColor>  … {hiddenMembers} more</Text> : null}
      {team.tasks.length > 0 ? (
        <>
          <Text>Tasks · {team.tasks.length}</Text>
          {visibleTasks.map((task, index) => {
            const mark = task.status === 'completed'
              ? <Text color="green">✔</Text>
              : task.status === 'in_progress'
                ? <Text color="#a5d8ff">◼</Text>
                : task.blocked
                  ? <Text dimColor>⊘</Text>
                  : <Text dimColor>◻</Text>
            const meta = `(${task.ownerName ?? 'unowned'} · ${task.status})`
            // Clamp the subject so the task row stays one physical line.
            const subject = truncateToWidth(task.subject, Math.max(4, width - stringWidth(meta) - 6))
            return (
              <Box key={index}>
                <Text>  {mark} {subject} </Text>
                <Text dimColor>{meta}</Text>
              </Box>
            )
          })}
          {hiddenTasks > 0 ? <Text dimColor>  … {hiddenTasks} more</Text> : null}
        </>
      ) : null}
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

/** Remount the panel per approval request so the selection resets. */
function approvalKey(overlay: Extract<Overlay, { kind: 'approval' }>): string {
  return `approval:${overlay.toolName}:${overlay.reason ?? ''}:${overlay.detail ?? ''}`
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
function ApprovalPanel({
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
            {status.effort !== undefined ? `● effort: ${status.effort}` : ''}
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

/** Lines one queued echo shows before eliding the rest with a hint row. */
const ECHO_MAX_LINES = 3

/**
 * The optimistic echoes of follow-ups submitted while a step was in flight.
 * Rendered dimmed and without the committed user background so a queued message
 * reads as pending; each is removed once its durable user/message frame lands
 * in the transcript above. Echoes cap at ECHO_MAX_LINES so a pasted follow-up
 * cannot squeeze the transcript window.
 */
function PendingUserEchoes({ items }: { items: readonly PendingUserEcho[] }): React.JSX.Element {
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
            <Text dimColor>  (queued — runs when the current turn ends)</Text>
          </Box>
        )
      })}
    </Box>
  )
}

function frameKey(frame: Frame): string {
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

function FrameRow({ frame, expandedOutput, approvalCallId }: { frame: Frame; expandedOutput: boolean; approvalCallId: string | undefined }): React.JSX.Element {
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
      return (
        <Box flexDirection="column">
          {frame.thinking !== undefined ? <ThinkingBlock thinking={frame.thinking} /> : null}
          {first === -1 ? null : assistantContent(lines.slice(first))}
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

/** Todos beyond this cap are elided with a hint row, keeping the chrome band
 *  bounded so the transcript window always keeps a usable height. */
const PLAN_MAX_TODOS = 10

/** The standing todo plan as a checklist panel above the stream; the tail
 *  (most recent) todos win when the list exceeds the cap. */
function PlanPanel({ todos }: { todos: FrameState['plan'] & object }): React.JSX.Element {
  const hidden = Math.max(0, todos.length - PLAN_MAX_TODOS)
  const visible = todos.slice(-PLAN_MAX_TODOS)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text><Text color="#51cf66">●</Text> Todo list</Text>
      {hidden > 0 ? <Text dimColor>  ⎿  … {hidden} earlier</Text> : null}
      {visible.map((todo, index) => {
        const mark = todo.status === 'completed'
          ? <Text color="green">✔</Text>
          : todo.status === 'in_progress'
            ? <Text color="#a5d8ff">◼</Text>
            : <Text dimColor>◻</Text>
        // The first line carries the `⎿` connector; continuations align under
        // its text (`⎿` is one cell wide, so `  ⎿  ` is five display columns).
        // The connector is dim like every other connector in the project; dim
        // is scoped to its own Text so it does not mute the colored status
        // markers, and the content text takes its own dim wrapper.
        const prefix = index === 0 && hidden === 0 ? '  ⎿  ' : '     '
        return <Text key={index}><Text dimColor>{prefix}</Text>{mark} <Text dimColor>{todo.content}</Text></Text>
      })}
    </Box>
  )
}


/** The step heartbeat: one label for the whole step — the model call and its tool executions. */
/** Star glyphs cycled in order to animate the heartbeat marker: a smooth
 *  same-family twinkle (bloom out then back), not mixed star shapes. */
const HEARTBEAT_FRAMES = ['✶', '✸', '✹', '✺', '✹', '✸']
const HEARTBEAT_INTERVAL_MS = 120

function HeartbeatLine({ startedAt, tokens }: { startedAt: number; tokens: number | undefined }): React.JSX.Element {
  // Self-driven animation: cycle the star glyph on an interval so the heartbeat
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
        <Text color="#a5d8ff">{glyph} Running…</Text> <Text dimColor>({formatElapsed(Date.now() - startedAt)}{tokenNote})</Text>
      </Text>
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

/** The Claude Code-style call line: a green dot (dim while the call waits on
 *  an approval decision), then the tool name in the default foreground. */
function ToolCallView({ frame, expandedOutput, awaitingApproval }: { frame: Extract<Frame, { kind: 'tool' }>; expandedOutput: boolean; awaitingApproval: boolean }): React.JSX.Element {
  const call = frame.call
  const label = toolLabel(frame.name)
  const full = call.card === 'diff'
    ? call.diffs.map(diff => `${diff.path}${diff.oldText === null ? ' (new)' : ''}`).join(', ')
    // Generic titles often start with the tool name (`Read /tmp/test.txt`);
    // strip it so the label on the left is not repeated.
    : call.title.startsWith(`${label} `) ? call.title.slice(label.length + 1) : call.title
  // Keep the call line on one row: clamp the invocation to CALL_WIDTH_RATIO of
  // the terminal width, minus the `● Label(…)` overhead. ctrl+o (expandedOutput)
  // reveals the full invocation, which then wraps normally.
  const budget = Math.floor(useTerminalWidth() * CALL_WIDTH_RATIO) - (stringWidth(label) + 4)
  const invocation = expandedOutput ? full : truncateToWidth(full, budget)
  return (
    <Text>
      {awaitingApproval ? <Text dimColor>●</Text> : <Text color="#51cf66">●</Text>} {label}
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

/** The tool's display label, capitalized like Claude Code's tool names. */
function toolLabel(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/** How many output lines render before truncation with an expand hint. */
const TRUNCATED_OUTPUT_LINES = 6

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
  onScroll,
  onFirstInput,
  history = [],
  focusMode = 'input',
  panelAvailable = false,
  commands = [],
  status,
}: {
  handlers: InputHandlers
  approvalPending: boolean
  /** The arrow-selected approval option, committed by Enter. */
  approvalSelected: number
  /** Toggle long tool outputs between truncated and full (the `l` key). */
  onToggleExpand: () => void
  /** Move the arrow selection of the pending approval question. */
  onApprovalSelect: (delta: number) => void
  /** Scroll the transcript: wheel notches and PageUp/PageDown. */
  onScroll?: (action: ScrollAction) => void
  /** Fired once when the buffer first becomes non-empty (typing or paste). */
  onFirstInput?: () => void
  /** The session's submitted lines; the arrows browse them (log-restored on resume). */
  history?: readonly string[]
  /** Which surface owns the keys; the panel and child view borrow them from the editor. */
  focusMode?: 'input' | 'panel' | 'child'
  /** Whether the subagent panel has rows, so `↓` from an empty editor can enter it. */
  panelAvailable?: boolean
  /** The registered slash commands; a leading-`/` buffer opens the completion menu. */
  commands?: readonly CommandInfo[]
  /** The footer facts; while the completion menu is open it takes this slot. */
  status?: StatusInfo
}): React.JSX.Element {
  // A ref mirror keeps the key handler's reads fresh even when several keys
  // land inside one render cycle (ink throttles re-renders).
  const bufferRef = React.useRef({ value: '', cursor: 0 })
  const [buffer, setBufferState] = useState(bufferRef.current)
  const historyRef = React.useRef<readonly string[]>(history)
  // The session log is the authority once it has caught up: the driver mounts
  // this bar before the replay folds, so the effect adopts the restored lines
  // as they land in the frames. A shorter prop than the local list means the
  // frames lag behind the bar's own optimistic commits (or the harness never
  // echoes them) — adopting it would wipe lines the user just submitted, so
  // the local list wins until the log is at least as long.
  React.useEffect(() => {
    if (history.length >= historyRef.current.length) historyRef.current = history
  }, [history])
  const [historyIndex, setHistoryIndex] = useState(-1)
  // Two Ctrl+C presses within a second (with an empty buffer) quit.
  const lastInterruptRef = React.useRef(0)
  // Slash-menu transient state: the arrow-selected row and the Esc dismissal.
  // Ref mirrors keep key handlers fresh when several keys land inside one
  // throttled render cycle, mirroring the buffer ref's rationale.
  const [menuIndex, setMenuIndexState] = useState(0)
  const menuIndexRef = React.useRef(0)
  const [menuHidden, setMenuHiddenState] = useState(false)
  const menuHiddenRef = React.useRef(false)
  const setMenuIndex = (next: number): void => { menuIndexRef.current = next; setMenuIndexState(next) }
  const setMenuHidden = (next: boolean): void => { menuHiddenRef.current = next; setMenuHiddenState(next) }
  // The slash menu's candidates for a buffer value: the buffer must be typing
  // a command name — a leading slash with no whitespace yet — and match at
  // one prefix. Anything else (space starts the args, Esc dismissal handled
  // by the caller) yields no menu.
  const commandMatchesFor = (value: string): readonly CommandInfo[] =>
    focusMode === 'input' && !approvalPending && value.startsWith('/') && !/\s/.test(value)
      ? commands.filter(command => command.name.startsWith(value.slice(1)))
      : []

  const setBuffer = (next: { value: string; cursor: number }): void => {
    const wasEmpty = bufferRef.current.value === ''
    const changed = bufferRef.current.value !== next.value
    bufferRef.current = next
    setBufferState(next)
    // The welcome splash is dismissed by the first text entering the box.
    if (wasEmpty && next.value !== '') onFirstInput?.()
    // Any edit re-derives the menu: selection falls back to the first match,
    // and an Esc dismissal lifts so filtering can reopen the menu.
    if (changed) { setMenuIndex(0); setMenuHidden(false) }
  }

  useInput((input, key) => {
    // Mouse tracking reports (wheel, clicks) arrive as ordinary input since
    // ink has no mouse support: wheel notches scroll the transcript, every
    // other report is swallowed — none may reach the editor buffer. These run
    // before the approval/panel/child branches so scrolling works everywhere.
    if (containsMouseReport(input)) {
      const delta = wheelDeltaFromInput(input)
      if (delta !== 0) onScroll?.({ type: 'wheel', delta })
      return
    }
    if (key.pageUp) {
      onScroll?.({ type: 'page', delta: 1 })
      return
    }
    if (key.pageDown) {
      onScroll?.({ type: 'page', delta: -1 })
      return
    }
    const { value, cursor } = bufferRef.current
    if (approvalPending) {
      // The pending question owns the keys: y and Enter-on-Yes allow, n and
      // Enter-on-No reject, Esc cancels (the request is withdrawn, distinct
      // from an answered rejection), the arrows move the selection;
      // everything else waits.
      if (input === 'y') handlers.onApproval('allow')
      if (input === 'n') handlers.onApproval('reject')
      if (key.escape) handlers.onApproval('cancel')
      if (key.upArrow) onApprovalSelect(-1)
      if (key.downArrow) onApprovalSelect(1)
      if (key.return) handlers.onApproval(approvalSelected === 0 ? 'allow' : 'reject')
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
    // The open slash menu owns the arrows, Tab/Enter (complete, never commit —
    // executing takes a second Enter on the completed line), and Esc (dismiss
    // the menu only; the buffer stays and the turn is not interrupted). Every
    // other key falls through to normal editing, which re-derives the menu.
    const matches = commandMatchesFor(bufferRef.current.value)
    if (matches.length > 0 && !menuHiddenRef.current) {
      if (key.escape) { setMenuHidden(true); return }
      if (key.upArrow) { setMenuIndex(Math.max(0, menuIndexRef.current - 1)); return }
      if (key.downArrow) { setMenuIndex(Math.min(matches.length - 1, menuIndexRef.current + 1)); return }
      if (key.tab || key.return) {
        const pick = matches[Math.min(menuIndexRef.current, matches.length - 1)]
        if (pick !== undefined) setBuffer({ value: `/${pick.name} `, cursor: pick.name.length + 2 })
        return
      }
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
      // Fallback for terminals without bracketed paste: a pasted chunk that
      // reaches useInput carries CR/CRLF line endings, which the renderer
      // (split on LF) would draw as overlapping lines. Normalize to LF so the
      // paste lands as proper buffer newlines. A lone Enter is handled above
      // (key.return) and never reaches here.
      const text = input.replace(/\r\n|\r/g, '\n')
      setBuffer({ value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length })
    }
  })

  // Bracketed paste (auto-enabled by usePaste) delivers the whole pasted string
  // on a channel separate from useInput, so multi-line paste never trips the
  // Enter-to-commit path. Normalize CR/CRLF to LF for the LF-splitting renderer.
  usePaste((text) => {
    if (approvalPending || focusMode !== 'input') return
    const { value, cursor } = bufferRef.current
    const normalized = text.replace(/\r\n|\r/g, '\n')
    setBuffer({ value: value.slice(0, cursor) + normalized + value.slice(cursor), cursor: cursor + normalized.length })
  })

  const { value, cursor } = buffer
  const lines = value.split('\n')
  const beforeCursor = value.slice(0, cursor)
  const cursorLine = beforeCursor.split('\n').length - 1
  const cursorColumn = beforeCursor.length - beforeCursor.lastIndexOf('\n') - 1
  const width = useTerminalWidth()
  // The slash menu's live derivation off the rendered buffer; the selection is
  // clamped so a shrinking filter never points past the last match.
  const menuMatches = commandMatchesFor(value)
  const menuOpen = menuMatches.length > 0 && !menuHidden
  const menuSelected = Math.min(menuIndex, menuMatches.length - 1)
  // The approval panel owns the screen bottom: the bar renders nothing (the
  // ApprovalPanel takes its rows in the chrome band) while still owning the
  // question's keys through the handler above.
  if (approvalPending) return <Box />
  // The child transcript view is read-only: the bar keeps routing Esc but
  // renders nothing, leaving the child transcript as the visible surface.
  if (focusMode === 'child') return <Box />

  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(width)}</Text>
      {lines.map((line, index) => {
        // The caret only shows while the input bar holds focus; a focused panel
        // (subagent or team) hides it so the selection highlight is unambiguous.
        const marked = focusMode === 'input' && index === cursorLine
          ? `${line.slice(0, cursorColumn)}▏${line.slice(cursorColumn)}`
          : line
        return (
          <Text key={index}>
            {/* The prompt marker leads the first line in the body color; later
                lines indent two columns so every line's text aligns. */}
            {index === 0 ? <Text>❯ </Text> : '  '}
            {marked}
          </Text>
        )
      })}
      <Text dimColor>{'─'.repeat(width)}</Text>
      {/* The completion menu and the status bar share one slot below the box:
          they swap in a single render, so opening the menu never paints an
          intermediate frame where both stack (the chrome band overshooting
          made the input box visibly jump before settling). */}
      {menuOpen
        ? <CommandMenu items={menuMatches} selected={menuSelected} width={width} />
        : <StatusBar status={status} />}
    </Box>
  )
}

/** Rows the slash completion menu shows before windowing around the selection. */
const MENU_MAX_ROWS = 8

/** Gap between the padded name column and the aligned descriptions. */
const MENU_DESCRIPTION_GAP = 3

/** The menu row's label segment: the slashed name plus its input hint. */
function commandLabel(item: CommandInfo): string {
  return `/${item.name}${item.hint === undefined ? '' : ` ${item.hint}`}`
}

/**
 * The `/` completion menu below the input bar (between the box and the status
 * bar): prefix-filtered commands with name, hint, and description, discovery-
 * menu styling — no marker column; the arrow-selected row turns the shared
 * highlight tint (#a5d8ff) in its entirety, every other row stays dim. Rows
 * beyond the cap window around the selection. No closing rule: the status
 * bar hides while the menu is up, so the rows simply end the chrome band.
 */
function CommandMenu({
  items,
  selected,
  width,
}: {
  items: readonly CommandInfo[]
  /** The arrow-selected index into `items`, already clamped by the caller. */
  selected: number
  width: number
}): React.JSX.Element {
  const start = items.length <= MENU_MAX_ROWS
    ? 0
    : Math.min(Math.max(0, selected - Math.floor(MENU_MAX_ROWS / 2)), items.length - MENU_MAX_ROWS)
  const visible = items.slice(start, start + MENU_MAX_ROWS)
  const hiddenBefore = start
  const hiddenAfter = items.length - start - visible.length
  // Descriptions align in one column: every label pads to the widest label in
  // the full match list (not just the visible window, so scrolling never
  // shifts the column), then the fixed gap follows.
  const nameCol = items.reduce((max, item) => Math.max(max, stringWidth(commandLabel(item))), 0)
  const descriptionBudget = Math.max(0, width - 2 - nameCol - MENU_DESCRIPTION_GAP)
  // The status bar's marginBottom={1} is what keeps the chrome band off the
  // very bottom row; the menu replaces the status bar while open, so it owns
  // the same bottom gap.
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hiddenBefore > 0 ? <Text dimColor>  … {hiddenBefore} more</Text> : null}
      {visible.map((item, index) => {
        const isSelected = start + index === selected
        const label = padToWidth(commandLabel(item), nameCol)
        const description = item.description === undefined ? '' : truncateToWidth(item.description, descriptionBudget)
        return isSelected ? (
          <Text key={item.name} color="#a5d8ff">
            <Text bold>  {label}</Text>{' '.repeat(MENU_DESCRIPTION_GAP)}{description}
          </Text>
        ) : (
          <Text key={item.name} dimColor>
            {'  '}{label}{' '.repeat(MENU_DESCRIPTION_GAP)}{description}
          </Text>
        )
      })}
      {hiddenAfter > 0 ? <Text dimColor>  … {hiddenAfter} more</Text> : null}
    </Box>
  )
}

/** The terminal columns, with a sane non-TTY fallback. */
function useTerminalWidth(fallback = 80): number {
  const { stdout } = useStdout()
  return typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : fallback
}

/**
 * The terminal size with sane non-TTY fallbacks. `rows` sizes the fullscreen
 * root layout; the fallback matches ink's own non-TTY default so tests and
 * piped output degrade the same way ink's viewport logic does.
 */
function useTerminalSize(fallbackColumns = 80, fallbackRows = 24): { columns: number; rows: number } {
  const { stdout } = useStdout()
  const columns = typeof stdout.columns === 'number' && stdout.columns > 0 ? stdout.columns : fallbackColumns
  const rows = typeof stdout.rows === 'number' && stdout.rows > 0 ? stdout.rows : fallbackRows
  return { columns, rows }
}

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

/** Fraction of the terminal width a tool call line may occupy before its
 *  invocation is truncated with an ellipsis (ctrl+o reveals the full text). */
const CALL_WIDTH_RATIO = 0.6

/** Fraction of the terminal width a panel row's activity may occupy before it
 *  is truncated, keeping a clear gap before the right-aligned elapsed/tokens. */
const PANEL_ACTIVITY_RATIO = 0.6

/**
 * Truncate text to fit `maxWidth` display columns, appending `…` when cut.
 * Width is measured with string-width so CJK and emoji count correctly; text
 * already within budget is returned unchanged.
 * @param text - the text to truncate.
 * @param maxWidth - the maximum display width, including the ellipsis.
 * @returns the text, truncated to `maxWidth` columns with a trailing `…` if cut.
 */
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
