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
    onQuestionAnswer: () => {},
    onCyclePermission: () => {},
    onPickerMove: () => {},
    onPickerConfirm: () => {},
    onPickerCancel: () => {},
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
/**
 * Click the collapsed shell run whose count row reads `label` (or the first
 * count row when omitted), revealing its member cards. A settled shell call
 * folds to one `● Ran N shell command` row — even a lone call — so a test
 * that asserts a card's body must open the run first, exactly as a reader
 * does.
 * @param app - the renderApp result.
 * @param label - the count row's leading text; defaults to `Ran 1 shell command`.
 * @returns whether a count row was found and clicked.
 */
export async function openShellRun(
  app: { lastFrame(): string; stdin: { write(data: string): void } },
  label = '',
): Promise<boolean> {
  const rows = app.lastFrame().split('\n')
  // Default to any episode row: the sentence may start `Ran`, `Read`,
  // `Searched`, or with `Thought`, depending on what the run did.
  const row = label === ''
    ? rows.findIndex(line => /^\s*(●\s*)?(Thought|Thinking|Ran|Running|Read|Reading|Searched|Searching)/.test(line))
    : rows.findIndex(line => line.includes(label))
  if (row === -1) return false
  app.stdin.write(`\x1b[<0;3;${row + 1}M`)
  // The toggle lands through the driver's throttled render, so give it the
  // same window the other click suites use rather than one frame's guess.
  await new Promise(resolve => setTimeout(resolve, 80))
  return true
}

/**
 * Render once and hand back the exact escape sequence ink wrote, with no
 * ANSI stripping. Color-asserting tests need this: the shared `lastFrame`
 * strips escapes so text assertions never depend on the runner's color
 * state, which also erases anything a test wants to say about a background
 * or a foreground it just set.
 * @param ui - the element to paint.
 * @returns the frame's raw text, escapes intact.
 */
export function renderRaw(ui: React.JSX.Element): string {
  const result = render(ui)
  liveApps.push(result)
  const raw = result.lastFrame() ?? ''
  return raw
}

export function renderApp(ui: React.JSX.Element) {
  const result = render(ui)
  liveApps.push(result)
  return {
    ...result,
    lastFrame: (): string => (result.lastFrame() ?? '').replace(/\[[0-9;]*[a-zA-Z]/g, ''),
  }
}
