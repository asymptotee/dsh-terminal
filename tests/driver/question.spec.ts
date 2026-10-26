/**
 * The ask_user_question answerer: the driver registers on the scoped
 * `user-questions/request` waterfall, shows the question batch as an overlay,
 * and resolves the waterfall with the answer the TuiApp's wizard submits.
 * @module dsh-terminal/tests/driver/question
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bench } from '../helpers/bench.ts'

/** Dispatch the `user-questions/request` waterfall and return its outcome,
 *  mirroring the approval test's direct-waterfall trigger. */
function ask(test: Awaited<ReturnType<typeof bench>>, request: unknown): Promise<unknown> {
  return (test.ctx.waterfall as unknown as (
    thisArg: unknown, name: string, req: unknown, next: () => Promise<unknown>,
  ) => Promise<unknown>)(test.ctx, 'user-questions/request', request, () => Promise.resolve({ answers: [] }))
}

describe('ask_user_question answerer', () => {
  it('shows the question batch as an overlay and resolves with the answer', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const outcome = ask(test, {
      agent: test.agent,
      questions: [
        { id: 'q1', question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] },
      ],
    })
    // The overlay mirrors the questions into the terminal's structural shape.
    expect(test.views.at(-1)?.overlay).toEqual({
      kind: 'question',
      questions: [{ id: 'q1', question: 'Pick a color', options: [{ label: 'red' }, { label: 'blue' }] }],
    })
    // The TuiApp's wizard submits the answer; the waterfall resolves with the
    // upstream's mutable batch shape.
    test.handlers.onQuestionAnswer({ answers: [{ id: 'q1', selected: ['blue'] }] })
    expect(await outcome).toEqual({ answers: [{ id: 'q1', selected: ['blue'] }] })
    // The overlay clears once the answer resolves the request.
    expect(test.views.at(-1)?.overlay).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('carries the call id and keeps the plan-review intent', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const outcome = ask(test, {
      agent: test.agent,
      wait: { callId: 'call-7' },
      questions: [
        {
          id: 'q1',
          question: 'Approve the plan?',
          detail: 'the plan markdown',
          header: 'Plan review',
          options: [{ label: 'Approve', description: 'go ahead' }, { label: 'Keep planning' }],
          multiSelect: false,
          // The intent survives the mirror so the view can narrow this to the
          // dedicated plan-review overlay; its callId names the logged
          // exit_plan_mode call whose arguments carry the reviewed plan.
          intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan' },
        },
      ],
    })
    expect(test.views.at(-1)?.overlay).toEqual({
      kind: 'question',
      callId: 'call-7',
      questions: [{
        id: 'q1',
        question: 'Approve the plan?',
        detail: 'the plan markdown',
        header: 'Plan review',
        options: [{ label: 'Approve', description: 'go ahead' }, { label: 'Keep planning' }],
        multiSelect: false,
        intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan' },
      }],
    })
    test.handlers.onQuestionAnswer({ answers: [{ id: 'q1', selected: ['Approve'] }] })
    expect(await outcome).toEqual({ answers: [{ id: 'q1', selected: ['Approve'] }] })
    await test.ctx.fiber.dispose()
  })

  it('carries a free-text custom answer through', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const outcome = ask(test, {
      agent: test.agent,
      questions: [{ id: 'q1', question: 'What is the port?' }],
    })
    test.handlers.onQuestionAnswer({ answers: [{ id: 'q1', selected: [], custom: '8080' }] })
    expect(await outcome).toEqual({ answers: [{ id: 'q1', selected: [], custom: '8080' }] })
    await test.ctx.fiber.dispose()
  })

  it('passes a foreign-session question through unanswered', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const other = test.ctx.sessions.create(SessionId('other-session'))
    const foreignAgent = { session: other } as Agent
    const outcome = ask(test, {
      agent: foreignAgent,
      questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'a' }] }],
    })
    // The next() fallback answers, so no overlay is raised for another agent.
    expect(await outcome).toEqual({ answers: [] })
    expect(test.views.every(v => v === undefined || v.overlay?.kind !== 'question')).toBe(true)
    await test.ctx.fiber.dispose()
  })

  it('answers every question empty when the request is aborted', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const controller = new AbortController()
    const outcome = ask(test, {
      agent: test.agent,
      signal: controller.signal,
      questions: [
        { id: 'q1', question: 'one', options: [{ label: 'a' }] },
        { id: 'q2', question: 'two' },
      ],
    })
    expect(test.views.at(-1)?.overlay?.kind).toBe('question')
    // A cancelled turn aborts the request: the waterfall resolves with an empty
    // answer per question rather than hanging.
    controller.abort()
    expect(await outcome).toEqual({ answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }] })
    expect(test.views.at(-1)?.overlay).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('answers a request that names no agent (unscoped dispatch)', async () => {
    // The service dispatches without an agent for an unscoped ask; the terminal
    // still claims it (its guard only rejects a *different* named agent).
    const test = await bench({ afterPrompt: () => {} })
    const outcome = ask(test, {
      questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'x' }] }],
    })
    expect(test.views.at(-1)?.overlay?.kind).toBe('question')
    test.handlers.onQuestionAnswer({ answers: [{ id: 'q1', selected: ['x'] }] })
    expect(await outcome).toEqual({ answers: [{ id: 'q1', selected: ['x'] }] })
    await test.ctx.fiber.dispose()
  })
})
