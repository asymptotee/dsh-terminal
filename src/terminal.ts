/**
 * Terminal takeover primitives for the fullscreen renderer: the alternate
 * screen and mouse-tracking escape sequences, the SGR mouse report parser, and
 * the pure transcript scroll model. The scroll state is measured, never
 * estimated — heights come from the laid-out tree (measureElement), so no
 * width/wrapping arithmetic lives here. No upstream imports: the module stays
 * inside the adapter boundary.
 * @module dsh-terminal/src/terminal
 */

/** Enter the alternate screen: the app owns the whole viewport. */
export const ENTER_FULLSCREEN = '\x1b[?1049h'

/** Leave the alternate screen, restoring the terminal's previous content. */
export const EXIT_FULLSCREEN = '\x1b[?1049l'

/** Enable mouse button tracking (wheel included) with SGR extended reports. */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'

/** Disable mouse tracking, returning the wheel to the terminal emulator. */
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l'

/** Hide the hardware cursor. Written raw at takeover: ink only hides it on
 *  its first flushed render, which a slow session resume defers for seconds —
 *  leaving the shell cursor blinking on the blank alternate screen. The UI
 *  draws its own caret, and ink never shows the cursor on its own. */
export const CURSOR_HIDE = '\x1b[?25l'

/** Show the hardware cursor again, restoring the shell's blinking caret. */
export const CURSOR_SHOW = '\x1b[?25h'

/**
 * Whether mouse tracking is wanted. `DSH_TERMINAL_MOUSE=0` (or `false`)
 * disables it: keyboard scrolling still works, and native terminal selection
 * needs no Shift bypass.
 */
export function mouseEnabled(env: { DSH_TERMINAL_MOUSE?: string } = process.env): boolean {
  return env.DSH_TERMINAL_MOUSE !== '0' && env.DSH_TERMINAL_MOUSE !== 'false'
}

/** SGR wheel button codes. */
export const WHEEL_UP = 64
export const WHEEL_DOWN = 65

/** Lines one wheel notch scrolls. */
export const WHEEL_SCROLL_LINES = 3

/**
 * An SGR mouse report as it survives ink's input pipeline: ink strips the
 * leading ESC from the first sequence in a chunk, so both `[<b;x;yM` and
 * `\x1b[<b;x;yM` occur (fast wheel notches batch into one chunk).
 */
const MOUSE_REPORT = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g

/** Whether a useInput string carries mouse reports that must not reach the
 *  editor buffer (wheel notches, clicks, releases). */
export function containsMouseReport(input: string): boolean {
  MOUSE_REPORT.lastIndex = 0
  return MOUSE_REPORT.test(input)
}

/**
 * The total wheel-scroll row delta of a useInput string: positive scrolls
 * toward older content. Modifier bits (shift/alt/ctrl = 4/8/16) are masked so
 * modified wheel notches still scroll; clicks and releases contribute 0.
 */
export function wheelDeltaFromInput(input: string): number {
  MOUSE_REPORT.lastIndex = 0
  let delta = 0
  let match: RegExpExecArray | null
  while ((match = MOUSE_REPORT.exec(input)) !== null) {
    const base = Number(match[1]) & ~28
    if (base === WHEEL_UP) delta += WHEEL_SCROLL_LINES
    else if (base === WHEEL_DOWN) delta -= WHEEL_SCROLL_LINES
  }
  return delta
}

/**
 * The transcript scroll position: rows above the live bottom (0 = sticky at
 * the bottom, auto-following new output) plus the measured content and window
 * heights in rows. Both heights are 0 until the first layout measurement.
 */
export interface ScrollState {
  readonly offset: number
  readonly contentRows: number
  readonly windowRows: number
}

export type ScrollAction =
  /** Scroll by `delta` rows toward older content (negative scrolls down). */
  | { type: 'wheel'; delta: number }
  /** Scroll by `delta` pages; a page is the window minus a 2-row overlap. */
  | { type: 'page'; delta: number }
  /** Return to the live bottom. */
  | { type: 'bottom' }
  /** Adopt freshly measured heights; growth while scrolled up re-anchors. */
  | { type: 'measure'; contentRows: number; windowRows: number }
  /** Drop all state (view switch: main transcript ↔ child transcript). */
  | { type: 'reset' }

export function createScrollState(): ScrollState {
  return { offset: 0, contentRows: 0, windowRows: 0 }
}

/** The furthest scroll-up position: the content rows overflowing the window. */
export function maxOffset(state: ScrollState): number {
  return Math.max(0, state.contentRows - state.windowRows)
}

/**
 * The pure scroll transitions. Clamping uses the measured heights, so wheel
 * input before the first measurement is a no-op instead of a guess.
 */
export function scrollReducer(state: ScrollState, action: ScrollAction): ScrollState {
  switch (action.type) {
    case 'wheel':
    case 'page': {
      const step = action.type === 'page' ? Math.max(1, state.windowRows - 2) : action.delta
      const delta = action.type === 'page' ? action.delta * step : step
      const offset = Math.min(Math.max(0, state.offset + delta), maxOffset(state))
      return offset === state.offset ? state : { ...state, offset }
    }
    case 'bottom':
      return state.offset === 0 ? state : { ...state, offset: 0 }
    case 'measure': {
      // Equal measurements return the identical state so React bails out —
      // the measure effect re-runs on every render and must not re-render.
      if (action.contentRows === state.contentRows && action.windowRows === state.windowRows) return state
      const next = { offset: state.offset, contentRows: action.contentRows, windowRows: action.windowRows }
      // Content growth while scrolled up keeps the user's absolute position:
      // the new rows land below what they are reading. Shrinkage clamps.
      const growth = action.contentRows - state.contentRows
      const offset = state.offset > 0
        ? Math.min(Math.max(0, state.offset + Math.max(0, growth)), maxOffset(next))
        : 0
      return { ...next, offset }
    }
    case 'reset': {
      // Identity-stable when already fresh, so the mount-time reset and the
      // per-render measure loop converge without extra renders.
      const fresh = createScrollState()
      return state.offset === fresh.offset && state.contentRows === fresh.contentRows && state.windowRows === fresh.windowRows
        ? state
        : fresh
    }
  }
}

/**
 * The `marginTop` (rows, usually negative) that positions the transcript
 * content inside its window: bottom-anchored while the content fits or the
 * user is at the live bottom, scrolled `offset` rows up otherwise. Before the
 * first measurement it is 0 (top-aligned), which the measure pass corrects.
 */
export function transcriptMarginTop(state: ScrollState): number {
  if (state.windowRows === 0 || state.contentRows === 0) return 0
  return state.windowRows - state.contentRows + state.offset
}

/**
 * Pre-measurement parking position for a frames transcript: far enough above
 * the window that the first paint shows an empty window instead of a
 * top-aligned flash that visibly jumps down when the measured bottom
 * anchoring lands one frame later.
 */
export const PRE_MEASURE_MARGIN = -1_000_000
