/** Direct interactive driving: frame-model folds, rebuilds, concurrent submission, flushing, and exit mapping. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
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
import { createFrameState } from '../src/frames.ts'
import type { FrameState } from '../src/frames.ts'

interface Script {
  /** When set, the driver must resume this persisted session id. */
  resumeId?: string
  /** Registered before the driver reads the tools registry. */
  tools?: unknown
  /** Registered before the driver reads the commands registry. */
  commands?: unknown
  /** Registered before the driver resolves the model context window. */
  llm?: unknown
  /** Registered before the driver reads the effective sandbox mode. */
  sandboxPolicy?: unknown
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
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: agentCtx,
      cancel: () => {},
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        agent.inbox.append('next-turn', message)
        idle = Promise.resolve().then(() => script.afterPrompt(ctx, session, message, ++turn))
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => idle,
    } satisfies Partial<Agent>)
    await setup?.(agentCtx)
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
    void run(ctx, script.resumeId === undefined ? {} : { resume: script.resumeId }, io, renderer)
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

  it('streams assistant chunks into one open frame and commits it', async () => {
    const test = await bench({
      afterPrompt(_ctx, session, message, turn) {
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } })
        session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } })
        session.append('assistant/message', {
          turn,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'Hello' }],
            source: { provider: 'test-provider', model: 'test-model' },
          }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      },
    })
    test.handlers.onCommit('stream')
    await test.agent.whenIdle()
    // Chunk renders fold into the throttled window; let it flush.
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
    test.handlers.onApproval(true)
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

  it('shows an unknown-command notice and never submits a model message', async () => {
    const followups: string[] = []
    const test = await bench({
      commands: { execute: () => Promise.resolve(undefined) },
      afterPrompt: () => {},
    })
    const original = test.agent.followup.bind(test.agent)
    test.agent.followup = (message: UserMessage) => {
      followups.push(message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(''))
      original(message)
    }
    test.handlers.onCommit('/bogus')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(followups).toEqual([])
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
    test.handlers.onApproval(true)
    expect(await outcome).toBe('allowed-once')
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
    // Enter on the main row returns focus to the input bar.
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
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
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
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
      test.handlers.onPanelBack()
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
