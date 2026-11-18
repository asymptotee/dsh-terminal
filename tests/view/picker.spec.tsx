/** The shared picker popup: both layouts, the key routing, the waterfall
 *  round trip, and the supersede/abort settlements. */

import { describe, expect, it, vi } from 'vitest'
import { renderApp, settled, noopHandlers, state } from '../helpers/render.tsx'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { PickerPopupView } from '../../src/view/renderer.tsx'
import { bench } from '../helpers/bench.ts'

const SCALE: PickerPopupView = {
  pickerId: 'effort:1',
  kind: 'scale',
  title: 'Effort',
  options: [
    { value: 'low', label: 'low', description: 'Fast and light' },
    { value: 'medium', label: 'medium' },
    { value: 'high', label: 'high', description: 'The default balance for most tasks.' },
  ],
  selected: 2,
  currentIndex: 2,
  scaleEnds: { low: 'Faster', high: 'Smarter' },
}

const LIST: PickerPopupView = {
  pickerId: 'model:1',
  kind: 'list',
  title: 'Model',
  options: [
    { value: 'anthropic/model-a', label: 'anthropic/model-a', note: 'Model A' },
    { value: 'anthropic/model-b', label: 'anthropic/model-b', note: 'Model B', description: 'The slower one' },
    { value: 'other/model-a', label: 'other/model-a' },
  ],
  selected: 1,
  currentIndex: 0,
}

describe('picker popup layouts', () => {
  it('renders a scale with its track, ends, and the focused description', () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={{ picker: SCALE }} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Effort')
    expect(frame).toContain('Faster')
    expect(frame).toContain('Smarter')
    expect(frame).toContain('▲')
    expect(frame).toContain('low')
    expect(frame).toContain('high')
    expect(frame).toContain('The default balance for most tasks.')
    expect(frame).toContain('←/→ to adjust · Enter to confirm · Esc to cancel')
    // Above the editor row.
    const rows = frame.split('\n')
    expect(rows.findIndex(row => row.includes('Effort'))).toBeLessThan(rows.findIndex(row => row.includes('❯')))
    // Two erased rows sit above the cap rule: the popup hides the transcript
    // lines it would otherwise crowd instead of touching the body text.
    const ruleRow = rows.findIndex(row => row.includes('▔'))
    expect(ruleRow).toBeGreaterThan(1)
    expect(rows[ruleRow - 1]).toBe('')
    expect(rows[ruleRow - 2]).toBe('')
  })

  it('renders a list with the current choice marked and the focused description', () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={{ picker: LIST }} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Model')
    expect(frame).toContain('anthropic/model-a')
    expect(frame).toContain('anthropic/model-b')
    expect(frame).toContain('other/model-a')
    // The row in effect carries a ✔ after its label; rows are ordinaled.
    expect(frame).toContain('✔')
    expect(frame).toContain('1. anthropic/model-a')
    expect(frame).toContain('The slower one')
    expect(frame).toContain('↑/↓ to move · Enter to confirm · Esc to cancel')
  })

  it('drops a nominal column that merely repeats the label', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          picker: {
            pickerId: 'model:2',
            kind: 'list',
            title: 'Model',
            options: [
              { value: 'anthropic/model-x', label: 'anthropic/model-x' },
              { value: 'anthropic/model-z', label: 'anthropic/model-z', note: 'Model Z' },
            ],
            selected: 1,
            currentIndex: 0,
          },
        }}
      />,
    )
    const rows = (lastFrame() ?? '').split('\n')
    expect(rows.find(row => row.includes('anthropic/model-x'))?.trimEnd()).toBe('      1. anthropic/model-x ✔')
    expect(rows.find(row => row.includes('anthropic/model-z'))).toContain('Model Z')
  })

  it('runs the selection past the row cap with an overflow notice', () => {
    const options = Array.from({ length: 20 }, (_, index) => ({
      value: `route-${index}`,
      label: `route-${index}`,
    }))
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{ picker: { pickerId: 'm:3', kind: 'list', title: 'Model', options, selected: 12 } }}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/… \d+ more/)
    // The window follows the selection rather than sticking to the head.
    expect(frame).toContain('route-12')
    expect(frame).not.toContain('route-0')
  })
})

describe('picker key routing', () => {
  it('routes both arrow pairs to the move handler regardless of layout', async () => {
    const handlers = {
      ...noopHandlers(),
      onCommit: vi.fn(),
      onPickerMove: vi.fn(),
      onPickerConfirm: vi.fn(),
      onPickerCancel: vi.fn(),
    }
    const { stdin, lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={handlers} view={{ picker: SCALE }} />,
    )
    stdin.write('\x1b[C') // Right
    await settled()
    expect(handlers.onPickerMove).toHaveBeenCalledWith(1)
    stdin.write('\x1b[D') // Left
    await settled()
    expect(handlers.onPickerMove).toHaveBeenCalledWith(-1)
    stdin.write('\x1b[A') // Up — accepted on a scale too
    await settled()
    expect(handlers.onPickerMove).toHaveBeenCalledWith(-1)
    stdin.write('\x1b[B') // Down
    await settled()
    expect(handlers.onPickerMove).toHaveBeenCalledWith(1)
    stdin.write('\r')
    await settled()
    expect(handlers.onPickerConfirm).toHaveBeenCalledTimes(1)
    stdin.write('\x1b')
    await settled()
    expect(handlers.onPickerCancel).toHaveBeenCalledTimes(1)
    // Typed characters are swallowed: the editor buffer underneath stays empty.
    stdin.write('x')
    await settled()
    expect(lastFrame()).toContain('❯ █')
    expect(handlers.onCommit).not.toHaveBeenCalled()
  })
})

describe('picker waterfall answerer', () => {
  type Answer = { value: string } | { cancelled: true }

  function fire(test: Awaited<ReturnType<typeof bench>>, over: Record<string, unknown> = {}): Promise<Answer | undefined> {
    const waterfall = (test.ctx as unknown as {
      waterfall(name: string, req: unknown, fallback: () => Promise<unknown>): Promise<unknown>
    }).waterfall.bind(test.ctx)
    return waterfall('picker/request', {
      pickerId: 'test:1',
      kind: 'list',
      title: 'Model',
      options: LIST.options,
      currentIndex: 0,
      signal: new AbortController().signal,
      ...over,
    }, () => Promise.resolve(undefined)) as Promise<Answer | undefined>
  }

  it('opens the popup and settles with the chosen value', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fire(test)
    await settled()
    const picker = test.views.at(-1)?.picker
    expect(picker?.title).toBe('Model')
    expect(picker?.kind).toBe('list')
    // The selection starts on the choice in effect.
    expect(picker?.selected).toBe(0)
    test.handlers.onPickerMove(1)
    test.handlers.onPickerConfirm()
    expect(await pending).toEqual({ value: 'anthropic/model-b' })
    expect(test.views.at(-1)?.picker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('carries the scale layout through untouched', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fire(test, { kind: 'scale', title: 'Effort', options: SCALE.options, currentIndex: 2, scaleEnds: SCALE.scaleEnds })
    await settled()
    const picker = test.views.at(-1)?.picker
    expect(picker?.kind).toBe('scale')
    expect(picker?.scaleEnds).toEqual({ low: 'Faster', high: 'Smarter' })
    expect(picker?.selected).toBe(2)
    test.handlers.onPickerCancel()
    expect(await pending).toEqual({ cancelled: true })
    await test.ctx.fiber.dispose()
  })

  it('settles cancelled on Esc', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fire(test)
    await settled()
    test.handlers.onPickerCancel()
    expect(await pending).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.picker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('settles cancelled when the dispatch signal aborts', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const controller = new AbortController()
    const pending = fire(test, { signal: controller.signal })
    await settled()
    expect(test.views.at(-1)?.picker).toBeDefined()
    controller.abort()
    await settled()
    expect(await pending).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.picker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('a superseded request settles the old picker as cancelled', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const first = fire(test, { pickerId: 'first:1' })
    await settled()
    const second = fire(test, { pickerId: 'second:1' })
    await settled()
    expect(await first).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.picker?.pickerId).toBe('second:1')
    test.handlers.onPickerCancel()
    expect(await second).toEqual({ cancelled: true })
    await test.ctx.fiber.dispose()
  })
})