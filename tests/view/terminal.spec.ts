/** The terminal takeover primitives: SGR mouse parsing and the scroll model. */

import { describe, expect, it } from 'vitest'
import {
  clickFromInput,
  clickRowInContent,
  colorLevelCorrection,
  containsMouseReport,
  moveFromInput,
  createScrollState,
  createScrollStates,
  hitFrameRow,
  maxOffset,
  mouseEnabled,
  scrollReducer,
  scrollStatesReducer,
  transcriptMarginTop,
  wheelDeltaFromInput,
  WHEEL_SCROLL_LINES,
} from '../../src/view/terminal.ts'
import type { ScrollState } from '../../src/view/terminal.ts'

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

describe('clickFromInput', () => {
  it('decodes a left press with ink\'s leading ESC stripped', () => {
    expect(clickFromInput('[<0;12;3M')).toEqual({ x: 12, y: 3 })
    expect(clickFromInput('\x1b[<0;12;3M')).toEqual({ x: 12, y: 3 })
  })

  it('masks modifier bits so shifted clicks still land', () => {
    expect(clickFromInput('[<4;7;8M')).toEqual({ x: 7, y: 8 }) // shift
  })

  it('ignores releases, other buttons, and wheel notches', () => {
    expect(clickFromInput('[<0;5;5m')).toBeUndefined() // release
    expect(clickFromInput('[<2;5;5M')).toBeUndefined() // right button
    expect(clickFromInput('[<64;5;5M')).toBeUndefined() // wheel
    expect(clickFromInput('hello')).toBeUndefined()
  })

  it('keeps the last press of a batched chunk', () => {
    expect(clickFromInput('[<0;1;1M\x1b[<0;9;9M')).toEqual({ x: 9, y: 9 })
  })
})

describe('moveFromInput', () => {
  it('decodes motion reports, button held or not', () => {
    expect(moveFromInput('[<35;12;3M')).toEqual({ x: 12, y: 3 }) // no button held
    expect(moveFromInput('[<32;4;9M')).toEqual({ x: 4, y: 9 }) // left drag
  })

  it('masks modifier bits so shifted motion still reports', () => {
    expect(moveFromInput('[<39;7;8M')).toEqual({ x: 7, y: 8 }) // shift + motion
  })

  it('ignores presses, releases, and wheel notches', () => {
    expect(moveFromInput('[<0;5;5M')).toBeUndefined() // press
    expect(moveFromInput('[<3;5;5m')).toBeUndefined() // release
    expect(moveFromInput('[<64;5;5M')).toBeUndefined() // wheel
    expect(moveFromInput('hello')).toBeUndefined()
  })

  it('keeps the last position of a batched motion chunk', () => {
    expect(moveFromInput('[<35;1;1M\x1b[<35;2;2M\x1b[<35;3;4M')).toEqual({ x: 3, y: 4 })
  })
})

describe('colorLevelCorrection', () => {
  it('boosts to truecolor on the hosts supports-color misreads', () => {
    expect(colorLevelCorrection({ WT_SESSION: 'abc' })).toBe(3)
    expect(colorLevelCorrection({ TERM_PROGRAM: 'vscode' })).toBe(3)
  })

  it('leaves plain hosts and an explicit 256-color request alone', () => {
    expect(colorLevelCorrection({})).toBeUndefined()
    expect(colorLevelCorrection({ WT_SESSION: 'abc', FORCE_COLOR: '2' })).toBeUndefined()
  })

  it('clamps to 256 inside tmux unless the setup vouches for truecolor', () => {
    expect(colorLevelCorrection({ TMUX: '/tmp/tmux-1000/default,1,0' })).toBe(2)
    // tmux wins even on a truecolor host: its re-emission is the bottleneck.
    expect(colorLevelCorrection({ WT_SESSION: 'abc', TMUX: '/tmp/x,1,0' })).toBe(2)
    expect(colorLevelCorrection({ WT_SESSION: 'abc', TMUX: '/tmp/x,1,0', DSH_TERMINAL_TMUX_TRUECOLOR: '1' })).toBe(3)
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

  it('keeps the top visible row fixed when the window height changes', () => {
    // offset 60 of {content 100, window 30} shows content row 10 at the top;
    // the pill joining the chrome band shrinks the window to 29 — the offset
    // rides along so row 10 stays at the top (and a clamp computed against
    // the old height does not strand the view one row short).
    const up = scrollReducer(measured, { type: 'wheel', delta: 60 })
    const shrunk = scrollReducer(up, { type: 'measure', contentRows: 100, windowRows: 29 })
    expect(shrunk.offset).toBe(61) // 100 - 29 - 61 = 10, the same top row
    const grown = scrollReducer(shrunk, { type: 'measure', contentRows: 100, windowRows: 30 })
    expect(grown.offset).toBe(60)
  })

  it('resets on view switch', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 20 })
    expect(scrollReducer(up, { type: 'reset' })).toEqual(createScrollState())
  })
})

describe('resize (thinking toggle)', () => {
  const measured: ScrollState = { offset: 0, contentRows: 100, windowRows: 30 }

  it('stays sticky at the live bottom in both directions', () => {
    const grown = scrollReducer(measured, { type: 'resize', delta: 8 })
    expect(grown).toEqual({ offset: 0, contentRows: 108, windowRows: 30 })
    expect(scrollReducer(grown, { type: 'resize', delta: -8 })).toEqual(measured)
  })

  it('borrows and repays the offset when scrolled up, round-tripping exactly', () => {
    const up = scrollReducer(measured, { type: 'wheel', delta: 20 })
    const grown = scrollReducer(up, { type: 'resize', delta: 8 })
    expect(grown.contentRows).toBe(108)
    expect(grown.offset).toBe(28) // the reading position holds
    const shrunk = scrollReducer(grown, { type: 'resize', delta: -8 })
    expect(shrunk).toEqual(up) // collapse lands back exactly
  })

  it('clamps the repaid offset at the top and the live bottom', () => {
    const nearTop = scrollReducer(measured, { type: 'wheel', delta: 3 })
    const shrunk = scrollReducer(nearTop, { type: 'resize', delta: -10 })
    expect(shrunk.offset).toBe(0)
    expect(shrunk.contentRows).toBe(90)
  })

  it('is identity-stable for a zero delta', () => {
    expect(scrollReducer(measured, { type: 'resize', delta: 0 })).toBe(measured)
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

describe('clickRowInContent', () => {
  const measured: ScrollState = { offset: 0, contentRows: 100, windowRows: 30 }

  it('maps the viewport row into scrolled content coordinates', () => {
    // Sticky at the live bottom: content rows 70..99 fill window rows 1..30.
    expect(clickRowInContent(measured, 1)).toBe(70)
    expect(clickRowInContent(measured, 30)).toBe(99)
    const scrolled = scrollReducer(measured, { type: 'wheel', delta: 10 })
    // Scrolled ten rows up: content rows 60..89 are on screen.
    expect(clickRowInContent(scrolled, 1)).toBe(60)
  })

  it('rejects clicks outside the window or before measurement', () => {
    expect(clickRowInContent(measured, 31)).toBeUndefined() // the chrome band
    expect(clickRowInContent(measured, 0)).toBeUndefined()
    expect(clickRowInContent(createScrollState(), 5)).toBeUndefined()
  })

  it('ignores rows below the content edge of a short transcript', () => {
    const short: ScrollState = { offset: 0, contentRows: 5, windowRows: 30 }
    // The content occupies the bottom five window rows (26..30).
    expect(clickRowInContent(short, 25)).toBeUndefined()
    expect(clickRowInContent(short, 26)).toBe(0)
    expect(clickRowInContent(short, 30)).toBe(4)
  })
})

describe('hitFrameRow', () => {
  it('walks measured frame heights with their one-row margins', () => {
    // Frames of 2 and 3 rows: rows 0-1 frame 0, row 2 the margin, 3-5 frame 1.
    expect(hitFrameRow([2, 3], 0, 0)).toEqual({ index: 0, rowInFrame: 0 })
    expect(hitFrameRow([2, 3], 1, 0)).toEqual({ index: 0, rowInFrame: 1 })
    expect(hitFrameRow([2, 3], 2, 0)).toBeUndefined() // the margin gap
    expect(hitFrameRow([2, 3], 3, 0)).toEqual({ index: 1, rowInFrame: 0 })
    expect(hitFrameRow([2, 3], 5, 0)).toEqual({ index: 1, rowInFrame: 2 })
    expect(hitFrameRow([2, 3], 6, 0)).toBeUndefined() // past the last frame
  })

  it('skips the leading elided-frames notice row', () => {
    expect(hitFrameRow([2], 0, 1)).toBeUndefined() // the notice itself
    expect(hitFrameRow([2], 1, 1)).toEqual({ index: 0, rowInFrame: 0 })
  })
})

describe('keyed scroll states', () => {
  it('anchors a returning visit at the live bottom with remembered heights', () => {
    let states = createScrollStates()
    states = scrollStatesReducer(states, { type: 'measure', contentRows: 100, windowRows: 20 })
    states = scrollStatesReducer(states, { type: 'wheel', delta: 30 })
    expect(states.entries.main).toEqual({ offset: 30, contentRows: 100, windowRows: 20 })
    // First visit to a child starts fresh (it will park and measure).
    states = scrollStatesReducer(states, { type: 'switch', key: 'child-1' })
    expect(states.active).toBe('child-1')
    expect(states.entries['child-1']).toEqual(createScrollState())
    states = scrollStatesReducer(states, { type: 'measure', contentRows: 10, windowRows: 25 })
    // Returning to main: heights remembered (no park, no blank frame),
    // offset re-anchored at the live bottom.
    states = scrollStatesReducer(states, { type: 'switch', key: 'main' })
    expect(states.active).toBe('main')
    expect(states.entries.main).toEqual({ offset: 0, contentRows: 100, windowRows: 20 })
    // The child's entry keeps its own measurements for the next visit.
    expect(states.entries['child-1']).toEqual({ offset: 0, contentRows: 10, windowRows: 25 })
  })

  it('routes per-view actions to the active entry only', () => {
    let states = scrollStatesReducer(createScrollStates(), { type: 'switch', key: 'child-1' })
    states = scrollStatesReducer(states, { type: 'measure', contentRows: 8, windowRows: 25 })
    expect(states.entries['child-1']).toEqual({ offset: 0, contentRows: 8, windowRows: 25 })
    expect(states.entries.main).toBeUndefined()
  })

  it('is identity-stable when switching to the already-active view', () => {
    const states = createScrollStates()
    expect(scrollStatesReducer(states, { type: 'switch', key: 'main' })).toBe(states)
  })
})
