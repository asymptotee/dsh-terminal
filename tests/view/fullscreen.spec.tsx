/** The fullscreen transcript window: scrolling, measurement, and bottom anchoring. */

import { describe, expect, it } from 'vitest'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { Frame } from '../../src/fold/frames.ts'
import { noopHandlers, renderApp, settled, state } from '../helpers/render.tsx'

describe('fullscreen transcript window', () => {
  const manyFrames = (count: number): Frame[] =>
    Array.from({ length: count }, (_, i) => ({ kind: 'user', seq: i + 1, text: `msg-${i}` }))

  it('renders exactly the viewport height', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state(manyFrames(3))}
      handlers={noopHandlers()}
      viewportRows={12}
    />)
    expect((lastFrame() ?? '').split('\n')).toHaveLength(12)
  })

  it('parks the transcript off-window before the first measurement (no top-aligned flash)', async () => {
    const { frames, lastFrame } = renderApp(<TuiApp
      state={state(manyFrames(40))}
      handlers={noopHandlers()}
      viewportRows={12}
    />)
    // The very first paint shows an empty window, not the transcript head
    // top-aligned (which would visibly jump down when the measure lands).
    expect(frames[0]).not.toContain('msg-0')
    await settled()
    expect(lastFrame()).toContain('msg-39')
  })

  it('clips the transcript to the window, keeping the newest content', async () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state(manyFrames(40))}
      handlers={noopHandlers()}
      viewportRows={12}
    />)
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('msg-39')
    expect(frame).not.toContain('msg-0')
    expect(frame).not.toContain('msg-30')
  })

  it('scrolls toward older content on a wheel-up report, back on wheel-down', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state(manyFrames(40))}
      handlers={noopHandlers()}
      viewportRows={12}
    />)
    await settled()
    stdin.write('\x1b[<64;5;5M')
    await settled()
    let frame = lastFrame() ?? ''
    // Scrolled up: the newest line left the window, an older one arrived.
    expect(frame).not.toContain('msg-39')
    expect(frame).toContain('msg-36')
    stdin.write('\x1b[<65;5;5M')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('msg-39')
  })

  it('pages with PageUp and returns to the live bottom with PageDown', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state(manyFrames(40))}
      handlers={noopHandlers()}
      viewportRows={12}
    />)
    await settled()
    stdin.write('\x1b[5~')
    await settled()
    // Paged up: the newest line scrolled out of the window.
    expect(lastFrame()).not.toContain('msg-39')
    stdin.write('\x1b[6~')
    await settled()
    expect(lastFrame()).toContain('msg-39')
  })

  it('never lets mouse reports reach the editor buffer', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    stdin.write('ab')
    stdin.write('\x1b[<64;5;5M')
    stdin.write('c')
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('abc█')
    expect(frame).not.toContain('[<64')
  })

  it('expands every transcript tool output on ctrl+o, not just the latest frame', async () => {
    const output = Array.from({ length: 10 }, (_, i) => `o${i}`).join('\n')
    const frames: Frame[] = [
      {
        kind: 'tool', seq: 1, turn: 1, step: 1, callId: 'c1', name: 'bash', args: {},
        call: { card: 'terminal', title: 'cmd' },
        result: { card: 'terminal', output },
      },
      { kind: 'user', seq: 2, text: 'next' },
    ]
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state(frames)}
      handlers={noopHandlers()}
      viewportRows={40}
    />)
    await settled()
    expect(lastFrame()).not.toContain('o9')
    stdin.write('\x0f')
    await settled()
    expect(lastFrame()).toContain('o9')
  })

  it('caps the standing plan with a hint for the elided todos', () => {
    const plan = Array.from({ length: 15 }, (_, i) => ({ content: `t${i}`, status: 'pending' as const }))
    const { lastFrame } = renderApp(<TuiApp state={state([], plan)} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('… 5 earlier')
    expect(frame).toContain('t14')
    expect(frame).not.toContain(' t0 ')
  })

  it('elides frames beyond the render cap with a hint', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state(manyFrames(350))}
      handlers={noopHandlers()}
      viewportRows={40}
    />)
    await settled()
    let frame = lastFrame() ?? ''
    // The cap keeps the newest 300 frames; the elided head renders nowhere.
    expect(frame).toContain('msg-349')
    expect(frame).not.toContain('msg-49')
    // Paging to the very top reaches the elision hint.
    for (let i = 0; i < 25; i++) stdin.write('\x1b[5~')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('… 50 earlier frames')
  })

  it('centers the welcome splash in the window while the session is fresh', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} viewportRows={15} />)
    const lines = (lastFrame() ?? '').split('\n')
    const top = lines.findIndex(line => line.includes('╭'))
    const bottom = lines.findIndex(line => line.includes('╰'))
    expect(top).toBeGreaterThanOrEqual(0)
    // The window spans rows 0..11 (chrome is the 3-row input bar); the block
    // must sit mid-window, not glued to the top or the bottom.
    const above = top
    const below = 11 - bottom
    expect(Math.abs(above - below)).toBeLessThanOrEqual(2)
  })

  it('dismisses the welcome splash on first input, for the rest of the session', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(lastFrame()).toContain('DeepSeek Harness — Terminal')
    stdin.write('a')
    await settled()
    expect(lastFrame()).not.toContain('DeepSeek Harness — Terminal')
    // Clearing the buffer again does not bring it back.
    stdin.write('\x7f')
    await settled()
    expect(lastFrame()).not.toContain('DeepSeek Harness — Terminal')
  })

  it('keeps the child identity note pinned at the bottom at any scroll position', async () => {
    const childFrames: Frame[] = Array.from({ length: 40 }, (_, i) => ({ kind: 'user', seq: i + 1, text: `child-msg-${i}` }))
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      viewportRows={12}
      view={{ openSubagent: { childId: 'c1', label: 'X', state: state(childFrames) } }}
    />)
    await settled()
    // Scroll fully to the top — the pinned header must remain visible.
    for (let i = 0; i < 30; i++) stdin.write('\x1b[5~')
    await settled()
    expect(lastFrame()).toContain('subagent: X')
  })

  it('shows the child transcript in the window instead of the main session', async () => {
    const childState = state([
      { kind: 'user', seq: 1, text: '子会话第一句' },
      { kind: 'assistant', seq: 2, turn: 1, step: 1, text: '子会话回复', streaming: false },
    ])
    const mainFrames: Frame[] = [{ kind: 'user', seq: 1, text: '主会话消息' }]
    const { lastFrame } = renderApp(<TuiApp
      state={state(mainFrames)}
      handlers={noopHandlers()}
      view={{ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } }}
    />)
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('subagent: 调研包结构')
    expect(frame).toContain('子会话第一句')
    expect(frame).toContain('子会话回复')
    expect(frame).not.toContain('主会话消息')
  })
})

