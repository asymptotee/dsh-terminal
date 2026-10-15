/** The goal strip: fused state word, round progress, and the completion linger. */

import { describe, expect, it } from 'vitest'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { GoalPanelInfo } from '../../src/view/renderer.tsx'
import type { Frame, FrameState } from '../../src/fold/frames.ts'
import { noopHandlers, renderApp, settled, state } from '../helpers/render.tsx'

describe('goal strip', () => {
  const goal = (over?: Partial<GoalPanelInfo>): GoalPanelInfo => ({
    objective: '把整个测试套件跑通并修复失败用例',
    phase: 'active',
    roundsStarted: 3,
    maxGoalRounds: 10,
    activation: 'armed',
    ...over,
  })

  it('renders the header, round progress, and objective', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ goal: goal() }} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Goal · ongoing ◼ · round 3/10')
    // The objective rides the `⎿` connector, five columns in, dimmed.
    expect(frame).toContain('⎿')
    expect(frame).toContain('把整个测试套件跑通并修复失败用例')
  })

  it('fuses the activation into the state word, never showing the raw switch', () => {
    const rows = (info: GoalPanelInfo): string =>
      (renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ goal: info }} />).lastFrame() ?? '')
        .split('\n').find(row => row.includes('Goal ·')) ?? ''
    // An active goal reads ongoing only while armed; disarmed it is inactive —
    // the web client's fusion of phase and the continuation switch. Each state
    // word trails its task-board glyph.
    expect(rows(goal({ phase: 'active', activation: 'armed' }))).toContain('Goal · ongoing ◼')
    expect(rows(goal({ phase: 'active', activation: 'disarmed' }))).toContain('Goal · inactive ⊘')
    expect(rows(goal({ phase: 'paused' }))).toContain('Goal · paused ⊘')
    expect(rows(goal({ phase: 'complete' }))).toContain('Goal · complete ✔')
    expect(rows(goal({ phase: 'blocked', blockedReason: { code: 'round-limit', message: 'no rounds left' } }))).toContain('Goal · blocked ✘')
    // The raw armed/disarmed jargon never reaches the screen.
    expect(rows(goal({ phase: 'active', activation: 'armed' }))).not.toContain('armed')
  })

  it('shows the blocked reason on its own row', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ goal: goal({ phase: 'blocked', activation: 'disarmed', blockedReason: { code: 'round-limit', message: 'Goal reached its limit.' } }) }}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Goal · blocked ✘ · round 3/10')
    expect(frame).toContain('round-limit: Goal reached its limit.')
    // A non-blocked goal carries no reason row.
    const clean = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ goal: goal({ phase: 'active' }) }} />)
    expect(clean.lastFrame() ?? '').not.toContain('round-limit')
  })

  it('lingers on completion then hides, and cancels the hide for a new phase', async () => {
    const app = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} completedLingerMs={40} view={{ goal: goal({ phase: 'complete' }) }} />)
    await settled(10)
    expect(app.lastFrame() ?? '').toContain('Goal · complete')
    await settled(80)
    expect(app.lastFrame() ?? '').not.toContain('Goal · complete')
    // A new active goal flips goalComplete and cancels the hide.
    app.rerender(<TuiApp state={state([])} handlers={noopHandlers()} completedLingerMs={40} view={{ goal: goal({ phase: 'active' }) }} />)
    await settled()
    expect(app.lastFrame() ?? '').toContain('Goal · ongoing')
  })

  it('renders below the heartbeat and hides while absent or under an approval', () => {
    const plan = [{ content: 'task one', status: 'in_progress' as const }]
    // A live turn clocks the heartbeat; the goal strip sits directly below
    // it, above the plan.
    const working: FrameState = { ...state([], plan), turnStartedAt: Date.now() }
    const { lastFrame } = renderApp(<TuiApp state={working} handlers={noopHandlers()} view={{ goal: goal() }} />)
    const frame = lastFrame() ?? ''
    expect(frame.indexOf('Working…')).toBeLessThan(frame.indexOf('Goal · ongoing'))
    // The goal strip leads the pinned chrome, above the plan.
    expect(frame.indexOf('Goal · ongoing')).toBeLessThan(frame.indexOf('Todos · 1'))
    // No goal in the view: nothing renders.
    const bare = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(bare.lastFrame() ?? '').not.toContain('Goal ·')
    // An approval question replaces the side panels below the input bar, but
    // the goal strip (like the plan) is pinned chrome above it and stays.
    const approval = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ goal: goal(), overlay: { kind: 'approval', toolName: 'bash', reason: 'run rm -rf' } }}
    />)
    expect(approval.lastFrame() ?? '').toContain('Goal · ongoing')
  })

  it('follows the main session, not the opened child transcript', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ goal: goal(), openSubagent: { childId: 'c-1', label: 'm', state: childState } }}
    />)
    // The goal is the session-level objective: it stays up over a child view.
    expect(lastFrame() ?? '').toContain('Goal · ongoing ◼ · round 3/10')
  })
})

