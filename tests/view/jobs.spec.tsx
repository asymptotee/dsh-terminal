/** The footer's jobs summary segment, the Background list, and the job detail view. */

import { describe, expect, it } from 'vitest'
import chalk from 'chalk'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { JobDetailView, JobsListView, StatusInfo, StatusJobsSummary } from '../../src/view/renderer.tsx'
import { noopHandlers, renderApp, renderRaw, state } from '../helpers/render.tsx'

describe('jobs summary, list, and detail', () => {
  const summary = (over?: Partial<StatusJobsSummary>): StatusJobsSummary => ({
    segments: [{ word: 'shell', count: 1 }],
    ...over,
  })

  const status = (jobs?: StatusJobsSummary, over?: Partial<StatusInfo>): StatusInfo => ({
    model: 'test-model',
    cwd: '/workspace/repo',
    mode: 'workspace-write',
    ...jobs === undefined ? {} : { jobs },
    ...over,
  })

  const detail = (over?: Partial<JobDetailView>): JobDetailView => ({
    jobId: 'bash-1',
    title: 'Shell details',
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

  it('appends the jobs summary to the permission row, dim at rest', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ status: status(summary()) }} />)
    expect(lastFrame()).toContain('⏵⏵ workspace-write mode on (shift+tab to cycle) · 1 shell')
    // The count pluralizes per kind; several kinds join with their own clauses.
    const many = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ status: status({ segments: [{ word: 'shell', count: 2 }, { word: 'subagent', count: 1 }] }) }}
    />)
    expect(many.lastFrame()).toContain('· 2 shells · 1 subagent')
  })

  it('shows the summary on its own row without a permission mode', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ status: { model: 'test-model', cwd: '/workspace/repo', jobs: summary() } }}
    />)
    expect(lastFrame()).toContain('1 shell')
    // No jobs at all: nothing renders — the mode row keeps to itself.
    const bare = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ status: status() }} />)
    expect(bare.lastFrame() ?? '').not.toContain('shell')
  })

  it('keeps the same text while the rung is selected, without extra hints', () => {
    // The rung inverts the segment onto a green fill — the text itself and the
    // row around it do not change, and no navigation hint trails it.
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ status: status(summary({ selected: true })) }}
    />)
    expect(lastFrame()).toContain('⏵⏵ workspace-write mode on (shift+tab to cycle) · 1 shell')
    expect(lastFrame()).not.toContain('Enter 打开')
  })

  it('paints the segment green, inverted onto a fill while selected', () => {
    // #51cf66 — the row's own auto-mode green — as the text color at rest and
    // the background fill under the cursor (the pill's badge recipe).
    const previous = chalk.level
    chalk.level = 3
    try {
      const rest = renderRaw(<TuiApp state={state([])} handlers={noopHandlers()} view={{ status: status(summary()) }} />)
      expect(rest).toContain('[38;2;81;207;102m')
      expect(rest).not.toContain('[48;2;81;207;102m')
      const selected = renderRaw(<TuiApp state={state([])} handlers={noopHandlers()} view={{ status: status(summary({ selected: true })) }} />)
      expect(selected).toContain('[48;2;81;207;102m')
    } finally {
      chalk.level = previous
    }
  })

  it('hides the summary while an approval question owns the screen bottom', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{
        status: status(summary()),
        overlay: { kind: 'approval', toolName: 'bash', reason: 'run rm -rf' },
      }}
    />)
    // The bar (status footer included) waits the question out.
    expect(lastFrame() ?? '').not.toContain('1 shell')
  })

  it('renders the Background list over the input region', () => {
    const list = (): JobsListView => ({
      activeSummary: '2 active shells',
      active: [
        { id: 'bash-b', label: 'sleep 60 && echo "后台命令B（60秒）完成"', status: 'running' },
        { id: 'bash-a', label: 'sleep 60 && echo "后台命令A（60秒）完成"', status: 'running' },
      ],
      earlier: [],
      selected: 1,
      killArmed: false,
      selectedKillable: true,
    })
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ jobsList: list() }} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Background')
    expect(frame).toContain('2 active shells')
    // The cursor row leads; the other row dims. The input bar yields its rows.
    const rows = frame.split('\n')
    const cursorRow = rows.find(row => row.includes('后台命令B')) ?? ''
    expect(cursorRow).toContain('❯')
    // The status word trails the label on the same row, not right-aligned.
    expect(cursorRow).toMatch(/"后台命令B（60秒）完成"\s+running/)
    const otherRow = rows.find(row => row.includes('后台命令A')) ?? ''
    expect(otherRow).not.toContain('❯')
    expect(frame).not.toContain('█')
    // The history section shows its count, then the key hints close the panel.
    expect(frame).toContain('Earlier in this session (0)')
    expect(frame).toContain('↑/↓ to select · Enter to view · x to stop · Esc to close')
  })

  it('lists the history under its header and hides the stop hint on a settled cursor', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{
        jobsList: {
          activeSummary: '1 active shell',
          active: [{ id: 'bash-c', label: 'sleep 30', status: 'running' }],
          earlier: [
            { id: 'bash-b', label: 'sleep 60 && echo B', status: 'completed' },
            { id: 'bash-a', label: 'sleep 60 && echo A', status: 'killed' },
          ],
          selected: 3,
          killArmed: false,
          selectedKillable: false,
        },
      }}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Earlier in this session (2)')
    // The cursor sits on the last history row; a settled row cannot be stopped.
    const rows = frame.split('\n')
    expect(rows.find(row => row.includes('sleep 60 && echo A'))).toContain('❯')
    expect(rows.find(row => row.includes('sleep 60 && echo B'))).not.toContain('❯')
    expect(frame).toContain('↑/↓ to select · Enter to view · Esc to close')
    expect(frame).not.toContain('x to stop')
  })

  it('paints the cursor row light blue with a dim marker', () => {
    // The row's own colors: ❯ and the label wear the shared highlight tint
    // (#a5d8ff) on the cursor row, the ● marker stays dim gray whatever the
    // status, and no status hue leaks into the dot.
    const previous = chalk.level
    chalk.level = 3
    try {
      const raw = renderRaw(<TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          jobsList: {
            activeSummary: '2 active shells',
            active: [
              { id: 'bash-b', label: 'sleep 60 && echo B', status: 'running' },
              { id: 'bash-a', label: 'sleep 60 && echo A', status: 'failed' },
            ],
            earlier: [],
            selected: 1,
            killArmed: false,
            selectedKillable: true,
          },
        }}
      />)
      expect(raw).toContain('[38;2;165;216;255m❯')
      expect(raw).toContain('[2m●')
      // The failed row's dot is dim too — never the status red.
      expect(raw).not.toContain('[38;2;255;107;107m●')
      // The status word is dim on the cursor row as well, at the wider gap.
      expect(raw).toContain('[2m   running')
      // The list's own chrome (rule and heading) wears the jobs green, and
      // the earlier header reads plain white — not dim.
      expect(raw).toContain('[38;2;81;207;102m─')
      expect(raw).toContain('[38;2;81;207;102m  Background')
      const earlierLine = raw.split('\n').find(line => line.includes('Earlier in this session')) ?? ''
      expect(earlierLine).not.toContain('[2m')
    } finally {
      chalk.level = previous
    }
  })

  it('flips the Background list hint to the armed confirm gesture', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{
        jobsList: {
          activeSummary: '1 active shell',
          active: [{ id: 'bash-c', label: 'sleep 30', status: 'running' }],
          earlier: [],
          selected: 1,
          killArmed: true,
          selectedKillable: true,
        },
      }}
    />)
    expect(lastFrame()).toContain('再按 x 确认停止 · Esc 取消')
  })

  it('renders the opened job as a full-screen detail view', () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ openJob: detail({ output: 'line one\nline two\n' }) }}
    />)
    const frame = lastFrame() ?? ''
    // The kind-driven heading and labelled fields lead; the output tail follows.
    expect(frame).toContain('Shell details')
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
    expect(rows.find(row => row.includes('Shell details'))?.startsWith('  Shell details')).toBe(true)
    const statusRow = rows.find(row => row.includes('Status:')) ?? ''
    expect(statusRow).toContain('running')
    expect(statusRow).not.toContain('◼')
    expect(rows.find(row => row.includes('line one'))?.startsWith('    line one')).toBe(true)
    // The three field values start on one column: the command text aligns
    // under `running` and the elapsed figure.
    const valueColumn = (row: string, value: string): number => row.indexOf(value)
    const runtimeRow = rows.find(row => row.includes('Runtime:')) ?? ''
    const commandRow = rows.find(row => row.includes('Command:')) ?? ''
    expect(valueColumn(statusRow, 'running')).toBeGreaterThan(0)
    expect(valueColumn(statusRow, 'running')).toBe(valueColumn(runtimeRow, '12s'))
    expect(valueColumn(statusRow, 'running')).toBe(valueColumn(commandRow, 'sleep 300'))
  })

  it('shows a placeholder for a job with no output ring', () => {
    // A background subagent registers a job with no output source, so its
    // detail names the work but has nothing to stream.
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ openJob: detail({ title: 'Subagent details', labelField: 'Task', label: '调研包结构', output: '' }) }}
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

  it('paints the detail chrome and status value green', () => {
    // #51cf66 — the jobs green — on the rule, the heading, and the status
    // word; the labelled field names stay dim.
    const previous = chalk.level
    chalk.level = 3
    try {
      const raw = renderRaw(<TuiApp state={state([])} handlers={noopHandlers()} view={{ openJob: detail() }} />)
      expect(raw).toContain('[38;2;81;207;102m─')
      expect(raw).toContain('[38;2;81;207;102m  Shell details')
      // The label column is plain white; the status value carries the green.
      expect(raw).toContain('  Status:   \x1b[38;2;81;207;102mrunning')
    } finally {
      chalk.level = previous
    }
  })

  it('carries the back, close, and stop hints in its own footer', () => {
    // The detail hides the status footer, so it carries its own key hints in
    // the bottom line — the one-layer back gesture and the close-to-input
    // gesture always, the two-step stop while the job is live. No switch
    // hint: the Background list is the switcher, ← returns to it.
    const live = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ openJob: detail() }} />)
    expect(live.lastFrame()).toContain('← to go back · Esc/Enter/Space to close · x to stop')
    expect(live.lastFrame()).not.toContain('↑/↓')
    const armed = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ openJob: detail({ killArmed: true }) }} />)
    expect(armed.lastFrame()).toContain('再按 x 确认停止 · Esc 取消')
    // A settled job cannot be stopped: no stop hint.
    const settled = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ openJob: detail({ status: 'completed', killable: false, detail: 'exit code: 0' }) }}
    />)
    expect(settled.lastFrame()).toContain('← to go back · Esc/Enter/Space to close')
    expect(settled.lastFrame()).not.toContain('x to stop')
  })
})
