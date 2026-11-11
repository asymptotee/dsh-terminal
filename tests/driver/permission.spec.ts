/**
 * The ⇧Tab permission cycle's driver side: the next preset in catalog order
 * switches through the service instantly — every preset one press away, the
 * indicator's color marking the danger — `custom` restarts from the catalog
 * head, `/permission` rides the command runtime, and a missing service or
 * failing set stays a no-op or a notice.
 * @module dsh-terminal/tests/driver/permission
 */

import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { bench } from '../helpers/bench.ts'

/** Append an event type the test program has not merged, via a structural cast. */
function appendRaw(session: Session, type: string, data: unknown): void {
  const append = session.append as unknown as (type: string, data: unknown, third?: unknown) => void
  append.call(session, type, data)
}

/** Flush microtasks and one macrotask so deferred renders land. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const OPTIONS = [
  { value: 'read-only', name: 'read-only' },
  { value: 'workspace-write', name: 'workspace-write' },
  { value: 'danger-full-access', name: 'danger-full-access' },
  { value: 'auto', name: 'auto' },
]

const SPECS: Record<string, { sandbox: string; approval: string }> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  // Full sandbox but ask: the reviewer gates it, so it is single-press.
  auto: { sandbox: 'danger-full-access', approval: 'ask' },
}

/** The structural face the driver reads: current + catalog + resolve + set. */
function presets(current: string, set: (session: unknown, name: string) => void) {
  return {
    current: () => current,
    catalog: () => ({ options: OPTIONS }),
    resolve: (name: string) => SPECS[name],
    set,
  }
}

describe('permission cycle driver', () => {
  it('switches to the next catalog preset on cycle', async () => {
    const set = vi.fn()
    const test = await bench({ permissionPresets: presets('read-only', set), afterPrompt: () => {} })
    test.handlers.onCyclePermission()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]?.[1]).toBe('workspace-write')
    await test.ctx.fiber.dispose()
  })

  it('wraps from the last preset back to the catalog head', async () => {
    const set = vi.fn()
    const test = await bench({ permissionPresets: presets('auto', set), afterPrompt: () => {} })
    test.handlers.onCyclePermission()
    expect(set.mock.calls[0]?.[1]).toBe('read-only')
    await test.ctx.fiber.dispose()
  })

  it('restarts from the catalog head when the session sits on custom', async () => {
    const set = vi.fn()
    const test = await bench({ permissionPresets: presets('custom', set), afterPrompt: () => {} })
    test.handlers.onCyclePermission()
    expect(set.mock.calls[0]?.[1]).toBe('read-only')
    await test.ctx.fiber.dispose()
  })

  it('switches straight into the never-ask preset on one cycle', async () => {
    const set = vi.fn()
    const test = await bench({ permissionPresets: presets('workspace-write', set), afterPrompt: () => {} })
    // workspace-write → danger-full-access: every preset is one press away;
    // the indicator's color, not a confirmation gate, marks the danger.
    test.handlers.onCyclePermission()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0]?.[1]).toBe('danger-full-access')
    await test.ctx.fiber.dispose()
  })

  it('surfaces a failing set as a notice', async () => {
    const set = vi.fn(() => { throw new Error('preset gone') })
    const test = await bench({ permissionPresets: presets('read-only', set), afterPrompt: () => {} })
    test.handlers.onCyclePermission()
    expect(test.views.at(-1)?.overlay).toEqual({
      kind: 'notice',
      text: 'permission switch failed: preset gone',
    })
    await test.ctx.fiber.dispose()
  })

  it('routes /permission to the command runtime again', async () => {
    const set = vi.fn()
    const execute = vi.fn(async (_agent: unknown, text: string) => ({ text }))
    const test = await bench({ permissionPresets: presets('read-only', set), commands: { execute }, afterPrompt: () => {} })
    test.handlers.onCommit('/permission')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[1]).toBe('/permission')
    await test.ctx.fiber.dispose()
  })

  it('no-ops the cycle when no presets service is mounted', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.handlers.onCyclePermission()
    expect(test.views.at(-1)?.overlay).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('never paints the transient custom derivation of a preset-switch burst', async () => {
    // Leaving `auto`, the service appends the preset identity and the changed
    // knob in one synchronous burst; between the two, the recorded preset
    // (read-only) does not yet match the still-auto knobs (full sandbox +
    // ask), which matches no configured preset and derives `custom`. Reading
    // the badge per event would paint that one-frame flash; the driver
    // coalesces the burst into a single post-burst read instead.
    let derived = 'auto'
    const presets = {
      current: () => derived,
      catalog: () => ({ options: OPTIONS }),
      set: () => {},
    }
    const test = await bench({ permissionPresets: presets, afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.status?.mode).toBe('auto')
    // The burst: derive flips to custom mid-append, then settles on the target.
    derived = 'custom'
    appendRaw(test.agent.session, 'permission/preset', { preset: 'read-only' })
    appendRaw(test.agent.session, 'sandbox/mode', { mode: 'read-only' })
    derived = 'read-only'
    await settle()
    expect(test.views.at(-1)?.status?.mode).toBe('read-only')
    // The intermediate derivation never reached a rendered frame.
    expect(test.views.some(view => view?.status?.mode === 'custom')).toBe(false)
    await test.ctx.fiber.dispose()
  })
})
