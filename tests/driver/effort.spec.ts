/** The terminal's half of the /effort feature: the popup answers the effort
 *  plugin's `effort-picker/request` waterfall, and the footer badge follows
 *  the durable `model/selection` event the plugin appends. */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { bench } from '../helpers/bench.ts'

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Append an event type the test program has not merged, via a structural cast. */
function appendRaw(session: Session, type: string, data: unknown): void {
  const append = session.append as unknown as (type: string, data: unknown, third?: unknown) => void
  append.call(session, type, data)
}

type PickAnswer = { level: string } | { cancelled: true }

interface PickerRequest {
  agent: unknown
  levels: readonly { id: string; name?: string; description?: string }[]
  current?: string
  signal?: AbortSignal
}

const LEVELS: readonly { id: string; description: string }[] = [
  { id: 'low', description: 'Fast and light' },
  { id: 'high', description: 'Deep and slow' },
]

/** Dispatch the picker waterfall the way the effort plugin does. */
function fireRequest(test: Awaited<ReturnType<typeof bench>>, request: Partial<PickerRequest> = {}): Promise<PickAnswer | undefined> {
  const waterfall = (test.ctx as unknown as {
    waterfall(name: string, req: unknown, fallback: () => Promise<unknown>): Promise<unknown>
  }).waterfall.bind(test.ctx)
  return waterfall('effort-picker/request', {
    agent: test.agent,
    levels: LEVELS,
    signal: new AbortController().signal,
    ...request,
  }, () => Promise.resolve(undefined)) as Promise<PickAnswer | undefined>
}

describe('effort picker waterfall answerer', () => {
  it('opens the popup on a picker request and settles with the chosen level', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fireRequest(test)
    await settle()
    const picker = test.views.at(-1)?.effortPicker
    expect(picker?.levels).toEqual(LEVELS)
    expect(picker?.selected).toBe(0)
    test.handlers.onEffortMove(1)
    test.handlers.onEffortConfirm()
    expect(await pending).toEqual({ level: 'high' })
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('starts the selection on the level in effect', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fireRequest(test, { current: 'high' })
    await settle()
    expect(test.views.at(-1)?.effortPicker?.selected).toBe(1)
    test.handlers.onEffortCancel()
    await pending
    await test.ctx.fiber.dispose()
  })

  it('settles cancelled on Esc', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const pending = fireRequest(test)
    await settle()
    expect(test.views.at(-1)?.effortPicker).toBeDefined()
    test.handlers.onEffortCancel()
    expect(await pending).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('settles cancelled and closes when the dispatch signal aborts', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const controller = new AbortController()
    const pending = fireRequest(test, { signal: controller.signal })
    await settle()
    expect(test.views.at(-1)?.effortPicker).toBeDefined()
    controller.abort()
    await settle()
    expect(await pending).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('delegates requests for other agents down the waterfall', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const answer = await fireRequest(test, { agent: {} })
    expect(answer).toBeUndefined()
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('a superseded request settles the old picker as cancelled', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const first = fireRequest(test)
    await settle()
    const second = fireRequest(test)
    await settle()
    expect(await first).toEqual({ cancelled: true })
    expect(test.views.at(-1)?.effortPicker).toBeDefined()
    test.handlers.onEffortCancel()
    expect(await second).toEqual({ cancelled: true })
    await test.ctx.fiber.dispose()
  })
})

describe('effort badge', () => {
  it('follows the model/selection event the plugin appends', async () => {
    const test = await bench({ afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.status?.effort).toBeUndefined()
    appendRaw(test.agent.session, 'model/selection', {
      provider: 'test-provider',
      model: 'test-model',
      reasoningEffort: 'high',
    })
    await settle()
    expect(test.views.at(-1)?.status?.effort).toBe('high')
    await test.ctx.fiber.dispose()
  })
})
