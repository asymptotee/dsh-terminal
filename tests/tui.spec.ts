/** Direct interactive driving: frame-model folds, rebuilds, concurrent submission, flushing, and exit mapping. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, Inbox, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { apply, Config, flushWithTimeout, run, SUBAGENT_FADE_MS } from '../src/index.ts'
import type { TuiRenderer } from '../src/index.ts'
import type { InputHandlers, RenderView } from '../src/index.ts'
// Side-effect type import: the `subagent/descriptor` event kind the child
// sessions append in the panel tests declaration-merges into the session map.
import type {} from '@deepseek-ai/dsh-subagent'
import { createFrameState } from '../src/fold/frames.ts'
import type { FrameState } from '../src/fold/frames.ts'

interface Script {
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

function appendTurn(
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

interface BenchHandle {
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
async function bench(script: Script): Promise<BenchHandle> {
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

describe('tui driver', () => {
  it('folds submitted lines into frames and flushes before exiting', async () => {
    const test = await bench({
      afterPrompt(_ctx, session, message, turn) { appendTurn(session, turn, message, 'answer') },
    })
    test.handlers.onCommit('first')
    await test.agent.whenIdle()
    test.handlers.onCommit('second')
    await test.agent.whenIdle()
    test.handlers.onExit()
    expect(await test.exited).toBe(0)
    const last = test.states.at(-1)!
    expect(last.frames).toMatchObject([
      { kind: 'user', text: 'first' },
      { kind: 'assistant', text: 'answer', streaming: false },
      { kind: 'user', text: 'second' },
      { kind: 'assistant', text: 'answer', streaming: false },
    ])
    await test.ctx.fiber.dispose()
  })

  it('echoes a mid-turn submission as steering, then drops it when the durable event lands', async () => {
    const test = await bench({
      afterPrompt(_ctx, session, message, turn) { appendTurn(session, turn, message, 'done') },
    })
    // Put the main agent mid-turn (a turn/start with no matching end) so the
    // steered message waits for the running turn's next step boundary.
    test.agent.session.append('turn/start', { turn: 99 })
    test.handlers.onCommit('wake pro-jsonl')
    // The commit renders a steering echo immediately, before the step claims it.
    expect(test.views.at(-1)?.pendingUser).toMatchObject([{ text: 'wake pro-jsonl' }])
    // The turn runs the message; its durable user/message carries the same id.
    await test.agent.whenIdle()
    // The echo is dropped once the real frame folds in, leaving exactly
    // one user frame for the message (no duplicate).
    expect(test.views.at(-1)?.pendingUser ?? []).toEqual([])
    const users = test.states.at(-1)!.frames.filter(frame => frame.kind === 'user' && frame.text === 'wake pro-jsonl')
    expect(users).toHaveLength(1)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('commits an assistant message into a closed frame', async () => {
    // Live streaming now rides the agent-scoped assistant-stream bus (transient
    // frames), which this scripted harness does not emit; the durable settlement
    // path is what the integration covers, and the live fold is unit-tested in
    // frames.spec.ts via foldAssistantStreamChunk.
    const test = await bench({
      afterPrompt(_ctx, session, message, turn) {
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Hello' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
          stream: [],
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    test.handlers.onCommit('stream')
    await test.agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))
    test.handlers.onExit()
    await test.exited
    const last = test.states.at(-1)!
    expect(last.frames.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: false })
    await test.ctx.fiber.dispose()
  })

  it('shows the context ratio from the latest token report', async () => {
    const test = await bench({
      llm: { resolveModelInfo: async () => ({ context: { contextWindow: 786_432 } }) },
      afterPrompt(_ctx, session, message, turn) {
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'answer' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
          stream: [],
          usage: { inputTokens: 63_000, outputTokens: 500 },
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    test.handlers.onCommit('hi')
    await test.agent.whenIdle()
    test.handlers.onExit()
    await test.exited
    const last = test.views.at(-1)
    expect(last?.status?.context).toEqual({ used: 63_000, window: 786_432 })
    await test.ctx.fiber.dispose()
  })

  it('folds tool calls and results through the registered tools presentation', async () => {
    const test = await bench({
      tools: {
        get: (name: string) => name === 'bash'
          ? {
            presentCall: () => ({ card: 'terminal', title: 'ls' }),
            presentResult: () => ({ card: 'terminal', output: 'a.txt\n', exitCode: 0 }),
          }
          : undefined,
      },
      afterPrompt(_ctx, session, message, turn) {
        const callId = ToolCallId('c1')
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{"command":"ls"}' })
        session.append('tool/result', {
          turn,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: 'a.txt\n' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    test.handlers.onCommit('run ls')
    await test.agent.whenIdle()
    test.handlers.onExit()
    await test.exited
    const last = test.states.at(-1)!
    expect(last.frames.at(-1)).toMatchObject({
      kind: 'tool',
      name: 'bash',
      call: { card: 'terminal', title: 'ls' },
      result: { card: 'terminal', output: 'a.txt\n', exitCode: 0 },
    })
    await test.ctx.fiber.dispose()
  })

  it('clears the standing todo plan on the next turn', async () => {
    const test = await bench({
      afterPrompt(_ctx, session, message, turn) {
        session.append('todo/write', {
          todos: [
            { content: 'task one', status: 'in_progress' },
            { content: 'task two', status: 'pending' },
          ],
        })
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'done' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
          stream: [],
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    test.handlers.onCommit('plan it')
    await test.agent.whenIdle()
    test.handlers.onExit()
    await test.exited
    const last = test.states.at(-1)!
    expect(last.plan).toBeUndefined()
    expect(last.frames.some(frame => frame.kind === 'assistant' && frame.text === 'done')).toBe(true)
    await test.ctx.fiber.dispose()
  })

  it('exits cleanly without input', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.handlers.onExit()
    expect(await test.exited).toBe(0)
    // No events folded, so the renderer only ever saw the initial empty state.
    expect(test.states).toEqual([{ ...createFrameState() }])
    await test.ctx.fiber.dispose()
  })

  it('flushes and exits exactly once across repeated exit requests', async () => {
    const test = await bench({ afterPrompt: () => {} })
    let flushes = 0
    test.ctx.on('session/flush', () => { flushes += 1 })
    test.handlers.onExit()
    test.handlers.onExit()
    test.handlers.onExit()
    expect(await test.exited).toBe(0)
    expect(flushes).toBe(1)
    await test.ctx.fiber.dispose()
  })

  it('bounds a never-settling flush and warns before exiting', async () => {
    const warned: string[] = []
    await flushWithTimeout(() => new Promise(() => {}), 10, message => warned.push(message))
    expect(warned).toEqual(['dsh: warn: session flush timed out; exiting anyway\n'])
  })

  it('awaits a settling flush without warning', async () => {
    const warned: string[] = []
    let done = false
    await flushWithTimeout(async () => { done = true }, 10, message => warned.push(message))
    expect(done).toBe(true)
    expect(warned).toEqual([])
  })

  it('ignores input once the exit has begun', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.handlers.onExit()
    test.handlers.onCommit('late line')
    test.handlers.onInterrupt()
    test.handlers.onApproval('allow')
    await test.exited
    expect(test.states.every(state => !state.frames.some(frame => frame.kind === 'user'))).toBe(true)
    await test.ctx.fiber.dispose()
  })

  it('resumes the requested persisted session through the Agent registry', async () => {
    const test = await bench({
      resumeId: 'session-abc',
      afterPrompt(_ctx, session, message, turn) { appendTurn(session, turn, message, 'continued') },
    })
    expect(test.resumedId).toBe('session-abc')
    test.handlers.onCommit('again')
    await test.agent.whenIdle()
    test.handlers.onExit()
    await test.exited
    expect(test.states.at(-1)!.frames).toMatchObject([
      { kind: 'user', text: 'again' },
      { kind: 'assistant', text: 'continued' },
    ])
    await test.ctx.fiber.dispose()
  })

  it('resolves continueLatest to the latest top-level session of this directory', async () => {
    const cwd = process.cwd()
    const test = await bench({
      continueLatest: true,
      sessionPersistence: {
        list: async () => [
          { header: { id: 'older', createdAt: 1_000, cwd, isSeeded: false } },
          { header: { id: 'newest', createdAt: 3_000, cwd, isSeeded: false } },
          // A later session from another directory and a subagent child must
          // both lose to this directory's most recent top-level session.
          { header: { id: 'elsewhere', createdAt: 9_000, cwd: '/somewhere/else', isSeeded: false } },
          { header: { id: 'child', createdAt: 9_500, cwd, origin: 'subagent', isSeeded: false } },
        ],
      },
      afterPrompt: () => {},
    })
    expect(test.resumedId).toBe('newest')
    await test.ctx.fiber.dispose()
  })

  it('starts fresh with a notice when continueLatest finds no stored session', async () => {
    const test = await bench({
      continueLatest: true,
      sessionPersistence: { list: async () => [] },
      afterPrompt: () => {},
    })
    expect(test.resumedId).toBeUndefined()
    expect(test.views.at(-1)?.overlay).toEqual({
      kind: 'notice',
      text: 'no stored session for this directory; started a new one',
    })
    await test.ctx.fiber.dispose()
  })

  it('rebuilds the display from the persisted log on resume before live events attach', async () => {
    const test = await bench({
      resumeId: 'session-abc',
      seed(session) {
        appendTurn(session, 1, createUserMessage({
          content: [{ type: 'text', text: 'seed prompt' }],
          source: { kind: 'user' },
        }), 'seed answer')
      },
      afterPrompt(_ctx, session, message, turn) { appendTurn(session, turn, message, 'continued') },
    })
    test.handlers.onCommit('again')
    await test.agent.whenIdle()
    test.handlers.onExit()
    await test.exited
    // The rebuilt display leads with the persisted transcript.
    const last = test.states.at(-1)!
    expect(last.frames.slice(0, 2)).toMatchObject([
      { kind: 'user', text: 'seed prompt' },
      { kind: 'assistant', text: 'seed answer' },
    ])
    await test.ctx.fiber.dispose()
  })

  it('ignores session events broadcast for foreign sessions', async () => {
    const test = await bench({
      afterPrompt(ctx, session, message, turn) {
        const other = ctx.sessions.create(SessionId('other-session'))
        appendTurn(other, 1, createUserMessage({
          content: [{ type: 'text', text: 'foreign prompt' }],
          source: { kind: 'user' },
        }), 'foreign noise')
        appendTurn(session, turn, message, 'owned answer')
      },
    })
    test.handlers.onCommit('mine')
    await test.agent.whenIdle()
    test.handlers.onExit()
    await test.exited
    const last = test.states.at(-1)!
    expect(last.frames.some(frame => frame.kind === 'assistant' && frame.text === 'foreign noise')).toBe(false)
    expect(last.frames.some(frame => frame.kind === 'assistant' && frame.text === 'owned answer')).toBe(true)
    await test.ctx.fiber.dispose()
  })

  it('dispatches slash lines through the commands registry and folds the command records', async () => {
    const execute = vi.fn((agent: Agent, _line: string) => {
      const session = agent.session
      session.append('command/run', { commandId: CommandId('cmd-1'), name: 'quit', args: '', source: { kind: 'user' } })
      session.append('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'bye' })
      return Promise.resolve({ commandId: CommandId('cmd-1') })
    })
    const test = await bench({
      commands: { execute },
      afterPrompt: () => {},
    })
    test.handlers.onCommit('/quit')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(execute).toHaveBeenCalledWith(test.agent, '/quit', [], expect.any(AbortSignal))
    const last = test.states.at(-1)!
    expect(last.frames).toMatchObject([{ kind: 'command', name: 'quit', done: { kind: 'success', text: 'bye' } }])
    await test.ctx.fiber.dispose()
  })

  it('exposes the registry descriptors on the view for the slash menu', async () => {
    const test = await bench({
      commands: {
        execute: () => Promise.resolve(undefined),
        list: () => [
          { name: 'permission', description: 'Switch the permission preset', input: { hint: '<preset>' } },
          { name: 'effort', description: 'Set the reasoning effort' },
        ],
      },
      afterPrompt: () => {},
    })
    // The driver maps descriptors to the renderer's CommandInfo shape:
    // description kept, input.hint flattened to hint, nothing else leaked.
    expect(test.views.at(-1)?.commands).toEqual([
      { name: 'permission', description: 'Switch the permission preset', hint: '<preset>' },
      { name: 'effort', description: 'Set the reasoning effort' },
    ])
    await test.ctx.fiber.dispose()
  })

  it('shows an unknown-command notice and never submits a model message', async () => {
    const steered: string[] = []
    const test = await bench({
      commands: { execute: () => Promise.resolve(undefined) },
      afterPrompt: () => {},
    })
    const original = test.agent.steer.bind(test.agent)
    test.agent.steer = (message: UserMessage) => {
      steered.push(message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(''))
      original(message)
    }
    test.handlers.onCommit('/bogus')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(steered).toEqual([])
    expect(test.views.at(-1)?.overlay).toEqual({ kind: 'notice', text: 'unknown command: /bogus' })
    await test.ctx.fiber.dispose()
  })

  it('shows the effective sandbox mode from the policy service', async () => {
    const test = await bench({
      sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) },
      afterPrompt: () => {},
    })
    expect(test.views.at(-1)?.status?.mode).toBe('read-only')
    await test.ctx.fiber.dispose()
  })

  it('shows the adapter default effort when the selection sets none', async () => {
    const test = await bench({
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 786_432 }, reasoning: { defaultEffort: 'max' } }),
      },
      afterPrompt: () => {},
    })
    expect(test.views.at(-1)?.status?.effort).toBe('max')
    await test.ctx.fiber.dispose()
  })

  it('reports the working directory in the status bar', async () => {
    const test = await bench({ afterPrompt: () => {} })
    expect(test.views.at(-1)?.status).toMatchObject({ model: 'test-model', cwd: process.cwd() })
    await test.ctx.fiber.dispose()
  })

  it('badges the permission preset selection over the raw sandbox mode', async () => {
    // The Auto preset resolves its sandbox knob to danger-full-access; the
    // badge must show the service-derived selection instead of that knob.
    let current = 'auto'
    const test = await bench({
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
      permissionPresets: { current: () => current },
      afterPrompt: () => {},
    })
    expect(test.views.at(-1)?.status).toMatchObject({ mode: 'auto' })
    // A live knob event re-reads the service, tracking a mid-session switch.
    // The knob event types belong to packages this suite does not import, so
    // the append goes through a structural cast.
    current = 'workspace-write'
    const append = test.agent.session.append as unknown as (type: string, data: unknown) => void
    append.call(test.agent.session, 'sandbox/mode', { mode: 'workspace-write' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.status).toMatchObject({ mode: 'workspace-write' })
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('answers approval questions with y/n keys through the waterfall', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const outcome = (test.ctx.waterfall as unknown as (
      thisArg: unknown, name: string, req: unknown, next: () => Promise<unknown>,
    ) => Promise<unknown>)(test.ctx, 'approval/request', {
      agent: test.agent,
      toolName: 'bash',
      reason: 'run rm -rf',
    }, () => Promise.resolve('unavailable'))
    expect(test.views.at(-1)?.overlay).toEqual({ kind: 'approval', toolName: 'bash', reason: 'run rm -rf' })
    test.handlers.onApproval('allow')
    expect(await outcome).toBe('allowed-once')
    await test.ctx.fiber.dispose()
  })

  it('prefers the zh displayReason over the audit reason on the overlay', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const outcome = (test.ctx.waterfall as unknown as (
      thisArg: unknown, name: string, req: unknown, next: () => Promise<unknown>,
    ) => Promise<unknown>)(test.ctx, 'approval/request', {
      agent: test.agent,
      toolName: 'bash',
      reason: 'escalate sandbox to danger-full-access: needs network',
      displayReason: {
        en: 'Allow this operation with danger-full-access permissions: needs network',
        zh: '允许本次操作使用 danger-full-access 权限：需要联网',
      },
    }, () => Promise.resolve('unavailable'))
    expect(test.views.at(-1)?.overlay).toEqual({
      kind: 'approval',
      toolName: 'bash',
      reason: '允许本次操作使用 danger-full-access 权限：需要联网',
    })
    test.handlers.onApproval('allow')
    expect(await outcome).toBe('allowed-once')
    await test.ctx.fiber.dispose()
  })

  it('falls back to the en displayReason when no zh copy is supplied', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const outcome = (test.ctx.waterfall as unknown as (
      thisArg: unknown, name: string, req: unknown, next: () => Promise<unknown>,
    ) => Promise<unknown>)(test.ctx, 'approval/request', {
      agent: test.agent,
      toolName: 'bash',
      reason: 'audit copy',
      displayReason: { en: 'Allow this operation' },
    }, () => Promise.resolve('unavailable'))
    expect(test.views.at(-1)?.overlay).toEqual({
      kind: 'approval',
      toolName: 'bash',
      reason: 'Allow this operation',
    })
    test.handlers.onApproval('allow')
    expect(await outcome).toBe('allowed-once')
    await test.ctx.fiber.dispose()
  })

  it('cancels on Esc and carries the pending call detail on the overlay', async () => {
    const test = await bench({
      // The bash presentation puts the command in the card title — a
      // multiline script folds to its `; ` one-liner for the detail row.
      tools: { get: () => ({ presentCall: (args: { command?: string }) => ({ card: 'terminal', title: args?.command ?? '' }) }) },
      seed: (session) => {
        session.append('tool/call', {
          turn: 1, step: 1, callId: ToolCallId('call-9'), name: 'bash',
          arguments: '{"command":"set -u\\nmkdir -p demo\\n"}',
        })
      },
      afterPrompt: () => {},
    })
    const outcome = (test.ctx.waterfall as unknown as (
      thisArg: unknown, name: string, req: unknown, next: () => Promise<unknown>,
    ) => Promise<unknown>)(test.ctx, 'approval/request', {
      agent: test.agent,
      toolName: 'bash',
      callId: ToolCallId('call-9'),
      reason: 'writes outside the workspace',
    }, () => Promise.resolve('unavailable'))
    expect(test.views.at(-1)?.overlay).toEqual({
      kind: 'approval',
      toolName: 'bash',
      reason: 'writes outside the workspace',
      detail: 'set -u; mkdir -p demo',
      callId: 'call-9',
    })
    test.handlers.onApproval('cancel')
    expect(await outcome).toBe('cancelled')
    await test.ctx.fiber.dispose()
  })

  it('passes foreign-session approval questions through unanswered', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const other = test.ctx.sessions.create(SessionId('other-session'))
    const foreignAgent = { session: other } as Agent
    const outcome = (test.ctx.waterfall as unknown as (
      thisArg: unknown, name: string, req: unknown, next: () => Promise<unknown>,
    ) => Promise<unknown>)(test.ctx, 'approval/request', {
      agent: foreignAgent,
      toolName: 'bash',
    }, () => Promise.resolve('unavailable'))
    expect(await outcome).toBe('unavailable')
    expect(test.views.every(v => v === undefined || v.overlay === undefined)).toBe(true)
    await test.ctx.fiber.dispose()
  })

  it('clears a notice on the next submission', async () => {
    const test = await bench({
      commands: { execute: () => Promise.resolve(undefined) },
      afterPrompt(_ctx, session, message, turn) { appendTurn(session, turn, message, 'answer') },
    })
    test.handlers.onCommit('/bogus')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.overlay?.kind).toBe('notice')
    test.handlers.onCommit('real question')
    await test.agent.whenIdle()
    test.handlers.onExit()
    await test.exited
    expect(test.views.at(-1)?.overlay).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('reports an Agent creation failure', async () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    await expect(run(ctx, {}, {
      stderr: { write: () => true },
      exit: () => {},
    }, { render: () => {}, setHandlers: () => {}, dispose: () => {} })).rejects.toThrow('factory exploded')
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, {}) }).toThrow('must provide ctx.appExit')
  })

  it('validates config: resume is an optional string', () => {
    expect(new Config({})).toEqual({ resume: undefined })
    expect(new Config({ resume: 'session-1' })).toEqual({ resume: 'session-1' })
  })
})

describe('subagent panel', () => {
  it('lists a direct child with its descriptor label, activity, and tokens', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-1'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: '调研包结构' })
    child.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'thinking' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
      stream: [],
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 50 },
    }, { surfaceOp: 'append' })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-1'), name: 'grep', arguments: '{"pattern":"x"}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({
      childId: 'child-1',
      label: '调研包结构',
      activity: 'grep',
      inputTokens: 150,
      fading: false,
    })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('folds a multiline command title into a one-line semicolon activity', async () => {
    const test = await bench({
      tools: { get: () => ({ presentCall: () => ({ card: 'terminal', title: 'set -u\ncd /work\n\nwc -l *.txt\n' }) }) },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('child-1'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-1'), name: 'bash', arguments: '{}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Newlines fold to `; `, the interior blank line drops, the trailing
    // newline leaves no dangling separator — one physical panel row.
    expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({
      activity: 'set -u; cd /work; wc -l *.txt',
    })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps the shortened-id label until the descriptor arrives', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-x'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-1'), name: 'grep', arguments: '{}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({ childId: 'child-x', label: 'subagent child-x' })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('ignores unrelated sessions and deeper descendants', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const unrelated = test.ctx.sessions.create(SessionId('other'))
    unrelated.append('turn/start', { turn: 1 })
    const grandchild = test.ctx.sessions.create(SessionId('grand'), {
      meta: { parentSession: SessionId('other'), origin: 'subagent' },
    })
    grandchild.append('turn/start', { turn: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.subagents).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('fades the row of a settled child after its delay', async () => {
    vi.useFakeTimers()
    try {
      const test = await bench({ afterPrompt: () => {} })
      const child = test.ctx.sessions.create(SessionId('child-2'), {
        meta: { parentSession: test.agent.session.id, origin: 'subagent' },
      })
      child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-2'), name: 'grep', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(0)
      // No Agent exists for the child, so the first tick marks the row as fading.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({ childId: 'child-2', fading: true })])
      await vi.advanceTimersByTimeAsync(SUBAGENT_FADE_MS)
      expect(test.views.at(-1)?.subagents).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('navigates the panel and opens the child transcript view', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-3'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: '调研包结构' })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-3'), name: 'grep', arguments: '{}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    // Enter on the main row returns to the main view but keeps the cursor
    // until Esc dismisses it.
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelMove(1)
    // The selection clamps at the last child row.
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    test.handlers.onPanelEnter()
    const opened = test.views.at(-1)?.openSubagent
    expect(opened?.childId).toBe('child-3')
    expect(opened?.label).toBe('调研包结构')
    expect(opened?.state.frames).toMatchObject([{ kind: 'tool', name: 'grep' }])
    // A one-shot child never offers continuation prompts.
    expect(opened?.continuable).toBeUndefined()
    // Enter keeps the navigation position: the panel still owns the keys and
    // the opened child's row stays highlighted.
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    expect(test.views.at(-1)?.panelNav).toBe(true)
    // Esc lands on the main input in one press: the child closes and every
    // cursor goes with it.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    expect(test.views.at(-1)?.panelNav).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('switches to another child from the child view through panel navigation', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const childA = test.ctx.sessions.create(SessionId('child-a'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    childA.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'A' })
    const childB = test.ctx.sessions.create(SessionId('child-b'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    childB.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'B' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Open A's transcript from the roster panel; Enter keeps the navigation
    // position, so the panel still owns the keys on A's highlighted row.
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-a')
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    expect(test.views.at(-1)?.panelNav).toBe(true)
    // Re-entering navigation (↓ from the child editor) keeps the current row;
    // moving down and Enter switches the open transcript to B.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.panelNav).toBe(true)
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.subagentSelected).toBe(2)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-b')
    // The switch keeps the navigation position: the panel still owns the keys,
    // so ↑↓/Enter keeps walking the roster.
    expect(test.views.at(-1)?.panelNav).toBe(true)
    expect(test.views.at(-1)?.subagentSelected).toBe(2)
    // A continuable child keeps the two-step ladder: the first Esc drops into
    // its editor (the browsing session ends, the ❯ goes with it), the second
    // returns to the main input.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-b')
    expect(test.views.at(-1)?.panelNav).toBeUndefined()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    // Re-entering starts on the main row; Enter there returns to the main
    // view but keeps the cursor until Esc dismisses it.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps the panel engaged when entering a child from the retained-cursor state', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-r'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'R' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // ↓ then Enter on the main row: home view, the cursor retained on main.
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    // Move onto the child and Enter: the panel must keep the keys, so the ❯
    // and the focused surface stay together instead of the caret jumping into
    // the child editor.
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-r')
    expect(test.views.at(-1)?.panelNav).toBe(true)
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('labels an opened teammate with its roster name, not the spawn description', async () => {
    const test = await bench({
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? {
            members: [{ id: 'm-1', name: 'product-manager', description: 'PM：定义需求与验收', phase: 'active' }],
            tasks: [],
          }
          : undefined,
      },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('m-1'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'PM：定义需求与验收' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // The team panel leads navigation; open the member from its row.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.teamSelected).toBe(0)
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    const opened = test.views.at(-1)?.openSubagent
    expect(opened?.childId).toBe('m-1')
    expect(opened?.label).toBe('product-manager')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('flags a continuable child and reconciles its prompt echo by rpcId', async () => {
    const prompts: { requestId: string; parentSessionId: string; childSessionId: string; mode: string; delivery: string; content: readonly unknown[] }[] = []
    const test = await bench({
      subagents: {
        prompt: (request: typeof prompts[number]) => {
          prompts.push(request)
          return Promise.resolve({ messageId: 'msg-1' })
        },
      },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('child-p'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: '长期助手' })
    await new Promise(resolve => setTimeout(resolve, 0))
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    const opened = test.views.at(-1)?.openSubagent
    expect(opened?.childId).toBe('child-p')
    expect(opened?.continuable).toBe(true)
    // The optimistic echo renders before any durable event, and the request
    // carries the seam's literal contract — the terminal's single send
    // gesture always steers.
    test.handlers.onChildPrompt('换个思路')
    expect(test.views.at(-1)?.openSubagent?.pending).toEqual([expect.objectContaining({ text: '换个思路' })])
    expect(prompts).toHaveLength(1)
    const [request] = prompts
    expect(request).toMatchObject({
      parentSessionId: test.agent.session.id,
      childSessionId: 'child-p',
      mode: 'continuable',
      delivery: 'steer',
      content: [{ type: 'text', text: '换个思路' }],
    })
    expect(typeof request.requestId).toBe('string')
    expect(request.requestId).not.toBe('')
    // The child's durable user/message carries the requestId as its source
    // rpcId; the local echo drops and the committed frame takes its place.
    const message = createUserMessage({ content: [{ type: 'text', text: '换个思路' }], source: { kind: 'user' } })
    child.append('user/message', { ...message, source: { kind: 'user', rpcId: request.requestId } as typeof message.source }, { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const settled = test.views.at(-1)?.openSubagent
    expect(settled?.pending).toBeUndefined()
    expect(settled?.state.frames).toMatchObject([{ kind: 'user', text: '换个思路' }])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('steers every child prompt and withdraws the echo of a rejected one', async () => {
    const deliveries: string[] = []
    let failing = false
    const test = await bench({
      subagents: {
        prompt: (request: { delivery: string }) => {
          deliveries.push(request.delivery)
          return failing
            ? Promise.reject({ code: 'subagent/not-resumable', message: 'subagent cannot be resumed' })
            : Promise.resolve({ messageId: 'msg-2' })
        },
      },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('child-q'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'q' })
    await new Promise(resolve => setTimeout(resolve, 0))
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    test.handlers.onChildPrompt('插一句')
    expect(deliveries).toEqual(['steer'])
    // A rejected prompt withdraws its own echo and raises the localized notice;
    // the earlier accepted echo stays.
    failing = true
    test.handlers.onChildPrompt('再来一句')
    await new Promise(resolve => setTimeout(resolve, 0))
    const view = test.views.at(-1)
    expect(view?.overlay).toEqual({ kind: 'notice', text: '发送失败：该子代理不支持续聊（one-shot）' })
    expect(view?.openSubagent?.pending).toEqual([expect.objectContaining({ text: '插一句' })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps an opened child out of the fade removal', async () => {
    vi.useFakeTimers()
    try {
      const test = await bench({ afterPrompt: () => {} })
      const child = test.ctx.sessions.create(SessionId('child-4'), {
        meta: { parentSession: test.agent.session.id, origin: 'subagent' },
      })
      child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-4'), name: 'grep', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onPanelOpen()
      test.handlers.onPanelMove(1)
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(1_000 + SUBAGENT_FADE_MS)
      // The viewed child stays in the roster, so the open view survives the fade.
      expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-4')
      // Esc closes the child in one press; the fade can then take the row.
      test.handlers.onPanelBack()
      expect(test.views.at(-1)?.openSubagent).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.views.at(-1)?.subagents).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('workflow panel', () => {
  // tool-workflow durable events carry a branded WorkflowRunId this suite
  // cannot mint without importing the workflow package; appends go through a
  // structural cast (the sandbox/mode precedent). The driver-side merge is
  // proven by `pnpm typecheck` compiling src/index.ts's switch, not here.
  function appendRaw(session: Session, type: string, data: unknown): void {
    const append = session.append as unknown as (type: string, data: unknown) => void
    append.call(session, type, data)
  }
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  const wfStart = (session: Session, id: string, name: string): void =>
    appendRaw(session, 'tool-workflow/run-start', { runId: id, name })
  const wfAgent = (session: Session, id: string, seq: number, label: string, childId: string, phase?: string): void =>
    appendRaw(session, 'tool-workflow/agent-start', { runId: id, seq, label, ...(phase === undefined ? {} : { phase }), childId })
  const wfEnd = (session: Session, id: string, seq: number, outcome: string): void =>
    appendRaw(session, 'tool-workflow/agent-end', { runId: id, seq, outcome })
  const wfRunEnd = (session: Session, id: string, stopReason: string): void =>
    appendRaw(session, 'tool-workflow/run-end', { runId: id, stopReason })

  /** One direct child session with a single tool event, so its fold entry exists. */
  function wfChild(test: Awaited<ReturnType<typeof bench>>, childId: string): Session {
    const child = test.ctx.sessions.create(SessionId(childId), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`cc-${childId}`), name: 'grep', arguments: '{}' })
    return child
  }

  it('folds durable workflow events into the panel projection', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    wfStart(main, 'wf-1', 'release-check')
    wfAgent(main, 'wf-1', 1, 'audit deps', 'wf-child-1')
    wfAgent(main, 'wf-1', 2, 'run tests', 'wf-child-2', '验证')
    await settle()
    const workflow = test.views.at(-1)?.workflow
    expect(workflow?.memberCount).toBe(2)
    expect(workflow?.runs[0]).toMatchObject({ id: 'wf-1', name: 'release-check', status: 'running' })
    // Phases group in first-appearance order; the unphased group keeps its
    // collision-free key and no phase header value.
    expect(workflow?.runs[0]?.phases.map(phase => phase.key)).toEqual(['missing', 'value:2:验证'])
    expect(workflow?.runs[0]?.phases[0]?.phase).toBeUndefined()
    expect(workflow?.runs[0]?.phases[0]?.members[0]).toMatchObject({ seq: 1, label: 'audit deps', childId: 'wf-child-1', status: 'running' })
    expect(workflow?.runs[0]?.phases[1]?.members[0]).toMatchObject({ seq: 2, label: 'run tests', status: 'running' })
    // Outcomes and the stop reason settle member and run status.
    wfEnd(main, 'wf-1', 1, 'failed')
    wfRunEnd(main, 'wf-1', 'error')
    await settle()
    const settledRun = test.views.at(-1)?.workflow?.runs[0]
    expect(settledRun?.status).toBe('failed')
    expect(settledRun?.phases[0]?.members[0]?.status).toBe('failed')
    // An orphan agent-end (a failed start consumed the seq) is ignored.
    wfEnd(main, 'wf-1', 99, 'completed')
    await settle()
    expect(test.views.at(-1)?.workflow?.memberCount).toBe(2)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('excludes workflow members from the roster and backfills their labels', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    const child = wfChild(test, 'wf-child-1')
    await settle()
    // Before the workflow record arrives the child is an ordinary roster row
    // with the id-fallback label.
    expect(test.views.at(-1)?.subagents?.map(row => row.childId)).toContain('wf-child-1')
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'audit deps', 'wf-child-1')
    await settle()
    // The member leaves the roster (the workflow panel owns it now) and the
    // backfilled label reaches the child view through the fold entry.
    expect(test.views.at(-1)?.subagents ?? []).toEqual([])
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent).toMatchObject({ childId: 'wf-child-1', label: 'audit deps' })
    expect(child.header.id).toBe('wf-child-1')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('navigates the workflow panel and walks the Esc ladder', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    wfChild(test, 'wf-child-1')
    wfChild(test, 'wf-child-2')
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
    wfAgent(main, 'wf-1', 2, 'two', 'wf-child-2')
    await settle()
    test.handlers.onPanelOpen()
    // The workflow panel takes navigation: members only, 1-based.
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.workflowSelected).toBe(2)
    // The selection clamps at the last member.
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.workflowSelected).toBe(2)
    test.handlers.onPanelMove(-1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-1')
    expect(test.views.at(-1)?.panelNav).toBe(true)
    // Esc lands on the main input in one press: the child closes and the
    // cursor goes with it.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    expect(test.views.at(-1)?.workflowSelected).toBeUndefined()
    // ↑ at the first member leaves the panel where ↓ found it.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.workflowSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps navigation when ↑ reaches the first member over a read-only child', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    wfChild(test, 'wf-child-1')
    wfChild(test, 'wf-child-2')
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
    wfAgent(main, 'wf-1', 2, 'two', 'wf-child-2')
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-2')
    expect(test.views.at(-1)?.workflowSelected).toBe(2)
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    // ↑ at the first member is a no-op over a read-only child: there is no
    // editor to hand the keys to, so the screen must not change.
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-2')
    expect(test.views.at(-1)?.panelNav).toBe(true)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('prefers the team panel over the workflow panel for navigation', async () => {
    const test = await bench({
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? { members: [{ id: 'm-1', name: 'product-manager', description: 'd', phase: 'active' }], tasks: [] }
          : undefined,
      },
      afterPrompt: () => {},
    })
    const main = test.agent.session
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
    await settle()
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.teamSelected).toBe(0)
    expect(test.views.at(-1)?.workflowSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('surfaces the task board when a lead has tasks but no members yet', async () => {
    // The old guard blanked teamBase whenever members were empty, hiding the
    // tasks a lead had just written (team_task_create precedes spawn). The
    // panel must stay up on tasks alone.
    const test = await bench({
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? {
            members: [],
            tasks: [{
              id: 'task-1',
              revision: 1,
              subject: '实现 math_utils.py 工具库',
              description: '',
              status: 'pending',
              blockedBy: [],
              writeScopes: [],
            }],
          }
          : undefined,
      },
      afterPrompt: () => {},
    })
    await settle()
    const team = test.views.at(-1)?.team
    expect(team).toBeDefined()
    expect(team?.members).toHaveLength(0)
    expect(team?.tasks).toHaveLength(1)
    expect(team?.tasks[0]?.subject).toBe('实现 math_utils.py 工具库')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('derives interrupted on resume and flips to running on live events', async () => {
    const test = await bench({
      resumeId: SessionId('resumed-session'),
      seed: (session) => {
        wfStart(session, 'wf-old', 'old-run')
        wfAgent(session, 'wf-old', 1, 'stale member', 'wf-child-9')
      },
      afterPrompt: () => {},
    })
    // The replayed run never saw run-end and no live event yet: interrupted.
    const workflow = test.views.at(-1)?.workflow
    expect(workflow?.runs[0]?.status).toBe('interrupted')
    expect(workflow?.runs[0]?.phases[0]?.members[0]?.status).toBe('interrupted')
    // A live event for the same run proves it is still running.
    wfEnd(test.agent.session, 'wf-old', 1, 'completed')
    await settle()
    const live = test.views.at(-1)?.workflow
    expect(live?.runs[0]?.status).toBe('running')
    expect(live?.runs[0]?.phases[0]?.members[0]?.status).toBe('completed')
    wfRunEnd(test.agent.session, 'wf-old', 'completed')
    await settle()
    expect(test.views.at(-1)?.workflow?.runs[0]?.status).toBe('completed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps workflow members out of the fade removal', async () => {
    vi.useFakeTimers()
    try {
      const test = await bench({ afterPrompt: () => {} })
      const main = test.agent.session
      wfChild(test, 'wf-child-1')
      wfStart(main, 'wf-1', 'audit')
      wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000 + SUBAGENT_FADE_MS)
      // The member's transcript survives the fade for the panel's Enter.
      test.handlers.onPanelOpen()
      test.handlers.onPanelMove(1)
      test.handlers.onPanelEnter()
      expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-1')
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('goal strip', () => {
  // The goal's durable half rides the `goal` session projection, so the driver
  // reads it through the mocked stateOf exactly as it reads agentTeam; the
  // events below only *trigger* a re-read, they do not carry the goal payload.
  // A goal/change event type is not merged into the test program (the merge
  // lives in the package root), so appends go through a structural cast.
  function appendRaw(session: Session, type: string, data: unknown, third?: unknown): void {
    const append = session.append as unknown as (type: string, data: unknown, third?: unknown) => void
    append.call(session, type, data, third)
  }
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  /** The projection cell for `stateOf(session, 'goal')`: a whole-value current
   *  goal, or null before create / after clear. */
  type GoalCell = { current: GoalProjectionLike | null; seenGoalIds: unknown[]; failure: null }
  type GoalProjectionLike = {
    goal: { id: string; revision: number; objective: string; phase: string; maxGoalRounds: number; blockedReason?: { code: string; message: string } }
    roundsStarted: number
    createdAt: number
    updatedAt: number
  }
  function projectionsFor(cell: { value: GoalCell | undefined }): unknown {
    return {
      stateOf: (_session: unknown, key: string) => key === 'goal' ? cell.value : undefined,
    }
  }
  const activeCell = (roundsStarted = 0, over?: Partial<GoalProjectionLike['goal']>): GoalCell => ({
    current: {
      goal: { id: 'goal-1', revision: 1, objective: '把测试套件跑通', phase: 'active', maxGoalRounds: 10, ...over },
      roundsStarted,
      createdAt: 1,
      updatedAt: 1,
    },
    seenGoalIds: ['goal-1'],
    failure: null,
  })

  it('surfaces the standing goal from the projection, disarmed by default', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    const goal = test.views.at(-1)?.goal
    expect(goal).toBeDefined()
    expect(goal?.objective).toBe('把测试套件跑通')
    expect(goal?.phase).toBe('active')
    expect(goal?.roundsStarted).toBe(0)
    expect(goal?.maxGoalRounds).toBe(10)
    // Resume/fork semantics: the switch starts disarmed until the bus says otherwise.
    expect(goal?.activation).toBe('disarmed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('re-reads the goal on a goal/ prefix event', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.goal?.phase).toBe('active')
    // Flip the durable projection to paused, then fire the event that makes the
    // driver re-read it; the payload is irrelevant (the mock is the source).
    cell.value = activeCell(0, { phase: 'paused' })
    appendRaw(test.agent.session, 'goal/change', { kind: 'goal/change', version: 1, operation: 'pause' })
    await settle()
    expect(test.views.at(-1)?.goal?.phase).toBe('paused')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('advances the round counter on a goal-sourced user/message', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.goal?.roundsStarted).toBe(0)
    // The projection folds the round from the admitted goal-round message, not
    // from goal/change — so this trigger (not the prefix) moves round N/M.
    cell.value = activeCell(3)
    // A goal-round user/message is surface-eligible (the model must see the
    // continuation prompt), so the append carries the surfaceOp marker; the
    // terminal still drops it because frames.ts ignores non-user sources.
    appendRaw(test.agent.session, 'user/message', {
      id: 'msg-goal-3',
      content: [{ type: 'text', text: '<goal_round>…</goal_round>' }],
      source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 3 },
    }, { surfaceOp: 'append' })
    await settle()
    expect(test.views.at(-1)?.goal?.roundsStarted).toBe(3)
    // The round prompt never enters the transcript (frames.ts drops non-user sources).
    expect(test.states.at(-1)?.frames.every(frame => frame.kind !== 'user')).toBe(true)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('carries a blocked reason and hides the strip once cleared', async () => {
    const cell = { value: activeCell(5, { phase: 'blocked', blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 10 rounds.' } }) as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    const blocked = test.views.at(-1)?.goal
    expect(blocked?.phase).toBe('blocked')
    expect(blocked?.blockedReason).toEqual({ code: 'round-limit', message: 'Goal reached its configured limit of 10 rounds.' })
    // Clearing the goal (projection current -> null) drops the strip.
    cell.value = { current: null, seenGoalIds: ['goal-1'], failure: null }
    appendRaw(test.agent.session, 'goal/change', { kind: 'goal/change', version: 1, operation: 'clear' })
    await settle()
    expect(test.views.at(-1)?.goal).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('flips armed/disarmed on the activation bus for the owned session only', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('disarmed')
    // An activation edge for another session must not touch this strip.
    test.ctx.emit('goal/activation-changed', { sessionId: SessionId('someone-else'), goal: { id: 'goal-1', revision: 1, activation: 'armed' } } as never)
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('disarmed')
    // The owned session's edge flips it.
    test.ctx.emit('goal/activation-changed', { sessionId: test.agent.session.id, goal: { id: 'goal-1', revision: 1, activation: 'armed' } } as never)
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('armed')
    // A cleared goal (no `goal` field) reports disarmed.
    test.ctx.emit('goal/activation-changed', { sessionId: test.agent.session.id } as never)
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('disarmed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('shows a resumed session goal disarmed on first paint', async () => {
    const cell = { value: activeCell(2) as GoalCell | undefined }
    const test = await bench({
      resumeId: SessionId('resumed-goal'),
      sessionProjections: projectionsFor(cell),
      seed: (session) => {
        appendRaw(session, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create' })
      },
      afterPrompt: () => {},
    })
    // Seeded before the live bus: the strip shows the objective and rounds,
    // disarmed, with no activation event ever arriving.
    const goal = test.views.at(-1)?.goal
    expect(goal?.objective).toBe('把测试套件跑通')
    expect(goal?.roundsStarted).toBe(2)
    expect(goal?.activation).toBe('disarmed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })
})

describe('jobs panel', () => {
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  type FakeJob = {
    id: string
    kind: string
    label: string
    status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
    progress?: string
    detail?: string
    startedAt: number
    finishedAt?: number
  }
  type FakeEvent =
    | { type: 'registered' | 'progress' | 'stopping' | 'removed'; job: FakeJob }
    | { type: 'settled'; job: FakeJob; cause: 'producer' | 'kill' | 'teardown' }
    | { type: 'output'; id: string; total: number }

  /** A scripted registry: the rows list() returns, the chunks readAt hands
   *  out from any offset, and the captured listener the test fires events at. */
  function fakeRegistry() {
    const rows: FakeJob[] = []
    const output = new Map<string, string>()
    let listener: ((event: FakeEvent) => void) | undefined
    const reads: { id: string; from: number }[] = []
    const kills: { id: string; reason: string | undefined }[] = []
    return {
      rows,
      output,
      reads,
      kills,
      emit(event: FakeEvent): void {
        // Mirror the registry: lifecycle events also move list(); the test
        // mutates `rows` itself where the case needs it.
        listener?.(event)
      },
      registry: {
        list: () => rows.map(row => ({ ...row })),
        readAt: (id: string, from: number) => {
          reads.push({ id, from })
          const text = output.get(id) ?? ''
          return { chunks: from < text.length ? [{ text: text.slice(from) }] : [], next: text.length, lossy: false }
        },
        kill: (id: string, _caller: unknown, reason?: string) => {
          kills.push({ id, reason })
          return 'requested' as const
        },
        events: {
          subscribe: (_filter: unknown, l: (event: FakeEvent) => void) => {
            listener = l
            return () => { listener = undefined }
          },
        },
      },
    }
  }

  const runningJob = (id: string, over?: Partial<FakeJob>): FakeJob =>
    ({ id, kind: 'bash', label: `sleep 300 && echo ${id}`, status: 'running', startedAt: Date.now() - 12_000, ...over })

  it('shows registered jobs, tracks progress, and lingers settled rows', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-1'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // The seeded list() shows the running job with its live elapsed.
    let jobs = test.views.at(-1)?.jobs
    expect(jobs?.rows).toHaveLength(1)
    expect(jobs?.rows[0]).toMatchObject({ id: 'bash-1', kind: 'bash', status: 'running' })
    expect(jobs?.rows[0]?.elapsedMs).toBeGreaterThanOrEqual(12_000)
    // A progress event updates the row in place.
    fake.rows[0] = runningJob('bash-1', { progress: '42%' })
    fake.emit({ type: 'progress', job: fake.rows[0] })
    await settle()
    expect(test.views.at(-1)?.jobs?.rows[0]?.progress).toBe('42%')
    // Settlement keeps the row (lingering) with its terminal detail frozen.
    const settledJob: FakeJob = { ...runningJob('bash-1'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() }
    fake.rows[0] = settledJob
    fake.emit({ type: 'settled', job: settledJob, cause: 'producer' })
    await settle()
    jobs = test.views.at(-1)?.jobs
    expect(jobs?.rows[0]?.status).toBe('completed')
    expect(jobs?.rows[0]?.detail).toBe('exit code: 0')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('retires a settled job the registry keeps listing after the linger window', async () => {
    // The registry's list() retains settled jobs until the owner is disposed —
    // the linger clock must run off the driver's own settledAt stamp, not off
    // the row's absence from list() (regression: three completed sleep jobs
    // pinned the panel forever because every tick re-stamped settledAt).
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      const done: FakeJob = { ...runningJob('bash-9'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() }
      fake.rows.push(done)
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
      expect(test.views.at(-1)?.jobs?.rows[0]?.status).toBe('completed')
      // Still listed by the registry, but past the linger window: retired.
      await vi.advanceTimersByTimeAsync(6_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      // The registry still lists it on every following tick; the tombstone
      // keeps it retired — without it the next list() re-adds the row with a
      // fresh settledAt and the panel oscillates forever (the revive bug).
      await vi.advanceTimersByTimeAsync(3_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a row the registry removes and retires lingerers after the window', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-2'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
      // A foreground bash promoted then removed before settlement vanishes at once.
      fake.rows.length = 0
      fake.emit({ type: 'removed', job: runningJob('bash-2') })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      // A settled job lingers through the window, then the tick retires it.
      fake.rows.push({ ...runningJob('bash-3'), status: 'completed', finishedAt: Date.now() })
      fake.emit({ type: 'registered', job: fake.rows[0] })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
      fake.rows.length = 0
      await vi.advanceTimersByTimeAsync(6_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the job detail on Enter and reads its output incrementally', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-4'))
    fake.output.set('bash-4', 'line one\n')
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // Enter on the first row opens its full-screen detail, read from offset 0.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    test.handlers.onPanelEnter()
    await settle()
    let detail = test.views.at(-1)?.openJob
    expect(detail?.jobId).toBe('bash-4')
    expect(detail?.title).toBe('Command details')
    expect(detail?.labelField).toBe('Command')
    expect(detail?.output).toBe('line one\n')
    expect(detail?.lossy).toBe(false)
    // New bytes land with an output pulse; the read resumes from the cursor.
    fake.output.set('bash-4', 'line one\nline two\n')
    fake.emit({ type: 'output', id: 'bash-4', total: 19 })
    await settle()
    detail = test.views.at(-1)?.openJob
    expect(detail?.output).toBe('line one\nline two\n')
    expect(fake.reads.at(-1)).toEqual({ id: 'bash-4', from: 9 })
    // Enter on the same row again toggles the detail closed.
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('shows an empty detail output for a subagent job with no output ring', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('subagent-1', { kind: 'subagent', label: '调研包结构' }))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    await settle()
    const detail = test.views.at(-1)?.openJob
    expect(detail?.title).toBe('Subagent details')
    expect(detail?.labelField).toBe('Task')
    expect(detail?.label).toBe('调研包结构')
    expect(detail?.output).toBe('')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('arms the kill gesture then kills on the second press within the window', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-9'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onPanelOpen()
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(0)
      // The first x only arms: the detail flags it, no kill yet.
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(true)
      expect(fake.kills).toHaveLength(0)
      // The second x within the window kills with the terminal's reason.
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.kills).toEqual([{ id: 'bash-9', reason: 'stopped from the terminal' }])
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(false)
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disarms the kill gesture once the re-arm window lapses', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-10'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onPanelOpen()
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(true)
      // Past the window the arm lapses (the projection re-derives it); the next
      // x only re-arms instead of killing.
      await vi.advanceTimersByTimeAsync(4_000)
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(false)
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.kills).toHaveLength(0)
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(true)
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not arm a kill for a settled job', async () => {
    const fake = fakeRegistry()
    fake.rows.push({ ...runningJob('bash-11'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() })
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    await settle()
    const detail = test.views.at(-1)?.openJob
    expect(detail?.killable).toBe(false)
    test.handlers.onJobKill()
    await settle()
    expect(fake.kills).toHaveLength(0)
    expect(test.views.at(-1)?.openJob?.killArmed).toBe(false)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('joins the navigation ladder last and leaves on ↑ at the first row', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-5'), runningJob('bash-6'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // With only jobs present, ↓ lands the cursor on the first job.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.jobsSelected).toBe(2)
    // Clamped at the row count.
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.jobsSelected).toBe(2)
    // ↑ at the first row exits navigation; the open detail closes with it.
    test.handlers.onPanelMove(-1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openJob?.jobId).toBe('bash-5')
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.jobsSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('prefers every other panel over the jobs ladder rung', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-7'))
    const test = await bench({
      jobs: fake.registry,
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? { members: [{ id: 'm-1', name: 'lead', description: 'd', phase: 'active' }], tasks: [] }
          : undefined,
      },
      afterPrompt: () => {},
    })
    await settle()
    // With a team present, ↓ enters the team panel; jobs stay unfocused.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.teamSelected).toBe(0)
    expect(test.views.at(-1)?.jobsSelected).toBeUndefined()
    // The jobs roster still renders below the team panel.
    expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('steps out of the job detail to the roster, then to the input', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-8'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openJob).toBeDefined()
    // The first Esc closes the detail back to the roster (the cursor stays).
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    // The second Esc leaves the panel to the main input.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.jobsSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })
})
