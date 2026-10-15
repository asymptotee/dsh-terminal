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
      onChildPrompt: vi.fn(), onJobKill: vi.fn(),
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

  it('hides the status bar while the menu is open and restores it after completion', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={spyHandlers()}
      view={{ ...commandView, status: { model: 'test-model', cwd: '/workspace/repo' } }}
    />)
    expect(lastFrame() ?? '').toContain('test-model')
    stdin.write('/')
    await settled()
    await settled()
    // The menu occupies the chrome band; the status bar yields its rows.
    expect(lastFrame() ?? '').not.toContain('test-model')
    stdin.write('\t')
    await settled()
    await settled()
    // Completion closes the menu; the status bar comes back.
    expect(lastFrame() ?? '').toContain('test-model')
  })
})

