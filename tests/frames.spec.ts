/** The replayable session-event fold: frames, rendered lines, and plan lifetime. */

import { beforeEach, describe, expect, it } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session'
import { createFrameState, foldEvent } from '../src/frames.ts'
import type { FoldDeps, Frame, ToolPresentation } from '../src/frames.ts'

let nextSeq = 0
beforeEach(() => { nextSeq = 0 })
function ev<T extends SessionEventType>(type: T, data: SessionEvent<T>['data']): SessionEvent<T> {
  nextSeq += 1
  return { type, seq: nextSeq, time: 0, data } as SessionEvent<T>
}

function deps(tools: Record<string, ToolPresentation> = {}, childLabels: ReadonlyMap<string, string> = new Map()): FoldDeps {
  return { tools: { get: name => tools[name] }, childLabels }
}

function assistant(text: string): SessionEvent<'assistant/message'> {
  return ev('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  })
}

function chunk(text: string): SessionEvent<'assistant/chunk'> {
  return ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } })
}

/** Fold a full event sequence from an empty state and collect the output. */
function replay(events: readonly SessionEvent[], tools: Record<string, ToolPresentation> = {}): {
  lines: string[]
  state: ReturnType<typeof createFrameState>
} {
  const dep = deps(tools)
  let state = createFrameState()
  const lines: string[] = []
  for (const event of events) {
    const folded = foldEvent(state, event, dep)
    state = folded.state
    lines.push(...folded.lines)
  }
  return { lines, state }
}

describe('fold: user echoes', () => {
  it('echoes user-sourced text messages', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      })),
      deps(),
    )
    expect(folded.lines).toEqual(['❯ hello\n'])
    expect(folded.state.frames).toEqual([{ kind: 'user', seq: 1, text: 'hello' }])
  })

  it('skips plugin-sourced messages', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [{ type: 'text', text: 'injected' }],
        source: { kind: 'plugin', plugin: 'context' },
      })),
      deps(),
    )
    expect(folded.lines).toEqual([])
    expect(folded.state.frames).toEqual([])
  })

  it('skips empty text', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [{ type: 'text', text: '' }],
        source: { kind: 'user' },
      })),
      deps(),
    )
    expect(folded.lines).toEqual([])
    expect(folded.state.frames).toEqual([])
  })
})

describe('fold: notices', () => {
  it('folds a notice-form injection into a notice frame with the source summary and remaining body', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [
          { type: 'text', text: 'Background job subagent-1 finished.' },
          { type: 'text', text: 'Its closing message:' },
          { type: 'text', text: 'all done.' },
        ],
        source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'Background job subagent-1 finished.' },
      })),
      deps(),
    )
    expect(folded.lines).toEqual([
      '[notice] Background job subagent-1 finished.\n',
      '  Its closing message:\n',
      '  all done.\n',
    ])
    expect(folded.state.frames).toEqual([{
      kind: 'notice',
      seq: 1,
      summary: 'Background job subagent-1 finished.',
      body: 'Its closing message:\nall done.',
    }])
  })

  it('folds a relay-form injection with its opening text as the summary', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [
          { type: 'text', text: 'Background subagent child-1 reported:' },
          { type: 'text', text: 'found the bug.' },
        ],
        source: { kind: 'plugin', plugin: 'relay-test', form: 'relay' },
      })),
      deps(),
    )
    expect(folded.state.frames).toEqual([{
      kind: 'notice',
      seq: 1,
      summary: 'Background subagent child-1 reported:',
      body: 'found the bug.',
    }])
  })

  it('reads merge-extensible notice kinds from other packages structurally', () => {
    // dsh-terminal does not import dsh-subagent, so its settlement/report source
    // kinds sit outside the compile-time MessageSource union; the fold reads
    // their form and summary fields structurally.
    const source = {
      kind: 'subagent-settled',
      form: 'notice',
      summary: 'Background subagent child-1 finished.',
      senderSessionId: 'child-1',
    } as unknown as MessageSource
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [
          { type: 'text', text: 'Background subagent child-1 finished.' },
          { type: 'text', text: 'done.' },
        ],
        source,
      })),
      deps(),
    )
    expect(folded.state.frames).toEqual([{
      kind: 'notice',
      seq: 1,
      summary: 'Background subagent child-1 finished.',
      body: 'done.',
    }])
  })

  it('renames the sender session id in notice text to the friendly label', () => {
    const source = {
      kind: 'subagent-settled',
      form: 'notice',
      summary: 'Background subagent child-1 finished.',
      senderSessionId: 'child-1',
    } as unknown as MessageSource
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [
          { type: 'text', text: 'Background subagent child-1 finished.' },
          { type: 'text', text: 'closing note about child-1.' },
        ],
        source,
      })),
      deps({}, new Map([['child-1', 'architect']])),
    )
    expect(folded.state.frames).toEqual([{
      kind: 'notice',
      seq: 1,
      summary: 'Background subagent architect finished.',
      body: 'closing note about architect.',
    }])
  })

  it('keeps the raw id when the sender has no known label', () => {
    const source = {
      kind: 'subagent-settled',
      form: 'notice',
      summary: 'Background subagent child-1 finished.',
      senderSessionId: 'child-1',
    } as unknown as MessageSource
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Background subagent child-1 finished.' }],
        source,
      })),
      deps(),
    )
    expect(folded.state.frames[0]).toMatchObject({ kind: 'notice', summary: 'Background subagent child-1 finished.' })
  })

  it('keeps the full text as body when the first content block is not text', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'report arrived.' },
        ],
        source: { kind: 'plugin', plugin: 'relay-test', form: 'notice', summary: 'report arrived.' },
      })),
      deps(),
    )
    expect(folded.state.frames).toEqual([{
      kind: 'notice',
      seq: 1,
      summary: 'report arrived.',
      body: 'report arrived.',
    }])
  })

  it('folds a summary-only notice without a body', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Background job subagent-1 finished.' }],
        source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'Background job subagent-1 finished.' },
      })),
      deps(),
    )
    expect(folded.lines).toEqual(['[notice] Background job subagent-1 finished.\n'])
    expect(folded.state.frames).toEqual([{ kind: 'notice', seq: 1, summary: 'Background job subagent-1 finished.' }])
  })

  it('keeps context-form injections off the terminal stream', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [{ type: 'text', text: 'assembled context' }],
        source: { kind: 'plugin', plugin: 'context', form: 'snapshot', sections: [] },
      })),
      deps(),
    )
    expect(folded.lines).toEqual([])
    expect(folded.state.frames).toEqual([])
  })

  it('drops a notice injection with no displayable account', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('user/message', createUserMessage({
        content: [],
        source: { kind: 'plugin', plugin: 'relay-test', form: 'relay' },
      })),
      deps(),
    )
    expect(folded.lines).toEqual([])
    expect(folded.state.frames).toEqual([])
  })
})

describe('fold: assistant streaming', () => {
  it('accumulates text deltas into one open frame and streams them verbatim', () => {
    const { lines, state } = replay([chunk('Hel'), chunk('lo')])
    expect(lines).toEqual(['Hel', 'lo'])
    expect(state.frames).toEqual([{ kind: 'assistant', seq: 1, turn: 1, step: 1, text: 'Hello', streaming: true }])
  })

  it('commits the stream: replaces text, closes the frame, and closes the line', () => {
    const { lines, state } = replay([chunk('Hel'), chunk('lo'), assistant('Hello')])
    expect(lines).toEqual(['Hel', 'lo', '\n'])
    // The committed frame keeps the seq of the first chunk that opened it.
    expect(state.frames).toEqual([{ kind: 'assistant', seq: 1, turn: 1, step: 1, text: 'Hello', streaming: false }])
  })

  it('prints the committed text when no stream preceded it', () => {
    const { lines, state } = replay([assistant('answer')])
    expect(lines).toEqual(['answer\n'])
    expect(state.frames).toEqual([{ kind: 'assistant', seq: 1, turn: 1, step: 1, text: 'answer', streaming: false }])
  })

  it('does not reprint or pad a committed text already ending in a newline', () => {
    const { lines } = replay([chunk('x\n'), assistant('x\n')])
    expect(lines).toEqual(['x\n'])
  })

  it('folds reasoning deltas into the open frame thinking', () => {
    const first = { type: 'assistant/chunk', seq: 1, time: 1000, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } } } as SessionEvent<'assistant/chunk'>
    const second = { type: 'assistant/chunk', seq: 2, time: 2000, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'ing' } } } as SessionEvent<'assistant/chunk'>
    const { lines, state } = replay([first, second])
    expect(lines).toEqual([])
    expect(state.frames).toEqual([{
      kind: 'assistant',
      seq: 1,
      turn: 1,
      step: 1,
      text: '',
      streaming: true,
      // The second delta at t=2000 refreshes the span to one second already.
      thinking: { text: 'thinking', startedAt: 1000, seconds: 1 },
    }])
  })

  it('computes thinking seconds from event times at the commit point', () => {
    const started = { type: 'assistant/chunk', seq: 1, time: 10_000, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } } } as SessionEvent<'assistant/chunk'>
    const committed = {
      type: 'assistant/message',
      seq: 2,
      time: 14_600,
      data: { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'p', model: 'm' } }) },
    } as SessionEvent<'assistant/message'>
    const { state } = replay([started, committed])
    expect(state.frames).toEqual([{
      kind: 'assistant',
      seq: 1,
      turn: 1,
      step: 1,
      text: 'answer',
      streaming: false,
      thinking: { text: 'hmm', startedAt: 10_000, seconds: 5 },
    }])
  })

  it('computes thinking seconds when the turn ends mid-stream', () => {
    const started = { type: 'assistant/chunk', seq: 1, time: 1000, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } } } as SessionEvent<'assistant/chunk'>
    const ended = { type: 'turn/end', seq: 2, time: 4500, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent<'turn/end'>
    const { state } = replay([started, ended])
    expect(state.frames[0]).toMatchObject({ kind: 'assistant', streaming: false, thinking: { text: 'hmm', seconds: 4 } })
  })

  it('extracts reasoning from a committed message with no stream', () => {
    const committed = {
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'reasoning', text: 'why' }, { type: 'text', text: 'answer' }],
          source: { provider: 'p', model: 'm' },
        }),
      },
    } as SessionEvent<'assistant/message'>
    const { state } = replay([committed])
    expect(state.frames[0]).toMatchObject({ kind: 'assistant', text: 'answer', streaming: false, thinking: { text: 'why', seconds: 0 } })
  })
})

describe('fold: tool cards', () => {
  it('falls back to a generic call card when the tool has no presentation', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'read_file', arguments: '{"path":"a.ts"}' }),
      deps(),
    )
    expect(folded.lines).toEqual(['[tool] read_file\n'])
    const frame = folded.state.frames[0]
    expect(frame).toMatchObject({ kind: 'tool', callId: 'c1', name: 'read_file', args: { path: 'a.ts' } })
    expect(frame).toMatchObject({ call: { card: 'generic', title: 'read_file', rawInput: { path: 'a.ts' } } })
  })

  it('falls back to the generic card for malformed logged arguments', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'read_file', arguments: 'not-json' }),
      deps(),
    )
    const frame = folded.state.frames[0]
    expect(frame).toMatchObject({ args: undefined, call: { card: 'generic', rawInput: 'not-json' } })
  })

  it('renders terminal call and result cards from the tool presentation', () => {
    const bash: ToolPresentation = {
      presentCall: () => ({ card: 'terminal', title: 'ls', cwd: '/tmp' }),
      presentResult: () => ({ card: 'terminal', title: 'ls', output: 'a.txt\n', exitCode: 0 }),
    }
    const call = ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{"command":"ls"}' })
    const result = ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'a.txt\n' }],
        isError: false,
      }),
    })
    const { lines, state } = replay([call, result], { bash })
    expect(lines).toEqual(['$ ls\n', 'a.txt\n', 'exit 0\n'])
    const frame = state.frames[0]
    expect(frame).toMatchObject({ call: { card: 'terminal' }, result: { card: 'terminal', exitCode: 0 } })
  })

  it('renders diff call and result cards', () => {
    const write: ToolPresentation = {
      presentCall: () => ({
        card: 'diff',
        title: 'Write a.ts',
        diffs: [{ path: 'a.ts', oldText: null, newText: 'x\n' }],
      }),
      presentResult: () => ({
        card: 'diff',
        title: 'Write a.ts',
        diffs: [{ path: 'a.ts', oldText: '', newText: 'x\n' }],
      }),
    }
    const call = ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'write', arguments: '{}' })
    const result = ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c1'), content: [], isError: false }),
    })
    const { lines } = replay([call, result], { write })
    expect(lines).toEqual(['[diff] Write a.ts\n', '  a.ts (new)\n', '  a.ts\n', '+ x\n'])
  })

  it('renders the raw result content when the tool has no result presentation', () => {
    const call = ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'read_file', arguments: '{}' })
    const result = ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: 'a.ts content' }],
        isError: false,
      }),
    })
    const { lines } = replay([call, result])
    expect(lines).toEqual(['[tool] read_file\n', 'a.ts content\n'])
  })

  it('strips the outer console fence and carries the error flag on failed results', () => {
    const call = ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{}' })
    const result = ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c1'),
        content: [{ type: 'text', text: '```console\nError: rejected\n```' }],
        isError: true,
      }),
    })
    const { lines, state } = replay([call, result])
    expect(lines).toEqual(['[tool] bash\n', 'Error: rejected\n'])
    // tool/result updates the pending tool frame in place — still frames[0].
    const frame = state.frames[0] as Extract<Frame, { kind: 'tool' }> | undefined
    expect(frame?.isError).toBe(true)
  })

  it('ignores an orphan tool result with no matching pending call', () => {
    const result = ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c9'), content: [], isError: false }),
    })
    const { lines, state } = replay([result])
    expect(lines).toEqual([])
    expect(state.frames).toEqual([])
  })
})

describe('fold: todo plan', () => {
  it('renders the standing plan on write and clears it on turn/start', () => {
    const write = ev('todo/write', {
      todos: [
        { content: 'pending task', status: 'pending' },
        { content: 'active task', status: 'in_progress' },
        { content: 'done task', status: 'completed' },
      ],
    })
    const turnStart = ev('turn/start', { turn: 2 })
    const { lines, state } = replay([write, turnStart])
    expect(lines).toEqual([
      '● todolist进行中...\n',
      '  ⎿  ◻ pending task\n',
      '     ◼ active task\n',
      '     ✔ done task\n',
    ])
    expect(state.plan).toBeUndefined()
  })

  it('hides the standing plan once every item is completed', () => {
    const { state } = replay([ev('todo/write', {
      todos: [
        { content: 'task one', status: 'completed' },
        { content: 'task two', status: 'completed' },
      ],
    })])
    expect(state.plan).toBeUndefined()
  })

  it('keeps the plan across assistant output until the next turn starts', () => {
    const { state } = replay([ev('todo/write', { todos: [{ content: 'task', status: 'pending' }] }), assistant('ok')])
    expect(state.plan).toEqual([{ content: 'task', status: 'pending' }])
  })
})

describe('fold: interruption marker', () => {
  it('appends the marker when the user aborts the turn', () => {
    const { lines, state } = replay([
      ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ])
    expect(lines).toEqual(['[interrupted] Interrupted\n'])
    expect(state.frames.at(-1)).toEqual({ kind: 'interrupted', seq: 1 })
  })

  it('does not mark non-user aborts or completed turns', () => {
    const legacy = replay([ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } })])
    expect(legacy.state.frames).toEqual([])
    const done = replay([ev('turn/end', { turn: 1, reason: { kind: 'completed' } })])
    expect(done.state.frames).toEqual([])
  })
})

describe('fold: active step', () => {
  it('opens the thinking clock on step/start and closes it on step/end', () => {
    const { state: open } = replay([ev('step/start', { turn: 1, step: 1 })])
    expect(open.activeStep).toEqual({ turn: 1, step: 1, startedAt: 0 })
    const { state: closed } = replay([
      ev('step/start', { turn: 1, step: 1 }),
      ev('step/end', { turn: 1, step: 1 }),
    ])
    expect(closed.activeStep).toBeUndefined()
  })

  it('ignores a stale step/end and clears the clock on turn/end', () => {
    const stale = replay([
      ev('step/start', { turn: 1, step: 2 }),
      ev('step/end', { turn: 1, step: 1 }),
    ])
    expect(stale.state.activeStep).toEqual({ turn: 1, step: 2, startedAt: 0 })
    const ended = replay([
      ev('step/start', { turn: 1, step: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(ended.state.activeStep).toBeUndefined()
  })
})

describe('fold: commands', () => {
  it('renders a user slash command and pairs its settled outcome', () => {
    const run = ev('command/run', { commandId: CommandId('c1'), name: 'quit', args: '', source: { kind: 'user' } })
    const done = ev('command/done', { commandId: CommandId('c1'), kind: 'success', text: 'bye' })
    const { lines, state } = replay([run, done])
    expect(lines).toEqual(['/quit\n'])
    expect(state.frames).toEqual([{
      kind: 'command',
      seq: 1,
      commandId: CommandId('c1'),
      name: 'quit',
      args: '',
      done: { kind: 'success', text: 'bye' },
    }])
  })

  it('records an error outcome without a text payload', () => {
    const run = ev('command/run', { commandId: CommandId('c2'), name: 'compact', source: { kind: 'user' } })
    const done = ev('command/done', { commandId: CommandId('c2'), kind: 'error' })
    const { state } = replay([run, done])
    const frame = state.frames.at(-1)
    expect(frame).toMatchObject({ kind: 'command', name: 'compact', done: { kind: 'error' } })
    expect('args' in (frame as Extract<Frame, { kind: 'command' }>)).toBe(false)
  })

  it('ignores an orphan command settlement', () => {
    const done = ev('command/done', { commandId: CommandId('c9'), kind: 'success', text: 'x' })
    const { lines, state } = replay([done])
    expect(lines).toEqual([])
    expect(state.frames).toEqual([])
  })
})

describe('fold: turn boundaries', () => {
  it('closes streaming assistant frames on turn/end', () => {
    const { state } = replay([chunk('partial'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } })])
    expect(state.frames).toEqual([{ kind: 'assistant', seq: 1, turn: 1, step: 1, text: 'partial', streaming: false }])
    expect(state.openAssistant.size).toBe(0)
  })

  it('ignores unknown event families', () => {
    const folded = foldEvent(
      createFrameState(),
      ev('request/header', { header: {} as never, reason: 'initial' }),
      deps(),
    )
    expect(folded.lines).toEqual([])
    expect(folded.state.frames).toEqual([])
  })
})

describe('fold: replay determinism', () => {
  it('folds the same event sequence into the same frames and lines', () => {
    const events = [
      ev('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })),
      chunk('Hel'),
      chunk('lo'),
      assistant('Hello'),
      ev('todo/write', { todos: [{ content: 'task', status: 'in_progress' }] }),
      ev('turn/start', { turn: 2 }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(replay(events)).toEqual(replay(events))
  })
})
