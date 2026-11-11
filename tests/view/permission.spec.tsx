/**
 * The ⇧Tab permission cycle's view surface: the status row reads the Claude
 * Code style (`⏵ <mode> mode on (shift+tab to cycle)`, the mode segment
 * wearing its per-preset color — colors are ANSI and the harness strips
 * them, so only the wording is asserted here), and ⇧Tab reaches the cycle
 * handler while plain Tab stays with the slash menu.
 * @module dsh-terminal/tests/view/permission
 */

import { describe, expect, it, vi } from 'vitest'
import { renderApp, settled, noopHandlers, state } from '../helpers/render.tsx'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { RenderView, StatusInfo } from '../../src/view/renderer.tsx'

const STATUS: StatusInfo = { model: 'test-model', cwd: '/tmp', mode: 'workspace-write' }

function statusView(over?: Partial<RenderView>): RenderView {
  return { status: STATUS, ...over }
}

describe('permission cycle indicator', () => {
  it('reads the mode with the shift+tab cycle affordance', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={statusView()} />)
    expect(lastFrame() ?? '').toContain('⏵⏵ workspace-write mode on (shift+tab to cycle)')
  })

  it('routes ⇧Tab to the cycle handler', async () => {
    const onCyclePermission = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onCyclePermission }}
      view={statusView()}
    />)
    stdin.write('\x1b[Z')
    await settled()
    expect(onCyclePermission).toHaveBeenCalledTimes(1)
  })

  it('keeps plain Tab out of the cycle', async () => {
    const onCyclePermission = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onCyclePermission }}
      view={statusView()}
    />)
    stdin.write('\t')
    await settled()
    expect(onCyclePermission).not.toHaveBeenCalled()
  })
})
