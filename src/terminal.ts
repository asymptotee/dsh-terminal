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

/** One decoded SGR mouse report (`CSI < b;x;y M|m`). */
export interface SgrMouseEvent {
  /** Raw button code; 64/65 are the wheel directions. */
  button: number
  /** 1-based report coordinates (unused for wheel scrolling, kept for hit-testing later). */
  x: number
  y: number
  /** True for the release event (`m`); wheel reports are press-only in practice. */
  release: boolean
}

/**
 * Parse SGR mouse reports out of a raw stdin chunk. Text typed between
 * reports is ignored. A trailing incomplete sequence stays unconsumed — the
 * caller keeps it buffered for the next chunk (pty reads can split anywhere).
 */
export function parseSgrMouse(chunk: string): { events: readonly SgrMouseEvent[]; consumed: number } {
  const events: SgrMouseEvent[] = []
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(chunk)) !== null) {
    events.push({
      button: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      release: match[4] === 'm',
    })
    consumed = re.lastIndex
  }
  return { events, consumed }
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
      const next = { offset: state.offset, contentRows: action.contentRows, windowRows: action.windowRows }
      // Content growth while scrolled up keeps the user's absolute position:
      // the new rows land below what they are reading. Shrinkage clamps.
      const growth = action.contentRows - state.contentRows
      const offset = state.offset > 0
        ? Math.min(Math.max(0, state.offset + Math.max(0, growth)), maxOffset(next))
        : 0
      return { ...next, offset }
    }
    case 'reset':
      return createScrollState()
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
