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
import type { ScrollAction } from './terminal.ts'
import { clickFromInput, containsMouseReport, moveFromInput, wheelDeltaFromInput } from './terminal.ts'
import type { ClickPosition } from './terminal.ts'
import type { CommandInfo, InputHandlers, PickerPopupView, StatusInfo } from './view-types.ts'
import { padToWidth, titledRule, truncateToWidth } from './text-helpers.ts'
import { useTerminalWidth } from './use-terminal.ts'
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
  onClick,
  onHover,
  bottomHintVisible = false,
  onFirstInput,
  history = [],
  focusMode = 'input',
  childPromptable = false,
  childReadOnly = false,
  childReadOnlyNote,
  childPlaceholder,
  jobDetailOpen = false,
  questionPending = false,
  questionHasOptions = false,
  questionMultiSelect = false,
  questionTextDraft = '',
  onQuestionSelect,
  onQuestionToggle,
  onQuestionConfirm,
  onQuestionSkip,
  onQuestionStep,
  onQuestionTextChange,
  panelAvailable = false,
  commands = [],
  picker,
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
  /** A question batch owns the screen bottom: the bar renders nothing (the
   *  QuestionPanel takes its rows) while still routing the question's keys. */
  questionPending?: boolean
  /** The current question offers options (a menu) rather than free text. */
  questionHasOptions?: boolean
  /** The current question allows multiple option selections (space toggles). */
  questionMultiSelect?: boolean
  /** The current free-text draft for a no-options question, owned by TuiApp. */
  questionTextDraft?: string
  /** Move the arrow selection of the current question's options. */
  onQuestionSelect?: (delta: number) => void
  /** Toggle the arrow-selected option in a multi-select question. */
  onQuestionToggle?: () => void
  /** Confirm the current question (its selected options, or its text draft). */
  onQuestionConfirm?: () => void
  /** Skip the current question (an empty answer item). */
  onQuestionSkip?: () => void
  /** Walk the question step bar (←/→/Tab) across the batch and its Submit step. */
  onQuestionStep?: (delta: number) => void
  /** Replace the free-text draft as the user types a no-options answer. */
  onQuestionTextChange?: (text: string) => void
  /** Scroll the transcript: wheel notches and PageUp/PageDown. */
  onScroll?: (action: ScrollAction) => void
  /** A left click inside the transcript window, in 1-based SGR viewport
   *  coordinates; the caller hit-tests it against the measured frames. */
  onClick?: (position: ClickPosition) => void
  /** The pointer moved, in the same viewport coordinates; the caller tracks
   *  its hover affordances off it. */
  onHover?: (position: ClickPosition) => void
  /** The transcript sits off the live bottom (the blue pill is up): End and
   *  an empty-buffer Enter jump back; without it End keeps its editor role
   *  (cursor to the buffer's end). */
  bottomHintVisible?: boolean
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
  /** The picker popup's state; present while it floats above the box. */
  picker?: PickerPopupView
  /** The footer facts; the completion menu opens above the box and never
   *  displaces them. */
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
      if (delta !== 0) {
        onScroll?.({ type: 'wheel', delta })
        return
      }
      // No wheel notch: a left press goes to the transcript's click-to-expand
      // hit-test, a motion report to its hover tracking; every other report
      // (releases, other buttons) is swallowed.
      const click = clickFromInput(input)
      if (click !== undefined) {
        // While the completion menu or the effort picker overlays the
        // transcript's bottom rows, a click must not fall through to the
        // content (or the pill) hidden beneath it: both are keyboard-driven,
        // so the press is swallowed.
        const menuOpenNow = commandMatchesFor(bufferRef.current.value).length > 0 && !menuHiddenRef.current
        if (!menuOpenNow && picker === undefined) onClick?.(click)
        return
      }
      const move = moveFromInput(input)
      if (move !== undefined) onHover?.(move)
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
    if (key.end && bottomHintVisible) {
      // The pill's End promise holds only while it is up: at the live bottom
      // End keeps its editor role (cursor to the buffer's end).
      onScroll?.({ type: 'bottom' })
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
    if (questionPending) {
      // The pending question batch owns the keys, wizard-style: one question
      // at a time. An option question takes the arrows, space (multi-select
      // toggle), Enter (confirm), and Esc (skip). A free-text question types
      // into the TuiApp-owned draft (rendered by the QuestionPanel), and
      // Enter/Esc mean the same. The main buffer, history, and the slash menu
      // all stay untouched.
      if (key.escape) { onQuestionSkip?.(); return }
      if (key.return) { onQuestionConfirm?.(); return }
      // ←→ (and Tab/Shift+Tab) walk the step bar across the batch and its
      // Submit step, independent of the current question's kind.
      if (key.leftArrow || (key.tab && key.shift)) { onQuestionStep?.(-1); return }
      if (key.rightArrow || (key.tab && !key.shift)) { onQuestionStep?.(1); return }
      // ↑↓ always route to the TuiApp, which decides by step: the Submit
      // step's choice, an option question's cursor, or a no-op for text.
      if (key.upArrow) { onQuestionSelect?.(-1); return }
      if (key.downArrow) { onQuestionSelect?.(1); return }
      if (questionHasOptions) {
        if (input === ' ' && questionMultiSelect) { onQuestionToggle?.(); return }
        return
      }
      if (key.backspace) {
        onQuestionTextChange?.(questionTextDraft.slice(0, -1))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        // A pasted chunk reaching useInput carries CR/CRLF; normalize to LF
        // like the main editor does (the draft renders line-split).
        onQuestionTextChange?.(questionTextDraft + input.replace(/\r\n|\r/g, '\n'))
      }
      return
    }
    if (picker !== undefined) {
      // The picker owns the keys while it floats: ←/→ walk a scale, ↑/↓ walk
      // a list (both accepted so neither layout traps the other's keys),
      // Enter applies the selection, Esc cancels; everything else waits and
      // the editor buffer underneath is untouched.
      if (key.escape) { handlers.onPickerCancel(); return }
      if (key.leftArrow || key.upArrow) { handlers.onPickerMove(-1); return }
      if (key.rightArrow || key.downArrow) { handlers.onPickerMove(1); return }
      if (key.return) { handlers.onPickerConfirm(); return }
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
      if (!childPromptable) {
        // The read-only child has no buffer to protect: an empty Enter
        // honors the pill's jump when it is up.
        if (key.return && bottomHintVisible) onScroll?.({ type: 'bottom' })
        return
      }
      if (key.return) {
        const text = value.trim()
        if (text === '') {
          if (bottomHintVisible) onScroll?.({ type: 'bottom' })
          return
        }
        setBuffer({ value: '', cursor: 0 })
        handlers.onChildPrompt(text)
        // The continuation follows the child's conversation the same way.
        onScroll?.({ type: 'bottom' })
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
    // ⇧Tab cycles the session's permission preset — the Claude Code gesture —
    // ahead of the slash menu so plain Tab keeps completing and the cycle
    // stays available mid-typing.
    if (key.tab && key.shift) {
      handlers.onCyclePermission()
      return
    }
    // The open slash menu owns the arrows, Tab (complete the selected row to
    // type its arguments), Enter (execute the selected command at once), and
    // Esc (dismiss the menu only; the buffer stays and the turn is not
    // interrupted). Every other key falls through to normal editing, which
    // re-derives the menu.
    const matches = commandMatchesFor(bufferRef.current.value)
    if (matches.length > 0 && !menuHiddenRef.current) {
      if (key.escape) { setMenuHidden(true); return }
      if (key.upArrow) { setMenuIndex(Math.max(0, menuIndexRef.current - 1)); return }
      if (key.downArrow) { setMenuIndex(Math.min(matches.length - 1, menuIndexRef.current + 1)); return }
      if (key.tab) {
        const pick = matches[Math.min(menuIndexRef.current, matches.length - 1)]
        if (pick !== undefined) setBuffer({ value: `/${pick.name} `, cursor: pick.name.length + 2 })
        return
      }
      if (key.return) {
        // Enter executes the arrow-selected command: the commit runs exactly
        // as if the same line had been typed and submitted by hand — history
        // entry, the ❯ echo, the ⎿ outcome, all identical.
        const pick = matches[Math.min(menuIndexRef.current, matches.length - 1)]
        if (pick === undefined) return
        const text = `/${pick.name}`
        historyRef.current = [...historyRef.current, text]
        setHistoryIndex(-1)
        setBuffer({ value: '', cursor: 0 })
        handlers.onCommit(text)
        onScroll?.({ type: 'bottom' })
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
      if (text === '') {
        // The pill's Enter promise: an empty submit returns to the live
        // bottom; a typed buffer keeps committing as usual.
        if (bottomHintVisible) onScroll?.({ type: 'bottom' })
        return
      }
      historyRef.current = [...historyRef.current, text]
      setHistoryIndex(-1)
      setBuffer({ value: '', cursor: 0 })
      handlers.onCommit(text)
      // A submission follows the conversation: snap to the live bottom so
      // the echo and the answer it starts are on screen (a no-op when
      // already there).
      onScroll?.({ type: 'bottom' })
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
      if (recalled !== undefined) {
        setBuffer({ value: recalled, cursor: recalled.length })
        // A recalled line is restored text, not fresh typing: keep the slash
        // menu dismissed (setBuffer's edit path just lifted the dismissal),
        // so ↑/↓ keep walking the history — a bare recalled command would
        // otherwise reopen the menu over itself and own the arrows.
        setMenuHidden(true)
      }
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
        if (recalled !== undefined) {
          setBuffer({ value: recalled, cursor: recalled.length })
          setMenuHidden(true)
        }
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
  // A slash buffer may tint its command token with the shared light blue (the
  // line renderer gates on a full registered-name match); the main editor
  // only — a child's continuation prompt is not a command line.
  const commandInput = focusMode === 'input' && value.startsWith('/')
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
  // A pending ask_user_question owns the screen bottom: the bar renders
  // nothing (the QuestionPanel takes its rows in the chrome band) while still
  // routing the question's keys through the handler above.
  if (questionPending) return <Box />
  // A read-only child (one-shot, or no descriptor mode known) takes no
  // prompts; its box still draws — in the child view's light-blue chrome —
  // with a dim note explaining the silence in place of a caret, and the
  // footer keeps the session's standing facts.
  if (childReadOnly) {
    const readOnlyRule = <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
    // No title on a child's rule: the label names THIS session, and a child
    // transcript is not it.
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
  // view's chrome; the main input keeps the dim rules. The TOP rule carries
  // the session title at its right end — the title belongs to this session
  // alone, so a child transcript's box does not show the parent's. The bottom
  // rule stays plain: two labelled rules would read as two headers sandwiching
  // the editor.
  const title = childPromptable || childReadOnly ? '' : (status?.title ?? '')
  const rule = childPromptable
    ? <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
    : <Text dimColor>{'─'.repeat(width)}</Text>
  const topRule = childPromptable
    ? <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
    : <Text dimColor>{titledRule(width, title)}</Text>
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
      {/* The completion menu floats above the box, Claude Code style: an
          absolute overlay painted over the transcript's bottom rows, so the
          transcript content, the input box, and the footer all hold their
          rows — opening the menu never reflows anything. The effort picker
          floats the same way; the two never open together (the picker owns
          the keys, so the buffer never reaches the menu's prefix rule). */}
      {picker !== undefined ? <PickerPopup picker={picker} width={width} /> : null}
      {menuOpen ? <CommandMenu items={menuMatches} selected={menuSelected} width={width} /> : null}
      {topRule}
      {showPlaceholder
        ? (
          <Text>
            ❯ {caretVisible ? caretCell : null}<Text dimColor>{truncateToWidth(childPlaceholder ?? '', Math.max(0, width - 2))}</Text>
          </Text>
        )
        : lines.map((line, index) => {
          const hasCaret = caretVisible && index === cursorLine
          // The command token (the `/name`, up to the first whitespace) wears
          // the shared light blue once it completes a registered command's
          // name — an unfinished prefix or an unknown name stays body-colored,
          // and the arguments always do. Only the buffer's first line can
          // carry the token (a name never spans a newline). The caret takes
          // the tint of the segment it sits in; the ❯ marker stays outside.
          const tokenEnd = commandInput && index === 0 ? (/\s/.exec(line)?.index ?? line.length) : -1
          const tinted = tokenEnd >= 0 && commands.some(command => line.slice(1, tokenEnd) === command.name)
          const blue = (node: React.ReactNode): React.ReactNode => (
            node === '' || node === null ? null : <Text color="#a5d8ff">{node}</Text>
          )
          let body: React.ReactNode
          if (!hasCaret) {
            body = tinted
              ? <>{blue(line.slice(0, tokenEnd))}{line.slice(tokenEnd)}</>
              : line
          } else if (!tinted || cursorColumn > tokenEnd) {
            // The caret sits in the body-colored stretch: a plain line, an
            // untinted token, or a command's arguments past the token.
            const token = tinted ? blue(line.slice(0, tokenEnd)) : null
            const plainBefore = tinted ? line.slice(tokenEnd, cursorColumn) : line.slice(0, cursorColumn)
            body = <>{token}{plainBefore}{caretCell}{line.slice(cursorColumn)}</>
          } else {
            // The caret sits inside (or right at the end of) the blue token.
            body = (
              <>
                {blue(line.slice(0, cursorColumn))}
                <Text color="#a5d8ff">{caretCell}</Text>
                {blue(line.slice(cursorColumn, tokenEnd))}
                {line.slice(tokenEnd)}
              </>
            )
          }
          return (
            <Text key={index}>
              {/* The prompt marker leads the first line in the body color; later
                  lines indent two columns so every line's text aligns. */}
              {index === 0 ? <Text>❯ </Text> : '  '}
              {body}
            </Text>
          )
        })}
      {rule}
      <StatusBar status={status} {...(statusHint === undefined ? {} : { hint: statusHint })} />
    </Box>
  )
}

/** The menu row's label segment: the slashed name plus its input hint. */
function commandLabel(item: CommandInfo): string {
  return `/${item.name}${item.hint === undefined ? '' : ` ${item.hint}`}`
}

/**
 * The `/` completion menu floating above the input bar: an absolute overlay
 * whose negative `top` equals its own row count, so its bottom edge lands on
 * the box's top rule and its rows stack upward over the transcript's bottom
 * rows. It stays out of flow — the chrome band's height never changes, the
 * transcript never re-measures or re-anchors, and the footer holds its rows.
 * The overlay leads with one erased row — hiding the transcript line the
 * menu's arrival would otherwise crowd — and a light-blue rule (#a5d8ff)
 * capping the menu rows. Every row pads to the full terminal width: ink
 * paints writes per cell, and only the padded spaces erase the transcript
 * text underneath (without them it would dangle to the right of the narrower
 * menu rows). Contents: prefix-filtered commands with name, hint, and
 * description, discovery-menu styling — no marker column; the arrow-selected
 * row turns the shared highlight tint (#a5d8ff) in its entirety, every other
 * row stays dim. Rows beyond the cap window around the selection.
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
  // The overlay's negative `top` is its own row count: the bottom edge lands
  // on the input box's top rule and the rows stack upward out of flow — two
  // extra rows for the clear row and the light-blue cap rule above the menu.
  const rowCount = visible.length + (hiddenBefore > 0 ? 1 : 0) + (hiddenAfter > 0 ? 1 : 0) + 2
  return (
    <Box position="absolute" top={-rowCount} left={0} right={0} flexDirection="column">
      {/* One erased row hides the transcript line the overlay would otherwise
          crowd, and the light-blue rule caps the menu (both full-width, so
          the cells underneath are overwritten clean). */}
      <Text>{' '.repeat(width)}</Text>
      <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
      {hiddenBefore > 0 ? <Text dimColor>{padToWidth(`  … ${hiddenBefore} more`, width)}</Text> : null}
      {visible.map((item, index) => {
        const isSelected = start + index === selected
        const label = padToWidth(commandLabel(item), nameCol)
        const description = item.description === undefined ? '' : truncateToWidth(item.description, descriptionBudget)
        // Trailing spaces to the full width: the per-cell overwrite that
        // erases the transcript row underneath (ink trims them away again
        // when serializing the row, so the frame text stays clean).
        const pad = Math.max(0, width - 2 - nameCol - MENU_DESCRIPTION_GAP - stringWidth(description))
        return isSelected ? (
          <Text key={item.name} color="#a5d8ff">
            <Text bold>  {label}</Text>{' '.repeat(MENU_DESCRIPTION_GAP)}{description}{' '.repeat(pad)}
          </Text>
        ) : (
          <Text key={item.name} dimColor>
            {'  '}{label}{' '.repeat(MENU_DESCRIPTION_GAP)}{description}{' '.repeat(pad)}
          </Text>
        )
      })}
      {hiddenAfter > 0 ? <Text dimColor>{padToWidth(`  … ${hiddenAfter} more`, width)}</Text> : null}
    </Box>
  )
}


/** Rows a list picker shows before windowing around the selection. */
const PICKER_LIST_MAX_ROWS = 8

/** Leading columns before the picker's text, so the content sits inset from
 *  the popup's own rule rather than hugging the terminal edge. */
const PICKER_INDENT = '    '

/** Rows the effort popup renders: rule, title, blank, ends, track, labels,
 *  [blank + description], blank, hint. */
const EFFORT_POPUP_BASE_ROWS = 8

/**
 * The effort picker popup: a scale of the route's disclosed levels. Its own
 * component, deliberately not shared with the route list — the two layouts
 * have different geometry (a track in column coordinates vs rows in a
 * scrollable list) and sharing one renderer made every tweak to one shift the
 * other. The ▲ rides the track at the ←/→ selection, the labels sit centred on
 * their own ▲ column, and Faster/Smarter float above the two ends.
 */
function EffortPickerPopup({ picker, width }: {
  picker: PickerPopupView
  width: number
}): React.JSX.Element {
  const { options, selected } = picker
  const clampedSelected = Math.min(Math.max(0, selected), Math.max(0, options.length - 1))
  // The nominal track length follows the level count — 10 columns per level,
  // floor 20, ceiling 50 — and shrinks further only when the terminal is
  // narrower. The Faster/Smarter labels float above its two ends, so the row
  // itself is just the track.
  const wantedSpan = Math.min(Math.max(options.length * 10, 20), 50)
  const trackSpan = Math.max(8, Math.min(wantedSpan, width - 8))
  // The ▲ never rides the track's ends: both keep one cell of ─ clear, so a
  // selection at either end still sits inside the scale.
  const trackEndInset = 1
  const columnOf = (index: number): number => {
    if (options.length <= 1) return Math.floor(trackSpan / 2)
    const inner = Math.max(0, trackSpan - 1 - trackEndInset * 2)
    return trackEndInset + Math.round(index * inner / (options.length - 1))
  }
  const column = columnOf(clampedSelected)
  const pad = (used: number): string => ' '.repeat(Math.max(0, width - used))
  // The levels row: each label placed so its ▲-cell sits exactly on its track
  // column (odd widths center exactly; even widths shift right, landing the ▲
  // on the left-of-center cell — the `i` of `high`), kept two clear of
  // neighbours; the first label is never bumped off its column.
  const labels: { text: string; start: number; isSelected: boolean }[] = []
  let previousEnd = -Infinity
  options.forEach((option, index) => {
    const centered = columnOf(index) - Math.floor((stringWidth(option.label) - 1) / 2)
    const start = Math.max(previousEnd + 2, Math.max(0, centered))
    labels.push({ text: option.label, start, isSelected: index === clampedSelected })
    previousEnd = start + stringWidth(option.label)
  })
  // The rendered track spans the labels: an even-width LAST name shifted onto
  // its ▲-cell can overhang the nominal end, and the line must reach the
  // name's last cell — both ends of the rule align with the names below.
  const lastLabel = labels[labels.length - 1]
  const trackLen = Math.max(trackSpan, lastLabel === undefined ? 0 : lastLabel.start + stringWidth(lastLabel.text))
  const leftPad = Math.max(0, Math.floor((width - trackLen) / 2))
  const trackBefore = '─'.repeat(column)
  const trackAfter = '─'.repeat(Math.max(0, trackLen - column - 1))
  // The ends row: `Faster` flush with the track's left end, `Smarter` with its
  // right end, both above the line.
  const lowEnd = picker.scaleEnds?.low ?? 'Faster'
  const highEnd = picker.scaleEnds?.high ?? 'Smarter'
  const lowWidth = stringWidth(lowEnd)
  const highWidth = stringWidth(highEnd)
  const labelGap = Math.max(1, trackLen - lowWidth - highWidth)
  let labelCursor = 0
  const labelSegments = labels.map((label, index) => {
    const gap = ' '.repeat(Math.max(0, label.start - labelCursor))
    labelCursor = label.start + stringWidth(label.text)
    return label.isSelected ? (
      <React.Fragment key={index}>{gap}<Text color="#a5d8ff" bold>{label.text}</Text></React.Fragment>
    ) : (
      <React.Fragment key={index}>{gap}<Text dimColor>{label.text}</Text></React.Fragment>
    )
  })
  const hint = '←/→ to adjust · Enter to confirm · Esc to cancel'
  // The selected level's description floats under the scale — one centered
  // dim line, truncated to the popup width; levels that disclose none drop
  // the row entirely (the overlay's row count follows).
  const rawDescription = options[clampedSelected]?.description
  const description = rawDescription === undefined || rawDescription === ''
    ? undefined
    : truncateToWidth(rawDescription, Math.max(0, width - 4))
  // Two blank rows above the rule hide the transcript lines the popup would
  // otherwise crowd; the description keeps one blank row of breathing room
  // under the level names.
  const rowCount = EFFORT_POPUP_BASE_ROWS + 2 + (description === undefined ? 0 : 2)
  return (
    <Box position="absolute" top={-rowCount} left={0} right={0} flexDirection="column">
      <Text>{' '.repeat(width)}</Text>
      <Text>{' '.repeat(width)}</Text>
      <Text color="#a5d8ff">{'▔'.repeat(width)}</Text>
      <Text color="#ffffff">{`${PICKER_INDENT}${picker.title}`}{pad(stringWidth(PICKER_INDENT) + stringWidth(picker.title))}</Text>
      <Text>{' '.repeat(width)}</Text>
      <Text>
        {' '.repeat(leftPad)}<Text color="#ffffff">{lowEnd}</Text>{' '.repeat(labelGap)}<Text color="#ffffff">{highEnd}</Text>
        {pad(leftPad + lowWidth + labelGap + highWidth)}
      </Text>
      <Text>
        {' '.repeat(leftPad)}<Text dimColor>{trackBefore}</Text><Text color="#a5d8ff">▲</Text><Text dimColor>{trackAfter}</Text>
        {pad(leftPad + trackLen)}
      </Text>
      <Text>{' '.repeat(leftPad)}{labelSegments}{pad(leftPad + labelCursor)}</Text>
      {description === undefined ? null : <Text>{' '.repeat(width)}</Text>}
      {description === undefined
        ? null
        : (
          <Text dimColor>
            {' '.repeat(Math.max(0, Math.floor((width - stringWidth(description)) / 2)))}
            {description}
            {pad(Math.floor((width - stringWidth(description)) / 2) + stringWidth(description))}
          </Text>
        )}
      <Text>{' '.repeat(width)}</Text>
      <Text dimColor>{PICKER_INDENT}{hint}{pad(stringWidth(PICKER_INDENT) + stringWidth(hint))}</Text>
    </Box>
  )
}

/**
 * The model-route picker popup: a scrollable list of the adapters' routes.
 * Its own component for the same reason the effort scale is — a vertical list
 * and a column-coordinate track share no geometry worth unifying. A ❯ marks
 * the ↑/↓ selection, a dim ordinal counts across the whole list, the route in
 * effect wears mint with a green ✔, and the focused route's description
 * floats under the list.
 */
function ModelPickerPopup({ picker, width }: {
  picker: PickerPopupView
  width: number
}): React.JSX.Element {
  const { options, selected, currentIndex } = picker
  const clamped = Math.min(Math.max(0, selected), Math.max(0, options.length - 1))
  const start = options.length <= PICKER_LIST_MAX_ROWS
    ? 0
    : Math.min(Math.max(0, clamped - Math.floor(PICKER_LIST_MAX_ROWS / 2)), options.length - PICKER_LIST_MAX_ROWS)
  const visible = options.slice(start, start + PICKER_LIST_MAX_ROWS)
  const hiddenBefore = start
  const hiddenAfter = options.length - start - visible.length
  const nameCol = options.reduce((max, option) => Math.max(max, stringWidth(option.label)), 0)
  const noteBudget = Math.max(0, width - stringWidth(PICKER_INDENT) - 2 - 2 - nameCol - MENU_DESCRIPTION_GAP)
  const pad = (used: number): string => ' '.repeat(Math.max(0, width - used))
  const focused = options[clamped]
  const description = focused?.description === undefined || focused.description === ''
    ? undefined
    : truncateToWidth(focused.description, Math.max(0, width - 4))
  const listRows = visible.length + (hiddenBefore > 0 ? 1 : 0) + (hiddenAfter > 0 ? 1 : 0)
  // Rows: two erased, rule, title, blank, the list, [blank + description],
  // blank, hint.
  const rowCount = 7 + listRows + (description === undefined ? 0 : 2)
  const hint = '↑/↓ to move · Enter to confirm · Esc to cancel'
  return (
    <Box position="absolute" top={-rowCount} left={0} right={0} flexDirection="column">
      <Text>{' '.repeat(width)}</Text>
      <Text>{' '.repeat(width)}</Text>
      <Text color="#a5d8ff">{'▔'.repeat(width)}</Text>
      <Text color="#ffffff">{`${PICKER_INDENT}${picker.title}`}{pad(stringWidth(PICKER_INDENT) + stringWidth(picker.title))}</Text>
      <Text>{' '.repeat(width)}</Text>
      {hiddenBefore > 0
        ? <Text dimColor>{padToWidth(`${PICKER_INDENT}… ${hiddenBefore} more`, width)}</Text>
        : null}
      {visible.map((option, index) => {
        const absolute = start + index
        const isSelected = absolute === clamped
        const isCurrent = absolute === currentIndex
        const cursor = isSelected ? '❯ ' : '  '
        const ordinal = `${absolute + 1}. `
        const check = isCurrent ? ' ✔' : '  '
        const label = padToWidth(option.label, nameCol)
        const note = option.note === undefined ? '' : truncateToWidth(option.note, noteBudget)
        const gap = Math.max(
          0,
          width - stringWidth(PICKER_INDENT) - stringWidth(cursor) - stringWidth(ordinal) - nameCol - stringWidth(check) - MENU_DESCRIPTION_GAP - stringWidth(note),
        )
        // A plain row takes no color: it inherits the terminal's foreground
        // exactly like body text. The selection wears the highlight tint, the
        // route in effect mint with a green ✔.
        const rowColor = isSelected ? '#a5d8ff' : isCurrent ? '#8ce99a' : undefined
        return (
          <Text key={option.value} {...(rowColor === undefined ? {} : { color: rowColor })}>
            {PICKER_INDENT}
            <Text color="#a5d8ff">{cursor}</Text>
            <Text color="#adb5bd">{ordinal}</Text>
            {isSelected ? <Text bold>{label}</Text> : label}
            {isCurrent ? <Text color="#51cf66" bold>{check}</Text> : check}
            {note}{' '.repeat(gap)}
          </Text>
        )
      })}
      {hiddenAfter > 0
        ? <Text dimColor>{padToWidth(`${PICKER_INDENT}… ${hiddenAfter} more`, width)}</Text>
        : null}
      {description === undefined ? null : <Text>{' '.repeat(width)}</Text>}
      {description === undefined
        ? null
        : (
          <Text dimColor>
            {PICKER_INDENT}{description}{pad(stringWidth(PICKER_INDENT) + stringWidth(description))}
          </Text>
        )}
      <Text>{' '.repeat(width)}</Text>
      <Text dimColor>{PICKER_INDENT}{hint}{pad(stringWidth(PICKER_INDENT) + stringWidth(hint))}</Text>
    </Box>
  )
}

/** Dispatch to the popup the request's layout calls for. */
function PickerPopup({ picker, width }: {
  picker: PickerPopupView
  width: number
}): React.JSX.Element {
  return picker.kind === 'scale'
    ? <EffortPickerPopup picker={picker} width={width} />
    : <ModelPickerPopup picker={picker} width={width} />
}
