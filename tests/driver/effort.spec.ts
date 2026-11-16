/** The driver-registered `/effort` command and the effort badge that follows it. */

import { describe, expect, it, vi } from 'vitest'
import { bench } from '../helpers/bench.ts'

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** The structural face the commands fake captures at register(). */
interface RegisteredCommand {
  name: string
  description: string
  input?: { hint?: string }
  handler(invocation: {
    agent: unknown
    rawInput: string
    attachments: readonly unknown[]
    signal: AbortSignal
    commandId: string
  }): Promise<{ kind: string; text?: string }>
}

/** A commands fake that records registrations and lists them back, the way
 *  the real runtime feeds the slash menu. */
function commandsFake() {
  const registered: RegisteredCommand[] = []
  return {
    registered,
    service: {
      register: (definition: RegisteredCommand) => {
        registered.push(definition)
        return () => {}
      },
      list: () => registered.map(def => ({
        name: def.name,
        description: def.description,
        ...(def.input === undefined ? {} : { input: def.input }),
      })),
      execute: vi.fn(async (_agent: unknown, _line: string) => ({ commandId: 'c-exec', result: { kind: 'success' } })),
    },
  }
}

describe('effort command', () => {
  it('registers /effort, appears in the menu, and switches the selection', async () => {
    const commands = commandsFake()
    const test = await bench({ commands: commands.service, afterPrompt: () => {} })
    const effort = commands.registered.find(def => def.name === 'effort')
    expect(effort?.description).toBe('Set the reasoning effort')
    // The registry list feeds the slash menu with the input hint.
    expect(test.views.at(-1)?.commands).toEqual([
      { name: 'effort', description: 'Set the reasoning effort', hint: '<level>|off' },
    ])
    const invoke = (rawInput: string): Promise<{ kind: string; text?: string }> =>
      effort!.handler({ agent: test.agent, rawInput, attachments: [], signal: new AbortController().signal, commandId: 'c1' })
    // Bare /effort opens the picker; this bench discloses no levels, so the
    // handler settles as the command's error instead.
    expect(await invoke('')).toEqual({ kind: 'error', text: 'No effort levels disclosed for this model' })
    expect(await invoke(' high ')).toEqual({ kind: 'success', text: 'Reasoning effort set to high' })
    await settle()
    // The switch is durable (the scripted model appended `model/selection`)
    // and the badge follows the event.
    expect(test.agent.model.current()?.reasoningEffort).toBe('high')
    expect(test.views.at(-1)?.status?.effort).toBe('high')
    await test.ctx.fiber.dispose()
  })

  it('clears back to the model default with off', async () => {
    const commands = commandsFake()
    const test = await bench({ commands: commands.service, afterPrompt: () => {} })
    const effort = commands.registered.find(def => def.name === 'effort')!
    const invoke = (rawInput: string): Promise<{ kind: string; text?: string }> =>
      effort.handler({ agent: test.agent, rawInput, attachments: [], signal: new AbortController().signal, commandId: 'c1' })
    await invoke('high')
    await settle()
    expect(test.views.at(-1)?.status?.effort).toBe('high')
    expect(await invoke('off')).toEqual({ kind: 'success', text: 'Reasoning effort cleared (model default).' })
    await settle()
    expect(test.agent.model.current()?.reasoningEffort).toBeUndefined()
    // The bench discloses no adapter default: the badge drops the segment.
    expect(test.views.at(-1)?.status?.effort).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('reports and validates against the adapter-disclosed levels', async () => {
    const commands = commandsFake()
    const test = await bench({
      commands: commands.service,
      llm: {
        resolveModelInfo: async () => ({
          reasoning: { defaultEffort: 'low', efforts: [{ id: 'low' }, { id: 'high' }] },
        }),
      },
      afterPrompt: () => {},
    })
    await settle()
    const effort = commands.registered.find(def => def.name === 'effort')!
    const invoke = (rawInput: string): Promise<{ kind: string; text?: string }> =>
      effort.handler({ agent: test.agent, rawInput, attachments: [], signal: new AbortController().signal, commandId: 'c1' })
    // The resolved adapter default seeds the badge; the bare call opens the
    // picker and settles only when the user does.
    const pendingBare = invoke('')
    await settle()
    expect(test.views.at(-1)?.effortPicker).toBeDefined()
    expect(test.views.at(-1)?.status?.effort).toBe('low')
    test.handlers.onEffortCancel()
    expect(await pendingBare).toEqual({ kind: 'success', text: 'Cancelled' })
    // An unknown level is rejected without touching the selection.
    expect(await invoke('ultra')).toEqual({ kind: 'error', text: 'Unknown effort: ultra · available: low · high' })
    expect(test.agent.model.current()?.reasoningEffort).toBeUndefined()
    expect(test.views.at(-1)?.status?.effort).toBe('low')
    await test.ctx.fiber.dispose()
  })
})

describe('effort picker', () => {
  /** Invoke the registered handler the way the runtime does — the returned
   *  promise settles only when the user confirms or cancels the popup. */
  async function openViaHandler(test: Awaited<ReturnType<typeof bench>>, commands: ReturnType<typeof commandsFake>): Promise<{ kind: string; text?: string }> {
    const effort = commands.registered.find(def => def.name === 'effort')!
    return await effort.handler({ agent: test.agent, rawInput: '', attachments: [], signal: new AbortController().signal, commandId: 'c-open' })
  }

  function llmFake(efforts: readonly { id: string; description?: string }[]) {
    return { resolveModelInfo: async () => ({ reasoning: { efforts } }) }
  }

  it('routes a bare /effort through the runtime like any other command', async () => {
    const commands = commandsFake()
    const test = await bench({
      commands: commands.service,
      llm: llmFake([{ id: 'low', description: 'Fast and light' }, { id: 'high', description: 'Deep and slow' }]),
      afterPrompt: () => {},
    })
    test.handlers.onCommit('/effort')
    await settle()
    // The line rides the registry — logged ❯ echo, log-restored history,
    // resume-proof — exactly like the other commands.
    expect(commands.service.execute).toHaveBeenCalledTimes(1)
    expect(commands.service.execute.mock.calls[0]?.[1]).toBe('/effort')
    // The registered handler is what opens the popup; it settles only when
    // the user confirms or cancels.
    const pending = openViaHandler(test, commands)
    await settle()
    const picker = test.views.at(-1)?.effortPicker
    expect(picker).toBeDefined()
    expect(picker?.levels).toEqual([
      { id: 'low', description: 'Fast and light' },
      { id: 'high', description: 'Deep and slow' },
    ])
    expect(picker?.selected).toBe(0)
    test.handlers.onEffortCancel()
    expect(await pending).toEqual({ kind: 'success', text: 'Cancelled' })
    await test.ctx.fiber.dispose()
  })

  it('walks, clamps, and applies the selection', async () => {
    const commands = commandsFake()
    const test = await bench({
      commands: commands.service,
      llm: llmFake([{ id: 'low' }, { id: 'high' }]),
      afterPrompt: () => {},
    })
    test.handlers.onCommit('/effort')
    await settle()
    const pending = openViaHandler(test, commands)
    await settle()
    test.handlers.onEffortMove(1)
    expect(test.views.at(-1)?.effortPicker?.selected).toBe(1)
    test.handlers.onEffortMove(5) // clamped at the last level
    expect(test.views.at(-1)?.effortPicker?.selected).toBe(1)
    test.handlers.onEffortConfirm()
    await settle()
    // Closed, applied (the scripted model logged model/selection), badged.
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    expect(test.agent.model.current()?.reasoningEffort).toBe('high')
    expect(test.views.at(-1)?.status?.effort).toBe('high')
    // The choice rides the pending command's ⎿ result — no separate local
    // notice frame in the transcript.
    expect(await pending).toEqual({ kind: 'success', text: 'Reasoning effort set to high' })
    expect(test.states.at(-1)!.frames.some(frame => frame.kind === 'notice')).toBe(false)
    await test.ctx.fiber.dispose()
  })

  it('cancels untouched on Esc and keeps /effort <level> on the runtime path', async () => {
    const commands = commandsFake()
    const test = await bench({
      commands: commands.service,
      llm: llmFake([{ id: 'low' }, { id: 'high' }]),
      afterPrompt: () => {},
    })
    test.handlers.onCommit('/effort')
    await settle()
    const pending = openViaHandler(test, commands)
    await settle()
    expect(test.views.at(-1)?.effortPicker).toBeDefined()
    test.handlers.onEffortCancel()
    expect(await pending).toEqual({ kind: 'success', text: 'Cancelled' })
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    expect(test.agent.model.current()?.reasoningEffort).toBeUndefined()
    test.handlers.onCommit('/effort high')
    await settle()
    // Both lines ride the runtime: the bare one (whose handler opened the
    // popup) and the direct set.
    expect(commands.service.execute).toHaveBeenCalledTimes(2)
    expect(commands.service.execute.mock.calls[1]?.[1]).toBe('/effort high')
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('settles as Cancelled when the dispatch signal aborts mid-popup', async () => {
    const commands = commandsFake()
    const test = await bench({
      commands: commands.service,
      llm: llmFake([{ id: 'low' }, { id: 'high' }]),
      afterPrompt: () => {},
    })
    const effort = commands.registered.find(def => def.name === 'effort')!
    const controller = new AbortController()
    const pending = effort.handler({ agent: test.agent, rawInput: '', attachments: [], signal: controller.signal, commandId: 'c1' })
    await settle()
    expect(test.views.at(-1)?.effortPicker).toBeDefined()
    // The abort (a graceful exit mid-popup, or the dispatcher cancelling)
    // settles the command and closes the picker with it.
    controller.abort()
    await settle()
    expect(await pending).toEqual({ kind: 'success', text: 'Cancelled' })
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    expect(test.agent.model.current()?.reasoningEffort).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('reports a missing disclosure as the command error instead of opening', async () => {
    const commands = commandsFake()
    const test = await bench({ commands: commands.service, afterPrompt: () => {} })
    const effort = commands.registered.find(def => def.name === 'effort')!
    const result = await effort.handler({ agent: test.agent, rawInput: '', attachments: [], signal: new AbortController().signal, commandId: 'c1' })
    expect(result).toEqual({ kind: 'error', text: 'No effort levels disclosed for this model' })
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    expect(test.states.at(-1)!.frames.some(frame => frame.kind === 'notice')).toBe(false)
    await test.ctx.fiber.dispose()
  })
  it('backfills well-known level descriptions the adapter did not disclose', async () => {
    const commands = commandsFake()
    const test = await bench({
      commands: commands.service,
      llm: llmFake([{ id: 'off' }, { id: 'medium' }, { id: 'turbo' }]),
      afterPrompt: () => {},
    })
    test.handlers.onCommit('/effort')
    await settle()
    const pending = openViaHandler(test, commands)
    await settle()
    expect(test.views.at(-1)?.effortPicker?.levels).toEqual([
      { id: 'off', description: 'Use for simple tasks that do not need reasoning.' },
      { id: 'medium', description: 'A balanced choice for everyday tasks.' },
      { id: 'turbo' }, // an unknown id keeps the row blank rather than inventing copy
    ])
    test.handlers.onEffortCancel()
    await pending
    await test.ctx.fiber.dispose()
  })
})
