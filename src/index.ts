/**
 * dsh-terminal — interactive terminal UI driver. The patch layer
 * rides over dsh-base without Host, HTTP, or browser plugins; this plugin
 * creates (or resumes) one Agent through the core registry, folds the durable
 * session event stream into display frames, and renders them through the ink
 * terminal UI (the frame stream plus the multiline input bar). Input submits
 * through the Agent's durable inbox without waiting for the owned turn, so
 * further lines queue while the agent works; Ctrl+D flushes the Session and
 * exits.
 *
 * A resumed session rebuilds its display by replaying the persisted log
 * through the same fold before live events attach.
 *
 * @module dsh-terminal
 */

import { randomUUID } from 'node:crypto'
import type { AgentSetup, ApprovalOutcome, CommandRuntime, Context, ModelSelectionRef, SessionEvent } from './dsh-adapter/types.ts'
import { createUserMessage, installModelSelection, SessionId, z } from './dsh-adapter/services.ts'
import './dsh-adapter/effects.ts'
import { createFrameState, foldEvent, readableFailureMessage } from './frames.ts'
import type { FoldDeps, FrameState } from './frames.ts'
import { createInkRenderer } from './renderer.tsx'
import type { Overlay, RenderView, SubagentRow, TuiRenderer } from './renderer.tsx'

// Re-exported so driver suites import the renderer contract without reaching
// the ink view's .tsx module directly (the host aggregate compiles specs).
export type { InputHandlers, OpenSubagent, Overlay, RenderView, SubagentRow, TuiRenderer } from './renderer.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui'

/** Core services required before the interactive turn loop can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the resume target resolved from the startup provider. */
export interface Config {
  /** Persisted session id to resume; undefined starts a fresh session. */
  resume?: string
}

export const Config: z<Config> = z.object({
  resume: z.string(),
})

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

/** One unfinished direct subagent tracked for the panel below the status bar. */
interface ChildEntry {
  /** The child's display label: its delegation description once the descriptor arrives. */
  label: string
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
  const handle = config.resume === undefined
    ? await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    : await agents.resume({
      resumeSessionId: SessionId(config.resume),
      agentOptions,
      setup,
    })
  const agent = handle.agent

  // Rebuild the display from the durable log before the live stream attaches:
  // a resumed session's seeded events are not re-broadcast, so the fold runs
  // over them once here and live events fold through the same path below.
  // Child session id → friendly label, captured from every child's descriptor
  // event on the global bus, so relay/settlement notice text can rename the
  // raw session id it embeds to match the roster.
  const childLabels = new Map<string, string>()
  // Child session id → the error detail of its last failed turn, so the child's
  // settlement notice can show the concrete cause instead of just "failed".
  // Cleared by any later non-error turn, so a child that recovered shows none.
  const childErrors = new Map<string, { message: string; code: string }>()
  const deps: FoldDeps = { tools: ctx.get('tools') ?? { get: () => undefined }, childLabels, childErrors }
  let state = createFrameState()
  // The status bar shows the effective sandbox mode: the policy service folds
  // the session's override onto the deployment default (config or env).
  const policy = ctx.get('sandboxPolicy') as
    | { resolve(request: { session: unknown }): { mode: string; workspaceRoot: string } }
    | undefined
  const sandboxMode = policy?.resolve({ session: agent.session }).mode
  let view: RenderView = {
    status: {
      model: selection.model,
      cwd: process.cwd(),
      ...sandboxMode === undefined ? {} : { mode: sandboxMode },
      ...selection.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort },
    },
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
  let openChild: string | undefined

  /** The child's latest visible activity: the most recent tool card's title. */
  function childActivity(childState: FrameState): string | undefined {
    const last = childState.frames.at(-1)
    return last !== undefined && last.kind === 'tool' ? last.call.title : undefined
  }

  /** The panel rows in roster insertion order. */
  function rosterRows(): SubagentRow[] {
    return [...children.entries()].map(([childId, entry]) => {
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

  /** The base view plus the panel slice computed from the live roster. */
  function withPanel(base: RenderView): RenderView {
    const next: RenderView = { ...base }
    const rows = rosterRows()
    if (rows.length > 0) {
      next.subagents = rows
      if (panelSelected !== undefined) next.subagentSelected = Math.min(panelSelected, rows.length)
    }
    if (openChild !== undefined) {
      const opened = children.get(openChild)
      if (opened !== undefined) next.openSubagent = { childId: openChild, label: opened.label, state: opened.state }
    }
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
    scheduleRender(event.type !== 'assistant/chunk')
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
  for (const event of agent.session.snapshotEvents()) {
    trackUsage(event)
    adopt(foldEvent(state, event, deps).state, true)
  }
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.header.id !== agent.session.id) {
      // Descriptors are seeded at session creation, not live-appended, so they
      // never fire on this bus; read the child's friendly label from its own
      // event log the first time any of its events reaches us.
      if (!childLabels.has(session.header.id)) {
        const descriptor = session.snapshotEvents().find((e) => (e as { type: string }).type === 'subagent/descriptor')
        const label = descriptor === undefined ? undefined : (descriptor.data as { label?: unknown }).label
        if (typeof label === 'string' && label !== '') childLabels.set(session.header.id, label)
      }
      // Direct children feed the panel below the status bar; deeper
      // descendants stay in their own sessions. Error capture here runs for
      // every direct-child turn end, so the later settlement notice can show
      // the concrete cause.
      if (session.header.parentSession === agent.session.id) {
        trackChildError(session.header.id, event)
        foldChildEvent(session.header.id, event)
      }
      return
    }
    trackUsage(event)
    adopt(foldEvent(state, event, deps).state, event.type !== 'assistant/chunk')
  })
  // The panel ticks once a second: elapsed rows refresh, a child whose agent
  // left the registry (its run settled) fades out after its delay, and the
  // thinking indicator's elapsed seconds advance.
  const panelTick = setInterval(() => {
    if (children.size === 0 && state.activeStep === undefined) return
    const now = Date.now()
    for (const [childId, entry] of children) {
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
    setOverlay({
      kind: 'approval',
      toolName: req.toolName,
      ...req.reason === undefined ? {} : { reason: req.reason },
    })
    return new Promise<ApprovalOutcome>((resolve) => {
      pendingApproval = resolve
      req.signal?.addEventListener('abort', () => { resolve('cancelled') })
    }).finally(() => {
      pendingApproval = undefined
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
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
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
    onInterrupt: () => {
      if (exiting) return
      agent.cancel({ kind: 'user' })
    },
    onApproval: (allow) => {
      if (exiting) return
      pendingApproval?.(allow ? 'allowed-once' : 'rejected')
    },
    onPanelOpen: () => {
      if (exiting || children.size === 0) return
      panelSelected = 0
      scheduleRender(true)
    },
    onPanelMove: (delta) => {
      if (exiting || panelSelected === undefined) return
      panelSelected = Math.min(children.size, Math.max(0, panelSelected + delta))
      scheduleRender(true)
    },
    onPanelEnter: () => {
      if (exiting || panelSelected === undefined) return
      if (panelSelected === 0) {
        panelSelected = undefined
        scheduleRender(true)
        return
      }
      const childId = [...children.keys()][panelSelected - 1]
      panelSelected = undefined
      if (childId !== undefined) openChild = childId
      scheduleRender(true)
    },
    onPanelBack: () => {
      if (exiting) return
      if (openChild !== undefined) openChild = undefined
      else panelSelected = undefined
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
