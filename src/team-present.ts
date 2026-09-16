/**
 * Local presentation for the official Agent Teams tools. The experimental
 * tool-agent-team package registers its nine tools without presentCall or
 * presentResult, so their calls would fold into generic cards titled with the
 * raw tool name and raw JSON results. This module supplies the missing
 * presentation without touching the upstream packages: pure functions keyed by
 * tool name, reading the wire argument and result shapes best-effort. Any
 * unexpected shape returns undefined so the fold falls back to the generic
 * card instead of rendering wrong text.
 * @module dsh-terminal/src/team-present
 */

import type { ContentBlock, ToolCallView, ToolResult, ToolResultView } from './dsh-adapter/types.ts'
import type { ToolPresentation } from './frames.ts'

/** Narrow an unknown payload to a plain record; anything else is unreadable. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Narrow an unknown payload to a string. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Narrow an unknown payload to a finite number. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Keep only the string items of an unknown array payload. */
function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Collapse text to its first line, trimmed and clamped to `max` characters. */
function oneLine(text: string, max: number): string {
  const first = text.split('\n')[0].trim()
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

/** The pending-call card: a generic card whose title carries the whole design. */
function call(title: string): ToolCallView {
  return { card: 'generic', title }
}

/** The completed card: dim text lines rendered under the ⎿ connector. */
function lines(text: string): ToolResultView {
  return { card: 'generic', content: [{ type: 'text', text }] }
}

/**
 * Parse the tool's result value out of its rendered content. Team tools render
 * exactly one JSON text block; a failed call renders error text instead, so an
 * error (or an unparsable body) yields undefined and the caller falls back to
 * the raw-content path (which renders failures in red).
 */
function resultValue(result: ToolResult): unknown {
  if (result.isError) return undefined
  const text = result.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The task board marker, matching the team panel's glyphs. */
function taskMark(status: string, ready: unknown): string {
  if (status === 'completed') return '✔'
  if (status === 'in_progress') return '◼'
  return ready === false ? '⊘' : '◻'
}

/** One shared task result, as every task tool returns it. */
interface TaskView {
  id: string
  subject: string
  status: string
  revision: number
  ownerName: string | undefined
  blockedBy: readonly string[]
  ready: unknown
}

/** Read the shared task-view fields; any missing required field is unreadable. */
function taskView(value: unknown): TaskView | undefined {
  const task = asRecord(value)
  const id = asString(task?.id)
  const subject = asString(task?.subject)
  const status = asString(task?.status)
  const revision = asNumber(task?.revision)
  if (task === undefined || id === undefined || subject === undefined || status === undefined || revision === undefined) return undefined
  return { id, subject, status, revision, ownerName: asString(task.ownerName), blockedBy: asStringArray(task.blockedBy), ready: task.ready }
}

/** The effective wait_agent timeout in whole seconds; the tool default is 30s. */
function waitSeconds(args: unknown): number {
  const ms = asNumber(asRecord(args)?.timeout_ms)
  return ms === undefined ? 30 : Math.round(ms / 1000)
}

const spawnTeammate: ToolPresentation = {
  presentCall(args) {
    const record = asRecord(args)
    const name = asString(record?.name)
    if (name === undefined) return undefined
    return call(record?.context === 'fork' ? `${name} · fork` : name)
  },
  presentResult(_args, result) {
    const member = asRecord(asRecord(resultValue(result))?.member)
    const name = asString(member?.name)
    const status = asString(member?.status)
    if (name === undefined || status === undefined) return undefined
    return lines(`${name} created · ${status} · ${asString(member?.context) ?? 'fresh'}`)
  },
}

const sendMessage: ToolPresentation = {
  presentCall(args) {
    const record = asRecord(args)
    const target = asString(record?.target)
    if (target === undefined) return undefined
    const message = asString(record?.message)
    const preview = message === undefined ? '' : oneLine(message, 40)
    return call(preview === '' ? `→ ${target}` : `→ ${target}: ${preview}`)
  },
  presentResult(_args, result) {
    const status = asString(asRecord(resultValue(result))?.status)
    return status === undefined ? undefined : lines(status)
  },
}

const listAgents: ToolPresentation = {
  presentCall() {
    return call('team roster')
  },
  presentResult(_args, result) {
    const value = resultValue(result)
    if (!Array.isArray(value)) return undefined
    const rows: string[] = []
    for (const item of value) {
      const member = asRecord(item)
      const name = asString(member?.name)
      const status = asString(member?.status)
      if (name === undefined || status === undefined) return undefined
      rows.push(`${name} · ${status}`)
    }
    return lines(rows.length === 0 ? 'no members' : rows.join('\n'))
  },
}

const waitAgent: ToolPresentation = {
  presentCall(args) {
    return call(`waiting for team changes · timeout ${waitSeconds(args)}s`)
  },
  presentResult(args, result) {
    const value = asRecord(resultValue(result))
    if (value === undefined) return undefined
    if (asRecord(value.noProgress) !== undefined) return lines('no active peer to wait for')
    if (value.timedOut === true) return lines(`timed out after ${waitSeconds(args)}s`)
    if (value.timedOut === false) return lines('woken by a team change')
    return undefined
  },
}

const interruptAgent: ToolPresentation = {
  presentCall(args) {
    const target = asString(asRecord(args)?.target)
    return target === undefined ? undefined : call(target)
  },
  presentResult(_args, result) {
    const previous = asString(asRecord(resultValue(result))?.previousStatus)
    return previous === undefined ? undefined : lines(`interrupted · was ${previous}`)
  },
}

const teamTaskCreate: ToolPresentation = {
  presentCall(args) {
    const subject = asString(asRecord(args)?.subject)
    if (subject === undefined) return undefined
    const text = oneLine(subject, 60)
    return text === '' ? undefined : call(text)
  },
  presentResult(_args, result) {
    const task = taskView(resultValue(result))
    if (task === undefined) return undefined
    if (task.blockedBy.length > 0) return lines(`${task.id} · ${task.status} · blocked by ${task.blockedBy.join(', ')}`)
    return lines(task.ready === true ? `${task.id} · ${task.status} · ready` : `${task.id} · ${task.status}`)
  },
}

const teamTaskList: ToolPresentation = {
  presentCall(args) {
    const record = asRecord(args) ?? {}
    const parts: string[] = []
    const status = asString(record.status)
    const owner = asString(record.owner)
    if (status !== undefined) parts.push(`status=${status}`)
    if (owner !== undefined) parts.push(`owner=${owner}`)
    if (record.ready === true) parts.push('ready')
    if (record.ready === false) parts.push('not ready')
    if (parts.length === 0) return call('all tasks')
    if (parts.length === 1 && record.ready === true) return call('ready tasks')
    return call(parts.join(' · '))
  },
  presentResult(_args, result) {
    const value = asRecord(resultValue(result))
    if (value === undefined || !Array.isArray(value.tasks)) return undefined
    const rows: string[] = []
    for (const item of value.tasks) {
      const task = taskView(item)
      if (task === undefined) return undefined
      rows.push(`${taskMark(task.status, task.ready)} ${task.id} ${oneLine(task.subject, 60)} (${task.ownerName ?? 'unowned'} · ${task.status})`)
    }
    return lines(rows.length === 0 ? 'no tasks' : rows.join('\n'))
  },
}

const teamTaskGet: ToolPresentation = {
  presentCall(args) {
    const id = asString(asRecord(args)?.task_id)
    return id === undefined ? undefined : call(id)
  },
  presentResult(_args, result) {
    const task = taskView(resultValue(result))
    if (task === undefined) return undefined
    const detail = [
      task.status,
      task.ownerName === undefined ? 'unowned' : `owner ${task.ownerName}`,
      `rev ${task.revision}`,
      ...(task.blockedBy.length > 0 ? [`blocked by ${task.blockedBy.join(', ')}`] : []),
    ]
    return lines(`${task.id} ${taskMark(task.status, task.ready)} ${task.subject}\n${detail.join(' · ')}`)
  },
}

const teamTaskUpdate: ToolPresentation = {
  presentCall(args) {
    const record = asRecord(args)
    const id = asString(record?.task_id)
    const action = asString(record?.action)
    if (id === undefined || action === undefined) return undefined
    return call(`${id} · ${action}`)
  },
  presentResult(args, result) {
    const action = asString(asRecord(args)?.action)
    const task = taskView(resultValue(result))
    if (task === undefined) return undefined
    if (action === 'delete' || task.status === 'deleted') return lines(`${task.id} deleted`)
    if (task.status === 'completed') return lines(`${task.id} → completed · rev ${task.revision}`)
    return lines(`${task.id} → ${task.status} · ${task.ownerName ?? 'unowned'} · rev ${task.revision}`)
  },
}

/** The presentation table keyed by the official tool names. */
const presentations: ReadonlyMap<string, ToolPresentation> = new Map<string, ToolPresentation>([
  ['spawn_teammate', spawnTeammate],
  ['send_message', sendMessage],
  ['list_agents', listAgents],
  ['wait_agent', waitAgent],
  ['interrupt_agent', interruptAgent],
  ['team_task_create', teamTaskCreate],
  ['team_task_list', teamTaskList],
  ['team_task_get', teamTaskGet],
  ['team_task_update', teamTaskUpdate],
])

/**
 * Resolve the local presentation for one of the official Agent Teams tools.
 * @param name - the registered tool name.
 * @returns the presentation, or undefined for every non-team tool so the fold
 *   reads whatever presentation the registered tool itself carries.
 */
export function teamToolPresentation(name: string): ToolPresentation | undefined {
  return presentations.get(name)
}
