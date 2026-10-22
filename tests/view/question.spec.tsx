/**
 * The ask_user_question overlay: the QuestionPanel's rendering of option and
 * free-text questions, the TuiApp wizard that walks a batch one question at a
 * time, and the InputBar's key routing while a question owns the screen.
 * @module dsh-terminal/tests/view/question
 */

import { describe, expect, it, vi } from 'vitest'
import { renderApp, settled, noopHandlers, state } from '../helpers/render.tsx'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { InputHandlers, QuestionItem, RenderView } from '../../src/view/renderer.tsx'

function questionView(questions: readonly QuestionItem[], handlers?: Partial<InputHandlers>): RenderView {
  return { overlay: { kind: 'question', questions } }
}

const single: QuestionItem = {
  id: 'q1',
  question: 'Which library should we use?',
  header: 'Library',
  options: [
    { label: 'zod', description: 'schema-first' },
    { label: 'valibot' },
  ],
}
const multi: QuestionItem = {
  id: 'q2',
  question: 'Which features do you want?',
  options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
  multiSelect: true,
}
const freeText: QuestionItem = { id: 'q3', question: 'What port?' }

describe('question overlay', () => {
  it('renders the step bar and the numbered option menu', () => {
    const { lastFrame } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={questionView([single])} />)
    const frame = lastFrame() ?? ''
    // The step bar: the open step wears ☐ and the ❯ cursor, Submit trails dim.
    expect(frame).toContain('❯ ☐ Library')
    expect(frame).toContain('✔ Submit')
    // The header eyebrow and the wrapped question.
    expect(frame).toContain('Which library should we use?')
    // Numbered options: ❯ on the first row, the description under it; no row
    // is chosen yet, so nothing wears the trailing ✔.
    expect(frame).toContain('❯ 1. zod')
    expect(frame).toContain('schema-first')
    expect(frame).toContain('2. valibot')
    expect(frame).not.toContain('zod ✔')
    expect(frame).not.toContain('valibot ✔')
    expect(frame).toContain('↑↓ 选择 · Enter 确认 · ←/→ 跳题 · Esc 放弃全部')
    // The input bar renders nothing while the question owns the bottom.
    expect(frame).not.toContain('█')
  })

  it('marks a confirmed single-select option with a trailing ✔', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={questionView([single])} />)
    // Cursor on the second option, Enter confirms it: the step flips to ☒
    // and (back on this question) the row would wear its trailing ✔ — verify
    // via the review, which renders every confirmed answer.
    stdin.write('\x1b[B')
    await settled()
    stdin.write('\r')
    await settled()
    expect((lastFrame() ?? '')).toContain('☒ Library')
    expect((lastFrame() ?? '')).toContain('→ valibot')
    // ← walks back to the confirmed question: its row wears the trailing ✔.
    stdin.write('\x1b[D')
    await settled()
    expect((lastFrame() ?? '')).toContain('2. valibot ✔')
  })

  it('keeps the ✔ on the confirmed choice when the cursor moves elsewhere', async () => {
    const onQuestionAnswer = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([single, multi])}
    />)
    // Confirm q1 on its first option (zod), which lands on q2.
    stdin.write('\r')
    await settled()
    // ← walks back to q1: the ✔ stays on zod, the cursor lands on the first
    // row (light blue, no ✔).
    stdin.write('\x1b[D')
    await settled()
    expect((lastFrame() ?? '')).toContain('1. zod ✔')
    expect((lastFrame() ?? '')).toContain('❯ 1.')
    expect((lastFrame() ?? '')).not.toContain('2. valibot ✔')
    // Moving the cursor to the second option must NOT move the checkmark:
    // valibot turns light blue (cursor) but stays un-✔, zod keeps its ✔.
    stdin.write('\x1b[B')
    await settled()
    const moved = lastFrame() ?? ''
    expect(moved).toContain('1. zod ✔')
    expect(moved).not.toContain('2. valibot ✔')
    // Submit still carries the confirmed zod answer, not the hovered valibot:
    // → to q2, Enter confirms it (empty multi-set) and lands on Submit, the
    // final Enter resolves the batch.
    stdin.write('\x1b[C')
    await settled()
    stdin.write('\r')
    await settled()
    expect((lastFrame() ?? '')).toContain('❯ ✔ Submit')
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'q1', selected: ['zod'] }, { id: 'q2', selected: [] }],
    })
  })

  it('walks the step bar with the arrows and Tab', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={questionView([single, multi])} />)
    // → steps to the second question (its header-less label leads the cell).
    stdin.write('\x1b[C')
    await settled()
    expect((lastFrame() ?? '')).toContain('Which features do you want?')
    // Tab (Shift+Tab) walks back.
    stdin.write('\x1b[Z')
    await settled()
    expect((lastFrame() ?? '')).toContain('Which library should we use?')
    // →→ lands on the Submit step: both questions are still unconfirmed, so
    // the review shows the ⚠ warning and lists no answers.
    stdin.write('\x1b[C')
    await settled()
    stdin.write('\x1b[C')
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('❯ ✔ Submit')
    expect(frame).toContain('Review your answers')
    expect(frame).toContain('⚠ You have not answered all questions')
    expect(frame).not.toContain('●')
    expect(frame).toContain('Ready to submit your answers?')
    expect(frame).toContain('❯ 1. Submit answers')
    // The key hint stays Chinese even on the English Submit step.
    expect(frame).toContain('↑↓ 选择 · Enter 确认 · ←/→ 回看修改 · Esc 取消')
  })

  it('moves the option cursor with the arrows', async () => {
    const { lastFrame, stdin } = renderApp(<TuiApp state={state([])} handlers={noopHandlers()} view={questionView([single])} />)
    stdin.write('\x1b[B')
    await settled()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('❯ 2. valibot')
    expect(frame).not.toContain('❯ 1. zod')
    // Clamped at the last option.
    stdin.write('\x1b[B')
    await settled()
    expect((lastFrame() ?? '')).toContain('❯ 2. valibot')
  })

  it('toggles multi-select checkboxes with space and submits through the Submit step', async () => {
    const onQuestionAnswer = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([multi])}
    />)
    // space toggles the cursor's option: a multi-select row wears a [✔]/[ ]
    // bracket checkbox after its number — checked rows green, no trailing ✔.
    stdin.write(' ')
    await settled()
    expect((lastFrame() ?? '')).toContain('1. [✔] a')
    stdin.write('\x1b[B')
    await settled()
    stdin.write(' ')
    await settled()
    expect((lastFrame() ?? '')).toContain('2. [✔] b')
    // 'c' stays unchecked — an empty [ ] bracket on its row.
    expect((lastFrame() ?? '')).toContain('3. [ ] c')
    expect((lastFrame() ?? '')).not.toContain('3. [✔]')
    // Enter confirms the question (step bar ✔) and lands on Submit; the second
    // Enter resolves the waterfall with the checked set.
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).not.toHaveBeenCalled()
    expect((lastFrame() ?? '')).toContain('❯ ✔ Submit')
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({ answers: [{ id: 'q2', selected: ['a', 'b'] }] })
  })

  it('submits the arrow-selected option through the Submit step', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([single])}
    />)
    stdin.write('\x1b[B')
    await settled()
    stdin.write('\r')
    await settled()
    // Confirm lands on Submit; the second Enter answers.
    expect(onQuestionAnswer).not.toHaveBeenCalled()
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({ answers: [{ id: 'q1', selected: ['valibot'] }] })
  })

  it('submits an unconfirmed question empty from the Submit step', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([single, multi])}
    />)
    // Confirm q1, then jump straight to Submit (→) leaving q2 unconfirmed.
    stdin.write('\r')
    await settled()
    stdin.write('\x1b[C')
    await settled()
    stdin.write('\r')
    await settled()
    // q1 answered, q2 skipped (never confirmed) — the batch stays complete.
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'q1', selected: ['zod'] }, { id: 'q2', selected: [] }],
    })
  })

  it('records an empty answer when Esc skips the only question', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([single])}
    />)
    stdin.write('\x1b')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('walks a batch one question at a time and submits once at the end', async () => {
    const onQuestionAnswer = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([single, multi])}
    />)
    // Answer q1 with its first option; the wizard advances to q2 and the step
    // bar flips q1's cell to ☒.
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).not.toHaveBeenCalled()
    expect((lastFrame() ?? '')).toContain('☒ Library')
    expect((lastFrame() ?? '')).toContain('Which features do you want?')
    // Space-checks 'a', Enter confirms q2, the wizard lands on Submit.
    stdin.write(' ')
    await settled()
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).not.toHaveBeenCalled()
    const review = lastFrame() ?? ''
    expect(review).toContain('❯ ✔ Submit')
    // Both questions confirmed: every answer is listed and no ⚠ warning shows.
    expect(review).toContain('Review your answers')
    expect(review).toContain('→ zod')
    expect(review).toContain('→ a')
    expect(review).not.toContain('⚠')
    // Enter on Submit resolves the whole batch at once.
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledTimes(1)
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'q1', selected: ['zod'] }, { id: 'q2', selected: ['a'] }],
    })
  })

  it('cancels the batch from the Submit step choice', async () => {
    const onQuestionAnswer = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([single])}
    />)
    // Confirm q1, land on Submit, ↓ to Cancel, Enter.
    stdin.write('\r')
    await settled()
    stdin.write('\x1b[B')
    await settled()
    expect((lastFrame() ?? '')).toContain('❯ 2. Cancel')
    stdin.write('\r')
    await settled()
    // Cancel answers everything empty — the same as Esc.
    expect(onQuestionAnswer).toHaveBeenCalledWith({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('skips the whole batch when Esc is pressed mid-batch', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([single, multi])}
    />)
    stdin.write('\x1b')
    await settled()
    // Esc on the first question gives up the batch: the current question and
    // every remaining one are answered empty, so the waterfall resolves with a
    // complete batch and the model sees them all unanswered.
    expect(onQuestionAnswer).toHaveBeenCalledWith({
      answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }],
    })
  })

  it('renders a free-text question as a draft line and submits typed text', async () => {
    const onQuestionAnswer = vi.fn()
    const { lastFrame, stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([freeText])}
    />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('What port?')
    // No options: the draft line with its block caret, and the text hint.
    expect(frame).toContain('❯')
    expect(frame).toContain('█')
    expect(frame).toContain('Enter 提交 · ←/→ 跳题 · Esc 放弃全部')
    // Typed characters land in the TuiApp-owned draft; Enter confirms the
    // question (lands on Submit), the second Enter resolves with the custom.
    stdin.write('8080')
    await settled()
    expect((lastFrame() ?? '')).toContain('8080')
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).not.toHaveBeenCalled()
    expect((lastFrame() ?? '')).toContain('❯ ✔ Submit')
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({ answers: [{ id: 'q3', selected: [], custom: '8080' }] })
  })

  it('submits an empty skip for a free-text question confirmed blank', async () => {
    const onQuestionAnswer = vi.fn()
    const { stdin } = renderApp(<TuiApp
      state={state([])}
      handlers={{ ...noopHandlers(), onQuestionAnswer }}
      view={questionView([freeText])}
    />)
    // Confirming a blank draft marks it answered-with-nothing; Submit resolves
    // it as an empty item (no custom).
    stdin.write('\r')
    await settled()
    stdin.write('\r')
    await settled()
    expect(onQuestionAnswer).toHaveBeenCalledWith({ answers: [{ id: 'q3', selected: [] }] })
  })

  it('dims the asking tool call while the question waits', () => {
    // The callId ties the overlay to the pending ask_user_question card; the
    // transcript keeps that card visible (the question frame itself is the
    // tool's pending call, rendered by FrameRow like any other).
    const { lastFrame } = renderApp(<TuiApp
      state={state([])}
      handlers={noopHandlers()}
      view={{ overlay: { kind: 'question', callId: 'call-1', questions: [single] } }}
    />)
    expect((lastFrame() ?? '')).toContain('Which library should we use?')
  })
})
