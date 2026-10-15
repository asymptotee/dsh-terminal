/**
 * The multiline input editor and the `/` completion menu. The bar owns the
 * single stdin listener (useInput + usePaste) for the whole surface, routing
 * keys by focus mode: input, panel, child, job detail, or a pending approval.
 * @module dsh-terminal/src/input-bar
 */

// Classic-JSX source launch needs the React namespace in scope.
import React, { useState } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import stringWidth from 'string-width'
import type { ScrollAction } from '../terminal.ts'
import { containsMouseReport, wheelDeltaFromInput } from '../terminal.ts'
import type { CommandInfo, InputHandlers, StatusInfo } from './view-types.ts'
import { padToWidth, truncateToWidth } from '../text-helpers.ts'
import { useTerminalWidth } from '../use-terminal.ts'
import { StatusBar } from './chrome.tsx'

/** The dim note a read-only child's box shows where the editor would be. */
export const READ_ONLY_CHILD_NOTE = '当前子代理不接受新消息'

/** Rows the slash completion menu shows before windowing around the selection. */
const MENU_MAX_ROWS = 8

/** Gap between the padded name column and the aligned descriptions. */
const MENU_DESCRIPTION_GAP = 3

/** The multiline input editor: typing, cursor, history, Enter/Ctrl+J/Ctrl+C/Ctrl+D. */
export function InputBar({
  handlers,
  approvalPending,
  approvalSelected,
  onToggleExpand,
  onApprovalSelect,
  onScroll,
  onFirstInput,
  history = [],
  focusMode = 'input',
  childPromptable = false,
  childReadOnly = false,
  childReadOnlyNote,
  childPlaceholder,
  jobDetailOpen = false,
  panelAvailable = false,
  commands = [],
  status,
  statusHint,
}: {
  handlers: InputHandlers
  approvalPending: boolean
  /** The arrow-selected approval option, committed by Enter. */
  approvalSelected: number
  /** Toggle long tool outputs between truncated and full (the `l` key). */
  onToggleExpand: () => void
  /** Move the arrow selection of the pending approval question. */
  onApprovalSelect: (delta: number) => void
  /** Scroll the transcript: wheel notches and PageUp/PageDown. */
  onScroll?: (action: ScrollAction) => void
  /** Fired once when the buffer first becomes non-empty (typing or paste). */
  onFirstInput?: () => void
  /** The session's submitted lines; the arrows browse them (log-restored on resume). */
  history?: readonly string[]
  /** Which surface owns the keys; the panel, child view, and job detail borrow
   *  them from the editor. */
  focusMode?: 'input' | 'panel' | 'child' | 'job'
  /** The opened child is continuable: the child view borrows the editor to
   *  send continuation prompts (Enter steers, Esc returns). */
  childPromptable?: boolean
  /** A read-only child is open: the box draws with a dim note in place of
   *  an editor (identity plus the reason it takes no keys). */
  childReadOnly?: boolean
  /** The read-only box's dim note; defaults to the generic note when the
   *  caller has no child identity to fold in. */
  childReadOnlyNote?: string
  /** Identity-and-keys placeholder shown dim inside the empty child editor. */
  childPlaceholder?: string
  /** A job detail owns the transcript window: the input region collapses to
   *  the standing footer (the detail draws its own light-blue rules). */
  jobDetailOpen?: boolean
  /** Whether the subagent panel has rows, so `↓` from an empty editor can enter it. */
  panelAvailable?: boolean
  /** The registered slash commands; a leading-`/` buffer opens the completion menu. */
  commands?: readonly CommandInfo[]
  /** The footer facts; while the completion menu is open it takes this slot. */
  status?: StatusInfo
  /** Panel key hints trailing the permission row of the footer (the workflow
   *  panel's navigation keys, shown in the main and child views alike). */
  statusHint?: string
}): React.JSX.Element {
  // A ref mirror keeps the key handler's reads fresh even when several keys
  // land inside one render cycle (ink throttles re-renders).
  const bufferRef = React.useRef({ value: '', cursor: 0 })
  const [buffer, setBufferState] = useState(bufferRef.current)
  const historyRef = React.useRef<readonly string[]>(history)
  // The session log is the authority once it has caught up: the driver mounts
  // this bar before the replay folds, so the effect adopts the restored lines
  // as they land in the frames. A shorter prop than the local list means the
  // frames lag behind the bar's own optimistic commits (or the harness never
  // echoes them) — adopting it would wipe lines the user just submitted, so
  // the local list wins until the log is at least as long.
  React.useEffect(() => {
    if (history.length >= historyRef.current.length) historyRef.current = history
  }, [history])
  const [historyIndex, setHistoryIndex] = useState(-1)
  // Two Ctrl+C presses within a second (with an empty buffer) quit.
  const lastInterruptRef = React.useRef(0)
  // Slash-menu transient state: the arrow-selected row and the Esc dismissal.
  // Ref mirrors keep key handlers fresh when several keys land inside one
  // throttled render cycle, mirroring the buffer ref's rationale.
  const [menuIndex, setMenuIndexState] = useState(0)
  const menuIndexRef = React.useRef(0)
  const [menuHidden, setMenuHiddenState] = useState(false)
  const menuHiddenRef = React.useRef(false)
  const setMenuIndex = (next: number): void => { menuIndexRef.current = next; setMenuIndexState(next) }
  const setMenuHidden = (next: boolean): void => { menuHiddenRef.current = next; setMenuHiddenState(next) }
  // The slash menu's candidates for a buffer value: the buffer must be typing
  // a command name — a leading slash with no whitespace yet — and match at
  // one prefix. Anything else (space starts the args, Esc dismissal handled
  // by the caller) yields no menu.
  const commandMatchesFor = (value: string): readonly CommandInfo[] =>
    focusMode === 'input' && !approvalPending && value.startsWith('/') && !/\s/.test(value)
      ? commands.filter(command => command.name.startsWith(value.slice(1)))
      : []

  const setBuffer = (next: { value: string; cursor: number }): void => {
    const wasEmpty = bufferRef.current.value === ''
    const changed = bufferRef.current.value !== next.value
    bufferRef.current = next
    setBufferState(next)
    // The welcome splash is dismissed by the first text entering the box.
    if (wasEmpty && next.value !== '') onFirstInput?.()
    // Any edit re-derives the menu: selection falls back to the first match,
    // and an Esc dismissal lifts so filtering can reopen the menu.
    if (changed) { setMenuIndex(0); setMenuHidden(false) }
  }

  useInput((input, key) => {
    // Mouse tracking reports (wheel, clicks) arrive as ordinary input since
    // ink has no mouse support: wheel notches scroll the transcript, every
    // other report is swallowed — none may reach the editor buffer. These run
    // before the approval/panel/child branches so scrolling works everywhere.
    if (containsMouseReport(input)) {
      const delta = wheelDeltaFromInput(input)
      if (delta !== 0) onScroll?.({ type: 'wheel', delta })
      return
    }
    if (key.pageUp) {
      onScroll?.({ type: 'page', delta: 1 })
      return
    }
    if (key.pageDown) {
      onScroll?.({ type: 'page', delta: -1 })
      return
    }
    const { value, cursor } = bufferRef.current
    if (approvalPending) {
      // The pending question owns the keys: y and Enter-on-Yes allow, n and
      // Enter-on-No reject, Esc cancels (the request is withdrawn, distinct
      // from an answered rejection), the arrows move the selection;
      // everything else waits.
      if (input === 'y') handlers.onApproval('allow')
      if (input === 'n') handlers.onApproval('reject')
      if (key.escape) handlers.onApproval('cancel')
      if (key.upArrow) onApprovalSelect(-1)
      if (key.downArrow) onApprovalSelect(1)
      if (key.return) handlers.onApproval(approvalSelected === 0 ? 'allow' : 'reject')
      return
    }
    if (focusMode === 'job') {
      // The job detail owns the window: Esc or Enter closes it back to the
      // roster (the cursor stays), x fires the two-step stop gesture, and
      // everything else waits.
      if (key.escape || key.return) { handlers.onPanelBack(); return }
      if (input === 'x') { handlers.onJobKill(); return }
      return
    }
    if (focusMode === 'child') {
      // Esc steps back: one press from a read-only child, the second press
      // from a continuable child's editor (the first lands there).
      if (key.escape) { handlers.onPanelBack(); return }
      // ↓ hands the keys to the panels — starting on the open child's own row
      // — so Enter switches to another transcript without leaving the child
      // view; the continuable editor asks for an empty buffer first, the
      // read-only view has nothing to protect.
      if (key.downArrow && panelAvailable && (!childPromptable || value === '')) {
        handlers.onPanelOpen()
        return
      }
      if (!childPromptable) return
      if (key.return) {
        const text = value.trim()
        if (text === '') return
        setBuffer({ value: '', cursor: 0 })
        handlers.onChildPrompt(text)
        return
      }
      if (key.ctrl && input === 'c') {
        // The child's turn belongs to its own agent: Ctrl+C only clears the
        // buffer here — interrupt and quit stay owned by the main view.
        setBuffer({ value: '', cursor: 0 })
        return
      }
      // The main history's arrows do not apply; every other key falls through
      // to the shared editing tail (cursor motion, deletion, Ctrl+J newline,
      // Ctrl+D exit, typed input).
      if (key.upArrow || key.downArrow) return
    }
    if (focusMode === 'panel') {
      // The panel owns the arrows, Enter (open the selected row), and Esc.
      if (key.upArrow) handlers.onPanelMove(-1)
      else if (key.downArrow) handlers.onPanelMove(1)
      else if (key.return) handlers.onPanelEnter()
      else if (key.escape) handlers.onPanelBack()
      return
    }
    // The open slash menu owns the arrows, Tab/Enter (complete, never commit —
    // executing takes a second Enter on the completed line), and Esc (dismiss
    // the menu only; the buffer stays and the turn is not interrupted). Every
    // other key falls through to normal editing, which re-derives the menu.
    const matches = commandMatchesFor(bufferRef.current.value)
    if (matches.length > 0 && !menuHiddenRef.current) {
      if (key.escape) { setMenuHidden(true); return }
      if (key.upArrow) { setMenuIndex(Math.max(0, menuIndexRef.current - 1)); return }
      if (key.downArrow) { setMenuIndex(Math.min(matches.length - 1, menuIndexRef.current + 1)); return }
      if (key.tab || key.return) {
        const pick = matches[Math.min(menuIndexRef.current, matches.length - 1)]
        if (pick !== undefined) setBuffer({ value: `/${pick.name} `, cursor: pick.name.length + 2 })
        return
      }
    }
    if (key.escape) {
      // Esc interrupts the running turn; it never quits.
      handlers.onInterrupt()
      return
    }
    if (key.ctrl && input === 'c') {
      if (value !== '') {
        setBuffer({ value: '', cursor: 0 })
        return
      }
      const now = Date.now()
      if (now - lastInterruptRef.current < 1000) {
        handlers.onExit()
      } else {
        lastInterruptRef.current = now
        handlers.onInterrupt()
      }
      return
    }
    if (key.ctrl && input === 'd') {
      handlers.onExit()
      return
    }
    if (key.return) {
      const text = value.trim()
      if (text === '') return
      historyRef.current = [...historyRef.current, text]
      setHistoryIndex(-1)
      setBuffer({ value: '', cursor: 0 })
      handlers.onCommit(text)
      return
    }
    if (input === '\n') {
      // Ctrl+J: a literal newline. Alt+Enter is not distinguishable from
      // Enter on common terminals, so the newline key is the multiline input.
      setBuffer({ value: value.slice(0, cursor) + '\n' + value.slice(cursor), cursor: cursor + 1 })
      return
    }
    if (key.leftArrow) { setBuffer({ value, cursor: Math.max(0, cursor - 1) }); return }
    if (key.rightArrow) { setBuffer({ value, cursor: Math.min(value.length, cursor + 1) }); return }
    if (key.home) { setBuffer({ value, cursor: 0 }); return }
    if (key.end) { setBuffer({ value, cursor: value.length }); return }
    if (key.backspace) {
      if (cursor > 0) setBuffer({ value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 })
      return
    }
    if (key.delete) {
      if (cursor < value.length) setBuffer({ value: value.slice(0, cursor) + value.slice(cursor + 1), cursor })
      return
    }
    if (key.ctrl && input === 'o') {
      // Ctrl+O toggles truncated outputs between truncated and full.
      onToggleExpand()
      return
    }
    const history = historyRef.current
    if (key.upArrow) {
      if (history.length === 0) return
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      const recalled = history[next]
      if (recalled !== undefined) setBuffer({ value: recalled, cursor: recalled.length })
      return
    }
    if (key.downArrow) {
      if (historyIndex < 0) {
        // An empty editor's `↓` enters the subagent panel when it has rows.
        if (value === '' && panelAvailable) handlers.onPanelOpen()
        return
      }
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(-1)
        setBuffer({ value: '', cursor: 0 })
      } else {
        setHistoryIndex(next)
        const recalled = history[next]
        if (recalled !== undefined) setBuffer({ value: recalled, cursor: recalled.length })
      }
      return
    }
    if (input !== '') {
      // Fallback for terminals without bracketed paste: a pasted chunk that
      // reaches useInput carries CR/CRLF line endings, which the renderer
      // (split on LF) would draw as overlapping lines. Normalize to LF so the
      // paste lands as proper buffer newlines. A lone Enter is handled above
      // (key.return) and never reaches here.
      const text = input.replace(/\r\n|\r/g, '\n')
      setBuffer({ value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length })
    }
  })

  // Bracketed paste (auto-enabled by usePaste) delivers the whole pasted string
  // on a channel separate from useInput, so multi-line paste never trips the
  // Enter-to-commit path. Normalize CR/CRLF to LF for the LF-splitting renderer.
  usePaste((text) => {
    const editable = focusMode === 'input' || (focusMode === 'child' && childPromptable)
    if (approvalPending || !editable) return
    const { value, cursor } = bufferRef.current
    const normalized = text.replace(/\r\n|\r/g, '\n')
    setBuffer({ value: value.slice(0, cursor) + normalized + value.slice(cursor), cursor: cursor + normalized.length })
  })

  const { value, cursor } = buffer
  const lines = value.split('\n')
  const beforeCursor = value.slice(0, cursor)
  const cursorLine = beforeCursor.split('\n').length - 1
  const cursorColumn = beforeCursor.length - beforeCursor.lastIndexOf('\n') - 1
  const width = useTerminalWidth()
  // The slash menu's live derivation off the rendered buffer; the selection is
  // clamped so a shrinking filter never points past the last match.
  const menuMatches = commandMatchesFor(value)
  const menuOpen = menuMatches.length > 0 && !menuHidden
  const menuSelected = Math.min(menuIndex, menuMatches.length - 1)
  // The approval panel owns the screen bottom: the bar renders nothing (the
  // ApprovalPanel takes its rows in the chrome band) while still owning the
  // question's keys through the handler above.
  if (approvalPending) return <Box />
  // A job detail owns the region below the transcript: the input bar (and its
  // status footer) yields entirely — the detail's own keys hint carries the
  // standing facts, so no duplicate footer line.
  if (jobDetailOpen) return <Box />
  // A read-only child (one-shot, or no descriptor mode known) takes no
  // prompts; its box still draws — in the child view's light-blue chrome —
  // with a dim note explaining the silence in place of a caret, and the
  // footer keeps the session's standing facts.
  if (childReadOnly) {
    const readOnlyRule = <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
    return (
      <Box flexDirection="column">
        {readOnlyRule}
        {/* Darker than the ordinary dim: the disabled gray tells the user
            the box takes no input before they try typing into it. */}
        <Text color="#696969">
          ❯ {truncateToWidth(childReadOnlyNote ?? READ_ONLY_CHILD_NOTE, Math.max(0, width - 2))}
        </Text>
        {readOnlyRule}
        <StatusBar status={status} {...(statusHint === undefined ? {} : { hint: statusHint })} />
      </Box>
    )
  }

  // The continuable child's editor wears the light-blue tint of the child
  // view's chrome; the main input keeps the dim rules.
  const rule = childPromptable
    ? <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
    : <Text dimColor>{'─'.repeat(width)}</Text>
  // An empty child editor shows the identity-and-keys placeholder in dim gray
  // behind the caret; the first typed character replaces the placeholder.
  const showPlaceholder = childPromptable && value === '' && childPlaceholder !== undefined
  // The wide block caret, steady (no blink). A focused panel (subagent or
  // team — including one entered from the child view) hides it so the
  // selection highlight stays unambiguous.
  const caretVisible = focusMode === 'input' || (focusMode === 'child' && childPromptable)
  const caretCell = <Text>█</Text>
  return (
    <Box flexDirection="column">
      {rule}
      {showPlaceholder
        ? (
          <Text>
            ❯ {caretVisible ? caretCell : null}<Text dimColor>{truncateToWidth(childPlaceholder ?? '', Math.max(0, width - 2))}</Text>
          </Text>
        )
        : lines.map((line, index) => {
          const marked = caretVisible && index === cursorLine
            ? (
              <>
                {line.slice(0, cursorColumn)}
                {caretCell}
                {line.slice(cursorColumn)}
              </>
            )
            : line
          return (
            <Text key={index}>
              {/* The prompt marker leads the first line in the body color; later
                  lines indent two columns so every line's text aligns. */}
              {index === 0 ? <Text>❯ </Text> : '  '}
              {marked}
            </Text>
          )
        })}
      {rule}
      {/* The completion menu and the status bar share one slot below the box:
          they swap in a single render, so opening the menu never paints an
          intermediate frame where both stack (the chrome band overshooting
          made the input box visibly jump before settling). */}
      {menuOpen
        ? <CommandMenu items={menuMatches} selected={menuSelected} width={width} />
        : <StatusBar status={status} {...(statusHint === undefined ? {} : { hint: statusHint })} />}
    </Box>
  )
}

/** The menu row's label segment: the slashed name plus its input hint. */
function commandLabel(item: CommandInfo): string {
  return `/${item.name}${item.hint === undefined ? '' : ` ${item.hint}`}`
}

/**
 * The `/` completion menu below the input bar (between the box and the status
 * bar): prefix-filtered commands with name, hint, and description, discovery-
 * menu styling — no marker column; the arrow-selected row turns the shared
 * highlight tint (#a5d8ff) in its entirety, every other row stays dim. Rows
 * beyond the cap window around the selection. No closing rule: the status
 * bar hides while the menu is up, so the rows simply end the chrome band.
 */
function CommandMenu({
  items,
  selected,
  width,
}: {
  items: readonly CommandInfo[]
  /** The arrow-selected index into `items`, already clamped by the caller. */
  selected: number
  width: number
}): React.JSX.Element {
  const start = items.length <= MENU_MAX_ROWS
    ? 0
    : Math.min(Math.max(0, selected - Math.floor(MENU_MAX_ROWS / 2)), items.length - MENU_MAX_ROWS)
  const visible = items.slice(start, start + MENU_MAX_ROWS)
  const hiddenBefore = start
  const hiddenAfter = items.length - start - visible.length
  // Descriptions align in one column: every label pads to the widest label in
  // the full match list (not just the visible window, so scrolling never
  // shifts the column), then the fixed gap follows.
  const nameCol = items.reduce((max, item) => Math.max(max, stringWidth(commandLabel(item))), 0)
  const descriptionBudget = Math.max(0, width - 2 - nameCol - MENU_DESCRIPTION_GAP)
  // The status bar's marginBottom={1} is what keeps the chrome band off the
  // very bottom row; the menu replaces the status bar while open, so it owns
  // the same bottom gap.
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hiddenBefore > 0 ? <Text dimColor>  … {hiddenBefore} more</Text> : null}
      {visible.map((item, index) => {
        const isSelected = start + index === selected
        const label = padToWidth(commandLabel(item), nameCol)
        const description = item.description === undefined ? '' : truncateToWidth(item.description, descriptionBudget)
        return isSelected ? (
          <Text key={item.name} color="#a5d8ff">
            <Text bold>  {label}</Text>{' '.repeat(MENU_DESCRIPTION_GAP)}{description}
          </Text>
        ) : (
          <Text key={item.name} dimColor>
            {'  '}{label}{' '.repeat(MENU_DESCRIPTION_GAP)}{description}
          </Text>
        )
      })}
      {hiddenAfter > 0 ? <Text dimColor>  … {hiddenAfter} more</Text> : null}
    </Box>
  )
}
