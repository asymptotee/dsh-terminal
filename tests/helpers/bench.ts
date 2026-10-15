/**
 * Shared driver-test harness: mounts the real cordis registries around a small
 * scripted Agent factory and drives run(), capturing every adopted frame state
 * and rendered view. Used by the driver-level suites (fold, panels, navigation).
 * @module dsh-terminal/tests/helpers/bench
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, Inbox, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { run } from '../../src/index.ts'
import type { TuiRenderer } from '../../src/index.ts'
import type { InputHandlers, RenderView } from '../../src/index.ts'
import type { FrameState } from '../../src/fold/frames.ts'

export interface Script {
  /** When set, the driver must resume this persisted session id. */
  resumeId?: string
  /** When set, the driver config carries continueLatest (`-c`). */
  continueLatest?: boolean
  /** Registered before the driver reads the tools registry. */
  tools?: unknown
  /** Registered before the driver reads the commands registry. */
  commands?: unknown
  /** Registered before the driver resolves the model context window. */
  llm?: unknown
  /** Registered before the driver reads the effective sandbox mode. */
  sandboxPolicy?: unknown
  /** Registered before the driver resolves a --continue target. */
  sessionPersistence?: unknown
  /** Registered before the driver reads the permission preset service. */
  permissionPresets?: unknown
  /** Registered before the driver reads the subagent continuation seam. */
  subagents?: unknown
  /** Registered before the driver reads session projections (agentTeam). */
  sessionProjections?: unknown
  /** Registered before the driver reads the background-jobs registry. */
  jobs?: unknown
  /** Append a pre-existing turn before the driver attaches its live fold. */
  seed?(session: Session): void
  /** Append one owned turn; `turn` increments per submitted line. */
  afterPrompt(ctx: Context, session: Session, message: UserMessage, turn: number): Promise<void> | void
}

export function appendTurn(
  session: Session,
  turn: number,
  message: UserMessage,
  text: string,
): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

export interface BenchHandle {
  ctx: Context
  agent: Agent
  /** The input callbacks the driver bound to its renderer. */
  handlers: InputHandlers
  /** Every frame state the driver adopted, in order. */
  states: FrameState[]
  /** Every view the driver rendered, in order (clearing shows as undefined). */
  views: (RenderView | undefined)[]
  /** Resolves with the exit code when the driver requests process exit. */
  exited: Promise<number>
  /** The session id the factory resumed, when the script asked for one. */
  resumedId: string | undefined
}

/** Mount the real registries around a small scripted Agent factory and drive run(). */
export async function bench(script: Script): Promise<BenchHandle> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  let resumedId: string | undefined
  let agentRef: Agent | undefined
  const buildAgent = async (
    ownerCtx: Context,
    sessionId: SessionId,
    agentOptions: CreateAgentOptions['agentOptions'],
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> => {
    const session = ctx.sessions.create(sessionId)
    let idle = Promise.resolve()
    let turn = 0
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, {
      id: session.id,
      options: agentOptions ?? {},
      session,
      // Inbox is an interface in the new harness; the scripted agent only needs
      // a no-op append (the driver never reads the pending lists).
      inbox: { nextTurn: [], nextStep: [], append: () => {} } as unknown as Inbox,
      status: 'idle',
      ctx: agentCtx,
      cancel: () => {},
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        agent.inbox.append('next-turn', message)
        idle = Promise.resolve().then(() => script.afterPrompt(ctx, session, message, ++turn))
      },
      steer: (message: UserMessage) => {
        agent.inbox.append('next-step', message)
        idle = Promise.resolve().then(() => script.afterPrompt(ctx, session, message, ++turn))
      },
      inject: () => {},
      whenIdle: () => idle,
    } satisfies Partial<Agent>)
    await setup?.(agentCtx, agent)
    script.seed?.(session)
    ctx.agents.register(agent)
    agentRef = agent
    return { agent, dispose: () => Promise.resolve() }
  }
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      return buildAgent(ownerCtx, options.sessionId, options.agentOptions, options.setup)
    },
    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      resumedId = options.resumeSessionId
      return buildAgent(ownerCtx, options.resumeSessionId, options.agentOptions, options.setup)
    },
  })

  if (script.tools !== undefined) ctx.provide('tools', script.tools as never)
  if (script.commands !== undefined) ctx.provide('commands', script.commands as never)
  if (script.llm !== undefined) ctx.provide('llm', script.llm as never)
  if (script.sandboxPolicy !== undefined) ctx.provide('sandboxPolicy', script.sandboxPolicy as never)
  if (script.sessionPersistence !== undefined) ctx.provide('sessionPersistence', script.sessionPersistence as never)
  if (script.permissionPresets !== undefined) ctx.provide('permissionPresets', script.permissionPresets as never)
  if (script.subagents !== undefined) ctx.provide('subagents', script.subagents as never)
  if (script.sessionProjections !== undefined) ctx.provide('sessionProjections', script.sessionProjections as never)
  if (script.jobs !== undefined) ctx.provide('jobs', script.jobs as never)
  const states: FrameState[] = []
  const views: (RenderView | undefined)[] = []
  const order: string[] = []
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
  }
  let resolveBound: () => void = () => {}
  const bound = new Promise<void>((resolve) => { resolveBound = resolve })
  const renderer: TuiRenderer = {
    render: (next: FrameState, view?: RenderView) => {
      states.push(next)
      views.push(view)
    },
    setHandlers: (next: InputHandlers) => {
      handlers = next
      resolveBound()
    },
    dispose: () => {},
  }
  const exited = new Promise<number>((resolve) => {
    ctx.on('session/flush', () => { order.push('flush') })
    const io = {
      stderr: { write: () => true },
      exit: (code: number) => { order.push('exit'); resolve(code) },
    }
    const config: { resume?: string; continueLatest?: boolean } = {}
    if (script.resumeId !== undefined) config.resume = script.resumeId
    if (script.continueLatest !== undefined) config.continueLatest = script.continueLatest
    void run(ctx, config, io, renderer)
  })
  await bound
  return { ctx, agent: agentRef!, handlers, states, views, exited, resumedId }
}
