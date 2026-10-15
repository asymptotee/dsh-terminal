/** TuiApp rendering: transcript frames, the fullscreen window, and the chrome band. */

import { describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import stringWidth from 'string-width'
import { TuiApp, padToWidth, truncateToWidth } from '../../src/view/renderer.tsx'
import type { RenderView } from '../../src/view/renderer.tsx'
import type { Frame, FrameState } from '../../src/fold/frames.ts'
import { noopHandlers, renderApp, settled, state } from '../helpers/render.tsx'

describe('TuiApp rendering', () => {
  it('renders the empty stream with the input marker', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('❯ █')
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

  it('keeps exactly one blank row around the thought box in both frame shapes', () => {
    const thinking = { text: 'reasoning prose', startedAt: Date.now(), seconds: 9 }
    // Thinking + text: one breathing row between the box border and the text.
    const withText: Frame[] = [
      { kind: 'assistant', seq: 1, turn: 1, step: 1, text: 'Here we go', streaming: false, thinking },
    ]
    const first = renderApp(<TuiApp state={state(withText)} handlers={noopHandlers()} />)
    let lines = (first.lastFrame() ?? '').split('\n')
    let border = lines.findIndex(line => line.includes('╯'))
    let next = lines.findIndex(line => line.includes('● Here we go'))
    expect(next - border).toBe(2)
    // Thinking without text: the box ends the frame, and only the frame
    // wrapper's margin separates it from the next call — not margin doubled.
    const noText: Frame[] = [
      { kind: 'assistant', seq: 1, turn: 1, step: 1, text: '', streaming: false, thinking },
      { kind: 'tool', seq: 2, turn: 1, step: 1, callId: 'c1', name: 'bash', args: {}, call: { card: 'terminal', title: 'ls' } },
    ]
    const second = renderApp(<TuiApp state={state(noText)} handlers={noopHandlers()} />)
    lines = (second.lastFrame() ?? '').split('\n')
    border = lines.findIndex(line => line.includes('╯'))
    next = lines.findIndex(line => line.includes('● Bash(ls)'))
    expect(next - border).toBe(2)
  })

  it('collapses trailing newlines of assistant text to the single frame margin', () => {
    const frames: Frame[] = [
      { kind: 'assistant', seq: 1, turn: 1, step: 1, text: 'Hello there\n\n\n', streaming: false },
      { kind: 'tool', seq: 2, turn: 1, step: 1, callId: 'c1', name: 'bash', args: {}, call: { card: 'terminal', title: 'ls' } },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // Exactly one blank line — the frame wrapper's margin — between the text
    // and the next call; the model's trailing newlines render nothing.
    expect(frame).toContain('● Hello there\n\n● Bash(ls)')
    expect(frame).not.toContain('Hello there\n\n\n')
  })

  it('separates frames with a blank line', () => {
    const frames: Frame[] = [
      { kind: 'user', seq: 1, text: 'hello' },
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: 'answer', streaming: false },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    // The user echo pads its line to full width, so allow trailing spaces.
    expect(lastFrame()).toMatch(/❯ hello.*\n\n+● answer/)
  })

  it('folds a multiline invocation into a one-line semicolon summary', () => {
    const frames: Frame[] = [{
      kind: 'tool', seq: 1, turn: 1, step: 1, callId: 'c1', name: 'bash',
      args: { command: 'set -x\ncd /work\nmkdir smoke' },
      call: { card: 'terminal', title: 'set -x\ncd /work\nmkdir smoke' },
    }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    // Newlines fold to `; ` — shell one-liner reading, the same fold the
    // panel activity uses — and the short fold renders complete, unclamped.
    expect(lastFrame() ?? '').toContain('● Bash(set -x; cd /work; mkdir smoke)')
  })

  it('clamps a folded invocation to the width budget and expands it with ctrl+o', async () => {
    const script = Array.from({ length: 8 }, (_, i) => `step number ${i + 1} runs`).join('\n')
    const frames: Frame[] = [{
      kind: 'tool', seq: 1, turn: 1, step: 1, callId: 'c1', name: 'bash',
      args: { command: script },
      call: { card: 'terminal', title: script },
    }]
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    // Folded to `; ` then clamped at the budget with the bare ellipsis; the
    // later steps stay hidden until ctrl+o reveals the full fold.
    let frame = lastFrame() ?? ''
    expect(frame).toContain('● Bash(step number 1 runs; step number 2 runs; step number…')
    expect(frame).not.toContain('step number 3 runs')
    stdin.write('\x0f')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('step number 8 runs)')
  })

  it('echoes a multi-line user message aligned under the prompt', () => {
    const frames: Frame[] = [{ kind: 'user', seq: 1, text: 'line one\nline two' }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const rows = (lastFrame() ?? '').split('\n')
    const one = rows.findIndex(row => row.includes('line one'))
    const two = rows.findIndex(row => row.includes('line two'))
    // The marker leads the first line; the continuation indents to align.
    expect(rows[one]).toContain('❯ line one')
    expect(rows[two]).toContain('  line two')
  })

  it('pads content to the terminal width by display columns', () => {
    // CJK counts double: '你好 hi' is 2+2+1+2 = 7 columns, padded out to 20.
    expect(stringWidth(padToWidth('你好 hi', 20))).toBe(20)
    // The prompt marker plus a short message pads to the full row width.
    expect(stringWidth(padToWidth('❯ hi', 100))).toBe(100)
    // Content already past the target is returned unchanged (no negative pad).
    expect(padToWidth('x'.repeat(30), 20)).toBe('x'.repeat(30))
  })

  it('truncates text to a display-width budget with an ellipsis', () => {
    expect(truncateToWidth('abcdef', 10)).toBe('abcdef')   // fits: unchanged
    expect(truncateToWidth('abcdef', 4)).toBe('abc…')      // cut to 3 + ellipsis
    // CJK counts double, so the cut respects display width, not char count.
    expect(stringWidth(truncateToWidth('你好你好', 5))).toBeLessThanOrEqual(5)
    expect(truncateToWidth('anything', 0)).toBe('')        // no room: empty
  })

  it('clamps a long tool invocation to one row and reveals it with ctrl+o', async () => {
    const longCmd = 'echo ' + 'x'.repeat(150)
    const frames: Frame[] = [{
      kind: 'tool', seq: 1, turn: 1, step: 1, callId: 'c1', name: 'bash',
      args: { command: longCmd }, call: { card: 'terminal', title: longCmd },
    }]
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    // Collapsed: clamped to 60% of the 100-col test terminal, so the full
    // command is gone and an ellipsis marks the cut.
    expect(lastFrame()).toContain('…')
    expect(lastFrame()).not.toContain(longCmd)
    // ctrl+o expands: the full invocation shows (no ellipsis), wrapping normally.
    stdin.write('\x0f')
    await settled()
    expect(lastFrame()).not.toContain('…')
  })

  it('renders a message committed mid-step as a steering echo', () => {
    const view: RenderView = { pendingUser: [{ id: 'm1', text: 'wake pro-jsonl' }] }
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={view} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('❯ wake pro-jsonl')
    expect(frame).toContain('steering')
  })

  it('aligns a multi-line steering echo under the prompt', () => {
    const view: RenderView = { pendingUser: [{ id: 'm2', text: 'line one\nline two' }] }
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={view} />)
    const rows = (lastFrame() ?? '').split('\n')
    const one = rows.findIndex(row => row.includes('line one'))
    const two = rows.findIndex(row => row.includes('line two'))
    expect(rows[one]).toContain('❯ line one')
    expect(rows[two]).toContain('  line two')
  })

  it('renders a markdown table as an aligned bordered grid', () => {
    const text = [
      '任务板：',
      '| 任务 | ID | 就绪 |',
      '| --- | --- | --- |',
      '| 任务A：分析架构 | task-1 | ✅ |',
      '| 任务B | task-2 | ✅ |',
    ].join('\n')
    const frames: Frame[] = [{ kind: 'assistant', seq: 1, turn: 1, step: 1, text, streaming: false }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    const rows = frame.split('\n')
    const top = (rows.find(row => row.includes('┌')) ?? '').trim()
    const mid = (rows.find(row => row.includes('├')) ?? '').trim()
    const bottom = (rows.find(row => row.includes('└')) ?? '').trim()
    expect(top).not.toBe('')
    // Every horizontal rule spans the same display width, so CJK columns align.
    expect(stringWidth(top)).toBe(stringWidth(mid))
    expect(stringWidth(top)).toBe(stringWidth(bottom))
    // Two body rows get a rule between them, so adjacent rows stay separated:
    // one rule under the header plus one between the two body rows.
    expect(rows.filter(row => row.includes('├'))).toHaveLength(2)
    // Cells render; the raw separator row is consumed, not shown as pipes.
    expect(frame).toContain('task-1')
    expect(frame).not.toContain('| --- |')
  })

  it('leaves a lone pipe line as plain text when no separator row follows', () => {
    const frames: Frame[] = [{ kind: 'assistant', seq: 1, turn: 1, step: 1, text: 'a | b', streaming: false }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('a | b')
    expect(frame).not.toContain('┌')
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
    expect(lastFrame()).toContain('❯ l█')
  })

  it('inserts a bracketed multi-line paste as distinct lines', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    // A real paste arrives wrapped in bracketed-paste markers; usePaste delivers
    // the inner text on its own channel, so its newlines never trip Enter-commit.
    stdin.write('[200~line one\nline two[201~')
    await settled()
    const rows = (lastFrame() ?? '').split('\n')
    const one = rows.findIndex(row => row.includes('line one'))
    const two = rows.findIndex(row => row.includes('line two'))
    expect(one).toBeGreaterThanOrEqual(0)
    expect(two).toBeGreaterThanOrEqual(0)
    // Distinct rows: the newlines split the buffer instead of overlapping via CR.
    expect(one).not.toBe(two)
    // The prompt marker leads the first pasted line; the caret sits on the last
    // (the buffer end), and the text stays in the editor (not committed).
    expect(rows[one]).toContain('❯ line one')
    expect(rows[two]).toContain('line two█')
  })

  it('normalizes CR line endings from a non-bracketed paste', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    // Terminals without bracketed-paste support route CR-separated text through
    // useInput; the insert path normalizes CR to LF so lines do not overlap.
    stdin.write('line one\rline two')
    await settled()
    const rows = (lastFrame() ?? '').split('\n')
    const one = rows.findIndex(row => row.includes('line one'))
    const two = rows.findIndex(row => row.includes('line two'))
    expect(one).toBeGreaterThanOrEqual(0)
    expect(two).toBeGreaterThanOrEqual(0)
    expect(one).not.toBe(two)
  })

  it('does not commit a pasted newline as a turn', async () => {
    const committed: string[] = []
    const handlers = { ...noopHandlers(), onCommit: (text: string) => { committed.push(text) } }
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={handlers} />)
    stdin.write('[200~line one\nline two[201~')
    await settled()
    expect(committed).toEqual([])
  })

  it('renders the standing plan panel pinned above the input bar', () => {
    const plan = [
      { content: 'task one', status: 'in_progress' as const },
      { content: 'task two', status: 'pending' as const },
    ]
    const { lastFrame } = renderApp(<TuiApp state={state([], plan)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // The first line carries the `⎿` connector at absolute column two (the
    // transcript's tool-output alignment); continuations align at column five.
    const rows = frame.split('\n')
    expect(rows.find(row => row.includes('task one'))?.startsWith('  ⎿  ')).toBe(true)
    expect(rows.find(row => row.includes('task two'))?.startsWith('     ◻')).toBe(true)
    // The header is the label plus the item count, matching the sibling
    // panels' `Header · N` format; it carries no status dot.
    expect(frame).toContain('Todos · 2')
    expect(frame).not.toContain('● Todo')
    // The panel is pinned directly above the input bar: below the stream's
    // welcome block, above the `❯` input marker.
    expect(frame.indexOf('DeepSeek Harness — Terminal')).toBeLessThan(frame.indexOf('Todos · 2'))
    expect(frame.indexOf('Todos · 2')).toBeLessThan(frame.indexOf('❯'))
  })

  it('renders the user-interruption marker after the interrupted turn', () => {
    const frames: Frame[] = [{ kind: 'interrupted', seq: 3 }]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● Interrupted')
    expect(frame).toContain('· What should dsh do instead?')
  })

  it('renders the heartbeat above the input bar while a turn is in flight', () => {
    const working: FrameState = { ...state([]), turnStartedAt: Date.now() }
    const { lastFrame } = renderApp(<TuiApp state={working} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('⠋ Working… (0s)')
    expect(frame.indexOf('Working…')).toBeLessThan(frame.indexOf('❯'))
  })

  it('shows the per-turn output token count in the heartbeat', () => {
    const working: FrameState = { ...state([]), turnStartedAt: Date.now(), turnTokens: 3400 }
    const { lastFrame } = renderApp(<TuiApp state={working} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('⠋ Working… (0s · ↓ 3.4k tokens)')
  })

  it('pins the heartbeat above the plan and keeps the label while a tool is pending', () => {
    const plan = [{ content: 'task one', status: 'in_progress' as const }]
    const thinking: FrameState = {
      ...state([], plan),
      turnStartedAt: Date.now(),
    }
    const { lastFrame } = renderApp(<TuiApp state={thinking} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame.indexOf('Working…')).toBeLessThan(frame.indexOf('Todos · 1'))
    // A step covers the model call and its tool executions: the heartbeat
    // stays up — and keeps its single label — while a tool runs.
    const busy: FrameState = { ...thinking, pendingTools: new Map([['c1', 0]]) }
    expect(renderApp(<TuiApp state={busy} handlers={noopHandlers()} />).lastFrame()).toContain('Working…')
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
    expect(frame).not.toContain('(End of file)')
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
    // The first result line carries the `⎿` connector like every other card.
    expect(frame).toContain('⎿  a.ts')
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
    // The first numbered line carries the `⎿` connector like every other card.
    expect(frame).toContain('⎿  1: line 1')
    expect(frame).toContain('6: line 6')
    expect(frame).not.toContain('7: line 7')
    expect(frame).toContain('3 more lines (ctrl+o to expand)')
    stdin.write('\x0f')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('7: line 7')
    expect(frame).toContain('9: line 9')
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
    expect(frame.indexOf('unknown command: /x')).toBeLessThan(frame.indexOf('❯ █'))
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
    // The effort badge sits right-aligned on the model line.
    expect(frame).toContain('● effort: max')
    expect(frame.indexOf('● effort: max')).toBeGreaterThan(frame.indexOf('~/repo'))
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

  it('renders the approval panel at the screen bottom, hiding the input box and status bar', async () => {
    const onApproval = vi.fn()
    const { lastFrame, stdin } = renderApp(
      <TuiApp
        state={state([{ kind: 'user', seq: 1, text: 'hi' }])}
        handlers={{ ...noopHandlers(), onApproval }}
        view={{
          overlay: { kind: 'approval', toolName: 'bash', reason: 'run rm -rf', detail: 'rm -rf build' },
          status: { model: 'test-model', cwd: '/workspace/repo' },
        }}
      />,
    )
    let frame = lastFrame() ?? ''
    // The panel's rows: tinted title, the pending call's detail leading, the
    // asker's reason hanging below it, question, options with the ❯ marker,
    // and the Esc hint.
    expect(frame).toContain('Bash command')
    expect(frame).toContain('rm -rf build')
    expect(frame).toContain('run rm -rf')
    expect(frame.indexOf('rm -rf build')).toBeLessThan(frame.indexOf('run rm -rf'))
    expect(frame).toContain('Do you want to proceed?')
    expect(frame).toContain('❯ 1. Yes')
    expect(frame).toContain('2. No')
    expect(frame).toContain('Esc to cancel')
    // The question owns the bottom: no input caret, no status bar facts.
    expect(frame).not.toContain('█')
    expect(frame).not.toContain('test-model')
    stdin.write('\x1b[B') // Down: select No
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('❯ 2. No')
    expect(frame).toContain('1. Yes')
    stdin.write('\r') // Enter commits the selection
    await settled()
    expect(onApproval).toHaveBeenCalledWith('reject')
    stdin.write('\x1b[A') // Up: back to Yes
    await settled()
    stdin.write('\r')
    await settled()
    expect(onApproval).toHaveBeenCalledWith('allow')
    stdin.write('n')
    await settled()
    expect(onApproval).toHaveBeenLastCalledWith('reject')
    stdin.write('\x1b') // Esc cancels (withdrawn, not rejected)
    await settled()
    expect(onApproval).toHaveBeenLastCalledWith('cancel')
  })
})

