/**
 * The chrome band's navigable panels: the subagent roster, the Agent Teams
 * board, the background-jobs roster and its full-screen detail, and the
 * workflow run → phase → member tree. Each is pure presentation over its
 * driver-projected info; the ❯ cursor and ● open-marker follow the selection
 * props the driver owns.
 * @module dsh-terminal/src/panels
 */

// Classic-JSX source launch needs the React namespace in scope.
import React from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import type {
  JobDetailView,
  JobsPanelInfo,
  JobStatus,
  SubagentRow,
  TeamPanelInfo,
  WorkflowMemberRow,
  WorkflowPhaseGroup,
  WorkflowPanelInfo,
  WorkflowRunRow,
  WorkflowRunStatus,
} from './view-types.ts'
import { formatElapsed, formatTokenCount, padToWidth, truncateToWidth } from '../text-helpers.ts'
import { useTerminalSize, useTerminalWidth } from '../use-terminal.ts'

/** Panel rows beyond this cap are elided with a hint row, keeping the chrome
 *  band bounded; the window follows the arrow selection. */
export const PANEL_MAX_ROWS = 8

/** Fraction of the terminal width a panel row's activity may occupy before it
 *  is truncated, keeping a clear gap before the right-aligned elapsed/tokens. */
export const PANEL_ACTIVITY_RATIO = 0.6

/** One unfinished direct subagent's row in the panel below the status bar. */
export function SubagentPanel({
  rows,
  selected,
  openChildId,
}: {
  rows: readonly SubagentRow[]
  /** The ❯ cursor's row index over [main, ...rows]; undefined keeps the input bar focused. */
  selected: number | undefined
  /** The child transcript currently open; its row wears the ● (main's when undefined). */
  openChildId?: string
}): React.JSX.Element {
  const width = useTerminalWidth()
  // The main row always shows; the subagent rows window around the selection
  // (latest rows when unselected) once they exceed the cap.
  const selectedSub = selected === undefined || selected === 0 ? undefined : selected - 1
  const start = rows.length <= PANEL_MAX_ROWS
    ? 0
    : selectedSub === undefined
      ? rows.length - PANEL_MAX_ROWS
      : Math.min(Math.max(0, selectedSub - Math.floor(PANEL_MAX_ROWS / 2)), rows.length - PANEL_MAX_ROWS)
  const visible = rows.slice(start, start + PANEL_MAX_ROWS)
  const hiddenAfter = rows.length - start - visible.length
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(width)}</Text>
      {start > 0 ? <Text dimColor>  … {start} more</Text> : null}
      {[undefined, ...visible].map((row, index) => {
        const isMain = row === undefined
        // The ❯ cursor follows the arrows; the ● stays on the row whose
        // transcript is actually open — Enter is what moves it.
        const isCursor = isMain ? selected === 0 : selected === start + index
        const isOpen = isMain ? openChildId === undefined : openChildId === row.childId
        // Rows that are neither the cursor's nor the open view's dim entirely;
        // the two meaningful rows keep their full brightness.
        const emphasized = isCursor || isOpen
        const marker = isOpen ? '●' : '◯'
        // Clamp the label so a long delegation description cannot wrap the
        // row past one physical line and eat the transcript window's height.
        const label = truncateToWidth(isMain ? 'main' : row.label, Math.max(4, Math.floor(width * 0.4)))
        const elapsed = isMain
          ? ''
          : `${formatElapsed(Date.now() - row.startedAt)} · ↓ ${formatTokenCount(row.inputTokens)} tokens`
        // Clamp the activity so the row stays on one line with a clear gap
        // before the right-aligned elapsed/tokens: the smaller of (terminal
        // width minus label/elapsed/spacing) and PANEL_ACTIVITY_RATIO of width.
        const budget = Math.min(width - stringWidth(label) - stringWidth(elapsed) - 7, Math.floor(width * PANEL_ACTIVITY_RATIO))
        const activity = row !== undefined && row.activity !== undefined
          ? truncateToWidth(row.activity, Math.max(0, budget))
          : undefined
        return (
          <Box key={isMain ? 'main' : row.childId}>
            <Text>{isCursor ? <Text>❯</Text> : ' '}</Text>
            <Text> </Text>
            <Text>{emphasized ? <Text>{marker}</Text> : <Text dimColor>{marker}</Text>}</Text>
            <Text> </Text>
            {emphasized ? <Text bold={isCursor}>{label}</Text> : <Text dimColor>{label}</Text>}
            {activity !== undefined && activity !== ''
              ? emphasized ? <Text>  {activity}</Text> : <Text dimColor>  {activity}</Text>
              : null}
            <Box flexGrow={1} />
            {isMain ? null : emphasized ? <Text>{elapsed}</Text> : <Text dimColor>{elapsed}</Text>}
          </Box>
        )
      })}
      {hiddenAfter > 0 ? <Text dimColor>  … {hiddenAfter} more</Text> : null}
    </Box>
  )
}

/** The Agent Teams roster and shared task board, read from the agentTeam projection. */
export function TeamPanel({
  team,
  selected,
  tasksHidden,
  openChildId,
}: {
  team: TeamPanelInfo
  /** The ❯ cursor's row index over [main, ...members]; undefined keeps focus elsewhere. */
  selected: number | undefined
  /** The all-done board's hide flag, owned by TuiApp so it survives view switches. */
  tasksHidden: boolean
  /** The child transcript currently open; its row wears the ● (main's when undefined). */
  openChildId?: string
}): React.JSX.Element {
  const width = useTerminalWidth()
  // Index 0 is the main row; member rows start at 1 and window around the
  // member selection (roster head when unselected); tasks keep their reading
  // order from the top. Both cap at PANEL_MAX_ROWS so the chrome band stays
  // bounded.
  const memberSelected = selected === undefined || selected === 0 ? undefined : selected - 1
  const start = team.members.length <= PANEL_MAX_ROWS || memberSelected === undefined
    ? 0
    : Math.min(Math.max(0, memberSelected - Math.floor(PANEL_MAX_ROWS / 2)), team.members.length - PANEL_MAX_ROWS)
  const visibleMembers = team.members.slice(start, start + PANEL_MAX_ROWS)
  const hiddenMembers = team.members.length - visibleMembers.length
  const visibleTasks = team.tasks.slice(0, PANEL_MAX_ROWS)
  const hiddenTasks = team.tasks.length - visibleTasks.length
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* The two-column lead puts the section headers on the panels' shared
          header column (the Workflow run header and the status footer's
          indent); member rows keep the flush-left cursor column. */}
      {/* The key hints live on the status bar's permission row, exactly
          like the workflow panel's — the header keeps just its count. */}
      {/* A lead that has only planned tasks (no workers spawned yet) shows
          just the task board below — the empty roster section and its lone
          lead row would read as noise, and team navigation is inert until
          the first member exists. */}
      {team.members.length > 0
        ? (
          <>
            <Text>
              {'  '}Teammates · {team.members.length}
            </Text>
            {/* The lead row is the way home: Enter on it closes to the main view.
                The ● shows which transcript is open — the lead's own when no
                member is. (The subagent panel's counterpart keeps the 'main' name.) */}
            <Box key="lead" paddingLeft={2}>
              <Text>{selected === 0 ? <Text>❯</Text> : ' '}</Text>
              <Text> </Text>
              {selected === 0 || openChildId === undefined
                ? <Text>{openChildId === undefined ? '●' : '◯'}</Text>
                : <Text dimColor>◯</Text>}
              <Text> </Text>
              {selected === 0 || openChildId === undefined
                ? <Text bold={selected === 0}>lead</Text>
                : <Text dimColor>lead</Text>}
            </Box>
          </>
        )
        : null}
      {visibleMembers.map((member, index) => {
        // The ❯ cursor follows the arrows; the ● stays on the member whose
        // transcript is actually open — Enter is what moves it.
        const isCursor = selected === start + index + 1
        const isOpen = member.id !== undefined && member.id === openChildId
        // Rows that are neither the cursor's nor the open member's dim
        // entirely; the two meaningful rows keep their full brightness.
        const emphasized = isCursor || isOpen
        const marker = isOpen ? '●' : '◯'
        // Clamp the name so a long member name cannot wrap the row past one line.
        const name = truncateToWidth(member.name, Math.max(4, Math.floor(width * 0.3)))
        const elapsed = member.startedAt !== undefined
          ? `${formatElapsed(Date.now() - member.startedAt)} · ↓ ${formatTokenCount(member.inputTokens ?? 0)} tokens`
          : ''
        // Clamp the activity so the row stays on one line with a clear gap
        // before the right-aligned elapsed/tokens: the smaller of (terminal
        // width minus name/elapsed/spacing — 9 absorbs the two-column child
        // indent plus the marker columns) and PANEL_ACTIVITY_RATIO of width.
        const budget = Math.min(width - stringWidth(name) - stringWidth(elapsed) - 9, Math.floor(width * PANEL_ACTIVITY_RATIO))
        const activity = member.activity !== undefined
          ? truncateToWidth(member.activity, Math.max(0, budget))
          : undefined
        return (
          <Box key={member.name} paddingLeft={2}>
            {/* The cursor column keeps the member marker aligned under the
                task marker, exactly like the old two-space indent did. */}
            <Text>{isCursor ? <Text>❯</Text> : ' '}</Text>
            <Text> </Text>
            <Text>{emphasized ? <Text>{marker}</Text> : <Text dimColor>{marker}</Text>}</Text>
            <Text> </Text>
            {!emphasized
              ? <Text dimColor>{name}</Text>
              : member.phase === 'failed'
                ? <Text bold={isCursor} color="red">{name}</Text>
                : member.phase === 'provisioning'
                  ? <Text bold={isCursor} color="yellow">{name}</Text>
                  : <Text bold={isCursor}>{name}</Text>}
            {activity !== undefined && activity !== ''
              ? emphasized ? <Text>  {activity}</Text> : <Text dimColor>  {activity}</Text>
              : null}
            <Box flexGrow={1} />
            {elapsed !== ''
              ? emphasized ? <Text>{elapsed}</Text> : <Text dimColor>{elapsed}</Text>
              : null}
          </Box>
        )
      })}
      {hiddenMembers > 0 ? <Text dimColor>    … {hiddenMembers} more</Text> : null}
      {team.tasks.length > 0 && !tasksHidden ? (
        // marginTop keeps a blank row between the roster and the task board —
        // only when a roster is actually above it (a task-only team leads with
        // the board directly).
        <Box flexDirection="column" marginTop={team.members.length > 0 ? 1 : 0}>
          <Text>{'  '}Tasks · {team.tasks.length}</Text>
          {visibleTasks.map((task, index) => {
            const mark = task.status === 'completed'
              ? <Text color="green">✔</Text>
              : task.status === 'in_progress'
                ? <Text color="#a5d8ff">◼</Text>
                : task.blocked
                  ? <Text dimColor>⊘</Text>
                  : <Text dimColor>◻</Text>
            const meta = `(${task.ownerName ?? 'unowned'} · ${task.status})`
            // Clamp the subject so the task row stays one physical line
            // (8 absorbs the four-column child indent plus mark and gaps).
            const subject = truncateToWidth(task.subject, Math.max(4, width - stringWidth(meta) - 8))
            return (
              <Box key={index}>
                <Text>    {mark} {subject} </Text>
                <Text dimColor>{meta}</Text>
              </Box>
            )
          })}
          {hiddenTasks > 0 ? <Text dimColor>    … {hiddenTasks} more</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}

/** The status glyph of one background job — the task board's vocabulary:
 *  ◼ light blue while running, ⊘ yellow while stopping, then ✔/✘/⊘. */
function jobStatusGlyph(status: JobStatus): React.JSX.Element {
  switch (status) {
    case 'running': return <Text color="#a5d8ff">◼</Text>
    case 'stopping': return <Text color="#ffd43b">⊘</Text>
    case 'completed': return <Text color="green">✔</Text>
    case 'failed': return <Text color="red">✘</Text>
    case 'killed': return <Text dimColor>⊘</Text>
  }
}

/** The background-jobs roster: one row per live or lingering job. Enter opens
 *  a row's full-screen detail (RenderView.openJob); the roster itself stays a
 *  flat list. The last panel in the ladder — the whole-session backdrop the
 *  other panels' activities run against. */
export function JobsPanel({
  info,
  selected,
}: {
  info: JobsPanelInfo
  /** The ❯ cursor's 1-based row index; undefined keeps focus elsewhere. */
  selected: number | undefined
}): React.JSX.Element {
  const width = useTerminalWidth()
  const rows = info.rows
  // Windowing follows the SubagentPanel semantics: tail-anchored while
  // unselected (the newest jobs lead), centered on the cursor when selected.
  const selectedRow = selected === undefined || selected <= 0 ? -1 : selected - 1
  const start = rows.length <= PANEL_MAX_ROWS
    ? 0
    : selectedRow < 0
      ? rows.length - PANEL_MAX_ROWS
      : Math.min(Math.max(0, selectedRow - Math.floor(PANEL_MAX_ROWS / 2)), rows.length - PANEL_MAX_ROWS)
  const visible = rows.slice(start, start + PANEL_MAX_ROWS)
  const hiddenBefore = start
  const hiddenAfter = rows.length - start - visible.length
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{'  '}Jobs · {rows.length}</Text>
      {hiddenBefore > 0 ? <Text dimColor>    … {hiddenBefore} more</Text> : null}
      {visible.map((row, index) => {
        const rowIndex = start + index
        const isCursor = rowIndex + 1 === selected
        // The cursor row stays bright; the rest dim entirely.
        const id = truncateToWidth(row.id, 12)
        const label = truncateToWidth(row.label, Math.max(4, Math.floor(width * 0.35)))
        // The producer's live progress while running, its terminal detail
        // once settled — one line, clamped against the row's other columns.
        const note = row.status === 'running' || row.status === 'stopping'
          ? row.progress
          : row.detail ?? row.progress
        const elapsed = formatElapsed(row.elapsedMs)
        const budget = Math.min(width - stringWidth(id) - stringWidth(label) - stringWidth(elapsed) - 10, Math.floor(width * PANEL_ACTIVITY_RATIO))
        const noteText = note !== undefined && note !== '' ? truncateToWidth(note, Math.max(0, budget)) : undefined
        return (
          <Box key={row.id} paddingLeft={2}>
            {/* The two-column lead nests the row under the `Jobs · N` header,
                matching the team/workflow panels' header→row step: the cursor
                lands at column two, the status glyph at four. */}
            <Text>{isCursor ? <Text>❯</Text> : ' '}</Text>
            <Text> </Text>
            {jobStatusGlyph(row.status)}
            <Text> </Text>
            {isCursor ? <Text>{id}</Text> : <Text dimColor>{id}</Text>}
            <Text> </Text>
            {isCursor ? <Text bold>{label}</Text> : <Text dimColor>{label}</Text>}
            {noteText !== undefined
              ? isCursor ? <Text>  {noteText}</Text> : <Text dimColor>  {noteText}</Text>
              : null}
            <Box flexGrow={1} />
            {isCursor ? <Text>{elapsed}</Text> : <Text dimColor>{elapsed}</Text>}
          </Box>
        )
      })}
      {hiddenAfter > 0 ? <Text dimColor>    … {hiddenAfter} more</Text> : null}
    </Box>
  )
}

/** The full-screen detail of one opened job: a kind-named heading, labelled
 *  status/runtime/command fields, and the live output tail (or a placeholder
 *  for a job with no output ring, e.g. a background subagent). */
export function JobDetail({ view }: { view: JobDetailView }): React.JSX.Element {
  const width = useTerminalWidth()
  const { rows } = useTerminalSize()
  // The output tail adapts to the viewport: the detail owns everything below
  // the status footer, and the frame around the output is fixed — the
  // transcript window's floor (3), the footer (3), and the detail's own rules,
  // title, fields, and labels (10, plus one lossy-marker row of slack).
  const maxOutputLines = Math.max(4, rows - 17)
  const outputLines = view.output === '' ? [] : view.output.split('\n').slice(-maxOutputLines)
  return (
    <Box flexDirection="column">
      <Text color="#a5d8ff">{'─'.repeat(width)}</Text>
      {/* The heading aligns with the labelled fields below it (two-column
          lead), not centered — the detail reads as one field block. */}
      <Text>  {view.title}</Text>
      <Text> </Text>
      <Text><Text dimColor>  Status:   </Text>{view.status}</Text>
      <Text><Text dimColor>  Runtime:  </Text>{formatElapsed(view.elapsedMs)}</Text>
      <Text><Text dimColor>  {padToWidth(`${view.labelField}:`, 9)}</Text>{view.label}</Text>
      <Text> </Text>
      <Text dimColor>  Output:</Text>
      {view.lossy ? <Text dimColor>    … earlier output dropped</Text> : null}
      {outputLines.length === 0
        ? <Text dimColor>    No output available</Text>
        : outputLines.map((line, index) => (
          <Text key={index}>    {line === '' ? ' ' : line}</Text>
        ))}
      <Text> </Text>
      {/* The detail hides the status footer, so it carries its own key hints
          in the bottom line — armed flips them to the confirm gesture. */}
      <Text dimColor>
        {'  '}{view.killArmed
          ? '再按 x 确认停止 · Esc 取消'
          : view.killable ? 'Esc/Enter 关闭 · x 停止任务' : 'Esc/Enter 关闭'}
      </Text>
    </Box>
  )
}

/** The status glyph of one workflow run or member — the task board's
 *  vocabulary: ◼ light blue while in progress (static, and a square so it
 *  never confuses with the ●/◯ open-marker column), ✔/✘/⊘ once settled. */
function workflowStatusGlyph(status: WorkflowRunStatus): React.JSX.Element {
  switch (status) {
    case 'running': return <Text color="#a5d8ff">◼</Text>
    case 'completed': return <Text color="green">✔</Text>
    case 'failed': return <Text color="red">✘</Text>
    case 'cancelled': return <Text dimColor>⊘</Text>
    case 'interrupted': return <Text color="#ffd43b">⊘</Text>
  }
}

/**
 * The durable workflow runs as a run → phase → member tree, folded by the
 * driver from the four `tool-workflow/*` session events (the same source the
 * web client's run node consumes). Navigation walks the member rows (1-based,
 * in the driver's projection order): Enter opens the selected transcript, ↑
 * past the first row leaves the panel, and Esc from the child view is the way
 * back to the main view. Member rows beyond the cap window around the
 * selection (head-anchored while unselected — reading order, elision hides
 * the tail); run headers pin above the window and a phase header stays while
 * any of its members is visible.
 */
export function WorkflowPanel({
  info,
  selected,
  openChildId,
}: {
  info: WorkflowPanelInfo
  /** The ❯ cursor's member index (1-based); undefined keeps focus elsewhere. */
  selected: number | undefined
  /** The child transcript currently open; its member row wears the ●. */
  openChildId?: string
}): React.JSX.Element {
  const width = useTerminalWidth()
  // Per-run content rows with global member indices: the renderer draws
  // exactly the driver's projection order, so the selection index maps 1:1.
  type FlatRow =
    | { kind: 'phase'; group: WorkflowPhaseGroup; firstMember: number; lastMember: number }
    | { kind: 'member'; member: WorkflowMemberRow; memberIndex: number }
  // Only colliding run names carry a number: the count of this name's
  // occurrences in projection order (the first duplicate is #1). The model
  // picks the name, so collisions happen, but a unique name stays clean.
  // Runs are never dropped from the fold, so the numbers are session-stable.
  const nameTotals = new Map<string, number>()
  for (const run of info.runs) nameTotals.set(run.name, (nameTotals.get(run.name) ?? 0) + 1)
  const nameSeen = new Map<string, number>()
  const blocks: { run: WorkflowRunRow; rows: FlatRow[]; memberCount: number; ordinal: number; numbered: boolean }[] = []
  let memberIndex = 0
  for (const run of info.runs) {
    const rows: FlatRow[] = []
    let count = 0
    for (const group of run.phases) {
      const firstMember = memberIndex
      if (group.phase !== undefined) {
        rows.push({ kind: 'phase', group, firstMember, lastMember: firstMember + group.members.length - 1 })
      }
      for (const member of group.members) {
        rows.push({ kind: 'member', member, memberIndex: memberIndex++ })
        count += 1
      }
    }
    const seen = (nameSeen.get(run.name) ?? 0) + 1
    nameSeen.set(run.name, seen)
    blocks.push({ run, rows, memberCount: count, ordinal: seen, numbered: (nameTotals.get(run.name) ?? 0) > 1 })
  }
  // Only member rows window; a phase header stays visible as long as any of
  // its members is in the window, so the tree never shows members without
  // their phase (the pinned headers may push the band a row or two past the
  // cap in phase-heavy windows — accepted, the team panel overflows alike).
  const memberTotal = memberIndex
  const selectedRow = selected === undefined || selected <= 0 ? -1 : selected - 1
  const windowRows = Math.max(1, PANEL_MAX_ROWS - info.runs.length)
  // Unselected (reading from the top): head-anchored, the oldest members lead
  // and the trailing hint elides the tail. Selected: centered on the cursor.
  const start = memberTotal <= windowRows
    ? 0
    : selectedRow < 0
      ? 0
      : Math.min(Math.max(0, selectedRow - Math.floor(windowRows / 2)), Math.max(0, memberTotal - windowRows))
  const end = Math.min(start + windowRows, memberTotal) - 1
  const hiddenBefore = start
  const hiddenAfter = memberTotal - 1 - end
  // Per-run visible rows: each run keeps its header directly above its own
  // content (never stacked above another run's phases). A run whose members
  // are entirely elided drops its header too — the same sticky rule as phase
  // headers — while a memberless run (just started) keeps its header. The
  // leading hint rides with the first visible member, the trailing hint
  // closes the last visible block; both align with the member marker column.
  type VisibleRow = FlatRow | { kind: 'hint'; count: number; key: string }
  const visibleBlocks: { run: WorkflowRunRow; memberCount: number; ordinal: number; numbered: boolean; rows: VisibleRow[] }[] = []
  let beforePlaced = false
  for (const block of blocks) {
    const rows: VisibleRow[] = []
    let sawMember = false
    for (const row of block.rows) {
      if (row.kind === 'member') {
        if (row.memberIndex < start || row.memberIndex > end) continue
        if (hiddenBefore > 0 && !beforePlaced) {
          rows.push({ kind: 'hint', count: hiddenBefore, key: 'hint-before' })
          beforePlaced = true
        }
        rows.push(row)
        sawMember = true
      } else if (row.firstMember <= end && row.lastMember >= start) {
        rows.push(row)
      }
    }
    if (!sawMember && block.memberCount > 0) continue
    visibleBlocks.push({ run: block.run, memberCount: block.memberCount, ordinal: block.ordinal, numbered: block.numbered, rows })
  }
  if (hiddenAfter > 0 && visibleBlocks.length > 0) {
    visibleBlocks[visibleBlocks.length - 1]!.rows.push({ kind: 'hint', count: hiddenAfter, key: 'hint-after' })
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {visibleBlocks.map(block => (
        <Box key={block.run.id} flexDirection="column">
          {/* The run header leads its own block; the two-column indent aligns
              it under the other panels' marker column. */}
          <Box>
            <Text>  </Text>
            <Text>
              Workflow
              {block.numbered ? <Text> #{block.ordinal}</Text> : null}
              {block.run.name ? <Text dimColor> ({block.run.name})</Text> : null}
              <Text dimColor> · {block.memberCount} 成员</Text>
            </Text>
          </Box>
          {block.rows.map(row => {
            if (row.kind === 'hint') {
              // The eight-space lead aligns the hint with the member marker column.
              return <Text key={row.key} dimColor>        … {row.count} more</Text>
            }
            if (row.kind === 'phase') {
              return (
                <Box key={row.group.key}>
                  <Text>    {row.group.phase} · {row.group.members.length}</Text>
                </Box>
              )
            }
            const member = row.member
            const isCursor = selected !== undefined && selected > 0 && row.memberIndex === selected - 1
            const isOpen = openChildId === member.childId
            const emphasized = isCursor || isOpen
            const marker = isOpen ? '●' : '◯'
            // Clamp the label so a long script-provided label cannot wrap the
            // row past one physical line.
            const label = truncateToWidth(member.label, Math.max(4, Math.floor(width * 0.4)))
            const elapsed = member.startedAt !== undefined
              ? `${formatElapsed(Date.now() - member.startedAt)} · ↓ ${formatTokenCount(member.inputTokens ?? 0)} tokens`
              : ''
            // The glyph column and the nesting indent cost eight cells over
            // the team row's budget.
            const budget = Math.min(width - stringWidth(label) - stringWidth(elapsed) - 15, Math.floor(width * PANEL_ACTIVITY_RATIO))
            const activity = member.activity !== undefined
              ? truncateToWidth(member.activity, Math.max(0, budget))
              : undefined
            return (
              <Box key={member.childId}>
                {/* The six-column indent steps members under their phase
                    header: run header at 2 (aligned with the other panels'
                    marker column), phase title at 4, member cursor at 6 —
                    the run → phase → member hierarchy reads as a tree. */}
                <Text>      </Text>
                <Text>{isCursor ? <Text>❯</Text> : ' '}</Text>
                <Text> </Text>
                <Text>{emphasized ? <Text>{marker}</Text> : <Text dimColor>{marker}</Text>}</Text>
                <Text> </Text>
                {workflowStatusGlyph(member.status)}
                <Text> </Text>
                {emphasized ? <Text bold={isCursor}>{label}</Text> : <Text dimColor>{label}</Text>}
                {activity !== undefined && activity !== ''
                  ? emphasized ? <Text>  {activity}</Text> : <Text dimColor>  {activity}</Text>
                  : null}
                <Box flexGrow={1} />
                {elapsed !== ''
                  ? emphasized ? <Text>{elapsed}</Text> : <Text dimColor>{elapsed}</Text>
                  : null}
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}
