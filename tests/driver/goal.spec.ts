/** The driver's goal strip: the goal projection read, its refresh triggers, and the activation bus. */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { bench } from '../helpers/bench.ts'

describe('goal strip', () => {
  // The goal's durable half rides the `goal` session projection, so the driver
  // reads it through the mocked stateOf exactly as it reads agentTeam; the
  // events below only *trigger* a re-read, they do not carry the goal payload.
  // A goal/change event type is not merged into the test program (the merge
  // lives in the package root), so appends go through a structural cast.
  function appendRaw(session: Session, type: string, data: unknown, third?: unknown): void {
    const append = session.append as unknown as (type: string, data: unknown, third?: unknown) => void
    append.call(session, type, data, third)
  }
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  /** The projection cell for `stateOf(session, 'goal')`: a whole-value current
   *  goal, or null before create / after clear. */
  type GoalCell = { current: GoalProjectionLike | null; seenGoalIds: unknown[]; failure: null }
  type GoalProjectionLike = {
    goal: { id: string; revision: number; objective: string; phase: string; maxGoalRounds: number; blockedReason?: { code: string; message: string } }
    roundsStarted: number
    createdAt: number
    updatedAt: number
  }
  function projectionsFor(cell: { value: GoalCell | undefined }): unknown {
    return {
      stateOf: (_session: unknown, key: string) => key === 'goal' ? cell.value : undefined,
    }
  }
  const activeCell = (roundsStarted = 0, over?: Partial<GoalProjectionLike['goal']>): GoalCell => ({
    current: {
      goal: { id: 'goal-1', revision: 1, objective: '把测试套件跑通', phase: 'active', maxGoalRounds: 10, ...over },
      roundsStarted,
      createdAt: 1,
      updatedAt: 1,
    },
    seenGoalIds: ['goal-1'],
    failure: null,
  })

  it('surfaces the standing goal from the projection, disarmed by default', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    const goal = test.views.at(-1)?.goal
    expect(goal).toBeDefined()
    expect(goal?.objective).toBe('把测试套件跑通')
    expect(goal?.phase).toBe('active')
    expect(goal?.roundsStarted).toBe(0)
    expect(goal?.maxGoalRounds).toBe(10)
    // Resume/fork semantics: the switch starts disarmed until the bus says otherwise.
    expect(goal?.activation).toBe('disarmed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('re-reads the goal on a goal/ prefix event', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.goal?.phase).toBe('active')
    // Flip the durable projection to paused, then fire the event that makes the
    // driver re-read it; the payload is irrelevant (the mock is the source).
    cell.value = activeCell(0, { phase: 'paused' })
    appendRaw(test.agent.session, 'goal/change', { kind: 'goal/change', version: 1, operation: 'pause' })
    await settle()
    expect(test.views.at(-1)?.goal?.phase).toBe('paused')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('advances the round counter on a goal-sourced user/message', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.goal?.roundsStarted).toBe(0)
    // The projection folds the round from the admitted goal-round message, not
    // from goal/change — so this trigger (not the prefix) moves round N/M.
    cell.value = activeCell(3)
    // A goal-round user/message is surface-eligible (the model must see the
    // continuation prompt), so the append carries the surfaceOp marker; the
    // terminal still drops it because frames.ts ignores non-user sources.
    appendRaw(test.agent.session, 'user/message', {
      id: 'msg-goal-3',
      content: [{ type: 'text', text: '<goal_round>…</goal_round>' }],
      source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 3 },
    }, { surfaceOp: 'append' })
    await settle()
    expect(test.views.at(-1)?.goal?.roundsStarted).toBe(3)
    // The round prompt never enters the transcript (frames.ts drops non-user sources).
    expect(test.states.at(-1)?.frames.every(frame => frame.kind !== 'user')).toBe(true)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('carries a blocked reason and hides the strip once cleared', async () => {
    const cell = { value: activeCell(5, { phase: 'blocked', blockedReason: { code: 'round-limit', message: 'Goal reached its configured limit of 10 rounds.' } }) as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    const blocked = test.views.at(-1)?.goal
    expect(blocked?.phase).toBe('blocked')
    expect(blocked?.blockedReason).toEqual({ code: 'round-limit', message: 'Goal reached its configured limit of 10 rounds.' })
    // Clearing the goal (projection current -> null) drops the strip.
    cell.value = { current: null, seenGoalIds: ['goal-1'], failure: null }
    appendRaw(test.agent.session, 'goal/change', { kind: 'goal/change', version: 1, operation: 'clear' })
    await settle()
    expect(test.views.at(-1)?.goal).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('flips armed/disarmed on the activation bus for the owned session only', async () => {
    const cell = { value: activeCell() as GoalCell | undefined }
    const test = await bench({ sessionProjections: projectionsFor(cell), afterPrompt: () => {} })
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('disarmed')
    // An activation edge for another session must not touch this strip.
    test.ctx.emit('goal/activation-changed', { sessionId: SessionId('someone-else'), goal: { id: 'goal-1', revision: 1, activation: 'armed' } } as never)
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('disarmed')
    // The owned session's edge flips it.
    test.ctx.emit('goal/activation-changed', { sessionId: test.agent.session.id, goal: { id: 'goal-1', revision: 1, activation: 'armed' } } as never)
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('armed')
    // A cleared goal (no `goal` field) reports disarmed.
    test.ctx.emit('goal/activation-changed', { sessionId: test.agent.session.id } as never)
    await settle()
    expect(test.views.at(-1)?.goal?.activation).toBe('disarmed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('shows a resumed session goal disarmed on first paint', async () => {
    const cell = { value: activeCell(2) as GoalCell | undefined }
    const test = await bench({
      resumeId: SessionId('resumed-goal'),
      sessionProjections: projectionsFor(cell),
      seed: (session) => {
        appendRaw(session, 'goal/change', { kind: 'goal/change', version: 1, operation: 'create' })
      },
      afterPrompt: () => {},
    })
    // Seeded before the live bus: the strip shows the objective and rounds,
    // disarmed, with no activation event ever arriving.
    const goal = test.views.at(-1)?.goal
    expect(goal?.objective).toBe('把测试套件跑通')
    expect(goal?.roundsStarted).toBe(2)
    expect(goal?.activation).toBe('disarmed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })
})

