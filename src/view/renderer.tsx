/**
 * M5 ink renderer: the app shell that wires the transcript window, the chrome
 * band (status, panels, input bar), and the overlay slot into one fullscreen
 * surface. Presentation code lives in the sibling modules — this file is the
 * thin seam the driver drives plus the renderer's public type surface.
 * @module dsh-terminal/src/renderer
 */

// The source-launch tsx hook compiles with the launcher's tsconfig (classic
// JSX), so the React namespace must be imported even though the package's own
// tsc build uses react-jsx; React.createElement below keeps the import used.
import React, { useLayoutEffect, useReducer, useRef, useState } from 'react'
import { Box, measureElement, render, Text } from 'ink'
import type { Frame, FrameState } from '../fold/frames.ts'
import { createFrameState } from '../fold/frames.ts'
import {
  createScrollState,
  createScrollStates,
  CURSOR_HIDE,
  CURSOR_SHOW,
  ENTER_FULLSCREEN,
  EXIT_FULLSCREEN,
  MOUSE_OFF,
  MOUSE_ON,
  mouseEnabled,
  PRE_MEASURE_MARGIN,
  scrollStatesReducer,
  transcriptMarginTop,
} from './terminal.ts'
import type { InputHandlers, Overlay, PlanReviewNarrowed, QuestionAnswerItem, QuestionDraft, QuestionItem, RenderView, TuiRenderer } from './view-types.ts'
import {
  ApprovalPanel,
  COMPLETED_BOARD_LINGER_MS,
  GoalPanel,
  HeartbeatLine,
  PendingUserEchoes,
  PlanPanel,
  PlanReviewPanel,
  planReviewOf,
  QuestionPanel,
  WelcomeBlock,
} from './chrome.tsx'
import { JobDetail, JobsPanel, SubagentPanel, TeamPanel, WorkflowPanel } from './panels.tsx'
import { FrameRow, frameKey, PlanDocument, planMarkdownOf } from './transcript.tsx'
import { InputBar, READ_ONLY_CHILD_NOTE } from './input-bar.tsx'
import { useTerminalSize } from './use-terminal.ts'

// The renderer's public type surface and text helpers, re-exported from here so
// the driver and the tests keep a single import path (./renderer) unchanged.
export type * from './view-types.ts'
export {
  foldInvocationLine,
  formatContext,
  formatElapsed,
  formatTokenCount,
  padToWidth,
  shortenCwd,
  splitLines,
  truncateToWidth,
  wrapToWidth,
} from './text-helpers.ts'
export { COMPLETED_BOARD_LINGER_MS } from './chrome.tsx'

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
    onChildPrompt: () => {},
    onJobKill: () => {},
    onQuestionAnswer: () => {},
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

/** Remount the panel per approval request so the selection resets. */
function approvalKey(overlay: Extract<Overlay, { kind: 'approval' }>): string {
  return `approval:${overlay.toolName}:${overlay.reason ?? ''}:${overlay.detail ?? ''}`
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
  completedLingerMs,
}: {
  state: FrameState
  handlers: InputHandlers
  view?: RenderView
  /** Viewport height override for tests (ink-testing-library has no rows). */
  viewportRows?: number
  /** All-completed task-board linger override for tests; production keeps the constant. */
  completedLingerMs?: number
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
  // The pending ask_user_question batch, when one owns the screen bottom: the
  // input bar routes its keys and the QuestionPanel renders it, wizard-style.
  const questionOverlay = view?.overlay?.kind === 'question' ? view.overlay : undefined
  // The ask_user_question wizard state, owned here (same ownership as
  // approvalIndex): a step index walks the question batch plus a terminal
  // Submit step, and every question keeps its own draft (option cursor,
  // multi-select set, text, confirmed flag) so ←→ navigation can revisit and
  // revise an answer — the step bar's ☐/✔ reads the confirmed flags. All
  // state resets when a new question batch arrives (the overlay key changes).
  const [questionIndex, setQuestionIndex] = useState(0)
  const [questionDrafts, setQuestionDrafts] = useState<readonly QuestionDraft[]>([])
  // The Submit step's own ↑↓ selection: 0 = submit the batch, 1 = cancel.
  const [questionSubmitSelected, setQuestionSubmitSelected] = useState(0)
  const questionQuestions = questionOverlay?.questions
  // A plan-review question narrows to its dedicated overlay: the plan renders
  // in the transcript window (top-anchored, scrollable) and the control bar
  // asks Yes / Tell-DSH-what-to-change, where the second row is itself the
  // feedback input — no separate opened state, the ❯ landing on it goes live.
  // The generic wizard stays untouched when the batch doesn't narrow.
  const planReview = questionQuestions === undefined ? undefined : planReviewOf(questionQuestions)
  const [planSelected, setPlanSelected] = useState(0)
  const [planFeedback, setPlanFeedback] = useState('')
  const questionKey = questionOverlay === undefined ? '' : questionOverlay.questions.map(q => q.id).join('|')
  const lastQuestionKeyRef = React.useRef('')
  if (lastQuestionKeyRef.current !== questionKey) {
    lastQuestionKeyRef.current = questionKey
    setQuestionIndex(0)
    setQuestionDrafts((questionQuestions ?? []).map(() => ({
      optionSelected: 0, multiSelected: [], text: '', confirmed: false, confirmedIndex: undefined,
    })))
    setQuestionSubmitSelected(0)
    setPlanSelected(0)
    setPlanFeedback('')
  }
  const questionCount = questionQuestions?.length ?? 0
  const questionOnSubmit = questionIndex >= questionCount
  const currentQuestion = questionQuestions?.[questionIndex]
  const currentDraft = questionDrafts[questionIndex]
  // ←→ (and Tab) walk the step bar: question steps plus the Submit step.
  const onQuestionStep = (delta: number): void => {
    setQuestionIndex(current => Math.min(questionCount, Math.max(0, current + delta)))
  }
  const updateQuestionDraft = (patch: Partial<QuestionDraft>): void => {
    const index = questionIndex
    setQuestionDrafts(current => current.map((draft, i) => i === index ? { ...draft, ...patch } : draft))
  }
  const onQuestionSelect = (delta: number): void => {
    // On the Submit step the arrows move the submit/cancel choice instead.
    if (questionOnSubmit) {
      setQuestionSubmitSelected(current => Math.min(1, Math.max(0, current + delta)))
      return
    }
    const options = currentQuestion?.options ?? []
    if (options.length === 0) return
    const from = currentDraft?.optionSelected ?? 0
    updateQuestionDraft({ optionSelected: Math.min(options.length - 1, Math.max(0, from + delta)) })
  }
  const onQuestionToggle = (): void => {
    if (currentQuestion?.multiSelect !== true) return
    const options = currentQuestion.options ?? []
    const label = options[currentDraft?.optionSelected ?? 0]?.label
    if (label === undefined) return
    const checked = currentDraft?.multiSelected ?? []
    updateQuestionDraft({
      multiSelected: checked.includes(label) ? checked.filter(l => l !== label) : [...checked, label],
    })
  }
  // The free-text draft for a no-options question; the InputBar routes typed
  // characters here while the question overlay owns the keys.
  const onQuestionTextChange = (text: string): void => { updateQuestionDraft({ text }) }
  // One draft becomes its question's answer item: only a confirmed draft
  // answers; anything left unconfirmed submits empty (skipped). A single-select
  // question submits the index locked in at confirm time, so the submitted
  // answer always matches the trailing ✔ the user saw.
  const questionAnswerOf = (question: QuestionItem, draft: QuestionDraft | undefined): QuestionAnswerItem => {
    if (draft === undefined || !draft.confirmed) return { id: question.id, selected: [] }
    const options = question.options ?? []
    if (options.length > 0) {
      if (question.multiSelect === true) return { id: question.id, selected: [...draft.multiSelected] }
      const confirmed = draft.confirmedIndex ?? draft.optionSelected
      return { id: question.id, selected: [options[confirmed]?.label ?? ''] }
    }
    const trimmed = draft.text.trim()
    return { id: question.id, selected: [], ...(trimmed === '' ? {} : { custom: trimmed }) }
  }
  const onQuestionConfirm = (): void => {
    if (questionQuestions === undefined) return
    // Enter on the Submit step follows the submit/cancel choice: 0 resolves
    // the waterfall with every draft, 1 abandons the batch (all questions
    // answered empty, the same as Esc).
    if (questionOnSubmit) {
      if (questionSubmitSelected === 1) {
        onQuestionSkip()
        return
      }
      handlers.onQuestionAnswer({
        answers: questionQuestions.map((question, i) => questionAnswerOf(question, questionDrafts[i])),
      })
      return
    }
    // Confirm the current question (the step bar's ☒) and jump to the next
    // unconfirmed one, falling through to the Submit step when none is left.
    // For a single-select option question, snapshot the cursor index so the
    // trailing ✔ tracks the confirmed choice, not the live cursor (revisiting
    // the question and moving the arrows must not move the checkmark).
    const singleOption = (currentQuestion?.options?.length ?? 0) > 0 && currentQuestion?.multiSelect !== true
    updateQuestionDraft({
      confirmed: true,
      confirmedIndex: singleOption ? (currentDraft?.optionSelected ?? 0) : undefined,
    })
    const next = questionDrafts.findIndex((draft, i) => i > questionIndex && !draft.confirmed)
    setQuestionIndex(next === -1 ? questionCount : next)
  }
  const onQuestionSkip = (): void => {
    if (questionQuestions === undefined) return
    // Esc gives up the whole batch: every question answers empty, so the
    // waterfall resolves with a complete batch (one item per question — the
    // tool rejects partial ones) and the model sees them all unanswered.
    handlers.onQuestionAnswer({
      answers: questionQuestions.map(question => ({ id: question.id, selected: [] })),
    })
  }
  // ---- Plan-review decision closures ---------------------------------
  // The overlay reuses the InputBar's question key routing; this simpler
  // single-question flow owns the approve/keep-planning decision. The second
  // row is a live input while the ❯ sits on it (the arrows still navigate
  // away from it, the reference radio-list reading), so there is no separate
  // feedback mode — the selection is the mode.
  const planAnswerCount = planReview === undefined ? 0 : (planReview.declineLabel === undefined ? 1 : 2)
  const onPlanSelect = (delta: number): void => {
    setPlanSelected(current => Math.min(planAnswerCount - 1, Math.max(0, current + delta)))
  }
  const submitKeepPlanning = (feedback: string): void => {
    if (planReview === undefined) return
    const trimmed = feedback.trim()
    handlers.onQuestionAnswer({
      answers: [{
        id: planReview.id,
        // No decline option offered: answer empty with the custom feedback —
        // anything but the approve label keeps planning upstream.
        selected: planReview.declineLabel === undefined ? [] : [planReview.declineLabel],
        ...(trimmed === '' ? {} : { custom: trimmed }),
      }],
    })
  }
  const onPlanConfirm = (): void => {
    if (planReview === undefined) return
    if (planSelected === 0) {
      handlers.onQuestionAnswer({ answers: [{ id: planReview.id, selected: [planReview.approveLabel] }] })
      return
    }
    // Enter on the input row submits the keep-planning answer with the typed
    // feedback; an empty draft refuses Enter — the reference input-row
    // reading, nothing submits and the caret stays where it is.
    if (planFeedback.trim() === '') return
    submitKeepPlanning(planFeedback)
  }
  const onPlanSkip = (): void => {
    if (planReview === undefined) return
    // Esc keeps planning without feedback from any row — the reference's
    // cancel reading: the upstream tool call resolves with the keep-planning
    // message ("the user wants to speak instead"), dropping any typed draft.
    submitKeepPlanning('')
  }
  const onPlanTextChange = (text: string): void => { setPlanFeedback(text) }
  // The all-completed team board's hide flag lives here, not in TeamPanel:
  // TeamPanel unmounts while an approval question owns the screen bottom, and
  // the hide must survive that round trip — the linger timer keeps running
  // here, so the board stays hidden afterwards. A reopened or new task
  // cancels the hide.
  const teamTasks = view?.team?.tasks
  const teamAllDone = teamTasks !== undefined && teamTasks.length > 0
    && teamTasks.every(task => task.status === 'completed')
  const [teamBoardHidden, setTeamBoardHidden] = useState(false)
  React.useEffect(() => {
    if (!teamAllDone) {
      setTeamBoardHidden(false)
      return
    }
    const timer = setTimeout(() => setTeamBoardHidden(true), completedLingerMs ?? COMPLETED_BOARD_LINGER_MS)
    return () => clearTimeout(timer)
  }, [teamAllDone, completedLingerMs])
  // The workflow panel hides the same way once every run settles; a new run
  // arriving flips allSettled and cancels the hide automatically. A held
  // cursor suppresses the hide so the arrows never drive an invisible panel.
  const workflowRuns = view?.workflow?.runs
  const workflowAllSettled = workflowRuns !== undefined && workflowRuns.length > 0
    && workflowRuns.every(run => run.status !== 'running')
  const [workflowHidden, setWorkflowHidden] = useState(false)
  React.useEffect(() => {
    if (!workflowAllSettled) {
      setWorkflowHidden(false)
      return
    }
    const timer = setTimeout(() => setWorkflowHidden(true), completedLingerMs ?? COMPLETED_BOARD_LINGER_MS)
    return () => clearTimeout(timer)
  }, [workflowAllSettled, completedLingerMs])
  const workflowVisible = view?.workflow !== undefined
    && !(workflowHidden && view?.workflowSelected === undefined)
  // The goal strip lingers on completion the same way the boards do: a
  // completed goal shows its ✔ state for the linger window, then hides. Any
  // phase change away from complete (a new goal, an edit back to active, a
  // clear dropping it from the view) cancels the hide through goalComplete.
  const goalComplete = view?.goal?.phase === 'complete'
  const [goalHidden, setGoalHidden] = useState(false)
  React.useEffect(() => {
    if (!goalComplete) {
      setGoalHidden(false)
      return
    }
    const timer = setTimeout(() => setGoalHidden(true), completedLingerMs ?? COMPLETED_BOARD_LINGER_MS)
    return () => clearTimeout(timer)
  }, [goalComplete, completedLingerMs])
  const goalVisible = view?.goal !== undefined && !(goalHidden && goalComplete)
  // The jobs panel has no hide latch of its own: the driver lingers settled
  // rows and drops them, so the renderer draws exactly what it is given.
  const jobsVisible = view?.jobs !== undefined && view.jobs.rows.length > 0
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
  // The opened job's full-screen detail owns the transcript window (and the
  // keys) while set; it never coexists with an opened child transcript.
  const openJob = view?.openJob
  // The pending approval question, when one owns the screen bottom: the input
  // bar, status bar, and side panels all yield to the ApprovalPanel below.
  const approvalOverlay = view?.overlay?.kind === 'approval' ? view.overlay : undefined
  // Panel navigation outranks an open child only while the panel actually owns
  // the keys (panelNav); otherwise a retained selection is just the row
  // highlight and the child transcript keeps the keyboard.
  const selectionActive = view?.subagentSelected !== undefined || view?.teamSelected !== undefined
    || view?.workflowSelected !== undefined || view?.jobsSelected !== undefined
  // The job detail outranks every other surface: while it is open it owns the
  // window and the keys (Esc/Enter close, x stops), so the panel cursor — if
  // the driver retained one — does not take the arrows.
  const focusMode: 'input' | 'panel' | 'child' | 'job' = openJob !== undefined
    ? 'job'
    : selectionActive && (opened === undefined || view?.panelNav === true)
      ? 'panel'
      : opened !== undefined
        ? 'child'
        : 'input'

  // ---- Transcript scroll state ---------------------------------------
  // The transcript is the app's own data (no terminal scrollback): the
  // window clips a bottom-anchored content column, and `marginTop` slides it
  // through the window. Heights come from measureElement after layout — no
  // width/wrapping estimation anywhere. offset 0 = sticky at the live bottom.
  // Each view (main, every opened child) keeps its own measured entry: a
  // returning visit re-anchors at the live bottom with remembered heights
  // instead of parking unmeasured, whose blank window ink's leading-edge
  // throttle would paint as a screen jump.
  const [scrollStates, dispatch] = useReducer(scrollStatesReducer, undefined, createScrollStates)
  const windowRef = useRef<any>(null)
  const contentRef = useRef<any>(null)

  // The child view swaps the transcript source (header + the child's frames).
  // The pinned plan in the chrome band follows the active view — the main
  // session's plan, or the opened child's.
  const mainWindowed = windowFrames(frames)
  const childWindowed = opened === undefined ? undefined : windowFrames(opened.state.frames)
  const activePlan = opened === undefined ? state.plan : opened.state.plan
  // The heartbeat follows the active transcript too: while a child transcript
  // is on screen, the child's own turn clocks its Working… line.
  const activeTurn = opened === undefined ? state : opened.state
  const transcriptKey = opened === undefined ? 'main' : opened.childId
  // The view switch activates during render — React re-runs the component
  // before committing, so the first painted frame of the new view already
  // carries its remembered measurements.
  if (scrollStates.active !== transcriptKey) dispatch({ type: 'switch', key: transcriptKey })
  const scroll = scrollStates.entries[scrollStates.active] ?? createScrollState()

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
  const baseTranscript = opened === undefined ? (
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
  // The plan-review document sits in the transcript window under its "Here is
  // DSH's plan:" card (headings, bold, code, tables as light markdown), the
  // inline plan block pattern. The durable source is the exit_plan_mode
  // frame the review names — while that frame is on screen its ToolRow renders
  // the document itself, and it stays there after the answer (once settled
  // approved it collapses into the `● User approved DSH's plan` verdict card;
  // across a resume the fold replays the same arguments either way). Only when
  // the review names no such frame (an ask without a logged plan call) does a
  // transient copy append at the live bottom, disappearing once answered.
  const planInTranscript = planReview !== undefined && frames.some(frame => {
    if (frame.kind !== 'tool') return false
    const plan = planMarkdownOf(frame)
    if (plan === undefined) return false
    // The named call is authoritative (the web client reopens the logged plan
    // by callId); without a callId, a frame carrying the same text is the same
    // document, so the transient copy would only duplicate it on screen.
    return planReview.callId === undefined ? plan === planReview.plan : frame.callId === planReview.callId
  })
  const transcript = planReview === undefined || planInTranscript ? baseTranscript : (
    <>
      {baseTranscript}
      <PlanDocument plan={planReview.plan} />
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
        {/* Messages submitted while a step is in flight echo immediately
            (dimmed, no committed background) so the submission is never
            silently swallowed; each is dropped once its durable user/message
            frame lands above. */}
        {view?.pendingUser !== undefined && view.pendingUser.length > 0
          ? <PendingUserEchoes items={view.pendingUser} />
          : null}
        {/* Continuation prompts sent to the opened child echo the same way until
            its inbox claims them and the durable user/message frame lands in
            the child transcript. */}
        {opened?.pending !== undefined && opened.pending.length > 0
          ? <PendingUserEchoes items={opened.pending} />
          : null}
        {view?.overlay?.kind === 'notice'
          ? <Text color="red" key="notice">{view.overlay.text}</Text>
          : null}
        {/* The step heartbeat leads the pinned chrome: shown throughout a
            step — its tool executions included — while no overlay waits on
            the user; it tracks the active transcript's turn. */}
        {view?.overlay === undefined && activeTurn.turnStartedAt !== undefined
          ? <HeartbeatLine startedAt={activeTurn.turnStartedAt} tokens={activeTurn.turnTokens} />
          : null}
        {/* The standing goal strip sits directly below the heartbeat: it is
            the session-level objective the plan and panels serve, and unlike
            the plan it follows the main session, never the opened child. */}
        {goalVisible && view?.goal !== undefined ? <GoalPanel goal={view.goal} /> : null}
        {/* The standing plan sits below the goal strip, above the input bar;
            it follows the active transcript (main session or opened child). */}
        {activePlan !== undefined ? <PlanPanel todos={activePlan} /> : null}
        {/* The input bar stays mounted in every focus mode — it owns the single
            stdin listener; a read-only child view routes only Esc back, while a
            continuable child borrows the editor for its own prompts. */}
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
          childPromptable={opened?.continuable === true}
          {...(opened !== undefined && opened.continuable !== true
            ? {
              childReadOnly: true,
              childReadOnlyNote: `subagent: ${opened.label} · ${READ_ONLY_CHILD_NOTE}`,
            }
            : {})}
          {...(opened?.continuable === true
            ? { childPlaceholder: `subagent: ${opened.label}` }
            : {})}
          jobDetailOpen={openJob !== undefined}
          questionPending={questionOverlay !== undefined}
          // The plan review's input row owns the keys the moment the ❯ lands
          // on it: typing flows to the feedback draft while selected there,
          // and the approve row swallows type like any option row.
          questionHasOptions={planReview !== undefined ? planSelected === 0 : (currentQuestion?.options?.length ?? 0) > 0}
          questionMultiSelect={planReview !== undefined ? false : currentQuestion?.multiSelect === true}
          questionTextDraft={planReview !== undefined ? planFeedback : (currentDraft?.text ?? '')}
          onQuestionSelect={planReview !== undefined ? onPlanSelect : onQuestionSelect}
          onQuestionToggle={onQuestionToggle}
          onQuestionConfirm={planReview !== undefined ? onPlanConfirm : onQuestionConfirm}
          onQuestionSkip={planReview !== undefined ? onPlanSkip : onQuestionSkip}
          onQuestionStep={planReview !== undefined ? () => {} : onQuestionStep}
          onQuestionTextChange={planReview !== undefined ? onPlanTextChange : onQuestionTextChange}
          panelAvailable={subagents.length > 0 || (view?.team?.members.length ?? 0) > 0 || workflowVisible || jobsVisible}
          commands={view?.commands ?? []}
          {...(view?.status === undefined ? {} : { status: view.status })}
          {...(openJob !== undefined
            ? {}
            : view?.workflowSelected !== undefined || view?.teamSelected !== undefined
              ? { statusHint: '↑↓ 选择 · Enter 打开 · Esc 返回' }
              : view?.jobsSelected !== undefined
                ? { statusHint: '↑↓ 选择 · Enter 详情 · Esc 返回' }
                : {})}
        />
        {approvalOverlay !== undefined ? (
          /* The question owns the screen bottom: the bar above rendered
             nothing, and the side panels and child header wait it out. */
          <ApprovalPanel key={approvalKey(approvalOverlay)} overlay={approvalOverlay} selected={approvalIndex} width={columns} />
        ) : planReview !== undefined ? (
          /* A plan-review question takes over: the plan markdown renders in
             the transcript window above, and this control bar asks the
             approve / feedback decision — the second row is a live input
             while the ❯ sits on it, no separate opened state. */
          <PlanReviewPanel
            key={questionKey}
            review={planReview}
            selected={planSelected}
            feedback={planFeedback}
            width={columns}
          />
        ) : questionOverlay !== undefined ? (
          /* The ask_user_question batch owns the screen bottom the same way:
             the step bar walks the whole batch (plus the Submit step), one
             question at a time, keyed by the InputBar above. */
          <QuestionPanel
            key={questionKey}
            questions={questionOverlay.questions}
            index={questionIndex}
            drafts={questionDrafts}
            submitSelected={questionSubmitSelected}
            width={columns}
          />
        ) : openJob !== undefined ? (
          /* The opened job's detail owns the region below the status bar:
             it covers the side panels (the roster stays visible through the
             cursor on its row) while the transcript keeps scrolling above. */
          <JobDetail view={openJob} />
        ) : (
          <>
            {/* The read-only child's identity now rides its own input box's
                dim note at the screen bottom — no separate header row. */}
            {/* The workflow, roster, and team panels stay up in the child view
                too: the main agent's world keeps moving while a transcript is
                open. The workflow run leads — it is the most specific activity. */}
            {workflowVisible
              ? (
                <WorkflowPanel
                  info={view!.workflow!}
                  selected={view?.workflowSelected}
                  {...(opened === undefined ? {} : { openChildId: opened.childId })}
                />
              )
              : null}
            {subagents.length > 0
              ? (
                <SubagentPanel
                  rows={subagents}
                  selected={view?.subagentSelected}
                  {...(opened === undefined ? {} : { openChildId: opened.childId })}
                />
              )
              : null}
            {view?.team !== undefined
              ? (
                <TeamPanel
                  team={view.team}
                  selected={view.teamSelected}
                  tasksHidden={teamBoardHidden}
                  {...(opened === undefined ? {} : { openChildId: opened.childId })}
                />
              )
              : null}
            {jobsVisible
              ? (
                <JobsPanel
                  info={view!.jobs!}
                  selected={view?.jobsSelected}
                />
              )
              : null}
          </>
        )}
      </Box>
    </Box>
  )
}
