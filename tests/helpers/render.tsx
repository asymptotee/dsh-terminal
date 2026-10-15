/**
 * Shared ink-render test harness: renderApp wraps ink-testing-library with an
 * ANSI-stripping lastFrame and a global afterEach unmount so abandoned blink
 * timers never congest later tests. Used by the renderer-level suites.
 * @module dsh-terminal/tests/helpers/render
 */

import { afterEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { createFrameState } from '../../src/fold/frames.ts'
import type { Frame, FrameState } from '../../src/fold/frames.ts'
import type { InputHandlers } from '../../src/view/renderer.tsx'

/** Let the throttled ink render flush after a stdin write. */
export async function settled(ms = 30): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A frame state seeded with the given frames (and optional plan). */
export function state(frames: readonly Frame[], plan?: FrameState['plan']): FrameState {
  return { ...createFrameState(), frames, ...plan === undefined ? {} : { plan } }
}

/** Input handlers that do nothing; suites override the ones they assert on. */
export function noopHandlers(): InputHandlers {
  return {
    onCommit: () => {},
    onInterrupt: () => {},
    onApproval: () => {},
    onExit: () => {},
    onPanelOpen: () => {},
    onPanelMove: () => {},
    onPanelEnter: () => {},
    onPanelBack: () => {},
    onChildPrompt: () => {},
    onJobKill: () => {},
  }
}

/**
 * ink's render result with an ANSI-stripping `lastFrame`: ink emits color
 * codes whenever the ambient environment forces colors (FORCE_COLOR, CI), so
 * text assertions must not depend on the color state of the runner.
 */
// Every rendered ink instance unmounts when its test ends: the blinking
// dot/heartbeat intervals of abandoned instances would otherwise keep
// rendering dead apps throughout the file and congest the suite's timing.
const liveApps: { unmount(): void }[] = []
afterEach(() => {
  while (liveApps.length > 0) liveApps.pop()?.unmount()
})
export function renderApp(ui: React.JSX.Element) {
  const result = render(ui)
  liveApps.push(result)
  return {
    ...result,
    lastFrame: (): string => (result.lastFrame() ?? '').replace(/\[[0-9;]*[a-zA-Z]/g, ''),
  }
}
