/**
 * dsh-terminal — interactive terminal UI driver. The patch layer
 * rides over dsh-base without Host, HTTP, or browser plugins; this plugin
 * creates (or resumes) one Agent through the core registry, folds the durable
 * session event stream into display frames, and renders them through the ink
 * terminal UI (the frame stream plus the multiline input bar). Input steers
 * through the Agent's durable inbox without waiting for the owned turn, so a
 * submitted line lands at the running turn's next step boundary; Ctrl+D
 * flushes the Session and exits.
 *
 * A resumed session rebuilds its display by replaying the persisted log
 * through the same fold before live events attach.
 *
 * @module dsh-terminal
 */

import { randomUUID } from 'node:crypto'
import type { AgentSetup, ApprovalOutcome, AssistantStreamFrame, CommandDescriptor, CommandRuntime, Context, ModelSelectionRef, SessionEvent } from './dsh-adapter/types.ts'
import { createUserMessage, installModelSelection, SessionId, z } from './dsh-adapter/services.ts'
import './dsh-adapter/effects.ts'
import { createFrameState, foldAssistantStreamChunk, foldEvent, readableFailureMessage } from './fold/frames.ts'
import type { FoldDeps, Frame, FrameState } from './fold/frames.ts'
import { teamToolPresentation } from './fold/team-present.ts'
import { createInkRenderer, foldInvocationLine } from './view/renderer.tsx'
import type { ApprovalChoice, CommandInfo, GoalPanelInfo, GoalPhase, JobDetailView, JobsPanelInfo, JobRow, Overlay, QuestionAnswer, QuestionItem, RenderView, SubagentRow, TeamPanelInfo, TeamTaskRow, TuiRenderer, WorkflowMemberRow, WorkflowMemberStatus, WorkflowPanelInfo, WorkflowPhaseGroup, WorkflowRunRow, WorkflowRunStatus } from './view/renderer.tsx'

// Re-exported so driver suites import the renderer contract without reaching
// the ink view's .tsx module directly (the host aggregate compiles specs).
export type { InputHandlers, OpenSubagent, Overlay, RenderView, SubagentRow, TuiRenderer } from './view/renderer.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui'

/** Core services required before the interactive turn loop can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionProjections']

/** Plugin config: the resume target resolved from the startup provider. */
export interface Config {
  /** Persisted session id to resume; undefined starts a fresh session. */
  resume?: string
  /** Resume this working directory's most recent session (`-c`/`--continue`). */
  continueLatest?: boolean
}

export const Config: z<Config> = z.object({
  resume: z.string(),
  continueLatest: z.boolean(),
})

/** The header facts `--continue` needs from one stored-session snapshot. The
 *  persistence service sits outside the adapter contract, so it is read
 *  structurally — the sandboxPolicy pattern, no upstream import. */
interface StoredSessionSnapshot {
  readonly header: {
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
    readonly origin?: string
  }
}

/**
 * This working directory's most recent top-level session id, or undefined
 * when the store holds none. Subagent children are not user conversations,
 * and other directories' sessions belong to their own workspaces.
 * @param ctx - plugin context carrying the host's persistence service.
 */
async function latestWorkspaceSessionId(ctx: Context): Promise<string | undefined> {
  const persistence = ctx.get('sessionPersistence') as
    | { list(): Promise<readonly StoredSessionSnapshot[]> }
    | undefined
  if (persistence === undefined) return undefined
  const cwd = process.cwd()
  let latest: StoredSessionSnapshot | undefined
  for (const snapshot of await persistence.list()) {
    const header = snapshot.header
    if (header.cwd !== cwd || header.origin === 'subagent') continue
    if (latest === undefined || header.createdAt > latest.header.createdAt) latest = snapshot
  }
  return latest?.header.id
}

/** How long the exit flush may take before the driver exits without it. */
export const EXIT_FLUSH_TIMEOUT_MS = 5_000

/** Streaming chunks fold into one render per this window. */
export const STREAM_RENDER_INTERVAL_MS = 80

/** How long a settled subagent's panel row stays visible before it is removed. */
export const SUBAGENT_FADE_MS = 5_000

/** The heartbeat tick: subagent rows refresh and fade, thinking seconds advance. */
const SUBAGENT_PANEL_TICK_MS = 1_000

/**
 * Await a durability flush, bounded: a listener that never settles must not
 * strand the process (and the now-ignored input bar) forever. The bound timer
 * is cleared when the flush settles, so a fast flush leaves nothing holding
 * the event loop open on the way out.
 * @param flush - the flush operation to bound.
 * @param timeoutMs - how long to wait before giving up.
 * @param warn - one-line warning sink for the timeout case.
 * @returns when the flush settles or the timeout elapses.
 */
export async function flushWithTimeout(
  flush: () => Promise<unknown>,
  timeoutMs: number,
  warn: (message: string) => void,
): Promise<void> {
  let expire: () => void = () => {}
  const timeoutPromise = new Promise<void>((resolve) => { expire = resolve })
  const timeout = setTimeout(() => { expire() }, timeoutMs)
  try {
    const outcome = await Promise.race([
      flush().then(() => 'flushed' as const),
      timeoutPromise.then(() => 'expired' as const),
    ])
    if (outcome === 'expired') warn('dsh: warn: session flush timed out; exiting anyway\n')
  } finally {
    clearTimeout(timeout)
  }
}

/** One workflow member folded from a `tool-workflow/agent-start` event plus
 *  the outcome its paired `agent-end` carries. */
interface WorkflowMemberState {
  /** The agent()'s 1-based sequence within the run; a failed start consumes
   *  the number without emitting events, so gaps are normal. */
  seq: number
  label: string
  /** The exact phase string; undefined when the agent() call declared none. */
  phase: string | undefined
  childId: string
  outcome: 'completed' | 'failed' | 'cancelled' | undefined
}

/** One durable workflow run folded from the four `tool-workflow/*` events. */
interface WorkflowRunState {
  /** The branded WorkflowRunId keys the map fine as a plain string. */
  id: string
  name: string
  stopReason: 'completed' | 'cancelled' | 'error' | undefined
  /** True once any event for this run crossed the live bus (post-replay); a
   *  replayed run without a run-end is 'interrupted' unless live events prove
   *  it is still running. */
  liveSeen: boolean
  /** Insertion order = seq order; keyed by seq for O(1) agent-end pairing. */
  members: Map<number, WorkflowMemberState>
}

/** One background job as the panel tracks it: the registry's view fields plus
 *  the settled stamp that drives the linger (the registry may drop the job
 *  from list() before the panel retires it). */
interface JobDisplayState {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  progress: string | undefined
  detail: string | undefined
  startedAt: number
  finishedAt: number | undefined
  /** Epoch ms when the driver saw it settle; undefined while live. */
  settledAt: number | undefined
}

/** The registry's event stream, shaped structurally so the driver never
/** One job projection as the registry hands it out (view or event payload). */
interface JobViewShape {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  progress?: string
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** The registry's event stream, shaped structurally so the driver never
 *  imports the upstream union at runtime. Lifecycle events carry the job's
 *  post-commit projection; `output` carries only the id and the ring's new
 *  total, so an observer reads from its own cursor. */
type JobRegistryEvent =
  | { type: 'registered' | 'progress' | 'stopping' | 'removed'; job: JobViewShape }
  | { type: 'settled'; job: JobViewShape; cause: 'producer' | 'kill' | 'teardown' }
  | { type: 'output'; id: string; total: number }

/** How long a settled job lingers in the panel before the driver drops it. */
const SETTLED_JOB_LINGER_MS = 5_000

/** Cap of the expanded job's retained output tail (bytes ≈ chars, ASCII-ish). */
const JOB_OUTPUT_BUFFER_MAX = 8_000

/** How long the job detail's first `x` stays armed before the second press is
 *  needed again (the web kill button's same re-arm window). */
const JOB_KILL_ARM_MS = 3_000

/** One unfinished direct subagent tracked for the panel below the status bar. */
interface ChildEntry {
  /** The child's display label: its delegation description once the descriptor arrives. */
  label: string
  /** The child accepts human continuation prompts (its descriptor mode is
   *  `continuable`); one-shot and unknown children stay read-only. */
  continuable: boolean
  /** When the child's first observed event landed. */
  startedAt: number
  /** Accumulated input and cache-read tokens reported by the child. */
  inputTokens: number
  /** The child's folded frames — the same pure fold as the main stream. */
  state: FrameState
  /** True once the child's agent left the registry (its run settled). */
  fading: boolean
  /** When the fading row leaves the panel. */
  fadeAt: number | undefined
}

/** Process-facing effects of one interactive run; the renderer owns stdin/stdout. */
interface TuiIo {
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the driver writes; tests substitute captures. */
export const internals: { stderr: TuiIo['stderr'] } = {
  stderr: process.stderr,
}

/** Report an unexpected driver failure and request a failing exit. */
function fail(io: TuiIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one interactive session until the user requests exit. Exported for the
 * driver suites, which inject a capturing renderer; `apply` wires the ink view.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - validated resume config.
 * @param io - process-facing effects.
 * @param renderer - the presentation seam the driver drives.
 */
export async function run(ctx: Context, config: Config, io: TuiIo, renderer: TuiRenderer): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer.
  const setup: AgentSetup = (agentCtx) => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  // `-c` resolves this directory's most recent stored session; an explicit
  // --resume id always wins. A --continue with nothing to resume falls back to
  // a fresh session with a notice, rather than failing the launch.
  const resumeId = config.resume ?? (config.continueLatest === true
    ? await latestWorkspaceSessionId(ctx)
    : undefined)
  const continueMissed = config.resume === undefined && config.continueLatest === true && resumeId === undefined
  const handle = resumeId === undefined
    ? await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    : await agents.resume({
      resumeSessionId: SessionId(resumeId),
      agentOptions,
      setup,
    })
  const agent = handle.agent

  // The Agent Teams runtime owns the authoritative team state through the
  // `agentTeam` session projection; the driver re-reads it whenever a team
  // event crosses the session bus rather than re-folding the events itself, so
  // the rendered roster and task board cannot drift from the runtime's state.
  const sessionProjections = ctx.sessionProjections

  // Rebuild the display from the durable log before the live stream attaches:
  // a resumed session's seeded events are not re-broadcast, so the fold runs
  // over them once here and live events fold through the same path below.
  // Child session id → friendly label, captured from every child's descriptor
  // event on the global bus, so relay/settlement notice text can rename the
  // raw session id it embeds to match the roster.
  const childLabels = new Map<string, string>()
  // Child session id → its descriptor's mode (`one-shot`/`continuable`),
  // captured at the same point as the label; it decides whether the child's
  // transcript view offers an input box (continuation prompts).
  const childModes = new Map<string, string>()
  // Durable workflow runs folded from the four `tool-workflow/*` session
  // events (the recorder writes them into this session for top-level runs),
  // rebuilt by the replay on resume and advanced live on the session bus.
  const workflowRuns = new Map<string, WorkflowRunState>()
  /** Every workflow member child id ever seen; add-only, so the roster and
   *  the panelTick reap never touch them — the panel's Enter must keep
   *  working for a member transcript. */
  const workflowChildIds = new Set<string>()
  /** Background jobs by id, in registration order. The registry may drop a
   *  settled job from `list()` at any time (`removed`), but the panel lingers
   *  it for a beat — so the driver keeps its own copy with a settledAt stamp. */
  const jobsRows = new Map<string, JobDisplayState>()
  /** Jobs whose linger expired. The registry's list() retains settled jobs
   *  until the owner is disposed, so without a tombstone a retired row would
   *  be re-added on the next tick with a fresh settle stamp — a revive loop
   *  that pins it to the panel forever. Ids are unique for the process life
   *  (`<kind>-N` monotonics), so this set can only grow with real jobs. */
  const jobsRetired = new Set<string>()
  /** The job whose live output is expanded; its read cursor and buffer. */
  let jobsOpen: string | undefined
  let jobsOpenCursor = 0
  let jobsOpenBuffer = ''
  let jobsOpenLossy = false
  /** Epoch ms of the detail's armed kill gesture; armed while within
   *  JOB_KILL_ARM_MS. Derived at projection time, so the panel tick re-render
   *  disarms it without a dedicated timer. */
  let jobsKillArmedAt: number | undefined
  // Child session id → the error detail of its last failed turn, so the child's
  // settlement notice can show the concrete cause instead of just "failed".
  // Cleared by any later non-error turn, so a child that recovered shows none.
  const childErrors = new Map<string, { message: string; code: string }>()
  // Follow-ups submitted while a step is in flight queue behind the running
  // turn, so their durable user/message echo is delayed; render one local echo
  // per such submission now (keyed by message id) and drop it the moment the
  // real event lands, so input is never silently swallowed while the agent is busy.
  const pendingUser: { id: string; text: string }[] = []
  // Continuation prompts sent to a child are only claimed by its inbox at the
  // next step/turn boundary, so their durable user/message echo is delayed the
  // same way; the echo is keyed by the prompt's requestId (persisted as the
  // landed message's source.rpcId) and dropped when that event lands.
  const childPending = new Map<string, { id: string; text: string }[]>()
  // The official Agent Teams tools register without presentation, so a local
  // table renders their calls; every other tool reads the presentation its own
  // registration carries (absent tools fall back to the generic card).
  const registeredTools = ctx.get('tools')
  const deps: FoldDeps = {
    tools: { get: name => teamToolPresentation(name) ?? registeredTools?.get(name) },
    childLabels,
    childErrors,
  }
  let state = createFrameState()
  // The status bar shows the effective sandbox mode: the policy service folds
  // the session's override onto the deployment default (config or env).
  const policy = ctx.get('sandboxPolicy') as
    | { resolve(request: { session: unknown }): { mode: string; workspaceRoot: string } }
    | undefined
  const sandboxMode = policy?.resolve({ session: agent.session }).mode
  // The badge prefers the permission preset selection: the service derives it
  // from the logged knob overrides (a preset key, `auto`, or `custom`), while
  // the raw sandbox knob would badge the Auto preset as danger-full-access,
  // hiding the reviewer that guards its open sandbox. Structural read, the
  // same pattern as sandboxPolicy — no upstream import.
  const permissionPresets = ctx.get('permissionPresets') as
    | { current(session: unknown): string }
    | undefined
  // The continuation seam for opened child transcripts: one human message
  // addressed to a continuable direct child. Structural read, the same
  // pattern as sandboxPolicy — no upstream import. The requestId is minted by
  // us and persisted as the landed message's source.rpcId, the key the local
  // echo reconciles against; success resolves once the child inbox admits the
  // message, its execution is independent of the call.
  const subagents = ctx.get('subagents') as
    | {
      prompt(request: {
        requestId: string
        parentSessionId: string
        childSessionId: string
        mode: 'continuable'
        delivery: 'queue' | 'steer'
        content: readonly { type: 'text'; text: string }[]
      }, signal: AbortSignal): Promise<{ messageId: string }>
    }
    | undefined
  // The background-jobs registry: a structured read like every other service
  // the driver touches, so no upstream runtime import crosses the boundary.
  // `readAt` is the observer's non-consuming read (the model's `read` cursor
  // must stay untouched); `list` is owner-fenced to this session.
  const jobs = ctx.get('jobs') as
    | {
      list(caller?: unknown): readonly JobViewShape[]
      readAt(id: string, from: number, caller?: unknown): { chunks: readonly { text: string }[]; next: number; lossy: boolean }
      kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
      events: {
        subscribe(filter: { owner: string }, listener: (event: JobRegistryEvent) => void): () => void
      }
    }
    | undefined
  const childPromptSignal = new AbortController().signal
  let view: RenderView = {
    status: {
      model: selection.model,
      cwd: process.cwd(),
      ...sandboxMode === undefined ? {} : { mode: sandboxMode },
      ...selection.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort },
    },
    // A --continue that found nothing to resume says so instead of silently
    // opening a fresh session; the notice clears on the first submission.
    ...(continueMissed
      ? { overlay: { kind: 'notice' as const, text: 'no stored session for this directory; started a new one' } }
      : {}),
  }
  // The footer's context ratio needs the model's window, and the effort badge
  // shows the effective reasoning strength (the selection when set, otherwise
  // the adapter's default). Adapters that disclose neither leave the footer
  // without those segments. The lookup can hit the provider, so it runs in
  // the background: the first frame never waits on it, and the footer fills
  // in when the info resolves.
  let contextWindow: number | undefined
  let latestUsed: number | undefined
  void (async () => {
    const info = (await ctx.get('llm')
      ?.resolveModelInfo(selection.provider, selection.model)
      .catch(() => undefined)) as
      | { context?: { contextWindow: number }; reasoning?: { defaultEffort?: string } }
      | undefined
    const window = info?.context?.contextWindow
    const effort = selection.reasoningEffort ?? info?.reasoning?.defaultEffort
    if (window === undefined && effort === undefined) return
    contextWindow = window
    view = view.status === undefined
      ? view
      : {
        ...view,
        status: {
          ...view.status,
          ...window === undefined ? {} : { context: { used: latestUsed ?? 0, window } },
          ...effort === undefined ? {} : { effort },
        },
      }
    renderer.render(state, withPanel(view))
  })()
  // Streaming chunks arrive far faster than the terminal can redraw: fold them
  // into one render per window, while non-stream events (commands, approvals,
  // settled messages) render immediately.
  // The subagent panel's roster: unfinished direct children of the owned
  // session, each carrying its own fold. The panel slice is computed per
  // render rather than stored in the base view, so every render path picks up
  // roster changes without threading them through the overlay/status setters.
  const children = new Map<string, ChildEntry>()
  let panelSelected: number | undefined
  /** The selected team-member row in the team panel; undefined keeps focus elsewhere. */
  let teamSelected: number | undefined
  /** The selected workflow row (0 = main); undefined keeps focus elsewhere. */
  let workflowSelected: number | undefined
  /** The selected job row (1-based); undefined keeps focus elsewhere. */
  let jobsSelected: number | undefined
  let openChild: string | undefined
  // The panels own the keys while a child transcript is open (↓ dropped into
  // navigation from the child view); without it a retained selection is only
  // the row highlight and the child keeps the keyboard.
  let panelNav = false

  /** The child's latest visible activity: the most recent tool card's title. */
  function childActivity(childState: FrameState): string | undefined {
    const last = childState.frames.at(-1)
    if (last === undefined || last.kind !== 'tool') return undefined
    // A panel row is one physical line: the shared fold turns a multiline
    // script's title into its `; ` one-liner, then the row's width clamp
    // takes over.
    const folded = foldInvocationLine(last.call.title)
    return folded === '' ? undefined : folded
  }

  /**
   * The subagent panel rows in roster insertion order, excluding team members —
   * a teammate is rendered (and navigated) in the team panel instead, so listing
   * it here too would duplicate it across both panels.
   */
  function rosterRows(): SubagentRow[] {
    const teamMemberIds = new Set(teamBase?.members.map(member => member.id) ?? [])
    return [...children.entries()]
      // Teammates render (and navigate) in the team panel and workflow members
      // in the workflow panel; listing either here too would duplicate rows.
      .filter(([childId]) => !teamMemberIds.has(childId) && !workflowChildIds.has(childId))
      .map(([childId, entry]) => {
        const activity = childActivity(entry.state)
        return {
          childId,
          label: entry.label,
          ...activity === undefined ? {} : { activity },
          startedAt: entry.startedAt,
          inputTokens: entry.inputTokens,
          fading: entry.fading,
        }
      })
  }

  /**
   * Fold one durable `tool-workflow/*` event into the run map — the same model
   * as the web client's workflow-run definition: members pair by seq, orphan
   * agent-ends (a failed start consumed the seq without emitting events) and
   * events for unknown runs are ignored, and a run without a run-end derives
   * 'interrupted' unless a live event proves it is still running. `live`
   * distinguishes the replay loop from the session bus.
   */
  const trackWorkflow = (event: SessionEvent, live: boolean): void => {
    switch (event.type) {
      case 'tool-workflow/run-start': {
        const run: WorkflowRunState = {
          id: event.data.runId,
          name: event.data.name,
          stopReason: undefined,
          liveSeen: live,
          members: new Map(),
        }
        workflowRuns.set(run.id, run)
        return
      }
      case 'tool-workflow/agent-start': {
        const run = workflowRuns.get(event.data.runId)
        if (run === undefined) return
        if (live) run.liveSeen = true
        const { seq, label, phase, childId } = event.data
        run.members.set(seq, { seq, label, phase, childId, outcome: undefined })
        workflowChildIds.add(childId)
        // Label backfill: a workflow child's descriptor carries no label, so
        // the agent-start label is the child's display identity — for the
        // fold's notices, a later foldChildEvent entry, and an entry that
        // already exists (either arrival order works).
        childLabels.set(childId, label)
        const entry = children.get(childId)
        if (entry !== undefined) entry.label = label
        return
      }
      case 'tool-workflow/agent-end': {
        const run = workflowRuns.get(event.data.runId)
        if (run === undefined) return
        if (live) run.liveSeen = true
        const member = run.members.get(event.data.seq)
        if (member === undefined) return
        member.outcome = event.data.outcome
        return
      }
      case 'tool-workflow/run-end': {
        const run = workflowRuns.get(event.data.runId)
        if (run === undefined) return
        run.stopReason = event.data.stopReason
        return
      }
      default:
        return
    }
  }

  /**
   * Refresh the team panel's projection-derived data. Members keep their session
   * id so withPanel can enrich each with its live child runtime (activity,
   * elapsed, tokens) at render time — those fields move on child events and the
   * panel tick, not on team events, so enriching per render keeps them fresh.
   * Cleared while no team exists, so the panel stays hidden until the first
   * teammate is spawned.
   */
  let teamBase: { members: { id: string; name: string; description: string; phase: string }[]; tasks: TeamTaskRow[] } | undefined
  function refreshTeam(): void {
    const team = sessionProjections?.stateOf(agent.session, 'agentTeam')
    const activeTasks = team === undefined ? [] : team.tasks.filter(task => task.status !== 'deleted')
    // The panel shows while the team holds any roster OR any task: a lead
    // plans tasks before spawning workers (team_task_create with an empty
    // roster), and the members-only guard used to blank the board exactly
    // then — hiding the very tasks the lead had just written.
    if (team === undefined || (team.members.length === 0 && activeTasks.length === 0)) {
      teamBase = undefined
      return
    }
    teamBase = {
      members: team.members.map(member => ({ id: member.id, name: member.name, description: member.description, phase: member.phase })),
      tasks: activeTasks
        .map(task => {
          const ownerName = task.ownerId === undefined
            ? undefined
            : team.members.find(member => member.id === task.ownerId)?.name
          return {
            subject: task.subject,
            status: task.status,
            ...ownerName === undefined ? {} : { ownerName },
            // A task stays blocked while any blocker is not yet completed.
            blocked: task.blockedBy.some(blockerId => team.tasks.find(candidate => candidate.id === blockerId)?.status !== 'completed'),
          }
        }),
    }
  }

  /** Enrich the projection members with their live child runtime for the panel. */
  function teamPanel(): TeamPanelInfo | undefined {
    if (teamBase === undefined) return undefined
    return {
      members: teamBase.members.map(member => {
        // Show live runtime (activity, elapsed, tokens) only while the member's
        // agent is still resident (working). Once it settles and is disposed,
        // the row drops back to its roster identity so a finished teammate does
        // not show a clock that keeps ticking.
        const entry = agents?.get(SessionId(member.id)) === undefined ? undefined : children.get(member.id)
        const activity = entry === undefined ? undefined : childActivity(entry.state)
        return {
          id: member.id,
          name: member.name,
          description: member.description,
          phase: member.phase,
          ...activity === undefined ? {} : { activity },
          ...entry === undefined ? {} : { startedAt: entry.startedAt, inputTokens: entry.inputTokens },
        }
      }),
      tasks: teamBase.tasks,
    }
  }

  /**
   * The standing goal strip's projection-derived data, plus the process-local
   * continuation switch the projection deliberately omits. `goalBase` is
   * cleared while no goal is current (never created, or cleared), so the strip
   * stays hidden until the first goal lands. `goalActivation` starts disarmed —
   * exactly the resume/fork default — and only the `goal/activation-changed`
   * bus flips it, so the driver never invents unattended continuation.
   */
  let goalBase: GoalPanelInfo | undefined
  let goalActivation: 'armed' | 'disarmed' = 'disarmed'
  function refreshGoal(): void {
    // Read the durable goal off the same projection the runtime owns (the
    // agentTeam pattern) rather than folding goal/change ourselves; the
    // StateMap cell carries a strict-replay failure we must not render past.
    const cell = sessionProjections?.stateOf(agent.session, 'goal')
    const current = cell === undefined || cell.failure !== null ? null : cell.current
    if (current === null) {
      goalBase = undefined
      return
    }
    const { goal, roundsStarted } = current
    goalBase = {
      objective: goal.objective,
      phase: goal.phase as GoalPhase,
      roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      activation: goalActivation,
      ...goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason },
    }
  }

  /** Upsert one registry job view into the panel's own table. */
  function upsertJobRow(job: JobViewShape): void {
    const existing = jobsRows.get(job.id)
    const settledNow = job.status !== 'running' && job.status !== 'stopping'
    jobsRows.set(job.id, {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      progress: job.progress,
      detail: job.detail,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // Stamp the settle once and keep it: refreshJobs re-reads list() every
      // tick, and the registry retains settled jobs, so a fresh stamp each
      // time would reset the linger clock and pin the row forever.
      settledAt: settledNow ? (existing?.settledAt ?? Date.now()) : undefined,
    })
  }

  /** Merge the registry's owner-fenced list into the linger table: live jobs
   *  and settled jobs inside their linger window survive; a settled job past
   *  the window retires whether or not the registry still lists it (list()
   *  keeps settled jobs until the owner is disposed). An open output block
   *  pins its row so the view never vanishes mid-read. */
  function refreshJobs(): void {
    if (jobs === undefined) return
    const now = Date.now()
    const listed = new Set<string>()
    for (const job of jobs.list(agent.session.id)) {
      listed.add(job.id)
      // A retired job's linger has already run to completion; the registry
      // still lists it, but re-adding it would stamp a fresh settledAt and
      // resurrect the row — skip tombstoned ids.
      if (jobsRetired.has(job.id)) continue
      upsertJobRow(job)
    }
    let dropped = false
    for (const [id, row] of jobsRows) {
      const expired = row.settledAt !== undefined && now - row.settledAt > SETTLED_JOB_LINGER_MS
      // A live job the registry dropped without a settle (defensive; the
      // `removed` event normally handles this) goes at once.
      const goneLive = !listed.has(id) && row.settledAt === undefined
      if ((expired || goneLive) && jobsOpen !== id) {
        if (expired) jobsRetired.add(id)
        jobsRows.delete(id)
        dropped = true
      }
    }
    // The panel tick's idle guard can return before it repaints once the last
    // row goes, so a retirement forces its own render.
    if (dropped) scheduleRender(true)
  }

  /** Append the opened job's new output bytes to its tail buffer. */
  function readOpenJob(): void {
    if (jobs === undefined || jobsOpen === undefined) return
    const read = jobs.readAt(jobsOpen, jobsOpenCursor, agent.session.id)
    if (read.lossy) jobsOpenLossy = true
    if (read.chunks.length > 0) {
      jobsOpenBuffer += read.chunks.map(chunk => chunk.text).join('')
      if (jobsOpenBuffer.length > JOB_OUTPUT_BUFFER_MAX) {
        jobsOpenBuffer = jobsOpenBuffer.slice(-JOB_OUTPUT_BUFFER_MAX)
        jobsOpenLossy = true
      }
    }
    jobsOpenCursor = read.next
  }

  /** Close the expanded output block and forget its cursor. */
  function closeJobOutput(): void {
    jobsOpen = undefined
    jobsOpenCursor = 0
    jobsOpenBuffer = ''
    jobsOpenLossy = false
    jobsKillArmedAt = undefined
  }

  /** The registry's event bus: lifecycle events move the linger table, the
   *  `output` pulse advances the opened job's tail. */
  function onJobEvent(event: JobRegistryEvent): void {
    if (event.type === 'output') {
      // Only the opened job's bytes reach the panel; the tail read is cheap,
      // so repaint at once rather than waiting for the next panel tick.
      if (event.id === jobsOpen) {
        readOpenJob()
        scheduleRender(true)
      }
      return
    }
    if (event.type === 'removed') {
      jobsRows.delete(event.job.id)
      if (jobsOpen === event.job.id) closeJobOutput()
      scheduleRender(true)
      return
    }
    upsertJobRow(event.job)
    scheduleRender(true)
  }

  /** The jobs panel slice for the render. */
  function jobsPanel(): JobsPanelInfo | undefined {
    if (jobsRows.size === 0) return undefined
    const rows: JobRow[] = [...jobsRows.values()].map(row => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      status: row.status,
      ...row.progress === undefined ? {} : { progress: row.progress },
      ...row.detail === undefined ? {} : { detail: row.detail },
      elapsedMs: (row.finishedAt ?? Date.now()) - row.startedAt,
    }))
    return { rows }
  }

  /** The kind-driven heading and label field name for one job's detail view. */
  function jobDetailVocabulary(kind: string): { title: string; labelField: string } {
    if (kind === 'bash' || kind === 'pwsh') return { title: 'Command details', labelField: 'Command' }
    if (kind === 'subagent') return { title: 'Subagent details', labelField: 'Task' }
    if (kind === 'workflow') return { title: 'Workflow details', labelField: 'Workflow' }
    return { title: 'Job details', labelField: 'Label' }
  }

  /** The opened job's full-screen detail slice, or undefined when none is open. */
  function jobDetail(): JobDetailView | undefined {
    if (jobsOpen === undefined) return undefined
    const row = jobsRows.get(jobsOpen)
    if (row === undefined) return undefined
    const { title, labelField } = jobDetailVocabulary(row.kind)
    const killArmed = jobsKillArmedAt !== undefined && Date.now() - jobsKillArmedAt < JOB_KILL_ARM_MS
    // Only a live job can be stopped; a settled row shows the outcome alone.
    const killable = row.status === 'running' || row.status === 'stopping'
    return {
      jobId: row.id,
      title,
      labelField,
      label: row.label,
      status: row.status,
      ...row.detail === undefined ? {} : { detail: row.detail },
      elapsedMs: (row.finishedAt ?? Date.now()) - row.startedAt,
      output: jobsOpenBuffer,
      lossy: jobsOpenLossy,
      killArmed,
      killable,
    }
  }

  /** Collision-free phase-group key preserving the absent-vs-empty identity
   *  (the web client's workflowPhaseKey). */
  function workflowPhaseKey(phase: string | undefined): string {
    return phase === undefined ? 'missing' : `value:${phase.length}:${phase}`
  }

  /**
   * Project the folded runs into the panel contract. The display order — runs
   * in insertion order, phases in first-appearance order, members in seq
   * order — is defined here alone: the renderer draws exactly this nesting and
   * the navigation handlers map indices onto the same flat order, so the two
   * can never drift.
   */
  function workflowPanel(): WorkflowPanelInfo | undefined {
    if (workflowRuns.size === 0) return undefined
    let memberCount = 0
    const runs: WorkflowRunRow[] = []
    for (const run of workflowRuns.values()) {
      const status: WorkflowRunStatus = run.stopReason !== undefined
        ? run.stopReason === 'completed' ? 'completed'
          : run.stopReason === 'cancelled' ? 'cancelled'
          : 'failed'
        : run.liveSeen ? 'running' : 'interrupted'
      const groups: { key: string; phase: string | undefined; members: WorkflowMemberRow[] }[] = []
      const groupIndex = new Map<string, number>()
      for (const member of run.members.values()) {
        const key = workflowPhaseKey(member.phase)
        let index = groupIndex.get(key)
        if (index === undefined) {
          index = groups.length
          groupIndex.set(key, index)
          groups.push({ key, phase: member.phase, members: [] })
        }
        // Live runtime (activity/elapsed/tokens) only while the member's agent
        // is resident — the teamPanel() rule, so settled rows show no clock.
        const entry = agents?.get(SessionId(member.childId)) === undefined ? undefined : children.get(member.childId)
        const activity = entry === undefined ? undefined : childActivity(entry.state)
        const memberStatus: WorkflowMemberStatus = member.outcome !== undefined
          ? member.outcome
          : status === 'interrupted' ? 'interrupted' : 'running'
        groups[index]!.members.push({
          seq: member.seq,
          // The engine truncates labels but a script may still pass an empty
          // one; fall back so the row is never blank.
          label: member.label === '' ? `agent #${member.seq}` : member.label,
          childId: member.childId,
          status: memberStatus,
          ...activity === undefined ? {} : { activity },
          ...entry === undefined ? {} : { startedAt: entry.startedAt, inputTokens: entry.inputTokens },
        })
        memberCount += 1
      }
      runs.push({
        id: run.id,
        name: run.name,
        status,
        phases: groups.map((group): WorkflowPhaseGroup => ({
          key: group.key,
          ...group.phase === undefined ? {} : { phase: group.phase },
          members: group.members,
        })),
      })
    }
    return { runs, memberCount }
  }

  // The input bar's slash menu: the registry's discovery descriptors mapped to
  // the renderer's CommandInfo shape. Recomputed per render so commands
  // registered after startup (late plugins) show up; list() is a small sorted
  // snapshot, cheap even at the panel tick's per-second cadence.
  const commandInfos = (): readonly CommandInfo[] => {
    const registry: CommandRuntime | undefined = ctx.get('commands')
    // Test harnesses may provide a partial commands fake (execute only).
    if (registry === undefined || typeof registry.list !== 'function') return []
    const descriptors: readonly CommandDescriptor[] | undefined = registry.list(agent)
    if (descriptors === undefined) return []
    return descriptors.map((descriptor): CommandInfo => ({
      name: descriptor.name,
      ...(descriptor.description === '' ? {} : { description: descriptor.description }),
      ...(descriptor.input?.hint === undefined ? {} : { hint: descriptor.input.hint }),
    }))
  }
  /** The base view plus the panel slice computed from the live roster. */
  function withPanel(base: RenderView): RenderView {
    const next: RenderView = { ...base }
    const infos = commandInfos()
    if (infos.length > 0) next.commands = infos
    if (goalBase !== undefined) next.goal = goalBase
    const rows = rosterRows()
    if (rows.length > 0) {
      next.subagents = rows
      if (panelSelected !== undefined) next.subagentSelected = Math.min(panelSelected, rows.length)
    }
    const team = teamPanel()
    if (team !== undefined) {
      next.team = team
      // Rows are [main, ...members]: the selection clamps to the member count.
      if (teamSelected !== undefined) next.teamSelected = Math.min(teamSelected, Math.max(0, team.members.length))
    }
    const workflow = workflowPanel()
    if (workflow !== undefined) {
      next.workflow = workflow
      // Members only (no main row): the 1-based selection clamps to the count.
      if (workflowSelected !== undefined) next.workflowSelected = Math.min(workflowSelected, workflow.memberCount)
    }
    const jobPanel = jobsPanel()
    if (jobPanel !== undefined) {
      next.jobs = jobPanel
      // Members only (no main row): the 1-based selection clamps to the count.
      if (jobsSelected !== undefined) next.jobsSelected = Math.min(jobsSelected, jobPanel.rows.length)
    }
    const openJobDetail = jobDetail()
    if (openJobDetail !== undefined) next.openJob = openJobDetail
    if (openChild !== undefined) {
      const opened = children.get(openChild)
      if (opened !== undefined) {
        const pending = childPending.get(openChild)
        // A teammate is identified by its roster name — unique within the
        // team and the same identity the panel row and send_message use —
        // instead of the model-worded spawn description; other children keep
        // their descriptor label.
        const member = teamBase?.members.find(candidate => candidate.id === openChild)
        next.openSubagent = {
          childId: openChild,
          label: member === undefined ? opened.label : member.name,
          state: opened.state,
          ...(opened.continuable ? { continuable: true } : {}),
          ...(pending === undefined || pending.length === 0 ? {} : { pending: [...pending] }),
        }
      }
    }
    if (pendingUser.length > 0) next.pendingUser = [...pendingUser]
    if (panelNav) next.panelNav = true
    return next
  }

  let streamRenderPending = false
  const scheduleRender = (immediate: boolean): void => {
    if (immediate) {
      renderer.render(state, withPanel(view))
      return
    }
    if (streamRenderPending) return
    streamRenderPending = true
    setTimeout(() => {
      streamRenderPending = false
      renderer.render(state, withPanel(view))
    }, STREAM_RENDER_INTERVAL_MS)
  }
  const adopt = (next: FrameState, immediate: boolean): void => {
    state = next
    scheduleRender(immediate)
  }
  const setOverlay = (overlay: Overlay | undefined): void => {
    view = overlay === undefined
      ? { ...(view.status === undefined ? {} : { status: view.status }) }
      : { ...view, overlay }
    scheduleRender(true)
  }
  // Fold one direct child's event into its own frame state for the panel and
  // the child transcript view.
  const foldChildEvent = (childId: string, event: SessionEvent): void => {
    let entry = children.get(childId)
    if (entry === undefined) {
      entry = {
        // The friendly label is captured from the child's seeded descriptor in
        // the session/event handler before this fold runs; fall back to a
        // shortened id when no descriptor label is available.
        label: childLabels.get(childId) ?? `subagent ${childId.slice(0, 8)}`,
        // Captured from the same descriptor; a missing or unknown mode keeps
        // the child read-only rather than offering a prompt it cannot take.
        continuable: childModes.get(childId) === 'continuable',
        startedAt: event.time,
        inputTokens: 0,
        state: createFrameState(),
        fading: false,
        fadeAt: undefined,
      }
      children.set(childId, entry)
    }
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      entry.inputTokens += event.data.usage.inputTokens + (event.data.usage.cacheReadTokens ?? 0)
    }
    entry.state = foldEvent(entry.state, event, deps).state
    // Streaming rides the assistant-stream bus, not durable child events, so
    // every child session event here is low-frequency and renders immediately.
    scheduleRender(true)
  }
  // Capture one direct child's terminal turn outcome: an error turn stores its
  // structured failure so the child's settlement notice can surface the cause;
  // any other turn end clears a stale entry so a recovered child shows none.
  const trackChildError = (childId: string, event: SessionEvent): void => {
    if (event.type !== 'turn/end') return
    const reason = event.data.reason
    if (reason.kind === 'error') {
      childErrors.set(childId, { message: readableFailureMessage(reason.error.message), code: reason.error.code })
    } else {
      childErrors.delete(childId)
    }
  }
  // The footer's context ratio follows the latest step's token report.
  const trackUsage = (event: SessionEvent): void => {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return
    const used = event.data.usage.inputTokens + (event.data.usage.cacheReadTokens ?? 0)
    latestUsed = used
    if (contextWindow === undefined) return
    view = view.status === undefined
      ? view
      : { ...view, status: { ...view.status, context: { used, window: contextWindow } } }
  }
  // The footer's badge shows the session's permission preset selection: the
  // permission service folds the three knob events (permission/preset,
  // sandbox/mode, approval/policy) into one derived name — a preset key,
  // `auto`, or `custom` — so each of them re-reads it. Without a permission
  // service composed the badge falls back to the raw sandbox/mode payload,
  // the pre-preset behavior.
  const PERMISSION_KNOB_EVENTS: ReadonlySet<string> = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])
  const refreshPermissionBadge = (event?: SessionEvent): void => {
    if (view.status === undefined) return
    const current = permissionPresets?.current(agent.session)
    if (current !== undefined) {
      view = { ...view, status: { ...view.status, mode: current } }
      return
    }
    if (event !== undefined && (event.type as string) === 'sandbox/mode') {
      const mode = (event.data as { mode?: unknown }).mode
      if (typeof mode === 'string') view = { ...view, status: { ...view.status, mode } }
    }
  }
  // Fold the replay without per-event renders: the intermediate states are
  // not interactable, painting each one wastes time on large logs, and an
  // early paint of the still-empty stream would flash the fresh-session
  // welcome splash over a resumed session. The single initial render below
  // publishes the fully replayed state at once.
  for (const event of agent.session.snapshotEvents()) {
    trackUsage(event)
    trackWorkflow(event, false)
    state = foldEvent(state, event, deps).state
  }

  // Seed the team panel from the durable log so a resumed session with an
  // existing team shows its roster and task board immediately.
  refreshTeam()
  // Seed the permission badge from the folded projection before the first
  // render: a resumed session's last /permission switch lives in the log.
  refreshPermissionBadge()
  // Seed the goal strip from the durable log too: a resumed session with a
  // current goal shows its objective and round progress immediately, starting
  // disarmed until an activation event says otherwise.
  refreshGoal()
  // Seed the jobs panel from the registry, then follow its event bus. The
  // subscription is owner-fenced to this session; `subscribe` is itself
  // effect-scoped upstream, so wrapping it in ctx.effect disposes the listener
  // with the driver's fiber. A resumed session's still-running jobs show up on
  // the first list().
  refreshJobs()
  ctx.effect(() => {
    const dispose = jobs?.events.subscribe({ owner: agent.session.id }, onJobEvent)
    return () => { dispose?.() }
  }, 'tui:jobs-subscribe')
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.header.id !== agent.session.id) {
      // Descriptors are seeded at session creation, not live-appended, so they
      // never fire on this bus; read the child's friendly label and its
      // continuation mode from its own event log the first time any of its
      // events reaches us.
      if (!childLabels.has(session.header.id)) {
        const descriptor = session.snapshotEvents().find((e) => (e as { type: string }).type === 'subagent/descriptor')
        const label = descriptor === undefined ? undefined : (descriptor.data as { label?: unknown }).label
        if (typeof label === 'string' && label !== '') childLabels.set(session.header.id, label)
        const mode = descriptor === undefined ? undefined : (descriptor.data as { mode?: unknown }).mode
        if (typeof mode === 'string') childModes.set(session.header.id, mode)
      }
      // Direct children feed the panel below the status bar; deeper
      // descendants stay in their own sessions. Error capture here runs for
      // every direct-child turn end, so the later settlement notice can show
      // the concrete cause.
      if (session.header.parentSession === agent.session.id) {
        // A continuation prompt's optimistic echo lands as the child's durable
        // user/message carrying our minted requestId as its source.rpcId; drop
        // the local copy so the message does not render twice.
        if (event.type === 'user/message') {
          const rpcId = (event.data.source as { rpcId?: unknown }).rpcId
          const pending = typeof rpcId === 'string' ? childPending.get(session.header.id) : undefined
          const echoed = pending?.findIndex(echo => echo.id === rpcId) ?? -1
          if (pending !== undefined && echoed !== -1) {
            pending.splice(echoed, 1)
            if (pending.length === 0) childPending.delete(session.header.id)
          }
        }
        trackChildError(session.header.id, event)
        foldChildEvent(session.header.id, event)
      }
      return
    }
    trackUsage(event)
    if (PERMISSION_KNOB_EVENTS.has(event.type as string)) refreshPermissionBadge(event)
    // A team event moves the authoritative agentTeam projection, so re-read it
    // before the render below to keep the team panel current.
    if ((event.type as string).startsWith('team/')) refreshTeam()
    // A goal event moves the goal projection's durable half (phase, objective,
    // the round budget), so re-read it before the render below. The round
    // counter itself advances on the goal-sourced user/message below, not here.
    if ((event.type as string).startsWith('goal/')) refreshGoal()
    // The four durable workflow-record events fold into the run map; the
    // adopt below renders the updated panel.
    if ((event.type as string).startsWith('tool-workflow/')) trackWorkflow(event, true)
    // A message committed while a step was in flight rendered a local steering
    // echo; now that its durable user/message frame folds in below, drop the
    // local copy so the message does not appear twice.
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const echoed = pendingUser.findIndex(pending => pending.id === (event.data.id as string))
      if (echoed !== -1) pendingUser.splice(echoed, 1)
    }
    // The goal projection advances its round counter on the admitted
    // goal-round user/message (source.kind 'goal'), not on goal/change — so
    // this is the trigger that keeps `round N/M` moving. The message itself
    // stays out of the transcript (frames.ts ignores non-user sources). The
    // `goal` MessageSourceMap merge lives in the package root (which drags
    // dsh-agent/dsh-llm into the bundle), so match the kind as a bare string —
    // the same reason the goal/ prefix match above is untyped.
    if (event.type === 'user/message' && (event.data.source.kind as string) === 'goal') refreshGoal()
    // Streaming no longer rides durable session events (the harness publishes it
    // on the agent-scoped assistant-stream bus instead), so every remaining
    // session event is low-frequency and renders immediately.
    adopt(foldEvent(state, event, deps).state, true)
  })
  // The goal's process-local continuation switch never becomes a session event;
  // the only signal is this cordis bus event. Track it for the owned session so
  // the strip's armed/disarmed badge follows the runtime's actual state.
  ctx.on('goal/activation-changed', (payload: { sessionId: string; goal?: { activation: 'armed' | 'disarmed' } }) => {
    if (payload.sessionId !== agent.session.id) return
    goalActivation = payload.goal?.activation ?? 'disarmed'
    refreshGoal()
    scheduleRender(true)
  })
  // Live assistant streaming arrives on the agent-scoped `agent/assistant-stream`
  // event as transient start/chunk/end frames. Chunk frames carry only the
  // attemptId, so the opening frame's turn/step are remembered per attempt and a
  // synthetic, never-colliding seq stands in for the durable session seq live
  // frames lack. The main agent folds into the primary stream; a direct child
  // folds into its panel entry when one already exists.
  const liveAttempts = new Map<string, { turn: number; step: number; seq: number }>()
  let liveSeq = 0
  ctx.on('agent/assistant-stream', ({ agent: subject, frame }: { agent: typeof agent; frame: AssistantStreamFrame }) => {
    if (frame.type === 'start') {
      liveSeq -= 1
      liveAttempts.set(frame.attemptId, { turn: frame.turn, step: frame.step, seq: liveSeq })
      return
    }
    if (frame.type === 'end') {
      liveAttempts.delete(frame.attemptId)
      return
    }
    const attempt = liveAttempts.get(frame.attemptId)
    if (attempt === undefined) return
    if (subject === agent) {
      adopt(foldAssistantStreamChunk(state, attempt.turn, attempt.step, frame.chunk, frame.time, attempt.seq).state, false)
      return
    }
    if (subject.session.header.parentSession !== agent.session.id) return
    const entry = children.get(subject.session.header.id)
    if (entry === undefined) return
    entry.state = foldAssistantStreamChunk(entry.state, attempt.turn, attempt.step, frame.chunk, frame.time, attempt.seq).state
    scheduleRender(false)
  })
  // The panel ticks once a second: elapsed rows refresh, a child whose agent
  // left the registry (its run settled) fades out after its delay, and the
  // thinking indicator's elapsed seconds advance.
  const panelTick = setInterval(() => {
    // React's development reconciler logs every committed component render as
    // a user-timing `performance.measure` entry, and Node's timeline never
    // evicts them: with teammates pinned the panel re-renders the whole tree
    // every second forever, which piled ~170 entries (~150KB) per render until
    // the heap died overnight (observed: 4GB, OOM crash). Clearing each tick
    // bounds the timeline to one tick's worth. Production React builds do not
    // instrument renders, so there this is a cheap no-op.
    performance.clearMarks()
    performance.clearMeasures()
    // Jobs tick for their own elapsed and linger-drop even with no child or
    // turn in flight; refreshJobs also merges the registry's current list.
    refreshJobs()
    if (children.size === 0 && state.turnStartedAt === undefined && jobsRows.size === 0) return
    const now = Date.now()
    const teamMemberIds = new Set(teamBase?.members.map(member => member.id) ?? [])
    for (const [childId, entry] of children) {
      // Team members and workflow members keep their transcript for their
      // panel's Enter-to-open, so they are never reaped; other children fade
      // once their agent settles.
      if (teamMemberIds.has(childId) || workflowChildIds.has(childId)) continue
      if (!entry.fading && entry.state.frames.length > 0 && agents.get(SessionId(childId)) === undefined) {
        entry.fading = true
        entry.fadeAt = now + SUBAGENT_FADE_MS
      }
      if (entry.fading && entry.fadeAt !== undefined && now >= entry.fadeAt && openChild !== childId) {
        children.delete(childId)
      }
    }
    scheduleRender(true)
  }, SUBAGENT_PANEL_TICK_MS)

  // Approval questions from the agent's tools answer through y/n keys; a
  // request for another agent passes through the waterfall unanswered.
  let pendingApproval: ((outcome: ApprovalOutcome) => void) | undefined
  ctx.on('approval/request', (req, next) => {
    if (req.agent.session.id !== agent.session.id) return next()
    // The panel's detail line: the request references the exact tool call
    // instead of duplicating its arguments; the pending frame for that call
    // carries the invocation summary (a terminal card's title is the
    // command), folded to one line like every other invocation surface.
    const pending = req.callId === undefined ? undefined : state.frames.find(
      (frame): frame is Extract<Frame, { kind: 'tool' }> =>
        frame.kind === 'tool' && frame.callId === req.callId && frame.result === undefined,
    )
    const detail = pending === undefined ? '' : foldInvocationLine(pending.call.title)
    // Localized presentation (upstream #4793): displayReason carries per-locale
    // display copy while the audit reason stays whatever the asker logged. The
    // terminal's own copy is Chinese, so resolve zh first, then the English
    // fallback the type guarantees, then the plain audit reason.
    const reason = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason
    setOverlay({
      kind: 'approval',
      toolName: req.toolName,
      ...reason === undefined ? {} : { reason },
      ...detail === '' ? {} : { detail },
      ...req.callId === undefined ? {} : { callId: req.callId },
    })
    return new Promise<ApprovalOutcome>((resolve) => {
      pendingApproval = resolve
      req.signal?.addEventListener('abort', () => { resolve('cancelled') })
    }).finally(() => {
      pendingApproval = undefined
      setOverlay(undefined)
    })
  })

  // ask_user_question (and plan-mode's exit_plan_mode review) reach the human
  // through the scoped `user-questions/request` waterfall: return an answer to
  // claim the request, or call next() to delegate. This listener sits on the
  // unscoped loader context, so it receives the main agent's requests; a
  // request that names a different live agent passes through. Without this
  // answerer the tool blocks forever (NO_PROVIDER) — and plan review fails.
  let pendingQuestion: ((answer: QuestionAnswer) => void) | undefined
  ctx.on('user-questions/request', (request, next) => {
    if (request.agent !== undefined && request.agent.session.id !== agent.session.id) return next()
    // Strip the upstream item to the terminal's structural mirror: the fields
    // the QuestionPanel renders. `intent` is kept (kind + approve) so the view
    // can narrow a plan-review request to its dedicated plan-review overlay;
    // every other intent kind renders through the generic option flow.
    const questions: QuestionItem[] = request.questions.map(question => ({
      id: question.id,
      question: question.question,
      ...question.detail === undefined ? {} : { detail: question.detail },
      ...question.header === undefined ? {} : { header: question.header },
      ...question.options === undefined
        ? {}
        : { options: question.options.map(option => ({
          label: option.label,
          ...option.description === undefined ? {} : { description: option.description },
        })) },
      ...question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect },
      ...question.intent === undefined
        ? {}
        : {
          intent: {
            kind: question.intent.kind,
            approve: question.intent.approve,
            // The logged plan call: the transcript renders the durable plan
            // document from that frame's arguments when it is on screen.
            ...question.intent.callId === undefined ? {} : { callId: question.intent.callId },
          },
        },
    }))
    setOverlay({
      kind: 'question',
      questions,
      ...request.wait?.callId === undefined ? {} : { callId: request.wait.callId },
    })
    return new Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>((resolve) => {
      // The view's answer is readonly (the view-types contract); the waterfall
      // wants the upstream's mutable batch, so convert here at the boundary.
      pendingQuestion = (answer) => resolve({
        answers: answer.answers.map(item => ({
          id: item.id,
          selected: [...item.selected],
          ...item.custom === undefined ? {} : { custom: item.custom },
        })),
      })
      // A cancelled turn aborts the request: answer every question empty so
      // the waterfall resolves (never hangs) and the model sees "no answer".
      request.signal?.addEventListener('abort', () => {
        resolve({ answers: questions.map(question => ({ id: question.id, selected: [] })) })
      })
    }).finally(() => {
      pendingQuestion = undefined
      setOverlay(undefined)
    })
  })

  // Command executions run against the session's command registry; an
  // unresolved slash line is a notice, never a model message.
  const commandSignal = new AbortController().signal
  // The exit is one-shot: rapid key chords (or keys landing while the tree
  // tears down after exit) must not start a second flush against a session
  // the teardown has already detached, and must not enqueue work on an agent
  // that is disposing.
  let exiting = false
  // An empty (or fully replayed) session folds nothing, so publish the initial
  // state once: the footer and input bar show from the first frame.
  renderer.render(state, withPanel(view))
  renderer.setHandlers({
    onCommit: (text) => {
      if (exiting) return
      setOverlay(undefined)
      if (!text.startsWith('/')) {
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        // While a turn is in flight the steered message waits for its next
        // step boundary, so its durable echo is delayed; render a local echo
        // now so the submission is visible instead of silently swallowed. The
        // session/event handler drops it once the real user/message frame lands.
        if (state.turnStartedAt !== undefined) {
          pendingUser.push({ id: message.id as string, text })
          scheduleRender(true)
        }
        agent.steer(message)
        return
      }
      const commands: CommandRuntime | undefined = ctx.get('commands')
      if (commands === undefined) {
        setOverlay({ kind: 'notice', text: `no command runtime: ${text} was not dispatched` })
        return
      }
      void commands.execute(agent, text, [], commandSignal).then((execution) => {
        if (execution === undefined) setOverlay({ kind: 'notice', text: `unknown command: ${text}` })
      })
    },
    onChildPrompt: (text) => {
      if (exiting || openChild === undefined) return
      const opened = children.get(openChild)
      if (opened === undefined || !opened.continuable) return
      setOverlay(undefined)
      if (subagents === undefined) {
        setOverlay({ kind: 'notice', text: 'no subagent service: the prompt was not sent' })
        return
      }
      const childId = openChild
      // The requestId is minted here and persisted as the landed message's
      // source.rpcId, so the session/event handler reconciles the optimistic
      // echo against it; the inbox admits the message before its execution.
      const requestId = randomUUID()
      const echoes = childPending.get(childId) ?? []
      echoes.push({ id: requestId, text })
      childPending.set(childId, echoes)
      scheduleRender(true)
      void subagents.prompt({
        requestId,
        parentSessionId: agent.session.id,
        childSessionId: childId,
        mode: 'continuable',
        // The terminal's single send gesture steers, matching the main input:
        // the message lands at the child's nearest step boundary.
        delivery: 'steer',
        content: [{ type: 'text', text }],
      }, childPromptSignal).catch((error: unknown) => {
        // Withdraw the optimistic echo and surface the cause; upstream rejects
        // with a stable `code` (discriminated by code, never by instanceof).
        const pending = childPending.get(childId)
        const echoed = pending?.findIndex(echo => echo.id === requestId) ?? -1
        if (pending !== undefined && echoed !== -1) {
          pending.splice(echoed, 1)
          if (pending.length === 0) childPending.delete(childId)
        }
        const code = (error as { code?: unknown }).code
        const message = (error as { message?: unknown }).message
        const reason = code === 'subagent/not-resumable' ? '该子代理不支持续聊（one-shot）'
          : code === 'subagent/parent-unavailable' ? '父会话不可用，无法投递'
          : code === 'subagent/unauthorized' ? '该子代理不属于当前会话'
          : code === 'subagent/delivery-unavailable' ? '子代理收件箱暂不可用'
          : typeof message === 'string' && message !== '' ? message
          : `发送失败（${String(code ?? 'unknown')}）`
        setOverlay({ kind: 'notice', text: `发送失败：${reason}` })
        scheduleRender(true)
      })
    },
    onJobKill: () => {
      if (exiting || jobsOpen === undefined) return
      const row = jobsRows.get(jobsOpen)
      if (row === undefined || (row.status !== 'running' && row.status !== 'stopping')) return
      // Two-step confirm: the first x arms the gesture, a second within the
      // window kills (the web button's same re-arm cadence — the panel tick's
      // re-render disarms a stale arm through the derived killArmed flag).
      const armed = jobsKillArmedAt !== undefined && Date.now() - jobsKillArmedAt < JOB_KILL_ARM_MS
      if (!armed) {
        jobsKillArmedAt = Date.now()
        scheduleRender(true)
        return
      }
      jobsKillArmedAt = undefined
      try {
        jobs?.kill(jobsOpen, agent.session.id, 'stopped from the terminal')
      } catch {
        // A kill racing the job's own settlement can throw (unknown job or a
        // fence rejection); the settled event converges the detail either way.
        setOverlay({ kind: 'notice', text: `停止失败：${jobsOpen} 已不在运行` })
      }
      scheduleRender(true)
    },
    onInterrupt: () => {
      if (exiting) return
      agent.cancel({ kind: 'user' })
    },
    onApproval: (choice: ApprovalChoice) => {
      if (exiting) return
      pendingApproval?.(choice === 'allow' ? 'allowed-once' : choice === 'reject' ? 'rejected' : 'cancelled')
    },
    onQuestionAnswer: (answer: QuestionAnswer) => {
      if (exiting) return
      pendingQuestion?.(answer)
    },
    onPanelOpen: () => {
      if (exiting) return
      // Navigation priority: team > workflow > subagent roster; Enter from any
      // opens the selected transcript. An existing selection is kept, so
      // dropping into navigation from an open child starts on that child's own
      // row. The workflow branch needs at least one member — a run that only
      // just started (no agent() yet) has no row worth cursoring.
      const workflow = workflowPanel()
      if (teamBase !== undefined && teamBase.members.length > 0) {
        if (teamSelected === undefined) teamSelected = 0
        panelSelected = undefined
        workflowSelected = undefined
        jobsSelected = undefined
      } else if (workflow !== undefined && workflow.memberCount > 0) {
        // Members only (no main row): the cursor starts on the first member;
        // Esc from the child view is the way back to the main view.
        if (workflowSelected === undefined) workflowSelected = 1
        panelSelected = undefined
        teamSelected = undefined
        jobsSelected = undefined
      } else if (rosterRows().length > 0) {
        if (panelSelected === undefined) panelSelected = 0
        teamSelected = undefined
        workflowSelected = undefined
        jobsSelected = undefined
      } else if (jobsRows.size > 0) {
        // Members only (no main row): the cursor starts on the first job; the
        // jobs panel is the ladder's last rung — the whole-session backdrop.
        if (jobsSelected === undefined) jobsSelected = 1
        panelSelected = undefined
        teamSelected = undefined
        workflowSelected = undefined
      } else {
        return
      }
      panelNav = true
      scheduleRender(true)
    },
    onPanelMove: (delta) => {
      if (exiting) return
      // A read-only child view has no editor to hand the keys to, so ↑ past
      // the first row stays put there instead of exiting navigation onto a
      // surface that cannot take input; Esc is the way out.
      const exitUpBlocked = openChild !== undefined
        && children.get(openChild)?.continuable !== true
      if (teamSelected !== undefined) {
        // ↑ at the main row leaves the panel back to where ↓ found it (the
        // input bar or the open child's editor), mirroring the entry gesture.
        if (delta < 0 && teamSelected === 0) {
          if (exitUpBlocked) return
          teamSelected = undefined
          panelNav = false
          scheduleRender(true)
          return
        }
        const count = teamBase?.members.length ?? 0
        if (count === 0) return
        // Rows are [main, ...members]: the selection spans 0..count.
        teamSelected = Math.min(count, Math.max(0, teamSelected + delta))
        scheduleRender(true)
        return
      }
      if (workflowSelected !== undefined) {
        // ↑ at the first member leaves the panel back to where ↓ found it,
        // mirroring the entry gesture.
        if (delta < 0 && workflowSelected === 1) {
          if (exitUpBlocked) return
          workflowSelected = undefined
          panelNav = false
          scheduleRender(true)
          return
        }
        const count = workflowPanel()?.memberCount ?? 0
        if (count === 0) return
        // Members only (no main row): the selection spans 1..count.
        workflowSelected = Math.min(count, Math.max(1, workflowSelected + delta))
        scheduleRender(true)
        return
      }
      if (jobsSelected !== undefined) {
        // ↑ at the first job leaves the panel back to where ↓ found it. The
        // jobs panel never opens a child transcript, so ↑ is never blocked.
        if (delta < 0 && jobsSelected === 1) {
          jobsSelected = undefined
          closeJobOutput()
          panelNav = false
          scheduleRender(true)
          return
        }
        const count = jobsRows.size
        if (count === 0) return
        // Members only (no main row): the selection spans 1..count.
        jobsSelected = Math.min(count, Math.max(1, jobsSelected + delta))
        scheduleRender(true)
        return
      }
      if (panelSelected === undefined) return
      // ↑ at the main row leaves the panel, mirroring the team panel and the
      // ↓ gesture that entered it.
      if (delta < 0 && panelSelected === 0) {
        if (exitUpBlocked) return
        panelSelected = undefined
        panelNav = false
        scheduleRender(true)
        return
      }
      panelSelected = Math.min(rosterRows().length, Math.max(0, panelSelected + delta))
      scheduleRender(true)
    },
    onPanelEnter: () => {
      if (exiting) return
      if (teamSelected !== undefined) {
        if (teamSelected === 0) {
          // The lead row is the way home: close any open child and return to
          // the main view — but keep the cursor on the lead row until Esc
          // dismisses it, so the arrows can re-engage the panel at once.
          panelNav = false
          openChild = undefined
          scheduleRender(true)
          return
        }
        // Opening a member keeps navigation active: the panel keeps the keys,
        // so ↑↓ walks the roster and Enter switches transcripts without ever
        // leaving it; one Esc drops into the opened member's editor. Setting
        // the flag unconditionally also covers entering a member from the
        // retained-cursor state left by Enter on the lead row — without it the
        // ❯ would stay on the row while the caret jumped into the editor.
        const member = teamBase?.members[teamSelected - 1]
        if (member !== undefined) openChild = member.id
        panelNav = true
        scheduleRender(true)
        return
      }
      if (workflowSelected !== undefined) {
        // The member maps through the driver's projection order — the same
        // order the panel draws — so the index and the rows cannot drift.
        // Returning to the main view is Esc's job, not Enter's.
        const info = workflowPanel()
        const member = info === undefined
          ? undefined
          : info.runs.flatMap(run => run.phases.flatMap(phase => phase.members))[workflowSelected - 1]
        if (member !== undefined) openChild = member.childId
        panelNav = true
        scheduleRender(true)
        return
      }
      if (jobsSelected !== undefined) {
        // Enter opens the selected job's full-screen detail (or toggles it
        // closed if already open). The detail owns the keys while set, so the
        // roster cursor stays put underneath. The index maps through
        // jobsPanel()'s row order.
        const row = jobsPanel()?.rows[jobsSelected - 1]
        if (row !== undefined) {
          if (jobsOpen === row.id) {
            closeJobOutput()
          } else {
            jobsOpen = row.id
            jobsOpenCursor = 0
            jobsOpenBuffer = ''
            jobsOpenLossy = false
            readOpenJob()
          }
        }
        panelNav = true
        scheduleRender(true)
        return
      }
      if (panelSelected === undefined) return
      if (panelSelected === 0) {
        // The main row is the way home: close any open child and return to
        // the main view — but keep the cursor on the main row until Esc
        // dismisses it, so the arrows can re-engage the panel at once.
        panelNav = false
        openChild = undefined
        scheduleRender(true)
        return
      }
      const row = rosterRows()[panelSelected - 1]
      // Keep the selection and the navigation: the same walk-the-roster
      // semantics as the team panel, re-engaged unconditionally so entering a
      // child from the retained-cursor state cannot split the ❯ and the caret.
      if (row !== undefined) openChild = row.childId
      panelNav = true
      scheduleRender(true)
    },
    onPanelBack: () => {
      if (exiting) return
      // A job detail is its own surface above the roster: the first Esc closes
      // it back to the jobs list (the cursor stays on the row), the second
      // leaves the panel — mirroring the continuable child's two-step ladder.
      if (jobsOpen !== undefined) {
        closeJobOutput()
        panelNav = true
        scheduleRender(true)
        return
      }
      const openedEntry = openChild === undefined ? undefined : children.get(openChild)
      if (openChild !== undefined && panelNav && openedEntry?.continuable === true) {
        // A continuable child keeps the two-step ladder: the first Esc drops
        // into its editor (the browsing session ends, the ❯ goes with it),
        // the second returns to the main input.
        panelNav = false
        panelSelected = undefined
        teamSelected = undefined
        workflowSelected = undefined
        jobsSelected = undefined
        closeJobOutput()
      } else {
        // A read-only child (or panel navigation with no child) lands on the
        // main input in one press: the child closes and every cursor goes.
        openChild = undefined
        panelNav = false
        panelSelected = undefined
        teamSelected = undefined
        workflowSelected = undefined
        jobsSelected = undefined
        closeJobOutput()
      }
      scheduleRender(true)
    },
    onExit: () => {
      if (exiting) return
      exiting = true
      clearInterval(panelTick)
      void (async () => {
        // Durability is best-effort at graceful exit: a persistence or
        // telemetry listener that never settles must not strand the process
        // (and the now-ignored input bar) forever.
        await flushWithTimeout(
          () => sessions.flush(agent.session),
          EXIT_FLUSH_TIMEOUT_MS,
          (message) => { io.stderr.write(message) },
        )
        io.exit(0)
      })().catch((error: unknown) => { fail(io, error) })
    },
  })
}

/**
 * Mount the interactive terminal UI driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated resume config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { stderr: internals.stderr, exit }
  const renderer = createInkRenderer()
  // Unmount the ink view with the tree: its stdin listener would otherwise
  // keep the event loop alive and strand a process that has already exited.
  ctx.effect(() => () => { renderer.dispose() })
  void run(ctx, config, io, renderer).catch((error: unknown) => { fail(io, error) })
}
