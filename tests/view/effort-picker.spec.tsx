/** The effort picker popup: its float over the input box and its key routing. */

import { describe, expect, it, vi } from 'vitest'
import { renderApp, settled, noopHandlers, state } from '../helpers/render.tsx'
import { TuiApp } from '../../src/view/renderer.tsx'
import type { EffortPickerView } from '../../src/view/renderer.tsx'
import type { Frame } from '../../src/fold/frames.ts'

const PICKER: EffortPickerView = {
  levels: [
    { id: 'low', description: 'Fast and light' },
    { id: 'medium', description: 'Balanced middle' },
    { id: 'high', description: 'The default balance for most tasks.' },
    { id: 'max', description: 'Hardest quality-first tasks' },
  ],
  selected: 2,
}

describe('effort picker popup', () => {
  it('floats above the input box with the scale, selection, and hints', () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={{ effortPicker: PICKER }} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Effort')
    expect(frame).toContain('Faster')
    expect(frame).toContain('Smarter')
    expect(frame).toContain('▲')
    expect(frame).toContain('low')
    expect(frame).toContain('max')
    expect(frame).toContain('←/→ to adjust · Enter to confirm · Esc to cancel')
    // The popup sits above the input box: its rows land before the editor row.
    const rows = frame.split('\n')
    // The selected level's description floats between the levels and the hint.
    const levelsRow = rows.findIndex(row => row.includes('low') && row.includes('max'))
    const descRow = rows.findIndex(row => row.includes('The default balance for most tasks.'))
    const hintRow = rows.findIndex(row => row.includes('to adjust'))
    // One blank row of breathing room between the level names and the copy.
    expect(descRow).toBe(levelsRow + 2)
    expect(hintRow).toBe(descRow + 2)
    const popupRow = rows.findIndex(row => row.includes('Effort'))
    const editorRow = rows.findIndex(row => row.includes('❯'))
    expect(popupRow).toBeGreaterThan(-1)
    expect(editorRow).toBeGreaterThan(popupRow)
  })

  it('floats the labels above the track, one clear cell beyond the ▲ at both ends', () => {
    const rowsFor = (selected: number): string[] => {
      const { lastFrame } = renderApp(
        <TuiApp state={state([])} handlers={noopHandlers()} view={{ effortPicker: { ...PICKER, selected } }} />,
      )
      return (lastFrame() ?? '').split('\n')
    }
    const first = rowsFor(0)
    const labelRow = first.findIndex(row => row.includes('Faster'))
    const trackRow = first.findIndex(row => row.includes('▲'))
    // The labels float one row above the track line.
    expect(trackRow).toBe(labelRow + 1)
    // First level: one ─ before the ▲...
    expect(first[trackRow].trimStart().startsWith('─▲')).toBe(true)
    // ...and the label's center cell sits exactly on the ▲'s column.
    const labelRowIndex = first.findIndex(row => row.includes('low'))
    expect(first[labelRowIndex].indexOf('low') + 1).toBe(first[trackRow].indexOf('▲'))
    // Even-width label ('high'): the ▲ lands on the left-of-center cell.
    const mid = rowsFor(2)
    const midTrackRow = mid.findIndex(row => row.includes('▲'))
    const midLabelRow = mid.findIndex(row => row.includes('high'))
    expect(mid[midLabelRow].indexOf('high') + 1).toBe(mid[midTrackRow].indexOf('▲'))
    // ...last level: one ─ after it.
    const last = rowsFor(PICKER.levels.length - 1)
    expect(last.find(row => row.includes('▲'))?.trimEnd().endsWith('▲─')).toBe(true)
  })

  it('reaches the track to the last label when an even-width name overhangs', () => {
    // 'high' as the last level: its ▲-cell shift pushes its tail one column
    // past the nominal track end — the rule must reach the name's last cell.
    const picker: EffortPickerView = { levels: [{ id: 'off' }, { id: 'high' }], selected: 1 }
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={{ effortPicker: picker }} />,
    )
    const rows = (lastFrame() ?? '').split('\n')
    const trackRow = rows.find(row => row.includes('▲')) ?? ''
    const labelRow = rows.find(row => row.includes('high')) ?? ''
    expect(trackRow.trimEnd().length).toBe(labelRow.trimEnd().length)
  })

  it('floats the selected level’s description and drops the row without one', () => {
    const { lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={noopHandlers()} view={{ effortPicker: { ...PICKER, selected: 0 } }} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Fast and light')
    expect(frame).not.toContain('The default balance')
    // Levels disclosing no description drop the row: the hint sits two rows
    // under the levels instead of three.
    const { lastFrame: bareFrame } = renderApp(
      <TuiApp
        state={state([])}
        handlers={noopHandlers()}
        view={{ effortPicker: { levels: [{ id: 'low' }, { id: 'high' }], selected: 0 } }}
      />,
    )
    const bareRows = (bareFrame() ?? '').split('\n')
    const bareLevels = bareRows.findIndex(row => row.includes('low') && row.includes('high'))
    const bareHint = bareRows.findIndex(row => row.includes('to adjust'))
    expect(bareHint).toBe(bareLevels + 2)
  })

  it('routes the arrows, Enter, and Esc to the picker handlers, swallowing the rest', async () => {
    const handlers = {
      ...noopHandlers(),
      onCommit: vi.fn(),
      onEffortMove: vi.fn(),
      onEffortConfirm: vi.fn(),
      onEffortCancel: vi.fn(),
    }
    const { stdin, lastFrame } = renderApp(
      <TuiApp state={state([])} handlers={handlers} view={{ effortPicker: PICKER }} />,
    )
    stdin.write('\x1b[C') // Right: toward smarter
    await settled()
    expect(handlers.onEffortMove).toHaveBeenCalledWith(1)
    stdin.write('\x1b[D') // Left: toward faster
    await settled()
    expect(handlers.onEffortMove).toHaveBeenCalledWith(-1)
    stdin.write('\r')
    await settled()
    expect(handlers.onEffortConfirm).toHaveBeenCalledTimes(1)
    stdin.write('\x1b')
    await settled()
    expect(handlers.onEffortCancel).toHaveBeenCalledTimes(1)
    // Typed characters are swallowed: the editor buffer underneath stays empty.
    stdin.write('x')
    await settled()
    expect(lastFrame()).toContain('❯ █')
    expect(handlers.onCommit).not.toHaveBeenCalled()
  })

  it('swallows clicks on the transcript rows it covers', async () => {
    const frames: Frame[] = Array.from({ length: 40 }, (_, i) => (
      { kind: 'assistant', seq: i + 1, turn: 1, step: 1, text: `line ${i + 1}`, streaming: false }
    ))
    const { lastFrame, stdin, rerender } = renderApp(
      <TuiApp state={state(frames)} handlers={noopHandlers()} />,
    )
    await settled(60)
    stdin.write('\x1b[<64;3;3M') // one wheel notch up pops the pill
    await settled(40)
    const rows = (lastFrame() ?? '').split('\n')
    const pillRow = rows.findIndex(row => row.includes('Back to bottom'))
    expect(pillRow).toBeGreaterThan(-1)
    const pillX = rows[pillRow].indexOf('Back') + 3
    // Open the picker over the pill's row: it paints the row clean.
    rerender(<TuiApp state={state(frames)} handlers={noopHandlers()} view={{ effortPicker: PICKER }} />)
    await settled(40)
    const covered = lastFrame() ?? ''
    expect(covered).toContain('Effort')
    expect(covered).not.toContain('Back to bottom')
    // A click where the pill used to be is swallowed — no fall-through jump.
    stdin.write(`\x1b[<0;${pillX};${pillRow + 1}M`)
    await settled(40)
    expect(lastFrame()).toBe(covered)
  })
})
