/** The driver's workflow fold: durable tool-workflow events into the run → phase → member projection. */

import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { SUBAGENT_FADE_MS } from '../../src/index.ts'
import { bench } from '../helpers/bench.ts'

describe('workflow panel', () => {
  // tool-workflow durable events carry a branded WorkflowRunId this suite
  // cannot mint without importing the workflow package; appends go through a
  // structural cast (the sandbox/mode precedent). The driver-side merge is
  // proven by `pnpm typecheck` compiling src/index.ts's switch, not here.
  function appendRaw(session: Session, type: string, data: unknown): void {
    const append = session.append as unknown as (type: string, data: unknown) => void
    append.call(session, type, data)
  }
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
  const wfStart = (session: Session, id: string, name: string): void =>
    appendRaw(session, 'tool-workflow/run-start', { runId: id, name })
  const wfAgent = (session: Session, id: string, seq: number, label: string, childId: string, phase?: string): void =>
    appendRaw(session, 'tool-workflow/agent-start', { runId: id, seq, label, ...(phase === undefined ? {} : { phase }), childId })
  const wfEnd = (session: Session, id: string, seq: number, outcome: string): void =>
    appendRaw(session, 'tool-workflow/agent-end', { runId: id, seq, outcome })
  const wfRunEnd = (session: Session, id: string, stopReason: string): void =>
    appendRaw(session, 'tool-workflow/run-end', { runId: id, stopReason })

  /** One direct child session with a single tool event, so its fold entry exists. */
  function wfChild(test: Awaited<ReturnType<typeof bench>>, childId: string): Session {
    const child = test.ctx.sessions.create(SessionId(childId), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`cc-${childId}`), name: 'grep', arguments: '{}' })
    return child
  }

  it('folds durable workflow events into the panel projection', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    wfStart(main, 'wf-1', 'release-check')
    wfAgent(main, 'wf-1', 1, 'audit deps', 'wf-child-1')
    wfAgent(main, 'wf-1', 2, 'run tests', 'wf-child-2', '验证')
    await settle()
    const workflow = test.views.at(-1)?.workflow
    expect(workflow?.memberCount).toBe(2)
    expect(workflow?.runs[0]).toMatchObject({ id: 'wf-1', name: 'release-check', status: 'running' })
    // Phases group in first-appearance order; the unphased group keeps its
    // collision-free key and no phase header value.
    expect(workflow?.runs[0]?.phases.map(phase => phase.key)).toEqual(['missing', 'value:2:验证'])
    expect(workflow?.runs[0]?.phases[0]?.phase).toBeUndefined()
    expect(workflow?.runs[0]?.phases[0]?.members[0]).toMatchObject({ seq: 1, label: 'audit deps', childId: 'wf-child-1', status: 'running' })
    expect(workflow?.runs[0]?.phases[1]?.members[0]).toMatchObject({ seq: 2, label: 'run tests', status: 'running' })
    // Outcomes and the stop reason settle member and run status.
    wfEnd(main, 'wf-1', 1, 'failed')
    wfRunEnd(main, 'wf-1', 'error')
    await settle()
    const settledRun = test.views.at(-1)?.workflow?.runs[0]
    expect(settledRun?.status).toBe('failed')
    expect(settledRun?.phases[0]?.members[0]?.status).toBe('failed')
    // An orphan agent-end (a failed start consumed the seq) is ignored.
    wfEnd(main, 'wf-1', 99, 'completed')
    await settle()
    expect(test.views.at(-1)?.workflow?.memberCount).toBe(2)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('excludes workflow members from the roster and backfills their labels', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    const child = wfChild(test, 'wf-child-1')
    await settle()
    // Before the workflow record arrives the child is an ordinary roster row
    // with the id-fallback label.
    expect(test.views.at(-1)?.subagents?.map(row => row.childId)).toContain('wf-child-1')
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'audit deps', 'wf-child-1')
    await settle()
    // The member leaves the roster (the workflow panel owns it now) and the
    // backfilled label reaches the child view through the fold entry.
    expect(test.views.at(-1)?.subagents ?? []).toEqual([])
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent).toMatchObject({ childId: 'wf-child-1', label: 'audit deps' })
    expect(child.header.id).toBe('wf-child-1')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('navigates the workflow panel and walks the Esc ladder', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    wfChild(test, 'wf-child-1')
    wfChild(test, 'wf-child-2')
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
    wfAgent(main, 'wf-1', 2, 'two', 'wf-child-2')
    await settle()
    test.handlers.onPanelOpen()
    // The workflow panel takes navigation: members only, 1-based.
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.workflowSelected).toBe(2)
    // The selection clamps at the last member.
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.workflowSelected).toBe(2)
    test.handlers.onPanelMove(-1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-1')
    expect(test.views.at(-1)?.panelNav).toBe(true)
    // Esc lands on the main input in one press: the child closes and the
    // cursor goes with it.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    expect(test.views.at(-1)?.workflowSelected).toBeUndefined()
    // ↑ at the first member leaves the panel where ↓ found it.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.workflowSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps navigation when ↑ reaches the first member over a read-only child', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const main = test.agent.session
    wfChild(test, 'wf-child-1')
    wfChild(test, 'wf-child-2')
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
    wfAgent(main, 'wf-1', 2, 'two', 'wf-child-2')
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-2')
    expect(test.views.at(-1)?.workflowSelected).toBe(2)
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    // ↑ at the first member is a no-op over a read-only child: there is no
    // editor to hand the keys to, so the screen must not change.
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.workflowSelected).toBe(1)
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-2')
    expect(test.views.at(-1)?.panelNav).toBe(true)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('prefers the team panel over the workflow panel for navigation', async () => {
    const test = await bench({
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? { members: [{ id: 'm-1', name: 'product-manager', description: 'd', phase: 'active' }], tasks: [] }
          : undefined,
      },
      afterPrompt: () => {},
    })
    const main = test.agent.session
    wfStart(main, 'wf-1', 'audit')
    wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
    await settle()
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.teamSelected).toBe(0)
    expect(test.views.at(-1)?.workflowSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('surfaces the task board when a lead has tasks but no members yet', async () => {
    // The old guard blanked teamBase whenever members were empty, hiding the
    // tasks a lead had just written (team_task_create precedes spawn). The
    // panel must stay up on tasks alone.
    const test = await bench({
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? {
            members: [],
            tasks: [{
              id: 'task-1',
              revision: 1,
              subject: '实现 math_utils.py 工具库',
              description: '',
              status: 'pending',
              blockedBy: [],
              writeScopes: [],
            }],
          }
          : undefined,
      },
      afterPrompt: () => {},
    })
    await settle()
    const team = test.views.at(-1)?.team
    expect(team).toBeDefined()
    expect(team?.members).toHaveLength(0)
    expect(team?.tasks).toHaveLength(1)
    expect(team?.tasks[0]?.subject).toBe('实现 math_utils.py 工具库')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('derives interrupted on resume and flips to running on live events', async () => {
    const test = await bench({
      resumeId: SessionId('resumed-session'),
      seed: (session) => {
        wfStart(session, 'wf-old', 'old-run')
        wfAgent(session, 'wf-old', 1, 'stale member', 'wf-child-9')
      },
      afterPrompt: () => {},
    })
    // The replayed run never saw run-end and no live event yet: interrupted.
    const workflow = test.views.at(-1)?.workflow
    expect(workflow?.runs[0]?.status).toBe('interrupted')
    expect(workflow?.runs[0]?.phases[0]?.members[0]?.status).toBe('interrupted')
    // A live event for the same run proves it is still running.
    wfEnd(test.agent.session, 'wf-old', 1, 'completed')
    await settle()
    const live = test.views.at(-1)?.workflow
    expect(live?.runs[0]?.status).toBe('running')
    expect(live?.runs[0]?.phases[0]?.members[0]?.status).toBe('completed')
    wfRunEnd(test.agent.session, 'wf-old', 'completed')
    await settle()
    expect(test.views.at(-1)?.workflow?.runs[0]?.status).toBe('completed')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps workflow members out of the fade removal', async () => {
    vi.useFakeTimers()
    try {
      const test = await bench({ afterPrompt: () => {} })
      const main = test.agent.session
      wfChild(test, 'wf-child-1')
      wfStart(main, 'wf-1', 'audit')
      wfAgent(main, 'wf-1', 1, 'one', 'wf-child-1')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000 + SUBAGENT_FADE_MS)
      // The member's transcript survives the fade for the panel's Enter.
      test.handlers.onPanelOpen()
      test.handlers.onPanelMove(1)
      test.handlers.onPanelEnter()
      expect(test.views.at(-1)?.openSubagent?.childId).toBe('wf-child-1')
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

