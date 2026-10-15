/** The workflow panel: run → phase → member tree, windowing, and the linger latch. */

import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { RenderView, StatusInfo, SubagentRow, WorkflowMemberRow, WorkflowMemberStatus, WorkflowRunRow } from '../../src/view/renderer.tsx'
import type { Frame } from '../../src/fold/frames.ts'
import { noopHandlers, renderApp, settled, state } from '../helpers/render.tsx'

describe('workflow panel', () => {
  const member = (seq: number, label: string, childId: string, status: WorkflowMemberStatus, extra?: Partial<WorkflowMemberRow>): WorkflowMemberRow =>
    ({ seq, label, childId, status, ...extra })
  const runView = (runs: readonly WorkflowRunRow[], extra?: Partial<RenderView>): RenderView => ({
    workflow: {
      runs,
      memberCount: runs.reduce((count, run) => count + run.phases.reduce((n, phase) => n + phase.members.length, 0), 0),
    },
    ...extra,
  })

  it('renders the run header, phase headers, and member rows', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([{
        id: 'wf-1',
        name: '发布流程',
        status: 'running',
        phases: [
          { key: 'value:2:调研', phase: '调研', members: [member(1, 'deps-audit', 'c-1', 'completed')] },
          { key: 'missing', members: [member(2, 'no-phase', 'c-2', 'running')] },
        ],
      }])}
    />)
    const frame = lastFrame() ?? ''
    // The header carries the workflow mark, the model-chosen run name in
    // parentheses, and the member count.
    expect(frame).toContain('Workflow (发布流程) · 2 成员')
    expect(frame).toContain('调研 · 1')
    expect(frame).toContain('deps-audit')
    expect(frame).toContain('no-phase')
    // A lone run carries no ordinal — the number only disambiguates
    // colliding run names.
    expect(frame).not.toContain('#1')
    // The hierarchy steps: run header at 2 (aligned with the main row's
    // marker), phase title at 4, member cursor at 6 — the member row nests
    // under its phase header.
    const rows = frame.split('\n')
    const memberRow = rows.find(row => row.includes('deps-audit')) ?? ''
    expect(memberRow.startsWith('      ')).toBe(true)
    const phaseRow = rows.find(row => row.includes('调研 · 1')) ?? ''
    expect(phaseRow.startsWith('    调研')).toBe(true)
    const runRow = rows.find(row => row.includes('Workflow (发布流程)')) ?? ''
    expect(runRow.startsWith('  Workflow')).toBe(true)
  })

  it('marks member statuses with the task-board glyph vocabulary', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([{
        id: 'wf-1',
        name: 'r',
        status: 'running',
        phases: [{
          key: 'missing',
          members: [
            member(1, 'm-done', 'c-1', 'completed'),
            member(2, 'm-fail', 'c-2', 'failed'),
            member(3, 'm-cancel', 'c-3', 'cancelled'),
            member(4, 'm-run', 'c-4', 'running'),
          ],
        }],
      }])}
    />)
    // Colors are stripped by renderApp, so rows are located by label; the
    // cancelled/interrupted pair shares the ⊘ glyph and differs only by color.
    const rows = (lastFrame() ?? '').split('\n')
    const rowOf = (label: string): string => rows.find(row => row.includes(label)) ?? ''
    expect(rowOf('m-done')).toContain('✔')
    expect(rowOf('m-fail')).toContain('✘')
    expect(rowOf('m-cancel')).toContain('⊘')
    // The running member wears the task board's light-blue in-progress square.
    expect(rowOf('m-run')).toContain('◼')
  })

  it('shows a resident member with activity, elapsed, and tokens on one row', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([{
        id: 'wf-1',
        name: 'r',
        status: 'running',
        phases: [{
          key: 'missing',
          members: [member(1, 'worker', 'c-1', 'running', {
            activity: 'grep(pattern)',
            startedAt: Date.now() - 86_000,
            inputTokens: 11_100,
          })],
        }],
      }])}
    />)
    const row = (lastFrame() ?? '').split('\n').find(r => r.includes('worker')) ?? ''
    expect(row).toContain('1m 26s')
    expect(row).toContain('↓ 11.1k tokens')
    expect(row).toContain('grep(pattern)')
  })

  it('moves the ❯ cursor with the selection and pins ● on the open member', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([{
        id: 'wf-1',
        name: 'r',
        status: 'running',
        phases: [{ key: 'missing', members: [
          member(1, 'first-member', 'c-1', 'running'),
          member(2, 'second-member', 'c-2', 'running'),
        ] }],
      }], {
        workflowSelected: 1,
        openSubagent: { childId: 'c-2', label: 'second-member', state: childState },
      })}
    />)
    // The child view stays open while the panel keeps its rows and the cursor.
    const rows = (lastFrame() ?? '').split('\n')
    // Exclude the read-only child's identity header: it names the open member too.
    const rowOf = (label: string): string => rows.find(row => row.includes(label) && !row.includes('subagent:')) ?? ''
    expect(rowOf('first-member')).toContain('❯')
    expect(rowOf('second-member')).toContain('●')
  })

  it('windows member rows head-anchored and follows the selection', () => {
    const members = Array.from({ length: 12 }, (_, i) =>
      member(i + 1, `member-${String(i + 1).padStart(2, '0')}`, `c-${i + 1}`, 'running'))
    const run: WorkflowRunRow = { id: 'wf-1', name: 'big', status: 'running', phases: [{ key: 'missing', members }] }
    // Unselected (reading from the top): head-anchored — the earliest members
    // lead and the trailing hint elides the tail.
    const unselected = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={runView([run])} />)
    const frame = unselected.lastFrame() ?? ''
    expect(frame).toContain('… 5 more')
    expect(frame).toContain('member-01')
    expect(frame).not.toContain('member-12')
    // The run header stays pinned above the window no matter the scroll.
    expect(frame).toContain('Workflow (big) · 12 成员')
    // Selecting an early member centers the window around it.
    const selected = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={runView([run], { workflowSelected: 2 })} />)
    const frame2 = selected.lastFrame() ?? ''
    expect(frame2).toContain('member-02')
    expect(frame2).toContain('Workflow (big) · 12 成员')
    expect(frame2).not.toContain('member-12')
  })

  it('keeps a phase header visible while any of its members is in the window', () => {
    const phased: WorkflowRunRow = {
      id: 'wf-1',
      name: 'phased',
      status: 'running',
      phases: [
        { key: 'value:1:A', phase: 'PhaseA', members: Array.from({ length: 4 }, (_, i) => member(i + 1, `a-${i + 1}`, `ca-${i + 1}`, 'completed')) },
        { key: 'value:1:B', phase: 'PhaseB', members: Array.from({ length: 6 }, (_, i) => member(i + 5, `b-${i + 1}`, `cb-${i + 1}`, 'running')) },
      ],
    }
    // Ten members, a seven-row window, head-anchored: a-1..a-4 and b-1..b-3
    // lead, the PhaseB header stays while any of its members is visible, and
    // the trailing hint elides b-4..b-6.
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={runView([phased])} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('… 3 more')
    expect(frame).toContain('a-1')
    expect(frame).toContain('a-4')
    expect(frame).not.toContain('b-4')
    expect(frame).toContain('PhaseA · 4')
    expect(frame).toContain('PhaseB · 6')
    // The trailing hint lands below the last visible member, aligned with the
    // member marker column.
    const rows = frame.split('\n')
    const hintIdx = rows.findIndex(row => row.includes('… 3 more'))
    const memberIdx = rows.findIndex(row => row.includes('b-3'))
    expect(hintIdx).toBeGreaterThan(memberIdx)
    expect(rows[hintIdx]?.startsWith('        …')).toBe(true)
  })

  it('keeps the session status footer while a read-only member view is open', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([{
        id: 'wf-1',
        name: 'r',
        status: 'running',
        phases: [{ key: 'missing', members: [member(1, 'm', 'c-1', 'running')] }],
      }], {
        openSubagent: { childId: 'c-1', label: 'm', state: childState },
        status: {
          model: 'test-model',
          cwd: '/workspace/repo',
          mode: 'workspace-write',
          effort: 'high',
          context: { used: 12_000, window: 1_000_000 },
        },
      })}
    />)
    const frame = lastFrame() ?? ''
    // The read-only member view's box shows the dim note instead of a
    // caret — it takes no keys — while the standing footer facts stay:
    // same model/cwd/context/effort/permission row the main view shows.
    expect(frame).toContain('当前子代理不接受新消息')
    expect(frame).not.toContain('█')
    expect(frame).toContain('test-model · /workspace/repo · context: 12k/1000k (1%)')
    expect(frame).toContain('● effort: high')
    expect(frame).toContain('workspace-write')
  })

  it('trails the workflow key hints after the permission row, in the child view too', () => {
    const status: StatusInfo = { model: 'test-model', cwd: '/workspace/repo', mode: 'workspace-write' }
    const run: WorkflowRunRow = { id: 'wf-1', name: 'r', status: 'running', phases: [{ key: 'missing', members: [member(1, 'm', 'c-1', 'running')] }] }
    // Main view under workflow navigation: the hint rides the permission row.
    const main = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={runView([run], { workflowSelected: 1, status })} />)
    const frame = main.lastFrame() ?? ''
    expect(frame).toContain('workspace-write · (↑↓ 选择 · Enter 打开 · Esc 返回)')
    // The run header stays clean — the hints no longer live up there.
    expect(frame).toContain('Workflow (r) · 1 成员')
    const headerRow = frame.split('\n').find(row => row.includes('Workflow (r)')) ?? ''
    expect(headerRow).not.toContain('选择')
    // The read-only member view keeps the same footer hint.
    const child = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([run], {
        workflowSelected: 1,
        openSubagent: { childId: 'c-1', label: 'm', state: state([{ kind: 'user', seq: 1, text: 'x' }]) },
        status,
      })}
    />)
    expect(child.lastFrame() ?? '').toContain('workspace-write · (↑↓ 选择 · Enter 打开 · Esc 返回)')
    // Without workflow navigation the footer carries no hint.
    const idle = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={runView([run], { status })} />)
    expect(idle.lastFrame() ?? '').not.toContain('Esc 返回')
  })

  it('numbers only colliding run names, leading the number before the name', () => {
    const mk = (id: string, name: string): WorkflowRunRow =>
      ({ id, name, status: 'running', phases: [{ key: 'missing', members: [member(1, `${id}-m`, `c-${id}`, 'running')] }] })
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([mk('wf-a', 'solo'), mk('wf-b', 'demo'), mk('wf-c', 'demo')])}
    />)
    const frame = lastFrame() ?? ''
    // The unique name stays clean; the colliding pair numbers within its
    // group, counting occurrences in projection order.
    expect(frame).toContain('Workflow (solo) · 1 成员')
    expect(frame).toContain('Workflow #1 (demo) · 1 成员')
    expect(frame).toContain('Workflow #2 (demo) · 1 成员')
    // The number leads the parenthesized name.
    expect(frame).toContain('#1 (demo)')
    expect(frame).toContain('#2 (demo)')
  })

  it('keeps each run header above its own content and drops fully elided runs', () => {
    const mk = (prefix: string, count: number, offset: number, status: WorkflowMemberStatus): WorkflowMemberRow[] =>
      Array.from({ length: count }, (_, i) => member(offset + i + 1, `${prefix}-${i + 1}`, `c${prefix}-${i}`, status))
    // Both runs share a name so the colliding pair carries #1/#2 ordinals.
    const runA: WorkflowRunRow = { id: 'wf-a', name: 'demo', status: 'completed', phases: [{ key: 'missing', members: mk('a', 4, 0, 'completed') }] }
    const runB: WorkflowRunRow = { id: 'wf-b', name: 'demo', status: 'running', phases: [{ key: 'missing', members: mk('b', 6, 4, 'running') }] }
    // Ten members, a six-row window (8 − 2 run headers), head-anchored: run-a
    // fully visible, run-b partially — each header sits above its own rows.
    const both = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={runView([runA, runB])} />)
    const frame = both.lastFrame() ?? ''
    const rows = frame.split('\n')
    const idx = (text: string): number => rows.findIndex(row => row.includes(text))
    // Each ordinal header sits above its own members.
    expect(idx('#1')).toBeLessThan(idx('a-1'))
    expect(idx('a-4')).toBeLessThan(idx('#2'))
    expect(idx('#2')).toBeLessThan(idx('b-1'))
    expect(frame).not.toContain('b-3')
    expect(frame).toContain('… 4 more')
    expect(frame).toContain('#1')
    expect(frame).toContain('#2')
    // Selecting deep into run-b scrolls run-a out entirely: its header drops
    // with its members (the same sticky rule as phase headers).
    const runB8: WorkflowRunRow = { id: 'wf-b', name: 'demo', status: 'running', phases: [{ key: 'missing', members: mk('b', 8, 4, 'running') }] }
    const deep = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={runView([runA, runB8], { workflowSelected: 12 })} />)
    const frame2 = deep.lastFrame() ?? ''
    expect(frame2).not.toContain('a-1')
    expect(frame2).not.toContain('#1')
    expect(frame2).toContain('#2')
    expect(frame2).toContain('b-3')
    expect(frame2).not.toContain('b-1')
    expect(frame2).toContain('… 6 more')
  })

  it('hides the settled panel after the linger and cancels the hide for a new run', async () => {
    const settledRun: WorkflowRunRow = {
      id: 'wf-1',
      name: 'done-run',
      status: 'completed',
      phases: [{ key: 'missing', members: [member(1, 'm', 'c-1', 'completed')] }],
    }
    const app = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} completedLingerMs={40} view={runView([settledRun])} />)
    await settled(10)
    expect(app.lastFrame() ?? '').toContain('Workflow (done-run) · 1 成员')
    await settled(80)
    expect(app.lastFrame() ?? '').not.toContain('Workflow (done-run) · 1 成员')
    // A new running run flips allSettled and cancels the hide.
    app.rerender(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      completedLingerMs={40}
      view={runView([{ id: 'wf-2', name: 'new-run', status: 'running', phases: [{ key: 'missing', members: [member(1, 'm2', 'c-2', 'running')] }] }])}
    />)
    await settled()
    expect(app.lastFrame() ?? '').toContain('Workflow (new-run) · 1 成员')
  })

  it('keeps the settled panel visible while the cursor is held', async () => {
    const settledRun: WorkflowRunRow = {
      id: 'wf-1',
      name: 'done-run',
      status: 'completed',
      phases: [{ key: 'missing', members: [member(1, 'm', 'c-1', 'completed')] }],
    }
    const app = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      completedLingerMs={40}
      view={runView([settledRun], { workflowSelected: 1 })}
    />)
    await settled(80)
    // Past the linger, but the held cursor suppresses the hide.
    expect(app.lastFrame() ?? '').toContain('Workflow (done-run) · 1 成员')
  })

  it('hides the input caret while the workflow panel holds focus', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={runView([{
        id: 'wf-1',
        name: 'r',
        status: 'running',
        phases: [{ key: 'missing', members: [member(1, 'm', 'c-1', 'running')] }],
      }], { workflowSelected: 1 })}
    />)
    expect(lastFrame() ?? '').not.toContain('█')
  })

  it('enters navigation with ↓ when only the workflow panel has rows', async () => {
    const onPanelOpen = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onPanelOpen }}
      view={runView([{
        id: 'wf-1',
        name: 'r',
        status: 'running',
        phases: [{ key: 'missing', members: [member(1, 'm', 'c-1', 'running')] }],
      }])}
    />)
    stdin.write('\x1b[B')
    await settled()
    expect(onPanelOpen).toHaveBeenCalledTimes(1)
  })

  it('renders above the subagent roster and yields to an approval question', () => {
    const rows: readonly SubagentRow[] = [{
      childId: 'child-1',
      label: '普通子代理',
      startedAt: Date.now() - 86_000,
      inputTokens: 11_100,
      fading: false,
    }]
    const view: RenderView = {
      ...runView([{
        id: 'wf-1',
        name: 'r',
        status: 'running',
        phases: [{ key: 'missing', members: [member(1, 'm', 'c-1', 'running')] }],
      }]),
      subagents: rows,
    }
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={view} />)
    const frame = lastFrame() ?? ''
    // The workflow run leads the band, the roster follows below it.
    expect(frame.indexOf('Workflow (r) · 1 成员')).toBeLessThan(frame.indexOf('普通子代理'))
    // An approval question owns the screen bottom: the panels wait it out.
    const approval = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ ...view, overlay: { kind: 'approval', toolName: 'bash', reason: 'run rm -rf' } }}
    />)
    expect(approval.lastFrame() ?? '').not.toContain('Workflow')
  })
})

