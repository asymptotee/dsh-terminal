/** The subagent panel: roster rows, the ❯/● marker model, and the opened child view. */

import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { RenderView, TeamPanelInfo } from '../../src/view/renderer.tsx'
import type { Frame, FrameState } from '../../src/fold/frames.ts'
import { noopHandlers, renderApp, settled, state } from '../helpers/render.tsx'

describe('subagent panel', () => {
  function panelView(extra?: Partial<RenderView>): RenderView {
    return {
      subagents: [{
        childId: 'child-1',
        label: '调研包结构',
        activity: 'grep(pattern)',
        startedAt: Date.now() - 86_000,
        inputTokens: 11_100,
        fading: false,
      }],
      ...extra,
    }
  }

  it('renders the main row and child rows below the status bar', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={panelView()} />)
    const frame = lastFrame() ?? ''
    // No child open: the main view is the current one, so main wears the ●.
    expect(frame).toContain('● main')
    expect(frame).toContain('◯ 调研包结构')
    expect(frame).toContain('grep(pattern)')
    expect(frame).toContain('1m 26s')
    expect(frame).toContain('↓ 11.1k tokens')
  })

  it('hides the panel when there are no unfinished subagents', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(lastFrame()).not.toContain('● main')
  })

  it('truncates a long activity so the row stays on one line', () => {
    const longActivity = 'find ' + 'x'.repeat(120)
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={panelView({ subagents: [{ childId: 'child-1', label: '调研包结构', activity: longActivity, startedAt: Date.now() - 86_000, inputTokens: 11_100, fading: false }] })}
      />,
    )
    const frame = lastFrame() ?? ''
    // The activity is cut with an ellipsis; the full command is gone.
    expect(frame).toContain('…')
    expect(frame).not.toContain(longActivity)
    // Single row: the label and the elapsed/tokens share one line (no wrap).
    const row = frame.split('\n').find(r => r.includes('调研包结构')) ?? ''
    expect(row).toContain('↓ 11.1k tokens')
  })

  it('renders the team panel with roster and task board', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          team: {
            members: [
              { name: 'lead', description: 'team lead', phase: 'active' },
              { name: 'researcher', description: '调研包结构', phase: 'active' },
            ],
            tasks: [
              { subject: 'investigate', status: 'in_progress', ownerName: 'researcher', blocked: false },
              { subject: 'write report', status: 'pending', blocked: true },
            ],
          },
        }}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Teammates · 2')
    // Members render by name (the description is dropped); unselected rows use ◯.
    expect(frame).toContain('researcher')
    expect(frame).toContain('◯')
    expect(frame).not.toContain('调研包结构')
    expect(frame).toContain('Tasks · 2')
    expect(frame).toContain('investigate')
    expect(frame).toContain('researcher · in_progress')
    expect(frame).toContain('unowned · pending')
  })

  it('shows completed rows while tasks remain open, then hides the all-done board after a linger', async () => {
    const team = (tasks: readonly { subject: string; status: string; ownerName?: string; blocked: boolean }[]) => ({
      members: [{ name: 'lead', description: 'lead', phase: 'active' }],
      tasks,
    })
    // Mixed board: completed ✔ rows stay visible next to open tasks — rows
    // never drop off one by one mid-run.
    const mixed = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          team: team([
            { subject: 'done thing', status: 'completed', ownerName: 'lead', blocked: false },
            { subject: 'open thing', status: 'in_progress', ownerName: 'lead', blocked: false },
          ]),
        }}
      />,
    )
    const mixedFrame = mixed.lastFrame() ?? ''
    expect(mixedFrame).toContain('Tasks · 2')
    expect(mixedFrame).toContain('done thing')
    expect(mixedFrame).toContain('open thing')
  })

  it('lingers the all-completed board, then keeps it hidden across a child-view round trip', async () => {
    const team: TeamPanelInfo = {
      members: [{ name: 'lead', description: 'lead', phase: 'active' }],
      tasks: [{ subject: 'done thing', status: 'completed', ownerName: 'lead', blocked: false }],
    }
    const app = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} completedLingerMs={40} view={{ team }} />,
    )
    await settled(10)
    expect(app.lastFrame() ?? '').toContain('Tasks · 1')
    expect(app.lastFrame() ?? '').toContain('done thing')
    await settled(80)
    let frame = app.lastFrame() ?? ''
    expect(frame).toContain('Teammates · 1')
    expect(frame).not.toContain('Tasks ·')
    // Enter the child transcript and Esc back: TeamPanel unmounts while the
    // child view is open, but the hide flag lives in TuiApp — the board must
    // not come back on return.
    const child = state([{ kind: 'user', seq: 1, text: 'child line' }])
    app.rerender(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        completedLingerMs={40}
        view={{ team, openSubagent: { childId: 'lead', label: 'lead', state: child } }}
      />,
    )
    await settled()
    app.rerender(<TuiApp state={state([])} handlers={noopHandlers()} completedLingerMs={40} view={{ team }} />)
    await settled()
    frame = app.lastFrame() ?? ''
    expect(frame).toContain('Teammates · 1')
    expect(frame).not.toContain('Tasks ·')
    expect(frame).not.toContain('done thing')
  })

  it('hides the team panel when there is no team', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} />)
    expect(lastFrame()).not.toContain('Teammates ·')
  })

  it('shows a task-only team as just the board, no empty roster section', () => {
    // A lead that plans tasks before spawning any worker: the roster is empty
    // but the board must still show the tasks it just wrote.
    const team: TeamPanelInfo = {
      members: [],
      tasks: [{ subject: '实现 math_utils.py', status: 'pending', blocked: false }],
    }
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={{ team }} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Tasks · 1')
    expect(frame).toContain('实现 math_utils.py')
    // The empty Teammates header and its lone lead row are dropped.
    expect(frame).not.toContain('Teammates ·')
    expect(frame).not.toContain('lead')
  })

  it('shows navigation hints and marks the selected team member', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          team: {
            members: [
              { name: 'researcher', description: '调研', phase: 'active' },
              { name: 'writer', description: '写文档', phase: 'active' },
            ],
            tasks: [],
          },
          teamSelected: 1,
          status: { model: 'test-model', cwd: '/workspace/repo', mode: 'workspace-write' },
        }}
      />,
    )
    const frame = lastFrame() ?? ''
    // The hint only renders while the team panel holds focus — on the
    // status bar's permission row, exactly like the workflow panel's.
    expect(frame).toContain('workspace-write · (↑↓ 选择 · Enter 打开 · Esc 返回)')
    expect(frame).toContain('researcher')
    expect(frame).toContain('writer')
  })

  it('shows the lead row above the team roster and selects it at index zero', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          team: {
            members: [
              { name: 'researcher', description: '调研', phase: 'active' },
              { name: 'writer', description: '写文档', phase: 'active' },
            ],
            tasks: [],
          },
          teamSelected: 0,
        }}
      />,
    )
    const frame = lastFrame() ?? ''
    // The lead row leads the panel, ahead of every member row.
    expect(frame.indexOf('lead')).toBeGreaterThanOrEqual(0)
    expect(frame.indexOf('lead')).toBeLessThan(frame.indexOf('researcher'))
    expect(frame.indexOf('researcher')).toBeLessThan(frame.indexOf('writer'))
  })

  it('omits navigation hints when the team panel is not focused', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{ team: { members: [{ name: 'researcher', description: '调研', phase: 'active' }], tasks: [] } }}
      />,
    )
    expect(lastFrame() ?? '').not.toContain('↑↓ 选择')
  })

  it('hides the input caret while the team panel holds focus', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          team: { members: [{ name: 'researcher', description: '调研', phase: 'active' }], tasks: [] },
          teamSelected: 0,
        }}
      />,
    )
    // The caret only renders while the input bar holds focus.
    expect(lastFrame() ?? '').not.toContain('█')
  })

  it('renders a member enriched with live runtime (activity, elapsed, tokens)', () => {
    const { lastFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{
          team: {
            members: [{
              name: 'researcher',
              description: '调研包结构',
              phase: 'active',
              activity: 'grep(pattern)',
              startedAt: Date.now() - 90_000,
              inputTokens: 12_300,
            }],
            tasks: [],
          },
        }}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Teammates · 1')
    expect(frame).toContain('researcher')
    expect(frame).toContain('grep(pattern)')
    expect(frame).toContain('1m 30s')
    expect(frame).toContain('↓ 12.3k tokens')
  })

  it('moves the ❯ cursor with the selection while ● stays on the open view', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={panelView({ subagentSelected: 1 })} />)
    const frame = lastFrame() ?? ''
    // The cursor sits on the child row; the ● stays on main — the view that
    // is actually open. Enter is what moves the ●.
    expect(frame).toContain('❯ ◯ 调研包结构')
    expect(frame).toContain('● main')
  })

  it('pins the panel ● to the open child while the cursor sits elsewhere', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={panelView({
        subagentSelected: 0,
        openSubagent: { childId: 'child-1', label: '调研包结构', state: childState },
      })}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('❯ ◯ main')
    expect(frame).toContain('● 调研包结构')
  })

  it('pins the team panel ● to the open member row', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{
        team: {
          members: [
            { id: 'm-1', name: 'researcher', description: '调研', phase: 'active' },
            { id: 'm-2', name: 'writer', description: '写文档', phase: 'active' },
          ],
          tasks: [],
        },
        teamSelected: 0,
        openSubagent: { childId: 'm-2', label: 'writer', state: childState },
      }}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('❯ ◯ lead')
    expect(frame).toContain('● writer')
    expect(frame).toContain('◯ researcher')
  })

  it('enters the panel with ↓ from an empty editor', async () => {
    const onPanelOpen = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onPanelOpen }} view={panelView()} />)
    stdin.write('\x1b[B')
    await settled()
    expect(onPanelOpen).toHaveBeenCalledTimes(1)
  })

  it('does not enter the panel when the buffer has text', async () => {
    const onPanelOpen = vi.fn()
    const { stdin } = renderApp(<TuiApp state={state([])} handlers={{ ...noopHandlers(), onPanelOpen }} view={panelView()} />)
    stdin.write('x')
    stdin.write('\x1b[B')
    await settled()
    expect(onPanelOpen).not.toHaveBeenCalled()
  })

  it('routes arrows, Enter, and Esc while the panel holds focus', async () => {
    const onPanelMove = vi.fn()
    const onPanelEnter = vi.fn()
    const onPanelBack = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onPanelMove, onPanelEnter, onPanelBack }}
      view={panelView({ subagentSelected: 0 })}
    />)
    stdin.write('\x1b[B')
    stdin.write('\r')
    stdin.write('\x1b')
    await settled()
    expect(onPanelMove).toHaveBeenCalledWith(1)
    expect(onPanelEnter).toHaveBeenCalledTimes(1)
    expect(onPanelBack).toHaveBeenCalledTimes(1)
  })

  it('renders the child transcript view instead of the input bar', () => {
    const childState = state([{ kind: 'user', seq: 1, text: '看看仓库结构' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } })}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('subagent: 调研包结构')
    expect(frame).toContain('❯ 看看仓库结构')
    expect(frame).not.toContain('❯ █')
  })

  it('folds the main session live frames away while the child view is open', () => {
    const childState = state([{ kind: 'user', seq: 1, text: '子会话内容' }])
    const mainFrames: Frame[] = [{ kind: 'assistant', seq: 1, turn: 1, step: 1, text: '协调员正在流式', streaming: true }]
    const { lastFrame } = renderApp(<TuiApp
      state={state(mainFrames)}
      handlers={noopHandlers()}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } })}
    />)
    const frame = lastFrame() ?? ''
    // The child transcript is the only live surface…
    expect(frame).toContain('subagent: 调研包结构')
    expect(frame).toContain('❯ 子会话内容')
    // …and the coordinator's own streaming frame is not drawn on top of it.
    expect(frame).not.toContain('协调员正在流式')
  })

  it('returns from the child view on Esc', async () => {
    const onPanelBack = vi.fn()
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onPanelBack }}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } })}
    />)
    stdin.write('\x1b')
    await settled()
    expect(onPanelBack).toHaveBeenCalledTimes(1)
  })

  it('lends the editor to a continuable child: Enter steers, Esc returns', async () => {
    const onChildPrompt = vi.fn()
    const onPanelBack = vi.fn()
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { stdin, lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onChildPrompt, onPanelBack }}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState, continuable: true } })}
    />)
    // The empty editor shows the steady block caret followed by the dim
    // identity-and-keys placeholder; the pinned header row is gone for a
    // continuable child.
    const chrome = lastFrame() ?? ''
    expect(chrome).toContain('❯ █subagent: 调研包结构')
    stdin.write('换个思路')
    await settled()
    // Typing replaces the placeholder with the buffer and the caret.
    expect(lastFrame() ?? '').toContain('❯ 换个思路█')
    expect(lastFrame() ?? '').not.toContain('(Enter 发送')
    stdin.write('\r')
    await settled()
    expect(onChildPrompt).toHaveBeenCalledWith('换个思路')
    // The buffer cleared after the send, so the placeholder returns.
    expect(lastFrame() ?? '').toContain('❯ █subagent: 调研包结构')
    stdin.write('\x1b')
    await settled()
    expect(onPanelBack).toHaveBeenCalledTimes(1)
  })

  it('keeps a read-only child without an editor', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } })}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('❯ █')
    // The identity rides the read-only box's dim note (above the panel band
    // at the screen bottom) — no separate header row leads the panels.
    expect(frame).toContain('subagent: 调研包结构 · 当前子代理')
    expect(frame.indexOf('subagent: 调研包结构')).toBeLessThan(frame.indexOf('◯ main'))
  })

  it('hides the orphan editor over a read-only child even while panels own the keys', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={panelView({
        subagentSelected: 0,
        openSubagent: { childId: 'child-1', label: '调研包结构', state: childState },
      })}
    />)
    // Panel navigation is active over a one-shot child: the panels render
    // (the open child's row wears the ●), but no editor box that belongs to
    // nobody — panel rows start with the cursor column plus a marker, never a
    // bare prompt marker on its own row.
    const frame = lastFrame() ?? ''
    expect(frame).toContain('● 调研包结构')
    expect(frame).not.toMatch(/^❯\s*$/m)
  })

  it('keeps the roster, team panel, and the child heartbeat up in the child view', () => {
    const childState: FrameState = {
      ...state([{ kind: 'user', seq: 1, text: 'child line' }]),
      turnStartedAt: Date.now() - 5_000,
    }
    const team: TeamPanelInfo = { members: [{ name: 'lead', description: 'lead', phase: 'active' }], tasks: [] }
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={panelView({ team, openSubagent: { childId: 'child-1', label: '调研包结构', state: childState } })}
    />)
    const frame = lastFrame() ?? ''
    // The roster row, the team panel, and the child's own turn heartbeat all
    // stay visible while its transcript is open.
    expect(frame).toContain('grep(pattern)')
    expect(frame).toContain('Teammates · 1')
    expect(frame).toContain('Working…')
    // The read-only child keeps its identity note at the bottom box.
    expect(frame).toContain('subagent: 调研包结构')
  })

  it('gives the panels the keys over an open child while panelNav is set', async () => {
    const onPanelMove = vi.fn()
    const onPanelEnter = vi.fn()
    const onPanelBack = vi.fn()
    const childState = state([{ kind: 'user', seq: 1, text: 'child line' }])
    const { stdin, lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onPanelMove, onPanelEnter, onPanelBack }}
      view={panelView({
        panelNav: true,
        subagentSelected: 1,
        openSubagent: { childId: 'child-1', label: '调研包结构', state: childState, continuable: true },
      })}
    />)
    // The child editor stays visible but drops its caret; the panel owns the
    // arrows, Enter, and Esc while navigation is active.
    expect(lastFrame() ?? '').not.toContain('█')
    stdin.write('\x1b[B') // Down
    await settled()
    expect(onPanelMove).toHaveBeenCalledWith(1)
    stdin.write('\r')
    await settled()
    expect(onPanelEnter).toHaveBeenCalledTimes(1)
    stdin.write('\x1b')
    await settled()
    expect(onPanelBack).toHaveBeenCalledTimes(1)
  })

  it('drops into panel navigation with ↓ from an open child editor', async () => {
    const onPanelOpen = vi.fn()
    const childState = state([{ kind: 'user', seq: 1, text: 'child line' }])
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onPanelOpen }}
      view={panelView({ openSubagent: { childId: 'child-1', label: '调研包结构', state: childState, continuable: true } })}
    />)
    stdin.write('\x1b[B')
    await settled()
    expect(onPanelOpen).toHaveBeenCalledTimes(1)
  })

  it('echoes pending continuation prompts above the child editor', () => {
    const childState = state([{ kind: 'user', seq: 1, text: 'x' }])
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={panelView({ openSubagent: {
        childId: 'child-1',
        label: '调研包结构',
        state: childState,
        continuable: true,
        pending: [
          { id: 'req-1', text: '第一条消息' },
          { id: 'req-2', text: '第二条消息' },
        ],
      } })}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('第一条消息')
    expect(frame).toContain('第二条消息')
    // Every echo carries the steering hint.
    expect(frame).toContain('(steering — runs at the next step boundary)')
  })
})

