/** The ink view: frame rendering and input-bar key handling through ink-testing-library. */

import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { TuiApp } from '../src/renderer.tsx'
import type { InputHandlers, RenderView } from '../src/renderer.tsx'
import { createFrameState } from '../src/frames.ts'
import type { Frame, FrameState } from '../src/frames.ts'

/** Let the throttled ink render flush after a stdin write. */
async function settled(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function state(frames: readonly Frame[], plan?: FrameState['plan']): FrameState {
  return { ...createFrameState(), frames, ...plan === undefined ? {} : { plan } }
}

function noopHandlers(): InputHandlers {
  return {
    onCommit: () => {},
    onInterrupt: () => {},
    onApproval: () => {},
    onExit: () => {},
    onPanelOpen: () => {},
    onPanelMove: () => {},
    onPanelEnter: () => {},
    onPanelBack: () => {},
  }
}

/**
 * ink's render result with an ANSI-stripping `lastFrame`: ink emits color
 * codes whenever the ambient environment forces colors (FORCE_COLOR, CI), so
 * text assertions must not depend on the color state of the runner.
 */
function renderApp(ui: React.JSX.Element) {
  const result = render(ui)
  return {
    ...result,
    lastFrame: (): string => (result.lastFrame() ?? '').replace(/\[[0-9;]*[a-zA-Z]/g, ''),
  }
}

describe('TuiApp rendering', () => {
  it('renders the empty stream with the input marker', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('❯ ▏')
  })

  it('renders user echoes, assistant text, and streaming frames in order', () => {
    const frames: Frame[] = [
      { kind: 'user', seq: 1, text: 'hello' },
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: 'Hel', streaming: true },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('❯ hello')
    expect(frame).toContain('● Hel')
    expect(frame.indexOf('❯ hello')).toBeLessThan(frame.indexOf('● Hel'))
  })

  it('separates frames with a blank line', () => {
    const frames: Frame[] = [
      { kind: 'user', seq: 1, text: 'hello' },
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: 'answer', streaming: false },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    expect(lastFrame()).toMatch(/❯ hello\n\n+● answer/)
  })

  it('renders a notice frame with its account line and truncated body', () => {
    const frames: Frame[] = [
      { kind: 'notice', seq: 1, summary: 'Background subagent child-1 finished.', body: 'a\nb\nc\nd\ne\nf\ng\nh' },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Background subagent child-1 finished.')
    expect(frame).toContain('… 2 more lines (ctrl+o to expand)')
  })

  it('renders a notice frame without a body as just its account line', () => {
    const frames: Frame[] = [
      { kind: 'notice', seq: 1, summary: 'Background subagent child-1 settled.' },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Background subagent child-1 settled.')
    expect(frame).not.toContain('⎿')
  })

  it('puts the assistant marker on the first non-empty line, not a leading newline', () => {
    const frames: Frame[] = [
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: '\nanswer', streaming: false },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● answer')
    expect(frame).not.toContain('●\n')
  })

  it('renders bold markdown without the asterisk markers', () => {
    const frames: Frame[] = [
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: '现在是 **2026年8月26日** 星期三', streaming: false },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('2026年8月26日')
    expect(frame).not.toContain('**')
    expect(frame).not.toContain('*2026')
  })

  it('renders inline code and headings without their markers', () => {
    const frames: Frame[] = [
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: '# 标题\n运行 `pnpm test` 验证', streaming: false },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● 标题')
    expect(frame).not.toContain('# 标题')
    expect(frame).toContain('pnpm test')
    expect(frame).not.toContain('`')
  })

  it('renders nothing for an assistant frame with only whitespace', () => {
    const frames: Frame[] = [
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: '\n', streaming: false },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    expect(lastFrame()).not.toContain('●')
  })

  it('shows a fixed window of the latest reasoning lines behind the thought marker', () => {
    const text = Array.from({ length: 10 }, (_, i) => `idea ${i + 1}`).join('\n')
    const frames: Frame[] = [{
      kind: 'assistant',
      seq: 2,
      turn: 1,
      step: 1,
      text: 'answer',
      streaming: false,
      thinking: { text, startedAt: 0, seconds: 4 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // Reasoning precedes the visible text, mirroring the model's order.
    expect(frame.indexOf('● Thought for 4s')).toBeLessThan(frame.indexOf('● answer'))
    expect(frame).toContain('╭')
    expect(frame).toContain('idea 6')
    expect(frame).toContain('idea 10')
    expect(frame).not.toContain('idea 1\n')
    expect(frame).not.toContain('idea 5')
  })

  it('wraps long reasoning lines into full-width rows without clipping', () => {
    const long = 'x'.repeat(200)
    const frames: Frame[] = [{
      kind: 'assistant',
      seq: 2,
      turn: 1,
      step: 1,
      text: 'answer',
      streaming: false,
      thinking: { text: long, startedAt: 0, seconds: 1 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // 200 columns at the 78-wide content box wrap into three physical rows,
    // the whole text visible, no clip marker.
    const inside = frame.split('\n').filter(line => line.includes('x'))
    expect(inside).toHaveLength(3)
    expect(frame).not.toContain('…')
    expect(frame).toContain('x'.repeat(78))
    expect(frame).toContain('x'.repeat(44))
  })

  it('sizes the thought window to the reasoning length below the cap', () => {
    const frames: Frame[] = [{
      kind: 'assistant',
      seq: 2,
      turn: 1,
      step: 1,
      text: 'answer',
      streaming: false,
      thinking: { text: 'only two', startedAt: 0, seconds: 4 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const inside = (lastFrame() ?? '').split('\n').filter(line => line.includes('only two'))
    expect(inside).toHaveLength(1)
  })

  it('shows the whole reasoning when it fits the window', () => {
    const frames: Frame[] = [{
      kind: 'assistant',
      seq: 2,
      turn: 1,
      step: 1,
      text: 'answer',
      streaming: false,
      thinking: { text: 'first idea\nsecond idea', startedAt: 0, seconds: 4 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Thought for 4s')
    expect(frame).toContain('first idea')
    expect(frame).toContain('second idea')
  })

  it('renders the thought window even when the visible text is empty', () => {
    const frames: Frame[] = [{
      kind: 'assistant',
      seq: 2,
      turn: 1,
      step: 1,
      text: '\n',
      streaming: false,
      thinking: { text: 'deep thought', startedAt: 0, seconds: 2 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Thought for 2s')
    expect(frame).toContain('deep thought')
    expect(frame).not.toContain('●\n')
  })

  it('renders a terminal tool card with command, output, and exit pill', () => {
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 3,
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'bash',
      args: { command: 'ls' },
      call: { card: 'terminal', title: 'ls' },
      result: { card: 'terminal', output: 'a.txt\n', exitCode: 0 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Bash(ls)')
    expect(frame).toContain('⎿  a.txt')
  })

  it('shows a sibling tool result that lands after a newer frame has overtaken it', () => {
    const first: Frame = {
      kind: 'tool', seq: 3, turn: 1, step: 1, callId: 'c1', name: 'subagent',
      args: { description: '调查 subagent 包结构' },
      call: { card: 'generic', title: '调查 subagent 包结构' },
    }
    const second: Frame = {
      kind: 'tool', seq: 4, turn: 1, step: 1, callId: 'c2', name: 'subagent',
      args: { description: '统计仓库包数量' },
      call: { card: 'generic', title: '统计仓库包数量' },
    }
    const { lastFrame, rerender } = renderApp(<TuiApp state={state([first, second])} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('● Subagent(调查 subagent 包结构)')
    expect(lastFrame()).not.toContain('started subagent child-1')
    const settledFirst: Frame = { ...first, resultContent: [{ type: 'text', text: 'started subagent child-1' }] }
    rerender(<TuiApp state={state([settledFirst, second])} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('started subagent child-1')
  })

  it('aligns continuation output lines under the connector text', () => {
    const frames: Frame[] = [{
      kind: 'tool', seq: 5, turn: 1, step: 1, callId: 'c3', name: 'bash',
      args: { command: 'ls' },
      call: { card: 'terminal', title: 'ls' },
      result: { card: 'terminal', output: 'a.txt\nb.txt\n', exitCode: 0 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('  ⎿  a.txt')
    expect(frame).toContain('     b.txt')
  })

  it('renders a diff card with its path lines', () => {
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 4,
      turn: 1,
      step: 1,
      callId: 'c2',
      name: 'write',
      args: {},
      call: {
        card: 'diff',
        title: 'Write a.ts',
        diffs: [{ path: 'a.ts', oldText: null, newText: 'x\n' }],
      },
      result: {
        card: 'diff',
        title: 'Write a.ts',
        diffs: [{ path: 'a.ts', oldText: '', newText: 'x\n' }],
      },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Write(a.ts (new))')
    expect(frame).toContain('a.ts (new)')
    expect(frame).toContain('+ x')
  })

  it('truncates long tool output with an expand hint and toggles on ctrl+o', async () => {
    const long = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n')
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 9,
      turn: 1,
      step: 1,
      callId: 'c4',
      name: 'bash',
      args: { command: 'seq 35' },
      call: { card: 'terminal', title: 'seq 35' },
      result: { card: 'terminal', output: long, exitCode: 0 },
    }]
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    let frame = lastFrame() ?? ''
    expect(frame).toContain('⎿  line 1')
    expect(frame).toContain('line 6')
    expect(frame).not.toContain('⎿  line 2')
    expect(frame).not.toContain('line 7')
    expect(frame).toContain('29 more lines (ctrl+o to expand)')
    stdin.write('\x0f')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('line 31')
    expect(frame).toContain('line 35')
    expect(frame).not.toContain('more lines')
    stdin.write('\x0f')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).not.toContain('line 7')
    expect(frame).toContain('29 more lines (ctrl+o to expand)')
  })

  it('does not truncate output within the limit', () => {
    const lines = Array.from({ length: 3 }, (_, i) => `line ${i + 1}`).join('\n')
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 10,
      turn: 1,
      step: 1,
      callId: 'c5',
      name: 'bash',
      args: { command: 'seq 3' },
      call: { card: 'terminal', title: 'seq 3' },
      result: { card: 'terminal', output: lines, exitCode: 0 },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('line 3')
    expect(lastFrame()).not.toContain('more lines')
  })

  it('types l as a character even when the buffer is empty', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    stdin.write('l')
    await settled()
    expect(lastFrame()).toContain('❯ l▏')
  })

  it('renders the standing plan panel pinned above the input bar', () => {
    const plan = [
      { content: 'task one', status: 'in_progress' as const },
      { content: 'task two', status: 'pending' as const },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state([], plan)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // The first line carries the `⎿` connector; continuations align at five columns.
    expect(frame).toContain('  ⎿  ◼ task one')
    expect(frame).toContain('     ◻ task two')
    // The header carries the same green dot as the tool call lines.
    expect(frame).toContain('● todolist进行中...')
    // The panel is pinned directly above the input bar: below the stream's
    // welcome block, above the `❯` input marker.
    expect(frame.indexOf('DeepSeek Harness — Terminal')).toBeLessThan(frame.indexOf('● todolist进行中...'))
    expect(frame.indexOf('● todolist进行中...')).toBeLessThan(frame.indexOf('❯'))
  })

  it('renders the user-interruption marker after the interrupted turn', () => {
    const frames: Frame[] = [{ kind: 'interrupted', seq: 3 }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Interrupted')
    expect(frame).toContain('· What should dsh do instead?')
  })

  it('renders the heartbeat above the input bar while a step is in flight', () => {
    const working: FrameState = { ...state([]), activeStep: { turn: 1, step: 1, startedAt: Date.now() } }
    const { lastFrame } = renderApp(<TuiApp state={working} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('✢ Running… (0s)')
    expect(frame.indexOf('✢ Running…')).toBeLessThan(frame.indexOf('❯'))
  })

  it('pins the heartbeat below the plan and keeps the label while a tool is pending', () => {
    const plan = [{ content: 'task one', status: 'in_progress' as const }]
    const thinking: FrameState = {
      ...state([], plan),
      activeStep: { turn: 1, step: 1, startedAt: Date.now() },
    }
    const { lastFrame } = renderApp(<TuiApp state={thinking} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame.indexOf('● todolist进行中...')).toBeLessThan(frame.indexOf('✢ Running…'))
    // A step covers the model call and its tool executions: the heartbeat
    // stays up — and keeps its single label — while a tool runs.
    const busy: FrameState = { ...thinking, pendingTools: new Map([['c1', 0]]) }
    expect(renderApp(<TuiApp state={busy} handlers={noopHandlers()} />).lastFrame()).toContain('✢ Running…')
  })

  it('renders a failed generic tool result bare, without the console fence', () => {
    const fenced = '```console\nError: the user rejected escalating\n```'
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 5,
      turn: 1,
      step: 1,
      callId: 'c5',
      name: 'bash',
      args: {},
      call: { card: 'generic', title: 'printf', rawInput: {} },
      result: { card: 'generic', content: [{ type: 'text', text: fenced }] },
      resultContent: [{ type: 'text', text: fenced }],
      isError: true,
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Error: the user rejected escalating')
    expect(frame).not.toContain('```')
  })

  it('renders the raw result content when the tool card has no result view', () => {
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 5,
      turn: 1,
      step: 1,
      callId: 'c3',
      name: 'read_file',
      args: {},
      call: { card: 'generic', title: 'read_file', rawInput: {} },
      resultContent: [{ type: 'text', text: 'file content\n' }],
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('file content')
  })

  it('renders a read card as numbered lines without the raw envelope', () => {
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 11,
      turn: 1,
      step: 1,
      callId: 'c6',
      name: 'read',
      args: { file_path: '/tmp/test.txt' },
      call: { card: 'generic', title: 'Read /tmp/test.txt', kind: 'read', rawInput: {} },
      result: {
        card: 'read',
        path: '/tmp/test.txt',
        offset: 1,
        lines: [
          { number: 1, text: 'first line' },
          { number: 2, text: 'second line' },
        ],
        totalLines: 2,
      },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // The call label is not repeated inside the invocation.
    expect(frame).toContain('● Read(/tmp/test.txt)')
    expect(frame).toContain('1: first line')
    expect(frame).toContain('2: second line')
    expect(frame).toContain('(End of file)')
    expect(frame).not.toContain('<path>')
  })

  it('truncates a long diff card and expands it on the l key', async () => {
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 13,
      turn: 1,
      step: 1,
      callId: 'c8',
      name: 'edit',
      args: {},
      call: { card: 'diff', title: 'Edit a.ts', diffs: [] },
      result: {
        card: 'diff',
        title: 'Edit a.ts',
        diffs: [{
          path: 'a.ts',
          oldText: Array.from({ length: 5 }, (_, i) => `old ${i + 1}`).join('\n'),
          newText: Array.from({ length: 5 }, (_, i) => `new ${i + 1}`).join('\n'),
        }],
      },
    }]
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    let frame = lastFrame() ?? ''
    expect(frame).toContain('a.ts')
    expect(frame).toContain('- old 1')
    expect(frame).not.toContain('new 4')
    expect(frame).toContain('more lines (ctrl+o to expand)')
    stdin.write('\x0f')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('new 4')
    expect(frame).toContain('new 5')
    expect(frame).not.toContain('more lines')
  })

  it('truncates a long read card and expands it on ctrl+o', async () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, text: `line ${i + 1}` }))
    const frames: Frame[] = [{
      kind: 'tool',
      seq: 12,
      turn: 1,
      step: 1,
      callId: 'c7',
      name: 'read',
      args: { file_path: '/tmp/test.txt' },
      call: { card: 'generic', title: 'Read /tmp/test.txt', kind: 'read', rawInput: {} },
      result: { card: 'read', path: '/tmp/test.txt', offset: 1, lines, totalLines: 9 },
    }]
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    let frame = lastFrame() ?? ''
    expect(frame).toContain('1: line 1')
    expect(frame).toContain('6: line 6')
    expect(frame).not.toContain('7: line 7')
    expect(frame).toContain('3 more lines (ctrl+o to expand)')
    stdin.write('\x0f')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('7: line 7')
    expect(frame).toContain('9: line 9')
    expect(frame).toContain('(End of file)')
    expect(frame).not.toContain('more lines')
  })

  it('renders a slash command with its settled outcome', () => {
    const frames: Frame[] = [
      { kind: 'command', seq: 6, commandId: 'c1', name: 'quit', args: '' },
      {
        kind: 'command',
        seq: 7,
        commandId: 'c2',
        name: 'compact',
        args: ' -1',
        done: { kind: 'success', text: 'compacted' },
      },
      {
        kind: 'command',
        seq: 8,
        commandId: 'c3',
        name: 'bogus',
        done: { kind: 'error', text: 'no such file' },
      },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('/quit')
    expect(frame).toContain('/compact -1')
    expect(frame).toContain('compacted')
    expect(frame).toContain('/bogus')
    expect(frame).toContain('no such file')
  })

  it('renders a notice overlay above the input bar', () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={{ overlay: { kind: 'notice', text: 'unknown command: /x' } }} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame.indexOf('unknown command: /x')).toBeLessThan(frame.indexOf('❯ ▏'))
  })

  it('renders the status bar with model, cwd, and mode', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{ status: { model: 'test-model', cwd: `${os.homedir()}/repo`, mode: 'read-only', effort: 'max' } }}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('test-model')
    expect(frame).toContain('~/repo')
    // The mode sits on its own row below the model line.
    expect(frame.indexOf('read-only')).toBeGreaterThan(frame.indexOf('~/repo'))
    // The effort hint sits right-aligned on the model line.
    expect(frame).toContain('◈ max · /effort')
    expect(frame.indexOf('◈ max')).toBeGreaterThan(frame.indexOf('context'))
  })

  it('renders the welcome block with title, model, and cwd', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{ status: { model: 'test-model', cwd: '/workspace/repo' } }}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('DeepSeek Harness — Terminal')
    expect(frame).toContain('model: test-model')
    expect(frame).toContain('cwd: /workspace/repo')
    expect(frame.indexOf('model: test-model')).toBeLessThan(frame.indexOf('cwd: /workspace/repo'))
  })

  it('renders the context ratio in the status bar', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          status: {
            model: 'test-model',
            cwd: '/workspace/repo',
            context: { used: 63_000, window: 786_400 },
          },
        }}
      />,
    )
    expect(lastFrame()).toContain('context: 63k/786.4k (8%)')
  })

  it('renders every frame appended into the stream', () => {
    const frames: Frame[] = [1, 2, 3, 4, 5].map(seq => ({ kind: 'user' as const, seq, text: `m${seq}` }))
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // All frames are present, oldest first; the terminal scrolls, not the TUI.
    for (let seq = 1; seq <= 5; seq++) {
      expect(frame.indexOf(`❯ m${seq}`)).toBeGreaterThanOrEqual(0)
    }
    expect(frame.indexOf('❯ m1')).toBeLessThan(frame.indexOf('❯ m5'))
  })

  it('renders an approval question with options, answered by y/n/Esc/arrows/Enter', async () => {
    const onApproval = vi.fn()
    const { lastFrame, stdin } = renderApp(
      <TuiApp
        state={state([])}
        handlers={{ ...noopHandlers(), onApproval }}
        view={{ overlay: { kind: 'approval', toolName: 'bash', reason: 'run rm -rf' } }}
      />,
    )
    let frame = lastFrame() ?? ''
    expect(frame).toContain('Allow Bash? (y/esc)')
    expect(frame).toContain('  ─ run rm -rf')
    expect(frame).toContain('Do you want to proceed?')
    expect(frame).toContain('❯ 1. Yes')
    expect(frame).toContain('2. No')
    stdin.write('\x1b[B') // Down: select No
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('❯ 2. No')
    expect(frame).toContain('1. Yes')
    stdin.write('\r') // Enter commits the selection
    await settled()
    expect(onApproval).toHaveBeenCalledWith(false)
    stdin.write('\x1b[A') // Up: back to Yes
    await settled()
    stdin.write('\r')
    await settled()
    expect(onApproval).toHaveBeenCalledWith(true)
    stdin.write('n')
    await settled()
    expect(onApproval).toHaveBeenLastCalledWith(false)
    stdin.write('\x1b') // Esc rejects too
    await settled()
    expect(onApproval).toHaveBeenLastCalledWith(false)
    // Typing while a question is pending answers the question, not the buffer.
    expect(lastFrame()).toContain('❯ ▏')
  })
})

describe('InputBar key handling', () => {
  it('types characters at the cursor and commits on Enter', async () => {
    const onCommit = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onCommit }} />)
    stdin.write('hello')
    await settled()
    expect(lastFrame()).toContain('❯ hello▏')
    stdin.write('\r')
    await settled()
    expect(onCommit).toHaveBeenCalledWith('hello')
    expect(lastFrame()).toContain('❯ ▏')
  })

  it('inserts a newline on Ctrl+J and submits the multiline buffer', async () => {
    const onCommit = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onCommit }} />)
    stdin.write('line one')
    stdin.write('\x0a')
    stdin.write('line two')
    await settled()
    expect(lastFrame()).toContain('line one')
    expect(lastFrame()).toContain('line two')
    stdin.write('\r')
    await settled()
    expect(onCommit).toHaveBeenCalledWith('line one\nline two')
  })

  it('clears the buffer on Ctrl+C with content and interrupts with none', async () => {
    const onInterrupt = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onInterrupt }} />)
    stdin.write('x')
    await settled()
    stdin.write('\x03')
    await settled()
    expect(lastFrame()).toContain('❯ ▏')
    expect(onInterrupt).not.toHaveBeenCalled()
    stdin.write('\x03')
    await settled()
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it('interrupts the turn on Esc without ever quitting', async () => {
    const onInterrupt = vi.fn()
    const onExit = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onInterrupt, onExit }} />)
    stdin.write('\x1b') // Esc
    await settled()
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(onExit).not.toHaveBeenCalled()
  })

  it('requests exit on Ctrl+D', async () => {
    const onExit = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onExit }} />)
    stdin.write('\x04')
    await settled()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('adopts the log history once the replay lands after mount', async () => {
    // The driver mounts the bar before the resume replay folds, so history
    // arrives in a later render.
    const { lastFrame, stdin, rerender } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    rerender(<TuiApp state={state([{ kind: 'user', seq: 1, text: 'past line' }])} handlers={noopHandlers()} />)
    await settled()
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ past line▏')
  })

  it('restores the session log lines into the arrow history', async () => {
    const frames: Frame[] = [
      { kind: 'user', seq: 1, text: 'first' },
      { kind: 'user', seq: 2, text: 'second' },
    ]
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ second▏')
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ first▏')
    // New submissions still append after the restored history.
    stdin.write('\x1b[B') // first → second...
    await settled()
    stdin.write('\x1b[B') // ...and past the end, back to the empty buffer
    await settled()
    stdin.write('third')
    stdin.write('\r')
    await settled()
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ third▏')
  })

  it('recalls submitted lines through the history arrows', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    stdin.write('first')
    stdin.write('\r')
    await settled()
    stdin.write('second')
    stdin.write('\r')
    await settled()
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ second▏')
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ first▏')
    stdin.write('\x1b[B')
    await settled()
    expect(lastFrame()).toContain('❯ second▏')
  })

  it('moves the cursor and edits mid-buffer', async () => {
    const onCommit = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onCommit }} />)
    stdin.write('ac')
    stdin.write('\x1b[D')
    stdin.write('b')
    await settled()
    // The cursor sits just after the inserted character.
    expect(lastFrame()).toContain('❯ ab▏c')
    stdin.write('\r')
    await settled()
    expect(onCommit).toHaveBeenCalledWith('abc')
  })

  it('quits on a second Ctrl+C with an empty buffer within a second', async () => {
    const onInterrupt = vi.fn()
    const onExit = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onInterrupt, onExit }} />)
    stdin.write('\x03')
    await settled()
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(onExit).not.toHaveBeenCalled()
    stdin.write('\x03')
    await settled()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('does not quit when the two Ctrl+C presses are far apart', async () => {
    const onExit = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onExit }} />)
    stdin.write('\x03')
    await settled(1100)
    stdin.write('\x03')
    await settled()
    expect(onExit).not.toHaveBeenCalled()
  })
})

describe('subagent panel', () => {
  function panelView(extra?: Partial<RenderView>): RenderView {
    return {
      subagents: [{
        childId: 'child-1',
        label: '调研包结构',
        activity: 'grep(pattern)',
        startedAt: Date.now() - 86_000,
        inputTokens: 11_100,
        fading: false,
      }],
      ...extra,
    }
  }

  it('renders the main row and child rows below the status bar', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={panelView()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('◯ main')
    expect(frame).toContain('◯ 调研包结构')
    expect(frame).toContain('grep(pattern)')
    expect(frame).toContain('1m 26s')
    expect(frame).toContain('↓ 11.1k tokens')
  })

  it('hides the panel when there are no unfinished subagents', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(lastFrame()).not.toContain('◯ main')
  })

  it('marks the selected panel row', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={panelView({ subagentSelected: 1 })} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● 调研包结构')
    expect(frame).toContain('◯ main')
  })

  it('enters the panel with ↓ from an empty editor', async () => {
    const onPanelOpen = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onPanelOpen }} view={panelView()} />)
    stdin.write('\x1b[B')
    await settled()
    expect(onPanelOpen).toHaveBeenCalledTimes(1)
  })

  it('does not enter the panel when the buffer has text', async () => {
    const onPanelOpen = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onPanelOpen }} view={panelView()} />)
    stdin.write('x')
    stdin.write('\x1b[B')
    await settled()
    expect(onPanelOpen).not.toHaveBeenCalled()
  })

  it('routes arrows, Enter, and Esc while the panel holds focus', async () => {
    const onPanelMove = vi.fn()
    const onPanelEnter = vi.fn()
    const onPanelBack = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onPanelMove, onPanelEnter, onPanelBack }}
      view={panelView({ subagentSelected: 0 })}
    />)
    stdin.write('\x1b[B')
    stdin.write('\r')
    stdin.write('\x1b')
    await settled()
    expect(onPanelMove).toHaveBeenCalledWith(1)
    expect(onPanelEnter).toHaveBeenCalledTimes(1)
    expect(onPanelBack).toHaveBeenCalledTimes(1)
  })

  it('renders the child transcript view instead of the input bar', () => {
    const childState = state([{ kind: 'user', seq: 1, text: '看看仓库结构' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } })}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('subagent: 调研包结构')
    expect(frame).toContain('❯ 看看仓库结构')
    expect(frame).toContain('Esc 返回')
    expect(frame).not.toContain('❯ ▏')
  })

  it('returns from the child view on Esc', async () => {
    const onPanelBack = vi.fn()
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onPanelBack }}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } })}
    />)
    stdin.write('\x1b')
    await settled()
    expect(onPanelBack).toHaveBeenCalledTimes(1)
  })
})
