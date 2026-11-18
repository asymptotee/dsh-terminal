/**
 * The input box's top rule carrying the session title: the label sits at the
 * right end behind one closing `─`, the plain rule survives without a title,
 * and the row holds exactly the terminal width in every case (an overlong row
 * wraps and breaks the frame).
 * @module dsh-terminal/tests/view/session-title
 */

import { describe, expect, it } from 'vitest'
import stringWidth from 'string-width'
import { renderApp, settled, noopHandlers, state } from '../helpers/render.tsx'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { RenderView } from '../../src/view/renderer.tsx'
import { titledRule } from '../../src/view/text-helpers.ts'

const STATUS = { model: 'test-model', cwd: '/tmp' }

function viewWith(title: string | undefined): RenderView {
  return { status: title === undefined ? STATUS : { ...STATUS, title } }
}

/** The input box's two rules, top then bottom. */
function rules(frame: string): string[] {
  return frame.split('\n').filter(line => line.startsWith('─'))
}

/** The input box's top rule: the first ─-run row in the frame. */
function topRule(frame: string): string {
  return rules(frame)[0] ?? ''
}

describe('titledRule', () => {
  it('closes the rule after the label', () => {
    const rule = titledRule(20, 'my session')
    // ` label ─` costs 10 + 1 + 2: the rest of the row is leading rule.
    expect(rule).toBe('─'.repeat(7) + ' my session ─')
    expect(rule).toHaveLength(20)
  })

  it('keeps the plain rule without a label', () => {
    expect(titledRule(12, '')).toBe('─'.repeat(12))
  })

  it('truncates a label that would crowd the rule', () => {
    const rule = titledRule(24, 'a very long session title that keeps going')
    expect(rule).toHaveLength(24)
    expect(rule).toContain('…')
    expect(rule.endsWith(' ─')).toBe(true)
    // The leading rule never disappears: at least the two-column minimum.
    expect(rule.startsWith('──')).toBe(true)
  })

  it('falls back to the plain rule when no label fits', () => {
    expect(titledRule(4, 'title')).toBe('────')
    expect(titledRule(0, 'title')).toBe('')
  })

  it('measures the label in display columns, not code units', () => {
    // A CJK title is twice as wide as its length: the row must still be
    // exactly `width` display columns.
    const rule = titledRule(20, '终端标题')
    expect(stringWidth(rule)).toBe(20)
    expect(rule.endsWith(' 终端标题 ─')).toBe(true)
  })
})

describe('the input box title label', () => {
  it('rides the top rule of the input box', async () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={viewWith('dsh-terminal工程')} />,
    )
    await settled()
    const rule = topRule(lastFrame() ?? '')
    expect(rule).toContain(' dsh-terminal工程 ─')
    // Right-aligned: the rule ends with the label, not the label with a rule.
    expect(rule.endsWith(' ─')).toBe(true)
  })

  it('leaves the plain rule when no title has landed', async () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={viewWith(undefined)} />,
    )
    await settled()
    const rule = topRule(lastFrame() ?? '')
    expect(rule).not.toContain(' ')
  })

  it('labels the top rule only, never the bottom one', async () => {
    // Two labelled rules would read as two headers sandwiching the editor;
    // the title marks the box's top edge alone.
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={viewWith('打招呼问候')} />,
    )
    await settled()
    const [top, bottom] = rules(lastFrame() ?? '')
    expect(top).toContain(' 打招呼问候 ─')
    expect(bottom).toBeDefined()
    expect(bottom).not.toContain('打招呼问候')
    expect(bottom).not.toContain(' ')
  })
})