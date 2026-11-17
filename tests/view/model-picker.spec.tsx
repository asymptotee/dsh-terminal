/** The model-route picker popup: its float over the input box, its key
 *  routing, and the waterfall round trip it answers. */

import { describe, expect, it, vi } from 'vitest'
import { renderApp, settled, noopHandlers, state } from '../helpers/render.tsx'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { ModelPickerView } from '../../src/view/renderer.tsx'
import { bench } from '../helpers/bench.ts'

const PICKER: ModelPickerView = {
  options: [
    { provider: 'anthropic', model: 'model-a', name: 'Model A' },
    { provider: 'anthropic', model: 'model-b', name: 'Model B', description: 'The slower one' },
    { provider: 'other', model: 'model-a', name: 'Model A (other)' },
  ],
  selected: 1,
  current: 'anthropic/model-a',
}

describe('model picker popup', () => {
  it('floats above the input box listing every route with the current one marked', () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={{ modelPicker: PICKER }} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Model')
    expect(frame).toContain('anthropic/model-a')
    expect(frame).toContain('anthropic/model-b')
    expect(frame).toContain('other/model-a')
    // The route in effect carries ✓.
    expect(frame).toContain('✓')
    // The focused route's description floats under the list.
    expect(frame).toContain('The slower one')
    expect(frame).toContain('↑/↓ to move · Enter to confirm · Esc to cancel')
    // Above the editor row.
    const rows = frame.split('\n')
    expect(rows.findIndex(row => row.includes('Model'))).toBeLessThan(rows.findIndex(row => row.includes('❯')))
  })

  it('drops a nominal column that merely repeats the id', () => {
    // pi-ai fills `name` with the model id when the row declares no display
    // name; the nominal column must not echo the label back at the reader.
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          modelPicker: {
            options: [
              { provider: 'anthropic', model: 'model-x', name: 'model-x' },
              { provider: 'anthropic', model: 'model-y', name: 'anthropic/model-y' },
              { provider: 'anthropic', model: 'model-z', name: 'Model Z' },
            ],
            selected: 2,
            current: 'anthropic/model-x',
          },
        }}
      />,
    )
    const rows = (lastFrame() ?? '').split('\n')
    const x = rows.find(row => row.includes('anthropic/model-x')) ?? ''
    const y = rows.find(row => row.includes('anthropic/model-y')) ?? ''
    const z = rows.find(row => row.includes('anthropic/model-z')) ?? ''
    // Only the genuinely distinct display name survives.
    expect(x.trimEnd()).toBe('  ✓ anthropic/model-x')
    expect(y.trimEnd()).toBe('    anthropic/model-y')
    expect(z).toContain('Model Z')
  })

  it('routes the arrows, Enter, and Esc to the picker handlers', async () => {
    const handlers = {
      ...noopHandlers(),
      onCommit: vi.fn(),
      onModelMove: vi.fn(),
      onModelConfirm: vi.fn(),
      onModelCancel: vi.fn(),
    }
    const { stdin, lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={handlers} view={{ modelPicker: PICKER }} />,
    )
    stdin.write('\x1b[A') // Up
    await settled()
    expect(handlers.onModelMove).toHaveBeenCalledWith(-1)
    stdin.write('\x1b[B') // Down
    await settled()
    expect(handlers.onModelMove).toHaveBeenCalledWith(1)
    stdin.write('\r')
    await settled()
    expect(handlers.onModelConfirm).toHaveBeenCalledTimes(1)
    stdin.write('\x1b')
    await settled()
    expect(handlers.onModelCancel).toHaveBeenCalledTimes(1)
    // Typed characters are swallowed: the editor buffer underneath stays empty.
    stdin.write('x')
    await settled()
    expect(lastFrame()).toContain('❯ █')
    expect(handlers.onCommit).not.toHaveBeenCalled()
  })
})

describe('model picker waterfall answerer', () => {
  type Answer = { provider: string; model: string } | { cancelled: true }

  function fire(test: Awaited<ReturnType<typeof bench>>, over: Record<string, unknown> = {}): Promise<Answer | undefined> {
    const waterfall = (test.ctx as unknown as {
      waterfall(name: string, req: unknown, fallback: () => Promise<unknown>): Promise<unknown>
    }).waterfall.bind(test.ctx)
    return waterfall('model-picker/request', {
      agent: test.agent,
      models: PICKER.options,
      current: 'anthropic/model-a',
      signal: new AbortController().signal,
      ...over,
    }, () => Promise.resolve(undefined)) as Promise<Answer | undefined>
  }

  it('opens the list on a request, starts on the current route, and settles the pick', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fire(test)
    await settled()
    const picker = test.views.at(-1)?.modelPicker
    expect(picker?.options).toEqual(PICKER.options)
    // The selection starts on the route in effect.
    expect(picker?.selected).toBe(0)
    test.handlers.onModelMove(1)
    test.handlers.onModelConfirm()
    expect(await pending).toEqual({ provider: 'anthropic', model: 'model-b' })
    expect(test.views.at(-1)?.modelPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('settles cancelled on Esc', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fire(test)
    await settled()
    test.handlers.onModelCancel()
    expect(await pending).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.modelPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('settles cancelled when the dispatch signal aborts', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const controller = new AbortController()
    const pending = fire(test, { signal: controller.signal })
    await settled()
    expect(test.views.at(-1)?.modelPicker).toBeDefined()
    controller.abort()
    await settled()
    expect(await pending).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.modelPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('delegates requests for other agents down the waterfall', async () => {
    const test = await bench({ afterPrompt: () => {} })
    expect(await fire(test, { agent: {} })).toBeUndefined()
    expect(test.views.at(-1)?.modelPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })
})