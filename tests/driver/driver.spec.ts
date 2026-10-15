/** Direct interactive driving: frame-model folds, rebuilds, concurrent submission, flushing, and exit mapping. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { apply, Config, flushWithTimeout, run } from '../../src/index.ts'
import { createFrameState } from '../../src/fold/frames.ts'
import { appendTurn, bench } from '../helpers/bench.ts'

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

