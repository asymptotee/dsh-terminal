/** The terminal takeover primitives: SGR mouse parsing and the scroll model. */

import { describe, expect, it } from 'vitest'
import {
  containsMouseReport,
  createScrollState,
  maxOffset,
  mouseEnabled,
  scrollReducer,
  transcriptMarginTop,
  wheelDeltaFromInput,
  WHEEL_SCROLL_LINES,
} from '../src/terminal.ts'
import type { ScrollState } from '../src/terminal.ts'

describe('wheelDeltaFromInput', () => {
  it('decodes a wheel notch with ink\'s leading ESC stripped', () => {
    expect(wheelDeltaFromInput('[<64;12;34M')).toBe(WHEEL_SCROLL_LINES)
    expect(wheelDeltaFromInput('[<65;12;34M')).toBe(-WHEEL_SCROLL_LINES)
  })

  it('decodes a report that still carries its ESC', () => {
    expect(wheelDeltaFromInput('\x1b[<64;1;1M')).toBe(WHEEL_SCROLL_LINES)
  })

  it('sums batched notches from one fast wheel flick', () => {
    expect(wheelDeltaFromInput('[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M')).toBe(3 * WHEEL_SCROLL_LINES)
    expect(wheelDeltaFromInput('[<64;5;5M\x1b[<65;5;5M')).toBe(0)
  })

  it('masks modifier bits so shift/ctrl wheel still scrolls', () => {
    expect(wheelDeltaFromInput('[<68;5;5M')).toBe(WHEEL_SCROLL_LINES)  // shift
    expect(wheelDeltaFromInput('[<80;5;5M')).toBe(WHEEL_SCROLL_LINES)  // ctrl
    expect(wheelDeltaFromInput('[<72;5;5M')).toBe(WHEEL_SCROLL_LINES)  // alt
  })

  it('ignores clicks and releases', () => {
    expect(wheelDeltaFromInput('[<0;5;5M')).toBe(0)
    expect(wheelDeltaFromInput('[<0;5;5m')).toBe(0)
  })

  it('returns 0 for plain typed input', () => {
    expect(wheelDeltaFromInput('hello [world]')).toBe(0)
  })
})

describe('containsMouseReport', () => {
  it('flags any mouse report, including clicks the editor must swallow', () => {
    expect(containsMouseReport('[<64;5;5M')).toBe(true)
    expect(containsMouseReport('[<0;5;5M[<0;5;5m')).toBe(true)
    expect(containsMouseReport('\x1b[<65;2;2M')).toBe(true)
  })

  it('passes ordinary typing through', () => {
    expect(containsMouseReport('ls -la')).toBe(false)
    expect(containsMouseReport('[not a report')).toBe(false)
  })
})

describe('mouseEnabled', () => {
  it('defaults on and honors the opt-out', () => {
    expect(mouseEnabled({})).toBe(true)
    expect(mouseEnabled({ DSH_TERMINAL_MOUSE: '0' })).toBe(false)
    expect(mouseEnabled({ DSH_TERMINAL_MOUSE: 'false' })).toBe(false)
    expect(mouseEnabled({ DSH_TERMINAL_MOUSE: '1' })).toBe(true)
  })
})

describe('scrollReducer', () => {
  /** A measured state: 100 content rows in a 30-row window. */
  const measured: ScrollState = { offset: 0, contentRows: 100, windowRows: 30 }

  it('starts at the live bottom with no measurements', () => {
    const state = createScrollState()
    expect(state.offset).toBe(0)
    expect(maxOffset(state)).toBe(0)
    // Wheel input before the first measurement is a no-op, not a guess.
    expect(scrollReducer(state, { type: 'wheel', delta: 3 })).toBe(state)
    expect(transcriptMarginTop(state)).toBe(0)
  })

  it('scrolls toward older content and clamps at the top', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 3 })
    expect(up.offset).toBe(3)
    const top = scrollReducer(up, { type: 'wheel', delta: 1000 })
    expect(top.offset).toBe(maxOffset(measured)) // 70
    expect(scrollReducer(top, { type: 'wheel', delta: 3 })).toBe(top)
  })

  it('scrolls back down and clamps at the live bottom', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 10 })
    const down = scrollReducer(up, { type: 'wheel', delta: -4 })
    expect(down.offset).toBe(6)
    const bottom = scrollReducer(down, { type: 'wheel', delta: -1000 })
    expect(bottom.offset).toBe(0)
  })

  it('pages by the window minus a 2-row overlap', () => {
    const up = scrollReducer(measured, { type: 'page', delta: 1 })
    expect(up.offset).toBe(28) // 30 - 2
    const down = scrollReducer(up, { type: 'page', delta: -1 })
    expect(down.offset).toBe(0)
  })

  it('returns to the bottom', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 25 })
    expect(scrollReducer(up, { type: 'bottom' }).offset).toBe(0)
    expect(scrollReducer(measured, { type: 'bottom' })).toBe(measured)
  })

  it('re-anchors on content growth while scrolled up', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 20 })
    const grew = scrollReducer(up, { type: 'measure', contentRows: 105, windowRows: 30 })
    // Five new rows landed below the reading position.
    expect(grew.offset).toBe(25)
    expect(grew.contentRows).toBe(105)
  })

  it('stays at the live bottom through growth while sticky', () => {
    const grew = scrollReducer(measured, { type: 'measure', contentRows: 130, windowRows: 30 })
    expect(grew.offset).toBe(0)
  })

  it('clamps when content shrinks while scrolled up', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 65 }) // near the top: offset 65
    const shrank = scrollReducer(up, { type: 'measure', contentRows: 80, windowRows: 30 })
    expect(shrank.offset).toBe(maxOffset(shrank)) // 50
  })

  it('resets on view switch', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 20 })
    expect(scrollReducer(up, { type: 'reset' })).toEqual(createScrollState())
  })
})

describe('transcriptMarginTop', () => {
  it('bottom-anchors content shorter than the window', () => {
    const state: ScrollState = { offset: 0, contentRows: 5, windowRows: 30 }
    // Content sits 25 rows below the window top: it ends at the live bottom.
    expect(transcriptMarginTop(state)).toBe(25)
  })

  it('shows the live bottom at offset 0 with overflowing content', () => {
    const state: ScrollState = { offset: 0, contentRows: 100, windowRows: 30 }
    expect(transcriptMarginTop(state)).toBe(-70)
  })

  it('moves the content down while scrolled up', () => {
    const state: ScrollState = { offset: 10, contentRows: 100, windowRows: 30 }
    expect(transcriptMarginTop(state)).toBe(-60)
  })
})
