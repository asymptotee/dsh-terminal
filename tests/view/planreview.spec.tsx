/**
 * The plan-review overlay: a plan-review question narrows to its dedicated
 * presentation — the plan document under its "Here is DSH's plan:" card in the
 * transcript window (durably from the exit_plan_mode frame's own arguments,
 * transiently from the request's detail), and the fixed-copy control bar at
 * the bottom whose second row is a live feedback input while the ❯ sits on
 * it. Everything else falls back to the generic question wizard.
 * @module dsh-terminal/tests/view/planreview
 */

import { describe, expect, it, vi } from 'vitest'
import { renderApp, settled, noopHandlers, state } from '../helpers/render.tsx'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { InputHandlers, QuestionItem, RenderView } from '../../src/view/renderer.tsx'
import type { Frame } from '../../src/fold/frames.ts'
import type { ContentBlock } from '../../src/dsh-adapter/types.ts'

const PLAN = '# 计划：创建 hello.py\n\n## Context\n\n打印当前时间。\n\n## 验证\n\npython3 hello.py\n'
// The test terminal is 24 rows, so the scroll window beside the control bar
// holds about 13 lines: layout-sensitive assertions use this short plan so the
// whole card (and the conversation above it) stays inside the visible window.
const PLAN_TRIM = '# 计划：创建 hello.py\n\n打印当前时间。\n\npython3 hello.py'

const planQuestion: QuestionItem = {
  id: 'plan-review',
  question: 'Approve this plan and leave plan mode?',
  header: 'Plan review',
  detail: PLAN,
  options: [
    { label: 'Approve', description: 'Leave plan mode' },
    { label: 'Keep planning', description: 'Stay in plan mode' },
  ],
  intent: { kind: 'plan-review', approve: 'Approve' },
}

function planView(questions: readonly QuestionItem[] = [planQuestion]): RenderView {
  return { overlay: { kind: 'question', questions } }
}

/** The logged exit_plan_mode call whose arguments carry the reviewed plan —
 *  the durable document source the frame renders from (and replays on resume).
 *  `settled` completes the call: plain content for the approved outcome, the
 *  same with isError for the declined one (the host expresses the decline by
 *  throwing, so its feedback rides the error result). */
function exitPlanFrame(
  callId = 'call-exit',
  plan = PLAN,
  settled?: { resultContent: readonly ContentBlock[]; isError?: boolean },
): Frame {
  return {
    kind: 'tool', seq: 2, turn: 1, step: 1, callId,
    name: 'exit_plan_mode', args: { plan },
    call: { card: 'generic', title: 'exit_plan_mode' },
    ...(settled === undefined ? {} : settled),
  }
}

describe('plan review overlay', () => {
  it("renders the plan under its Here is DSH's plan card above the control bar", () => {
    const { lastFrame } = renderApp(<TuiApp
      state={state([{ kind: 'user', seq: 1, text: '帮我写一个 hello.py' }])}
      handlers={noopHandlers()}
      view={planView([{ ...planQuestion, detail: PLAN_TRIM }])}
    />)
    const frame = lastFrame() ?? ''
    // The prior conversation stays visible above the plan block (regression:
    // an earlier revision replaced the whole transcript window).
    expect(frame).toContain('❯ 帮我写一个 hello.py')
    // The card header leads the document: a rule, then the lead line and a
    // breathing row above the plan markdown.
    expect(frame).toContain('─'.repeat(10))
    expect(frame).toContain("Here is DSH's plan:")
    expect(frame).toContain('计划：创建 hello.py')
    expect(frame).toContain('python3 hello.py')
    expect(frame.indexOf("Here is DSH's plan:")).toBeLessThan(frame.indexOf('计划：创建 hello.py'))
    // The control bar is the reference layout in fixed DSH-branded copy: the
    // proceed lead, then the approve row and the feedback input row. The
    // asker's own labels/descriptions are answer values, never display copy.
    expect(frame).toContain('DSH has written up a plan and is ready to execute. Would you like to proceed?')
    expect(frame).toContain('❯ 1. Yes')
    expect(frame).toContain('2. Tell DSH what to change')
    expect(frame).not.toContain('Leave plan mode')
    expect(frame).not.toContain('Stay in plan mode')
    expect(frame).toContain('↑↓ 选择 · Enter 确认 · Esc 保持规划')
    // The input row's caret only exists while the ❯ sits on it.
    expect(frame).not.toContain('█')
    // The generic wizard never renders for a plan review.
    expect(frame).not.toContain('Review your answers')
    expect(frame).not.toContain('✔ Submit')
  })

  it('approves on Enter over the Approve row', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={planView()}
    />)
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    })
  })

  it('types feedback directly on the second row once the ❯ lands on it', async () => {
    const onQuestionAnswer = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={planView()}
    />)
    // ↓ to the feedback row: the input goes live with the ❯ — no Enter step.
    // The caret starts at the line head with the dim placeholder after it.
    stdin.write('\x1b[B')
    await settled()
    expect(onQuestionAnswer).not.toHaveBeenCalled()
    let frame = lastFrame() ?? ''
    expect(frame).toContain('1. Yes')
    expect(frame).toContain('❯ 2.')
    expect(frame).toContain('█Tell DSH what to change')
    expect(frame).toContain('输入修改意见 · Enter 连同反馈提交 · Esc 保持规划')
    // The first typed character replaces the placeholder; Enter then submits
    // the keep-planning answer with the draft as its custom text.
    stdin.write('改用相对路径')
    await settled()
    frame = lastFrame() ?? ''
    expect(frame).toContain('改用相对路径█')
    expect(frame).not.toContain('Tell DSH what to change')
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: '改用相对路径' }],
    })
  })

  it('refuses Enter while the feedback draft is blank', async () => {
    const onQuestionAnswer = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={planView()}
    />)
    // ↓ goes live on the input row; Enter on the blank draft refuses — the
    // reference input-row reading: an empty answer never submits.
    stdin.write('\x1b[B')
    await settled()
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).not.toHaveBeenCalled()
    expect(lastFrame() ?? '').toContain('█Tell DSH what to change')
    // Whitespace alone is blank too.
    stdin.write('   ')
    await settled()
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).not.toHaveBeenCalled()
  })

  it('keeps planning without the draft when Esc is pressed on the input row', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={planView()}
    />)
    stdin.write('\x1b[B')
    await settled()
    stdin.write('一些意见')
    await settled()
    // Esc is the reference's cancel from any row: it submits keep-planning
    // with no feedback, dropping the typed draft.
    stdin.write('\x1b')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'plan-review', selected: ['Keep planning'] }],
    })
  })

  it('keeps planning without feedback when Esc is pressed on the choice', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={planView()}
    />)
    stdin.write('\x1b')
    await settled()
    // Esc on the choice = keep planning with no feedback (the model is told the
    // user wants to speak instead).
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'plan-review', selected: ['Keep planning'] }],
    })
  })

  it('renders the durable plan document from the exit_plan_mode frame', () => {
    // No overlay at all — the answered (or resumed) review leaves the plan on
    // screen: the frame's own arguments are the document source, exactly like
    // the web client's submittedPlan-derived PlanCards.
    const { lastFrame } = renderApp(<TuiApp
      state={state([{ kind: 'user', seq: 1, text: '规划一下' }, exitPlanFrame()])}
      handlers={noopHandlers()}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain("Here is DSH's plan:")
    expect(frame).toContain('计划：创建 hello.py')
    // The generic call line (`● Exit_plan_mode(…)`) gives way to the document.
    expect(frame).not.toContain('Exit_plan_mode(')
  })

  it("collapses the approved plan into the ● verdict card", () => {
    const approved = exitPlanFrame('call-exit', PLAN_TRIM, {
      resultContent: [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
    })
    const { lastFrame } = renderApp(<TuiApp state={state([approved])} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    // The verdict line replaces the review card's rule and lead, the plan
    // hangs under the ⎿ connector, and the host's result text is suppressed —
    // the verdict says it already.
    expect(frame).toContain("● User approved DSH's plan")
    expect(frame).toContain('  ⎿  ')
    expect(frame).toContain('计划：创建 hello.py')
    expect(frame).toContain('python3 hello.py')
    expect(frame).not.toContain("Here is DSH's plan:")
    expect(frame).not.toContain('Plan approved — plan mode exited')
  })

  it('keeps the review card with the red feedback when the plan is declined', () => {
    // The host expresses the decline by throwing, so the result is an error
    // block: the review card stays and the feedback renders red beneath it.
    const declined = exitPlanFrame('call-exit', PLAN_TRIM, {
      resultContent: [{ type: 'text', text: 'The user chose to keep planning; their feedback: 改用相对路径' }],
      isError: true,
    })
    const { lastFrame } = renderApp(<TuiApp state={state([declined])} handlers={noopHandlers()} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain("Here is DSH's plan:")
    expect(frame).toContain('计划：创建 hello.py')
    expect(frame).toContain('The user chose to keep planning')
    expect(frame).not.toContain("User approved DSH's plan")
  })

  it('anchors the overlay to the named frame instead of appending a second copy', () => {
    const withCallId: QuestionItem = {
      ...planQuestion,
      detail: PLAN_TRIM,
      intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-exit' },
    }
    const { lastFrame } = renderApp(<TuiApp
      state={state([exitPlanFrame('call-exit', PLAN_TRIM)])}
      handlers={noopHandlers()}
      view={planView([withCallId])}
    />)
    const frame = lastFrame() ?? ''
    // Exactly one document: the frame renders it, the transient copy is skipped.
    expect(frame.match(/Here is DSH's plan:/g)).toHaveLength(1)
    expect(frame).toContain('计划：创建 hello.py')
    // The control bar still asks the decision below.
    expect(frame).toContain('❯ 1. Yes')
  })

  it('falls back to the transient copy when no frame carries the document', () => {
    // A logged exit_plan_mode frame with a different plan plus a callId that
    // names no frame: the review still shows its own document, appended at the
    // live bottom, so both plan cards are on screen at once. Both plans are one
    // line so the two cards and the control bar fit the 24-row test terminal.
    const { lastFrame } = renderApp(<TuiApp
      state={state([exitPlanFrame('call-old', '# 旧计划')])}
      handlers={noopHandlers()}
      view={planView([{
        ...planQuestion,
        detail: '# 新计划',
        intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-missing' },
      }])}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('旧计划')
    expect(frame).toContain('新计划')
    expect(frame.match(/Here is DSH's plan:/g)).toHaveLength(2)
  })

  it('falls back to the generic wizard when the intent is missing', () => {
    // Strip the intent via destructuring — exactOptionalPropertyTypes forbids
    // an explicit `intent: undefined` on the optional prop.
    const { intent: _intent, ...rest } = planQuestion
    const generic: QuestionItem = rest
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={planView([generic])} />)
    const frame = lastFrame() ?? ''
    // No plan-review takeover: the step-bar wizard renders instead.
    expect(frame).toContain('✔ Submit')
    expect(frame).not.toContain("Here is DSH's plan:")
  })

  it('falls back to the generic wizard when the batch is not a single review', () => {
    const second: QuestionItem = { id: 'q2', question: 'Also this?', options: [{ label: 'yes' }] }
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={planView([planQuestion, second])} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('✔ Submit')
    expect(frame).not.toContain("Here is DSH's plan:")
  })
})
