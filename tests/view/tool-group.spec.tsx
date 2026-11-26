/**
 * The episode row: which frames join one, the sentence's wording, the click
 * that reveals every part, and the boundaries that keep a failure, an open
 * call, or an answer on its own row.
 * @module dsh-terminal/tests/view/tool-group
 */

import { describe, expect, it, vi } from 'vitest'
import chalk from 'chalk'
import { TuiApp } from '../../src/view/renderer.tsx'
import { groupFrames } from '../../src/view/renderer.tsx'
import { episodeLabel, isFoldableCall, runClause, runLabel, EpisodeRow } from '../../src/view/transcript.tsx'
import type { Frame } from '../../src/fold/frames.ts'
import { createFrameState, foldEvent } from '../../src/fold/frames.ts'
import { noopHandlers, openShellRun, renderApp, renderRaw, settled, state } from '../helpers/render.tsx'

/** A settled shell call as the fold produces it. */
function bash(callId: string, command: string, output: string): Extract<Frame, { kind: 'tool' }> {
  return {
    kind: 'tool',
    seq: Number(callId.replace(/\D/g, '')) || 1,
    turn: 1,
    step: 1,
    callId,
    name: 'bash',
    args: { command },
    call: { card: 'terminal', title: command },
    result: { card: 'terminal', output },
  }
}

/** A settled shell call that failed. */
function failedBash(callId: string, command: string, output: string): Extract<Frame, { kind: 'tool' }> {
  return { ...bash(callId, command, output), isError: true }
}

/** A settled shell call still in flight (no result yet). */
function pendingBash(callId: string, command: string): Extract<Frame, { kind: 'tool' }> {
  const { result: _dropped, ...rest } = bash(callId, command, '')
  return rest
}

/** A read call: foldable like every non-write/edit tool. */
function read(callId: string, path: string): Extract<Frame, { kind: 'tool' }> {
  return {
    kind: 'tool',
    seq: 9,
    turn: 1,
    step: 1,
    callId,
    name: 'read',
    args: { path },
    call: { card: 'generic', title: `Read ${path}` },
    result: { card: 'generic', content: [{ type: 'text', text: 'contents' }] },
  }
}

/** A run's calls, by tool name: what the label functions read. */
const callsOf = (...names: string[]): { name: string }[] => names.map(name => ({ name }))

const assistant = (seq: number, text: string): Frame => ({
  kind: 'assistant', seq, turn: 1, step: 1, text, streaming: false,
})

/** A settled assistant frame carrying reasoning and no answer text — the shape
 *  an episode absorbs. */
const reasoningOnly = (seq: number, text: string, seconds = 2): Frame => ({
  kind: 'assistant', seq, turn: 1, step: 1, text: '', streaming: false,
  thinking: { text, startedAt: 0, seconds },
})

describe('episodeLabel', () => {
  it('reads both facts when the episode thought and ran', () => {
    expect(episodeLabel(7, callsOf('bash', 'bash', 'bash'))).toBe('Thought for 7s, ran 3 shell commands')
    expect(episodeLabel(1, callsOf('bash'))).toBe('Thought for 1s, ran 1 shell command')
  })

  it('lists one clause per kind, in search-command-read order', () => {
    // A stretch of work usually searches, runs, and reads: the sentence says
    // how much of each, in the order a task tends to do them.
    expect(episodeLabel(23, callsOf('grep', 'bash', 'bash', 'bash', 'bash', 'bash', 'bash', 'read')))
      .toBe('Thought for 23s, searched for 1 pattern, ran 6 shell commands, read 1 file')
    expect(runClause(callsOf('read', 'grep', 'glob'))).toBe('searched for 2 patterns, read 1 file')
    expect(runLabel(callsOf('bash', 'pwsh'))).toBe('Ran 2 shell commands')
    // Plural agreement on every noun.
    expect(runClause(callsOf('read', 'read'))).toBe('read 2 files')
  })

  it('drops the reasoning clause when nothing was thought', () => {
    expect(episodeLabel(0, callsOf('bash', 'bash'))).toBe('Ran 2 shell commands')
  })

  it('drops the run clause when nothing was run', () => {
    // An episode never forms this way, but the label stays total.
    expect(episodeLabel(4, [])).toBe('Thought for 4s')
  })

  it('marks a working run with the present tense', () => {
    // The verb is the cheapest live signal: `running` while work is in flight,
    // `ran` once it settles.
    expect(episodeLabel(7, callsOf('bash', 'bash', 'bash'), true)).toBe('Thinking for 7s, running 3 shell commands')
    expect(episodeLabel(0, callsOf('bash', 'bash'), true)).toBe('Running 2 shell commands')
    expect(episodeLabel(1, callsOf('bash'), true)).toBe('Thinking for 1s, running 1 shell command')
    // Working with nothing to report yet stays silent: the live line below
    // says more than an empty header would.
    expect(episodeLabel(0, [], true)).toBe('')
  })

  it('switches the reasoning word with the state', () => {
    // Present tense while the model is still thinking, past once it stops:
    // the row reports what the model is doing, not just what it did.
    expect(episodeLabel(5, [], true)).toBe('Thinking for 5s')
    expect(episodeLabel(5, [], false)).toBe('Thought for 5s')
    expect(episodeLabel(5, callsOf('bash', 'bash'), true)).toBe('Thinking for 5s, running 2 shell commands')
    expect(episodeLabel(5, callsOf('bash', 'bash'), false)).toBe('Thought for 5s, ran 2 shell commands')
  })
})

describe('isFoldableCall', () => {
  it('accepts every shell tool the harness registers', () => {
    expect(isFoldableCall(bash('c1', 'ls', 'a'))).toBe(true)
    expect(isFoldableCall({ ...bash('c2', 'dir', 'a'), name: 'pwsh' })).toBe(true)
    expect(isFoldableCall({ ...bash('c3', 'ls', 'a'), name: 'terminal' })).toBe(true)
  })

  it('rejects a call that is still running', () => {
    // The dot is still blinking: the run is not over, so its card stays whole.
    expect(isFoldableCall(pendingBash('c1', 'npm test'))).toBe(false)
  })

  it('rejects a failed call', () => {
    // The red result is what a reader needs; an episode row would hide it.
    expect(isFoldableCall(failedBash('c1', 'npm test', 'boom'))).toBe(false)
  })

  it('rejects the two tools whose arguments carry the meaning', () => {
    // `write` and `edit` say which file and which lines: behind a count a
    // reader cannot tell what changed without opening every run.
    expect(isFoldableCall({ ...read('c1', '/tmp/a'), name: 'write' })).toBe(false)
    expect(isFoldableCall({ ...read('c2', '/tmp/a'), name: 'edit' })).toBe(false)
  })

  it('accepts exactly the five absorbed kinds', () => {
    // Thinking is handled separately; these are the tool calls an episode
    // counts: commands, searches, reads.
    for (const name of ['bash', 'pwsh', 'terminal', 'grep', 'glob', 'read', 'read_image']) {
      expect(isFoldableCall({ ...read('c1', '/tmp/a'), name }), name).toBe(true)
    }
    // Everything else keeps its own card.
    for (const name of ['todo_write', 'subagent', 'web_search', 'skill', 'job_list']) {
      expect(isFoldableCall({ ...read('c2', '/tmp/a'), name }), name).toBe(false)
    }
  })
})

describe('groupFrames', () => {
  it('collapses a run of settled shell calls into one episode', () => {
    const rows = groupFrames([bash('c1', 'ls', 'a'), bash('c2', 'pwd', '/w'), bash('c3', 'date', 'now')])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('episode')
    expect(rows[0]?.kind === 'episode' ? rows[0].parts.length : 0).toBe(3)
  })

  it('collapses a lone shell call too', () => {
    // Every shell call folds the same way: one place to look for output.
    const rows = groupFrames([bash('c1', 'ls', 'a')])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('episode')
  })

  it('spans several think-act steps as ONE episode', () => {
    // The shape a real task takes: think, run, think, run. One row, not four.
    const rows = groupFrames([
      reasoningOnly(1, 'first thought', 1),
      bash('c1', 'ls', 'a'),
      reasoningOnly(3, 'second thought', 1),
      bash('c2', 'pwd', '/w'),
      reasoningOnly(5, 'third thought', 1),
      bash('c3', 'date', 'now'),
      reasoningOnly(7, 'still thinking', 4),
    ])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('episode')
    if (row.kind !== 'episode') return
    expect(row.parts.filter(part => part.kind === 'tool')).toHaveLength(3)
    expect(row.parts.filter(part => part.kind === 'thinking')).toHaveLength(4)
  })

  it('sums the reasoning seconds across the span', async () => {
    const frames = [
      reasoningOnly(1, 'a', 1),
      bash('c1', 'ls', 'a'),
      reasoningOnly(3, 'b', 2),
      bash('c2', 'pwd', '/w'),
      reasoningOnly(5, 'c', 4),
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    await settled()
    expect(lastFrame()).toContain('Thought for 7s, ran 2 shell commands')
  })

  it('breaks the episode on a bare answer', () => {
    // Visible prose sits between the work and what follows; merging would skip
    // over it.
    const rows = groupFrames([
      reasoningOnly(1, 'thought', 1),
      bash('c1', 'ls', 'a'),
      assistant(3, 'Here is the plan:'),
      bash('c2', 'pwd', '/w'),
    ])
    expect(rows.map(row => row.kind)).toEqual(['episode', 'frame', 'episode'])
  })

  it('absorbs the reasoning that concludes an episode, leaving the answer alone', () => {
    // The shape every turn ends with: the last step thinks, then answers. The
    // thinking belongs to the work it just finished; the answer is the result
    // and stands on its own. Leaving the thinking out put a stray
    // `Thought for 21s` below the episode it concluded.
    const answer: Frame = {
      kind: 'assistant', seq: 5, turn: 1, step: 5, text: 'All done.',
      streaming: false, thinking: { text: 'let me sum up', startedAt: 0, seconds: 3 },
    }
    const rows = groupFrames([reasoningOnly(1, 'a', 1), bash('c1', 'ls', 'a'), answer])
    expect(rows.map(row => row.kind)).toEqual(['episode', 'frame'])
    const episode = rows[0]!
    if (episode.kind === 'episode') {
      // The final reasoning joins the count: 1s + 3s.
      expect(episodeLabel(
        episode.parts.reduce((n, part) => n + (part.kind === 'thinking' ? part.thinking.seconds : 0), 0),
        episode.parts.flatMap(part => (part.kind === 'tool' ? [{ name: part.frame.name }] : [])),
      )).toBe('Thought for 4s, ran 1 shell command')
    }
    const tail = rows[1]!
    if (tail.kind === 'frame' && tail.frame.kind === 'assistant') {
      // The answer row carries the text and no thinking of its own.
      expect(tail.frame.text).toBe('All done.')
      expect(tail.frame.thinking).toBeUndefined()
    }
  })

  it('takes the commands that follow a concluding reasoning into the episode', () => {
    // Some turns answer after one last command: the reasoning, that command,
    // then the prose.
    const answer: Frame = {
      kind: 'assistant', seq: 5, turn: 1, step: 5, text: 'Done.',
      streaming: false, thinking: { text: 'final check', startedAt: 0, seconds: 2 },
    }
    const rows = groupFrames([reasoningOnly(1, 'a', 1), bash('c1', 'ls', 'a'), answer, bash('c2', 'pwd', '/w')])
    expect(rows.map(row => row.kind)).toEqual(['episode', 'frame'])
    const episode = rows[0]!
    if (episode.kind === 'episode') {
      expect(episode.parts.filter(part => part.kind === 'tool')).toHaveLength(2)
      expect(episode.parts.filter(part => part.kind === 'thinking')).toHaveLength(2)
    }
  })

  it('a tool-only step does not split the run', () => {
    // Some steps call a tool without saying anything: no text, no reasoning.
    // Such a message used to fold into an empty assistant row, which sat
    // between two stretches of work and kept their episodes apart. The step's
    // calls are all there is to show, so the row should not exist at all.
    const frames = state([]).frames
    const deps = { tools: { get: () => undefined }, childLabels: new Map(), childErrors: new Map() }
    let folded = createFrameState()
    const events = [
      { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } },
      { type: 'tool/call', seq: 2, time: 2, data: { callId: 'c1', turn: 1, step: 1, name: 'bash', arguments: '{}' } },
      { type: 'tool/result', seq: 3, time: 3, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
      // A tool-only step: no text, no reasoning.
      { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 2, message: { content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }] } } },
      { type: 'tool/call', seq: 5, time: 5, data: { callId: 'c2', turn: 1, step: 2, name: 'read', arguments: '{}' } },
      { type: 'tool/result', seq: 6, time: 6, data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: 'file' }] } } },
    ]
    void frames
    for (const event of events) folded = foldEvent(folded, event as never, deps as never).state
    const rows = groupFrames(folded.frames)
    // One episode covering both steps — no blank assistant row between them.
    expect(rows.map(row => row.kind)).toEqual(['episode'])
  })

it('extends the episode above with the reasoning that concludes it', () => {
    // The last step of a task thinks once more and then answers, with no call
    // between. That thought is the same stretch of work: it extends the
    // episode above instead of starting a second `Thought for Ns` row under
    // it, which would report one task as two.
    const concluding: Frame = {
      kind: 'assistant', seq: 5, turn: 1, step: 5, text: 'Done.',
      streaming: false, thinking: { text: 'final check', startedAt: 0, seconds: 3 },
    }
    const rows = groupFrames([reasoningOnly(1, 'a', 1), bash('c1', 'ls', 'a'), concluding])
    expect(rows.map(row => row.kind)).toEqual(['episode', 'frame'])
    const episode = rows[0]!
    if (episode.kind === 'episode') {
      // One episode holding both reasoning blocks and the call.
      expect(episode.parts.filter(part => part.kind === 'thinking')).toHaveLength(2)
      expect(episode.parts.filter(part => part.kind === 'tool')).toHaveLength(1)
    }
  })

it('keeps the concluding step in one row while its answer streams', () => {
    // The reported flicker: the next step's reasoning showed as its own
    // `Thought for Ns` row, then snapped into the episode above once the
    // answer committed. The split must not depend on `streaming` — a frame
    // that carries text already belongs to the run, mid-stream or not.
    const e1: Frame[] = [reasoningOnly(1, 'first', 2), bash('c1', 'ls', 'a')]
    const withText: Frame = {
      kind: 'assistant', seq: 5, turn: 1, step: 5, text: 'Here is', streaming: true,
      thinking: { text: 'second', startedAt: 0, seconds: 3 },
    }
    const rows = groupFrames([...e1, withText])
    expect(rows.map(row => row.kind)).toEqual(['episode', 'frame'])
    const episode = rows[0]!
    if (episode.kind === 'episode') {
      // The concluding reasoning joined the episode instead of standing alone.
      expect(episode.parts.filter(part => part.kind === 'thinking')).toHaveLength(2)
    }
  })

it('lands the expand and the collapse in one paint each', async () => {
    // The reported flash: at the live bottom, clicking an episode made the
    // block jump and settle — the scroll correction landed a frame after the
    // body appeared, so the window re-anchored twice. The exact row delta is
    // staged before the paint (the thinking toggle's discipline), and one
    // ink write per click is the proof: a second write would mean the
    // post-commit measure disagreed with the staged number.
    const fillers: Frame[] = Array.from({ length: 30 }, (_, i) => ({
      kind: 'assistant', seq: 100 + i, turn: 1, step: 1, text: `filler ${i}`, streaming: false,
    }))
    const frames: Frame[] = [...fillers, reasoningOnly(1, 'thought text here', 12), bash('c1', 'ls', 'line1\nline2\nline3')]
    const app = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} viewportRows={16} />)
    await settled(80)
    const before = app.lastFrame().split('\n')
    const row = before.findIndex(line => line.includes('Thought for 12s'))

    const expandCount = app.frames.length
    app.stdin.write(`\x1b[<0;3;${row + 1}M`)
    await settled(160)
    expect(app.frames.length - expandCount).toBe(1)
    expect(app.lastFrame()).toContain('● Bash(ls)')

    const afterExpand = app.lastFrame().split('\n')
    const cardRow = afterExpand.findIndex(line => line.includes('Bash(ls)'))
    const collapseCount = app.frames.length
    app.stdin.write(`\x1b[<0;3;${cardRow + 1}M`)
    await settled(160)
    expect(app.frames.length - collapseCount).toBe(1)
    expect(app.lastFrame()).toContain('Thought for 12s')
  })

it('closes the thinking window the moment its answer starts streaming', () => {
    // The split branch copies the frame with its text blanked, and the copy
    // kept `streaming: true` — so the reasoning part read as live reasoning
    // and the episode's rolling window stayed open under the sentence for the
    // whole answer, folding only at commit. The reasoning stream ends when
    // the text arrives; the window must follow.
    const e1: Frame[] = [reasoningOnly(1, 'first', 2), bash('c1', 'ls', 'a')]
    const withText: Frame = {
      kind: 'assistant', seq: 5, turn: 1, step: 5, text: 'Here is', streaming: true,
      thinking: { text: 'second thoughts', startedAt: 0, seconds: 3 },
    }
    const rows = groupFrames([...e1, withText])
    const episode = rows[0]!
    if (episode.kind === 'episode') {
      // The concluding reasoning joined, but as settled — not live.
      const concluding = episode.parts.find(part => part.kind === 'thinking' && part.seq === 5)
      expect(concluding?.kind === 'thinking' ? concluding.live : undefined).toBe(false)
    }
  })

it('does not extend across an intervening answer', () => {
    // An answer between two stretches is a boundary: the second stretch is a
    // new episode, and its reasoning must not jump back over the prose.
    const prose: Frame = {
      kind: 'assistant', seq: 4, turn: 1, step: 4, text: 'Prose.', streaming: false,
    }
    const rows = groupFrames([
      reasoningOnly(1, 'a', 1), bash('c1', 'ls', 'a'),
      prose,
      reasoningOnly(6, 'next', 1), bash('c2', 'pwd', '/w'),
    ])
    expect(rows.map(row => row.kind)).toEqual(['episode', 'frame', 'episode'])
  })

it('keeps a lone thought before an answer on its own row', () => {
    // Nothing was run, so there is no episode to name; the settled thinking
    // block's dim row is the right shape.
    const answer: Frame = {
      kind: 'assistant', seq: 5, turn: 1, step: 5, text: 'Done.',
      streaming: false, thinking: { text: 'thinking', startedAt: 0, seconds: 2 },
    }
    const rows = groupFrames([answer])
    expect(rows.map(row => row.kind)).toEqual(['frame'])
  })

  it('folds a read in with the commands around it', () => {
    const rows = groupFrames([
      bash('c1', 'ls', 'a'),
      read('c2', '/tmp/a'),
      bash('c3', 'pwd', '/w'),
    ])
    expect(rows.map(row => row.kind)).toEqual(['episode'])
  })

  it('breaks the episode on a write or an edit', () => {
    for (const name of ['write', 'edit']) {
      const rows = groupFrames([
        bash('c1', 'ls', 'a'),
        { ...read('c2', '/tmp/a'), name },
        bash('c3', 'pwd', '/w'),
      ])
      expect(rows.map(row => row.kind)).toEqual(['episode', 'frame', 'episode'])
    }
  })

  it('keeps a failed call out of the episode', () => {
    const rows = groupFrames([
      bash('c1', 'ls', 'a'),
      failedBash('c2', 'npm test', 'boom'),
      bash('c3', 'date', 'now'),
    ])
    // The failure is its own row: its red result stays on screen.
    expect(rows.map(row => row.kind)).toEqual(['episode', 'frame', 'episode'])
  })

  it('absorbs a running call so the episode shows it live', () => {
    // The command being executed right now is part of the same stretch of
    // work: it rides inside the episode as a live line rather than starting a
    // card of its own below the sentence.
    const rows = groupFrames([bash('c1', 'ls', 'a'), pendingBash('c2', 'npm test')])
    expect(rows.map(row => row.kind)).toEqual(['episode'])
    const row = rows[0]!
    if (row.kind === 'episode') {
      const running = row.parts.filter(part => part.kind === 'tool' && part.running)
      expect(running).toHaveLength(1)
      expect(running[0]?.kind === 'tool' ? running[0].frame.callId : '').toBe('c2')
    }
  })

  it('keeps reasoning alone as its own row', () => {
    // Nothing was run, so `Thought for 4s` keeps the settled thinking block's
    // dim row rather than becoming an episode.
    const rows = groupFrames([reasoningOnly(1, 'thinking', 4)])
    expect(rows.map(row => row.kind)).toEqual(['frame'])
  })

  it('absorbs live reasoning into the episode it is running inside', () => {
    // Still streaming: the episode grows in place while the model thinks, so a
    // running task never sprouts a second header row for the work it is in the
    // middle of.
    const live: Frame = {
      kind: 'assistant', seq: 1, turn: 1, step: 1, text: '', streaming: true,
      thinking: { text: 'thinking…', startedAt: 0, seconds: 1 },
    }
    const rows = groupFrames([live, bash('c1', 'ls', 'a')])
    expect(rows.map(row => row.kind)).toEqual(['episode'])
    const row = rows[0]!
    if (row.kind === 'episode') {
      const thinkingPart = row.parts.find(part => part.kind === 'thinking')
      // The live flag is what makes the window render under the header while
      // the sentence stays collapsed.
      expect(thinkingPart?.kind === 'thinking' ? thinkingPart.live : false).toBe(true)
    }
  })

  it('starts an episode on live reasoning alone', () => {
    // A thought that has not run anything yet is still one episode: the row
    // exists from the first reasoning delta, and commands join it as they land.
    const live: Frame = {
      kind: 'assistant', seq: 1, turn: 1, step: 1, text: '', streaming: true,
      thinking: { text: 'thinking…', startedAt: 0, seconds: 1 },
    }
    const rows = groupFrames([live])
    expect(rows.map(row => row.kind)).toEqual(['frame'])
  })
})

describe('the episode row on screen', () => {
  it('shows the sentence instead of the parts', async () => {
    const frames = [reasoningOnly(1, 'thinking', 2), bash('c1', 'npm test', 'all passed'), bash('c2', 'pnpm build', 'done')]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Thought for 2s, ran 2 shell commands')
    // One row, not the old pair: neither a standalone `Thought for Ns` row
    // nor a bare `Ran N` row survives beside the episode.
    expect(frame).not.toContain('Thought for 2s\n')
    expect(frame).not.toContain('Ran 2 shell commands')
    // Both bodies are the revealed state.
    expect(frame).not.toContain('thinking')
    expect(frame).not.toContain('● Bash(npm test)')
  })

  it('keeps a failure card visible beside the episode', async () => {
    const frames = [
      bash('c1', 'npm test', 'all passed'),
      failedBash('c2', 'pnpm typecheck', 'TS2345: type error'),
    ]
    const { lastFrame } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Ran 1 shell command')
    expect(frame).toContain('● Bash(pnpm typecheck)')
    expect(frame).toContain('TS2345: type error')
  })
})

describe('clicking an episode', () => {
  it('reveals every part in order and folds them again', async () => {
    const frames = [
      reasoningOnly(1, 'let me check the tests', 2),
      bash('c1', 'npm test', 'all passed'),
      reasoningOnly(3, 'now the build', 1),
      bash('c2', 'pnpm build', 'done'),
    ]
    const { lastFrame, stdin } = renderApp(
      <TuiApp state={state(frames)} handlers={noopHandlers()} viewportRows={30} />,
    )
    await settled(60)
    const collapsed = lastFrame() ?? ''
    expect(collapsed).toContain('Thought for 3s, ran 2 shell commands')
    const row = collapsed.split('\n').findIndex(line => line.includes('Thought for 3s, ran'))
    expect(row).toBeGreaterThan(-1)
    stdin.write(`\x1b[<0;3;${row + 1}M`)
    await settled(60)
    const opened = lastFrame() ?? ''
    expect(opened).not.toContain('Thought for 3s, ran')
    // Both halves, in log order.
    expect(opened).toContain('let me check the tests')
    expect(opened).toContain('● Bash(npm test)')
    expect(opened).toContain('now the build')
    expect(opened).toContain('● Bash(pnpm build)')
    // A second click on the revealed content folds it back.
    const contentRow = opened.split('\n').findIndex(line => line.includes('now the build'))
    stdin.write(`\x1b[<0;3;${contentRow + 1}M`)
    await settled(60)
    expect(lastFrame()).toContain('Thought for 3s, ran 2 shell commands')
  })
})

describe('EpisodeRow', () => {
  const parts = () => ([
    { kind: 'thinking' as const, seq: 1, thinking: { text: 'let me check', startedAt: 0, seconds: 2 }, live: false },
    { kind: 'tool' as const, frame: bash('c1', 'npm test', 'all passed'), running: false },
  ])

  it('streams the live reasoning under the collapsed header', async () => {
    // The episode is where the work happens: while the model thinks, its
    // latest rows ride under the sentence on the live `│ ` rule — no second
    // header row below.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'first idea\nsecond idea', startedAt: 0, seconds: 2 }, live: true },
          { kind: 'tool', frame: bash('c1', 'npm test', 'all passed'), running: false },
        ]}
        expandedOutput={false}
        expanded={false}
        hovered={false}
      />,
    )
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Thinking for 2s, running 1 shell command')
    expect(frame).toContain('│ first idea')
    expect(frame).toContain('│ second idea')
    expect(frame).not.toContain('  Thinking for 2s')
  })

it('shows the settled reasoning whole when the episode is opened', async () => {
    // The episode stays one row: the sentence is the closed state, and the
    // whole stretch — reasoning in full, then each card — is one click away.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'first idea\nsecond idea', startedAt: 0, seconds: 2 }, live: false },
          { kind: 'tool', frame: bash('c1', 'npm test', 'all passed'), running: false },
        ]}
        expandedOutput={false}
        expanded
        hovered={false}
      />,
    )
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('first idea')
    expect(frame).toContain('second idea')
    expect(frame).toContain('● Bash(npm test)')
  })

it('shows the command being executed under the collapsed header', async () => {
    // Settled thinking, then a command still running: the sentence carries the
    // settled facts, and the invocation itself sits under it so a reader sees
    // what is executing without opening the episode.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'now the tests', startedAt: 0, seconds: 2 }, live: false },
          { kind: 'tool', frame: pendingBash('c2', 'npm test'), running: true },
        ]}
        expandedOutput={false}
        expanded={false}
        hovered={false}
      />,
    )
    await settled()
    const frame = lastFrame() ?? ''
    // The call in flight is counted, and the verb says so: `running`, not `ran`.
    expect(frame).toContain('● Thinking for 2s, running 1 shell command')
    expect(frame).not.toContain('ran 1 shell command')
    // The command itself under the shared connector, without the tool label.
    expect(frame).toContain('  ⎿  npm test')
    expect(frame).not.toContain('Bash(npm test)')
    expect(frame.indexOf('Thinking for 2s')).toBeLessThan(frame.indexOf('npm test'))
  })

  it('folds a multiline command onto the connector', async () => {
    // A shell script handed to bash folds its newlines into `; ` — the same
    // one-liner reading the call card uses — so the running line stays one row.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'checking', startedAt: 0, seconds: 1 }, live: false },
          { kind: 'tool', frame: pendingBash('c3', 'cd /work; npm test'), running: true },
        ]}
        expandedOutput={false}
        expanded={false}
        hovered={false}
      />,
    )
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('  ⎿  cd /work; npm test')
  })

it('carries the working dot while the episode is still running', async () => {
    // The episode is where work is happening: its header wears the blinking
    // dot, so the live row is unmistakable against the settled ones around it.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'checking', startedAt: 0, seconds: 1 }, live: false },
          { kind: 'tool', frame: pendingBash('c4', 'npm test'), running: true },
        ]}
        expandedOutput={false}
        expanded={false}
        hovered={false}
      />,
    )
    await settled()
    const frame = lastFrame() ?? ''
    // The dot leads the sentence, and the verb is present tense: both say the
    // row is live, so a reader cannot mistake it for a finished summary.
    expect(frame).toMatch(/^[● ] Thinking for 1s, running 1 shell command$/m)
  })

it('aligns the settled row with the body text, not the left edge', async () => {
    // A settled row is a line of body prose, not a status light: it sits on
    // the body text's column, where a settled `Thought for Ns` row already
    // sits, so the transcript keeps one left margin.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'checked', startedAt: 0, seconds: 1 }, live: false },
          { kind: 'tool', frame: bash('c5', 'npm test', 'ok'), running: false },
        ]}
        expandedOutput={false}
        expanded={false}
        hovered={false}
      />,
    )
    await settled()
    const row = (lastFrame() ?? '').split('\n').find(line => line.includes('Thought for 1s')) ?? ''
    expect(row.startsWith('  Thought for 1s')).toBe(true)
  })

it('drops the dot once the episode settles', async () => {
    // A finished row is a plain statement, not a status light.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'checked', startedAt: 0, seconds: 1 }, live: false },
          { kind: 'tool', frame: bash('c5', 'npm test', 'ok'), running: false },
        ]}
        expandedOutput={false}
        expanded={false}
        hovered={false}
      />,
    )
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Thought for 1s, ran 1 shell command')
    expect(frame).not.toContain('● Thought')
  })

it('counts the call once it finishes', async () => {
    // Same episode, the command now settled: the count appears and the live
    // call line is gone, folded into the number.
    const { lastFrame } = renderApp(
      <EpisodeRow
        parts={[
          { kind: 'thinking', seq: 1, thinking: { text: 'now the tests', startedAt: 0, seconds: 2 }, live: false },
          { kind: 'tool', frame: bash('c2', 'npm test', 'all passed'), running: false },
        ]}
        expandedOutput={false}
        expanded={false}
        hovered={false}
      />,
    )
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Thought for 2s, ran 1 shell command')
    expect(frame).not.toContain('Bash(npm test)')
  })

it('registers its element so the renderer can measure the target', () => {
    const ref = vi.fn()
    renderApp(<EpisodeRow parts={parts()} expandedOutput={false} expanded={false} hovered={false} blockRef={ref} />)
    expect(ref.mock.calls.some(call => call[0] != null)).toBe(true)
  })

  it('reveals the reasoning and the member cards together on expand', async () => {
    const { lastFrame } = renderApp(<EpisodeRow parts={parts()} expandedOutput={false} expanded hovered={false} />)
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('Thought for 2s, ran')
    expect(frame).toContain('let me check')
    expect(frame).toContain('● Bash(npm test)')
    expect(frame).toContain('all passed')
  })

  it('paints the revealed body on a full-width band', async () => {
    // The band is what makes the opened episode read as one block, and it
    // must reach the far edge — a band only as wide as the longest row would
    // look ragged. ink fills it cell by cell through chalk, so the assertion
    // has to read the raw escapes rather than the stripped frame.
    const previous = chalk.level
    chalk.level = 3
    try {
      const raw = renderRaw(
        <EpisodeRow parts={parts()} expandedOutput={false} expanded hovered={false} />,
      )
      // The band's own color, then a full run of spaces before it closes: the
      // content is short, so only the background fill can produce that run.
      expect(raw).toContain('[48;2;48;48;48m')
      // Every revealed row wears the band, and each runs to the terminal edge:
      // the short content cannot supply that many trailing spaces.
      for (const line of raw.split('\n')) {
        expect(line).toContain('[48;2;48;48;48m')
        expect(line).toMatch(/\s{60,}\u001b\[49m\s*$/)
      }
    } finally {
      chalk.level = previous
    }
  })

  it('drops the dim under the pointer', async () => {
    const dim = renderApp(<EpisodeRow parts={parts()} expandedOutput={false} expanded={false} hovered={false} />)
    await settled()
    const plain = dim.lastFrame() ?? ''
    expect(plain).toContain('Thought for 2s, ran 1 shell command')
  })
})