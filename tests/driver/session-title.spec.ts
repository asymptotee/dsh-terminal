/** The input box's session-title label: the `title` projection read, its
 *  resume seed, and the `session/title` trigger that refreshes it. */

import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { bench } from '../helpers/bench.ts'

describe('session title label', () => {
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  /** The projection cell for `stateOf(session, 'title')`: the folded last-wins
   *  title text, or null before any title lands. */
  function projectionsFor(cell: { value: string | null }): unknown {
    return {
      stateOf: (_session: unknown, key: string) => key === 'title' ? cell.value : undefined,
    }
  }
  function appendRaw(session: Session, type: string, data: unknown, third?: unknown): void {
    const append = session.append as unknown as (type: string, data: unknown, third?: unknown) => void
    append.call(session, type, data, third)
  }

  it('carries a seeded title into the first frame', async () => {
    // A resumed session's title event was folded by the replay above; the
    // label is present before any new event arrives.
    const cell = { value: 'dsh-terminal工程' }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.status?.title).toBe('dsh-terminal工程')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('leaves no label before the first title', async () => {
    const cell: { value: string | null } = { value: null }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.status?.title).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('re-reads the projection on a session/title event', async () => {
    const cell: { value: string | null } = { value: null }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.status?.title).toBeUndefined()
    // `/rename` appends the durable title event; the projection folds it into
    // the title text, and the driver re-reads through the event trigger.
    cell.value = 'renamed session'
    appendRaw(test.agent.session, 'session/title', {
      title: 'renamed session',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    await settle()
    expect(test.views.at(-1)?.status?.title).toBe('renamed session')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })
})