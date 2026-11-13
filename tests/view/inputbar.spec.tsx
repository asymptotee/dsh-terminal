/** InputBar key handling: editing, history, interrupt, exit, and paste. */

import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { Frame } from '../../src/fold/frames.ts'
import { noopHandlers, renderApp, settled, state } from '../helpers/render.tsx'

describe('InputBar key handling', () => {
  it('types characters at the cursor and commits on Enter', async () => {
    const onCommit = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onCommit }} />)
    stdin.write('hello')
    await settled()
    expect(lastFrame()).toContain('❯ hello█')
    stdin.write('\r')
    await settled()
    expect(onCommit).toHaveBeenCalledWith('hello')
    expect(lastFrame()).toContain('❯ █')
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
    expect(lastFrame()).toContain('❯ █')
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
    expect(lastFrame()).toContain('❯ past line█')
  })

  it('restores the session log lines into the arrow history', async () => {
    const frames: Frame[] = [
      { kind: 'user', seq: 1, text: 'first' },
      { kind: 'user', seq: 2, text: 'second' },
    ]
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(frames)} handlers={noopHandlers()} />)
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ second█')
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ first█')
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
    expect(lastFrame()).toContain('❯ third█')
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
    expect(lastFrame()).toContain('❯ second█')
    stdin.write('\x1b[A')
    await settled()
    expect(lastFrame()).toContain('❯ first█')
    stdin.write('\x1b[B')
    await settled()
    expect(lastFrame()).toContain('❯ second█')
  })

  it('moves the cursor and edits mid-buffer', async () => {
    const onCommit = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onCommit }} />)
    stdin.write('ac')
    stdin.write('\x1b[D')
    stdin.write('b')
    await settled()
    // The cursor sits just after the inserted character.
    expect(lastFrame()).toContain('❯ ab█c')
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


describe('back-to-bottom pill', () => {
  function overflowingFrames(): Frame[] {
    return Array.from({ length: 30 }, (_, i) => (
      { kind: 'assistant', seq: i + 1, turn: 1, step: 1, text: `line ${i + 1}`, streaming: false }
    ))
  }

  it('shows while scrolled up and returns on End', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(overflowingFrames())} handlers={noopHandlers()} />)
    await settled(60)
    expect(lastFrame()).not.toContain('Back to bottom')
    stdin.write('\x1b[<64;3;3M') // one wheel notch up
    await settled(40)
    expect(lastFrame()).toContain('↓ Back to bottom (Enter/End)')
    stdin.write('\x1b[F') // End jumps back to the live bottom
    await settled(40)
    expect(lastFrame()).not.toContain('Back to bottom')
  })

  it('returns on an empty-buffer Enter and keeps committing typed text', async () => {
    const onCommit = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(overflowingFrames())} handlers={{ ...noopHandlers(), onCommit }} />)
    await settled(60)
    stdin.write('\x1b[<64;3;3M')
    await settled(40)
    expect(lastFrame()).toContain('Back to bottom')
    stdin.write('\r') // an empty Enter jumps instead of committing
    await settled(40)
    expect(onCommit).not.toHaveBeenCalled()
    expect(lastFrame()).not.toContain('Back to bottom')
    // A typed buffer keeps its commit meaning even while scrolled up.
    stdin.write('\x1b[<64;3;3M')
    await settled(40)
    stdin.write('hi')
    stdin.write('\r')
    await settled(40)
    expect(onCommit).toHaveBeenCalledWith('hi')
  })

  it('keeps the editor End (cursor to buffer end) while at the bottom', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(overflowingFrames())} handlers={noopHandlers()} />)
    await settled(60)
    stdin.write('ab')
    stdin.write('\x1b[D') // one column left: the caret sits between a and b
    stdin.write('\x1b[F') // End at the live bottom keeps its editor role
    await settled()
    expect(lastFrame()).toContain('ab█')
  })

  it('returns to the bottom when the pill itself is clicked', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state(overflowingFrames())} handlers={noopHandlers()} />)
    await settled(60)
    stdin.write('\x1b[<64;3;3M') // one wheel notch up pops the pill
    await settled(40)
    const lines = lastFrame()!.split('\n')
    const pillRow = lines.findIndex(line => line.includes('Back to bottom'))
    expect(pillRow).toBeGreaterThan(-1)
    // Click inside the centered label: its column in the ANSI-stripped row,
    // mapped to 1-based SGR coordinates.
    const x = lines[pillRow].indexOf('Back') + 3
    stdin.write(`\x1b[<0;${x};${pillRow + 1}M`)
    await settled(40)
    expect(lastFrame()).not.toContain('Back to bottom')
  })
})
