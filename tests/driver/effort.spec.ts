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
      execute: vi.fn(async () => undefined),
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
    // Without args it reports the current state (no recorded selection, no
    // adapter default in this bench: the model default).
    expect(await invoke('')).toEqual({ kind: 'success', text: 'Reasoning effort: model default' })
    expect(await invoke(' high ')).toEqual({ kind: 'success', text: 'Reasoning effort set to: high' })
    await settle()
    // The switch is durable (the scripted model appended `model/selection`)
    // and the badge follows the event.
    expect(test.agent.model.current()?.reasoningEffort).toBe('high')
    expect(test.views.at(-1)?.status?.effort).toBe('high')
    expect(await invoke('')).toEqual({ kind: 'success', text: 'Reasoning effort: high' })
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
    // The resolved adapter default seeds both the report and the badge.
    expect(await invoke('')).toEqual({ kind: 'success', text: 'Reasoning effort: low · available: low · high' })
    expect(test.views.at(-1)?.status?.effort).toBe('low')
    // An unknown level is rejected without touching the selection.
    expect(await invoke('ultra')).toEqual({ kind: 'error', text: 'Unknown effort: ultra · available: low · high' })
    expect(test.agent.model.current()?.reasoningEffort).toBeUndefined()
    expect(test.views.at(-1)?.status?.effort).toBe('low')
    await test.ctx.fiber.dispose()
  })
})

describe('effort picker', () => {
  function llmFake(efforts: readonly { id: string; description?: string }[]) {
    return { resolveModelInfo: async () => ({ reasoning: { efforts } }) }
  }

  it('a bare /effort opens the picker instead of running the registry', async () => {
    const commands = commandsFake()
    const test = await bench({
      commands: commands.service,
      llm: llmFake([{ id: 'low', description: 'Fast and light' }, { id: 'high', description: 'Deep and slow' }]),
      afterPrompt: () => {},
    })
    test.handlers.onCommit('/effort')
    await settle()
    expect(commands.service.execute).not.toHaveBeenCalled()
    const picker = test.views.at(-1)?.effortPicker
    expect(picker).toBeDefined()
    expect(picker?.levels).toEqual([
      { id: 'low', description: 'Fast and light' },
      { id: 'high', description: 'Deep and slow' },
    ])
    expect(picker?.selected).toBe(0)
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
    // The transcript keeps its own account of the switch.
    expect(test.states.at(-1)!.frames.at(-1)).toMatchObject({
      kind: 'notice',
      summary: 'Reasoning effort set to: high',
    })
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
    expect(test.views.at(-1)?.effortPicker).toBeDefined()
    test.handlers.onEffortCancel()
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    expect(test.agent.model.current()?.reasoningEffort).toBeUndefined()
    test.handlers.onCommit('/effort high')
    await settle()
    expect(commands.service.execute).toHaveBeenCalledTimes(1)
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('reports a missing disclosure as a warn notice instead of opening', async () => {
    const test = await bench({ afterPrompt: () => {} })
    test.handlers.onCommit('/effort')
    await settle()
    expect(test.views.at(-1)?.effortPicker).toBeUndefined()
    expect(test.states.at(-1)!.frames.at(-1)).toMatchObject({
      kind: 'notice',
      summary: 'No effort levels disclosed for this model',
      tone: 'warn',
    })
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
    expect(test.views.at(-1)?.effortPicker?.levels).toEqual([
      { id: 'off', description: 'Use for simple tasks that do not need reasoning.' },
      { id: 'medium', description: 'A balanced choice for everyday tasks.' },
      { id: 'turbo' }, // an unknown id keeps the row blank rather than inventing copy
    ])
    await test.ctx.fiber.dispose()
  })
})
