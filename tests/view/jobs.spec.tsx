/** The jobs panel roster and the full-screen job detail view. */

import { describe, expect, it } from 'vitest'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { JobDetailView, JobRow, JobsPanelInfo, StatusInfo, TeamPanelInfo } from '../../src/view/renderer.tsx'
import type { Frame } from '../../src/fold/frames.ts'
import { noopHandlers, renderApp, settled, state } from '../helpers/render.tsx'

describe('jobs panel', () => {
  const job = (over?: Partial<JobRow>): JobRow => ({
    id: 'bash-1',
    kind: 'bash',
    label: 'sleep 300 && echo done',
    status: 'running',
    elapsedMs: 12_000,
    ...over,
  })

  it('renders the header, status glyphs, and elapsed', () => {
    const rows = (info: JobsPanelInfo): string =>
      (renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ jobs: info }} />).lastFrame() ?? '')
        .split('\n').find(row => row.includes('bash-')) ?? ''
    // The header carries the job count on the shared header column.
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ jobs: { rows: [job()] } }} />)
    expect(lastFrame()).toContain('Jobs · 1')
    // Each status wears its task-board glyph.
    expect(rows({ rows: [job({ status: 'running' })] })).toContain('◼')
    expect(rows({ rows: [job({ status: 'stopping' })] })).toContain('⊘')
    expect(rows({ rows: [job({ status: 'completed' })] })).toContain('✔')
    expect(rows({ rows: [job({ status: 'failed' })] })).toContain('✘')
    expect(rows({ rows: [job({ status: 'killed' })] })).toContain('⊘')
    // The row carries the id, label, and elapsed; running shows progress.
    const line = rows({ rows: [job({ progress: '42%' })] })
    expect(line).toContain('bash-1')
    expect(line).toContain('sleep 300 && echo done')
    expect(line).toContain('42%')
    expect(line).toContain('12s')
  })

  it('renders the rc.3 long registry id untruncated', () => {
    // `<kind>-<16 hex>` is 21 columns; the rc.2 `<kind>-N` monotonics stay
    // shorter — both fit the id column whole.
    const longId = 'bash-a1b2c3d4e5f60718'
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ jobs: { rows: [job({ id: longId })] } }}
    />)
    expect(lastFrame()).toContain(longId)
  })

  it('shows the terminal detail on settled rows', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ jobs: { rows: [job({ status: 'completed', detail: 'exit code: 0', progress: '42%' })] } }}
    />)
    // Settled rows swap the live progress for the terminal detail.
    expect(lastFrame()).toContain('exit code: 0')
    expect(lastFrame()).not.toContain('42%')
  })

  const detail = (over?: Partial<JobDetailView>): JobDetailView => ({
    jobId: 'bash-1',
    title: 'Command details',
    labelField: 'Command',
    label: 'sleep 300 && echo done',
    status: 'running',
    elapsedMs: 12_000,
    output: '',
    lossy: false,
    killArmed: false,
    killable: true,
    ...over,
  })

  it('renders the opened job as a full-screen detail view', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ openJob: detail({ output: 'line one\nline two\n' }) }}
    />)
    const frame = lastFrame() ?? ''
    // The kind-driven heading and labelled fields lead; the output tail follows.
    expect(frame).toContain('Command details')
    expect(frame).toContain('Status:')
    expect(frame).toContain('running')
    expect(frame).toContain('Runtime:')
    expect(frame).toContain('12s')
    expect(frame).toContain('Command:')
    expect(frame).toContain('sleep 300 && echo done')
    expect(frame).toContain('Output:')
    expect(frame).toContain('line one')
    expect(frame).toContain('line two')
    // The detail owns the transcript window: no editor caret below it.
    expect(frame).not.toContain('█')
    // The heading aligns with the field labels' two-column lead, the Status
    // row carries no glyph, and the output lines render bright (not dim).
    const rows = frame.split('\n')
    expect(rows.find(row => row.includes('Command details'))?.startsWith('  Command details')).toBe(true)
    const statusRow = rows.find(row => row.includes('Status:')) ?? ''
    expect(statusRow).toContain('running')
    expect(statusRow).not.toContain('◼')
    expect(rows.find(row => row.includes('line one'))?.startsWith('    line one')).toBe(true)
  })

  it('shows a placeholder for a job with no output ring', () => {
    // A background subagent registers a job with no output source, so its
    // detail names the work but has nothing to stream.
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ openJob: detail({ title: 'Subagent details', labelField: 'Task', label: '调研包结构', output: '', killable: true }) }}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Subagent details')
    expect(frame).toContain('Task:')
    expect(frame).toContain('No output available')
  })

  it('tails long detail output and flags a lossy head', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ openJob: detail({ output: many, lossy: true }) }}
    />)
    const frame = lastFrame() ?? ''
    // Only the tail survives the window; the head is elided with a marker.
    expect(frame).toContain('line 40')
    expect(frame).not.toContain('line 1\n')
    expect(frame).toContain('… earlier output dropped')
  })

  it('carries the kill hints in its own footer, hiding the status bar', () => {
    const status: StatusInfo = { model: 'test-model', cwd: '/workspace/repo', mode: 'workspace-write' }
    // The detail owns the region below the transcript, so the status footer
    // hides — the hints live in the detail's own bottom line instead.
    const idle = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ openJob: detail(), status }} />)
    expect(idle.lastFrame()).toContain('Esc/Enter 关闭 · x 停止任务')
    expect(idle.lastFrame()).not.toContain('workspace-write')
    const armed = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ openJob: detail({ killArmed: true }), status }} />)
    expect(armed.lastFrame()).toContain('再按 x 确认停止 · Esc 取消')
    // A settled job cannot be stopped: no kill hint.
    const settled = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ openJob: detail({ status: 'completed', killable: false, detail: 'exit code: 0' }), status }} />)
    expect(settled.lastFrame()).toContain('Esc/Enter 关闭')
    expect(settled.lastFrame()).not.toContain('x 停止任务')
  })

  it('moves the ❯ cursor with the selection', () => {
    const rows = [job({ id: 'bash-1' }), job({ id: 'bash-2' })]
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ jobs: { rows }, jobsSelected: 2 }}
    />)
    const frame = lastFrame() ?? ''
    const rowOf = (id: string): string => frame.split('\n').find(row => row.includes(id)) ?? ''
    expect(rowOf('bash-2')).toContain('❯')
    expect(rowOf('bash-1')).not.toContain('❯')
  })

  it('renders below the team panel and hides while absent or under an approval', () => {
    const team: TeamPanelInfo = {
      members: [{ name: 'lead', description: 'lead', phase: 'active' }],
      tasks: [],
    }
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ team, jobs: { rows: [job()] } }}
    />)
    // The jobs panel is the ladder's last rung: it trails the team panel.
    const frame = lastFrame() ?? ''
    expect(frame.indexOf('Teammates · 1')).toBeLessThan(frame.indexOf('Jobs · 1'))
    // No jobs: nothing renders.
    const bare = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(bare.lastFrame() ?? '').not.toContain('Jobs ·')
    // An approval question owns the screen bottom; the panel waits it out.
    const approval = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ jobs: { rows: [job()] }, overlay: { kind: 'approval', toolName: 'bash', reason: 'run rm -rf' } }}
    />)
    expect(approval.lastFrame() ?? '').not.toContain('Jobs ·')
  })

  it('puts the jobs key hints on the status bar while navigating', () => {
    const status: StatusInfo = { model: 'test-model', cwd: '/workspace/repo', mode: 'workspace-write' }
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ jobs: { rows: [job()] }, jobsSelected: 1, status }}
    />)
    expect(lastFrame()).toContain('workspace-write · (↑↓ 选择 · Enter 详情 · Esc 返回)')
  })
})
