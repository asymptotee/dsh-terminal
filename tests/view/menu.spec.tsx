/** The slash-command completion menu: filtering, selection, and windowing. */

import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { RenderView } from '../../src/view/renderer.tsx'
import type { Frame } from '../../src/fold/frames.ts'
import { renderApp, settled, state } from '../helpers/render.tsx'

describe('slash command completion menu', () => {
  // The registry's discovery descriptors as the driver maps them (name-sorted,
  // like CommandRuntime.list); one carries an input hint.
  const commandView: RenderView = {
    commands: [
      { name: 'effort', description: 'Set the reasoning effort' },
      { name: 'permission', description: 'Switch the permission preset', hint: '<preset>' },
      { name: 'status', description: 'Show session status' },
    ],
  }
  function spyHandlers() {
    return {
      onCommit: vi.fn(), onInterrupt: vi.fn(), onApproval: vi.fn(), onExit: vi.fn(),
      onPanelOpen: vi.fn(), onPanelMove: vi.fn(), onPanelEnter: vi.fn(), onPanelBack: vi.fn(),
      onChildPrompt: vi.fn(), onJobKill: vi.fn(), onQuestionAnswer: vi.fn(),
      onCyclePermission: vi.fn(),
    }
  }

  it('lists every command when the buffer is a lone slash', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={spyHandlers()} view={commandView} />)
    stdin.write('/')
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('/effort')
    expect(frame).toContain('/permission')
    expect(frame).toContain('/status')
    expect(frame).toContain('Switch the permission preset')
    expect(frame).toContain('<preset>')
  })

  it('filters by prefix as the command name is typed', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={spyHandlers()} view={commandView} />)
    stdin.write('/per')
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('/permission')
    expect(frame).not.toContain('/effort')
    expect(frame).not.toContain('/status')
  })

  // Rows differ only by color and renderApp strips ANSI codes, so selection is
  // asserted behaviorally: Tab completes whichever row is selected.
  it('moves the selection down with the arrow keys', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={spyHandlers()} view={commandView} />)
    stdin.write('/')
    await settled()
    stdin.write('\x1b[B') // Down: effort -> permission
    await settled()
    stdin.write('\t')
    await settled()
    expect(lastFrame() ?? '').toContain('❯ /permission █')
  })

  it('moves the selection back up', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={spyHandlers()} view={commandView} />)
    stdin.write('/')
    await settled()
    stdin.write('\x1b[B') // Down: effort -> permission
    await settled()
    stdin.write('\x1b[A') // Up: back to effort
    await settled()
    stdin.write('\t')
    await settled()
    expect(lastFrame() ?? '').toContain('❯ /effort █')
  })

  it('completes to the command name plus a space on Tab and closes the menu', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={spyHandlers()} view={commandView} />)
    stdin.write('/per')
    await settled()
    stdin.write('\t')
    await settled()
    const frame = lastFrame() ?? ''
    // The completed buffer carries the caret at the end; the space closed the
    // menu — descriptions exist only in menu rows.
    expect(frame).toContain('❯ /permission █')
    expect(frame).not.toContain('Switch the permission preset')
  })

  it('completes on Enter without committing while the menu is open', async () => {
    const handlers = spyHandlers()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={handlers} view={commandView} />)
    stdin.write('/per')
    await settled()
    stdin.write('\r')
    await settled()
    expect(handlers.onCommit).not.toHaveBeenCalled()
    expect(lastFrame() ?? '').toContain('❯ /permission █')
  })

  it('dismisses on Esc without interrupting, keeps the buffer, and reopens on the next edit', async () => {
    const handlers = spyHandlers()
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={handlers} view={commandView} />)
    stdin.write('/per')
    await settled()
    stdin.write('\x1b')
    await settled()
    let frame = lastFrame() ?? ''
    expect(handlers.onInterrupt).not.toHaveBeenCalled()
    expect(frame).not.toContain('Switch the permission preset')
    expect(frame).toContain('❯ /per█')
    // Typing again re-derives the menu.
    stdin.write('m')
    await settled()
    expect(lastFrame() ?? '').toContain('Switch the permission preset')
  })

  it('closes the menu once a space starts the argument input', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={spyHandlers()} view={commandView} />)
    stdin.write('/permission ')
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('Switch the permission preset')
    expect(frame).toContain('❯ /permission █')
  })

  it('stays closed for a view without commands', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={spyHandlers()} />)
    stdin.write('/per')
    await settled()
    expect(lastFrame() ?? '').not.toContain('Set the reasoning effort')
  })

  it('opens above the input box while the status bar keeps standing below', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={spyHandlers()}
      view={{ ...commandView, status: { model: 'test-model', cwd: '/workspace/repo' } }}
    />)
    expect(lastFrame() ?? '').toContain('test-model')
    stdin.write('/')
    await settled()
    await settled()
    const frame = lastFrame() ?? ''
    // The footer holds its rows while the menu is up, and the menu's name
    // rows sit above the editor box, which stays above the footer.
    expect(frame).toContain('test-model')
    const rows = frame.split('\n')
    const menuRow = rows.findIndex(row => row.includes('/effort'))
    const editorRow = rows.findIndex(row => row.includes('/█'))
    const statusRow = rows.findIndex(row => row.includes('test-model'))
    expect(menuRow).toBeGreaterThan(-1)
    expect(editorRow).toBeGreaterThan(menuRow)
    expect(statusRow).toBeGreaterThan(editorRow)
    stdin.write('\t')
    await settled()
    await settled()
    // Completion closes the menu (descriptions exist only in menu rows); the
    // box and footer never moved.
    const closed = lastFrame() ?? ''
    expect(closed).not.toContain('Set the reasoning effort')
    expect(closed).toContain('❯ /effort █')
    expect(closed).toContain('test-model')
  })

  /** An overflowing transcript: every frame one row, live bottom on screen. */
  function overflowingFrames(): Frame[] {
    return Array.from({ length: 40 }, (_, i) => (
      { kind: 'assistant', seq: i + 1, turn: 1, step: 1, text: `line ${i + 1}`, streaming: false }
    ))
  }

  it('paints over the transcript bottom rows instead of reflowing them', async () => {
    const { lastFrame, stdin } = renderApp(
      <TuiApp state={state(overflowingFrames())} handlers={spyHandlers()} view={commandView} />,
    )
    await settled(60)
    const before = (lastFrame() ?? '').split('\n')
    expect(lastFrame() ?? '').toContain('line 40')
    stdin.write('/')
    await settled()
    await settled()
    const frame = lastFrame() ?? ''
    const after = frame.split('\n')
    // The screen geometry is untouched: the same rows, and the rows above the
    // overlay are identical — the transcript never scrolled or re-anchored.
    expect(after.length).toBe(before.length)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    // The overlay's five rows (the clear row, the light-blue cap rule, the
    // three menu rows) replaced the bottom transcript rows — the live bottom
    // 'line 40' and 'line 39' hidden under it, full-width erase with no
    // leftover text on any overlay row — and everything above stands.
    expect(frame).toContain('/effort')
    expect(frame).not.toContain('line 40')
    expect(frame).not.toContain('line 39')
    expect(frame).toContain('line 38')
    // The cap rule sits directly above the first menu row, and the cleared
    // transcript row above it renders blank.
    const menuRow = after.findIndex(row => row.includes('/effort'))
    expect(menuRow).toBeGreaterThan(1)
    expect(/^─+$/.test(after[menuRow - 1])).toBe(true)
    expect(after[menuRow - 2]).toBe('')
  })

  it('swallows transcript clicks while the menu overlays them', async () => {
    const { lastFrame, stdin } = renderApp(
      <TuiApp state={state(overflowingFrames())} handlers={spyHandlers()} view={commandView} />,
    )
    await settled(60)
    stdin.write('\x1b[<64;3;3M') // one wheel notch up pops the pill
    await settled(40)
    const rows = (lastFrame() ?? '').split('\n')
    const pillRow = rows.findIndex(row => row.includes('Back to bottom'))
    expect(pillRow).toBeGreaterThan(-1)
    const pillX = rows[pillRow].indexOf('Back') + 3
    stdin.write('/')
    await settled()
    await settled()
    const covered = lastFrame() ?? ''
    // The menu paints over the pill's row (full-width erase).
    expect(covered).toContain('/effort')
    expect(covered).not.toContain('Back to bottom')
    // A click where the pill used to be is swallowed: no fall-through jump to
    // the bottom, the frame stays exactly as the menu left it.
    stdin.write(`\x1b[<0;${pillX};${pillRow + 1}M`)
    await settled(40)
    expect(lastFrame() ?? '').toBe(covered)
  })
})

