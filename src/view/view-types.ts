/**
 * The renderer's public type contracts: every shape the driver hands to the
 * ink view, plus the input callbacks and the renderer seam. Pure types — no
 * presentation code — so both the driver and the view modules import them
 * without pulling components.
 * @module dsh-terminal/src/view-types
 */

import type { FrameState } from '../frames.ts'

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
  /** Move keyboard focus into the subagent/team panels (`↓`) — from the input
   *  bar, or from an opened child view to switch to another transcript. */
  onPanelOpen(): void
  /** Move the panel selection by `delta` rows. */
  onPanelMove(delta: number): void
  /** Enter the selected panel row's view (the main row returns to the input bar). */
  onPanelEnter(): void
  /** Step back: a continuable child's first Esc drops into its editor and
   *  the next one reaches the main input; a read-only child (or plain panel
   *  navigation) reaches the main input in one press. */
  onPanelBack(): void
  /** Send one human prompt to the opened continuable child; it steers into
   *  the child's nearest step boundary. */
  onChildPrompt(text: string): void
  /** The job detail's two-step stop gesture: the first `x` arms, a second
   *  within the window kills the opened job. */
  onJobKill(): void
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
  /** The permission preset selection (`read-only`/`workspace-write`/`auto`/...), on its own row. */
  mode?: string
  /** Current context usage from the latest step's token report. */
  context?: { used: number; window: number }
  /** The reasoning effort, shown right-aligned with the `/effort` hint. */
  effort?: string
}

/** The standing goal's durable lifecycle phase (the goal domain's vocabulary). */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** The current goal as a standing chrome strip: objective, phase, round
 *  progress, and the process-local continuation switch. */
export interface GoalPanelInfo {
  /** The human-requested completion objective, shown in full. */
  objective: string
  /** The durable lifecycle phase. */
  phase: GoalPhase
  /** Admitted goal rounds so far; the round-driver's continuation counter. */
  roundsStarted: number
  /** The total round cap for this goal. */
  maxGoalRounds: number
  /** Process-local continuation eligibility: `armed` runs the next round
   *  unattended, `disarmed` needs a human. Resume/fork always starts disarmed. */
  activation: 'armed' | 'disarmed'
  /** Present exactly while `phase` is `blocked`: the stable code plus a
   *  human/model-readable reason. */
  blockedReason?: { code: string; message: string }
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

/** One message submitted while the agent was busy: echoed at once, steered
 *  into the running turn's next step boundary. */
export interface PendingUserEcho {
  /** The message id, used to drop the echo when its durable user/message event lands. */
  id: string
  /** The submitted text. */
  text: string
}

/** The child transcript the driver opens from the panel. */
export interface OpenSubagent {
  /** The child session id. */
  childId: string
  /** The child's display label, shown in the view header. */
  label: string
  /** The child's folded frames, rebuilt through the same fold as the main stream. */
  state: FrameState
  /** The child accepts human continuation prompts; absent keeps the view read-only. */
  continuable?: boolean
  /** Prompts sent while the child's inbox has not claimed them yet; echoed as steering. */
  pending?: readonly PendingUserEcho[]
}

/** One Agent Teams member row for the team panel roster. */
export interface TeamMemberRow {
  /** The member's child session id; the ● marker follows the open transcript. */
  id?: string
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

/** The display status of one workflow run or member (the web client's vocabulary). */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** The display status of one workflow member row. */
export type WorkflowMemberStatus = WorkflowRunStatus

/** One workflow member row: one agent() call of the orchestration script. */
export interface WorkflowMemberRow {
  /** The agent()'s 1-based sequence within the run (a failed start can skip it). */
  seq: number
  label: string
  /** The member's child session id; Enter opens this transcript. */
  childId: string
  status: WorkflowMemberStatus
  /** The latest visible activity from the live child fold; absent while not resident. */
  activity?: string
  /** When the member's child run began; absent while it is not a live child. */
  startedAt?: number
  /** The member's reported input tokens; absent while it is not a live child. */
  inputTokens?: number
}

/** Members sharing one phase identity; an absent `phase` is the unphased group. */
export interface WorkflowPhaseGroup {
  /** Collision-free key (`missing` / `value:len:phase`). */
  key: string
  phase?: string
  members: readonly WorkflowMemberRow[]
}

/** One durable workflow run, folded from the four `tool-workflow/*` events. */
export interface WorkflowRunRow {
  id: string
  name: string
  status: WorkflowRunStatus
  phases: readonly WorkflowPhaseGroup[]
}

/** The workflow panel contract: runs in display order plus the navigation bound. */
export interface WorkflowPanelInfo {
  runs: readonly WorkflowRunRow[]
  /** Total member rows across every run; workflowSelected clamps to it (0 = main). */
  memberCount: number
}

/** The background-job lifecycle state (the jobs registry's vocabulary). */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** One background job as a panel row. */
export interface JobRow {
  /** The registry-issued id (`<kind>-N`). */
  id: string
  /** The producer kind (bash, subagent, workflow, …); shown as the row's dim tag. */
  kind: string
  /** The producer's one-line label (the command; the delegation description). */
  label: string
  status: JobStatus
  /** The producer's live progress line while running; cleared at settlement. */
  progress?: string
  /** The terminal reason once settled (`exit code: 3`, the kill reason). */
  detail?: string
  /** Milliseconds since registration; frozen at settlement (finishedAt − startedAt). */
  elapsedMs: number
}

/** The jobs panel contract: rows in registry order. The opened job renders as
 *  a full-screen detail view (RenderView.openJob), not an inline block. */
export interface JobsPanelInfo {
  rows: readonly JobRow[]
}

/** The full-screen detail of one opened job: kind-named heading, labelled
 *  fields, and the incrementally-read output tail. */
export interface JobDetailView {
  /** The job being inspected. */
  jobId: string
  /** The kind-driven heading (`Command details`, `Subagent details`, …). */
  title: string
  /** The kind-driven label field name (`Command:`, `Task:`, …). */
  labelField: string
  /** The producer's label (the command; the delegation description; the name). */
  label: string
  status: JobStatus
  /** The terminal reason once settled (`exit code: 0`); absent while live. */
  detail?: string
  /** Milliseconds since registration; frozen at settlement. */
  elapsedMs: number
  /** The retained output tail (the driver caps the buffer); empty shows a
   *  "No output available" placeholder (a subagent job has no output ring). */
  output: string
  /** The read cursor fell below the ring's retained window; head bytes are gone. */
  lossy: boolean
  /** The kill gesture is armed: a second `x` within the window stops the job. */
  killArmed: boolean
  /** Only a live job can be stopped; settled rows hide the kill hint. */
  killable: boolean
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
  /** The panels own the keys while a child transcript is open (`↓` dropped into navigation from the child view). */
  panelNav?: boolean
  /** The child transcript opened from the panel; replaces the input region while set. */
  openSubagent?: OpenSubagent
  /** The Agent Teams roster and task board; absent hides the team panel. */
  team?: TeamPanelInfo
  /** The selected team-member row; absent means the team panel is not focused. */
  teamSelected?: number
  /** The current goal; absent (no goal, or cleared) hides the goal strip. */
  goal?: GoalPanelInfo
  /** Durable workflow runs; absent hides the workflow panel. */
  workflow?: WorkflowPanelInfo
  /** The selected workflow row (0 = the main row); absent means the workflow panel is not focused. */
  workflowSelected?: number
  /** Background jobs; absent hides the jobs panel. */
  jobs?: JobsPanelInfo
  /** The selected job row; absent means the jobs panel is not focused. */
  jobsSelected?: number
  /** The opened job's full-screen detail; replaces the transcript window while
   *  set, exactly like openSubagent replaces it with a child transcript. */
  openJob?: JobDetailView
  /** Messages submitted while a step was in flight; shown immediately as steering until their durable echo lands. */
  pendingUser?: readonly PendingUserEcho[]
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
