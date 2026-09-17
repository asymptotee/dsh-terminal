/** The local presentation table for the official Agent Teams tools. */

import { describe, expect, it } from 'vitest'
import { teamToolPresentation } from '../src/team-present.ts'
import type { ToolCallView, ToolResult, ToolResultView } from '../src/dsh-adapter/types.ts'

/** A successful tool result carrying one JSON text block, as the team tools render. */
function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}

/** The completed-card text lines of a generic result view. */
function resultText(view: ToolResultView | undefined): string {
  if (view === undefined || view.card !== 'generic') throw new Error('expected a generic result view')
  const block = view.content?.[0]
  return block !== undefined && block.type === 'text' ? block.text : ''
}

/** The pending-card title of a generic call view. */
function callTitle(view: ToolCallView | undefined): string {
  if (view === undefined || view.card !== 'generic') throw new Error('expected a generic call view')
  return view.title
}

describe('teamToolPresentation', () => {
  it('covers all nine team tools and nothing else', () => {
    for (const name of [
      'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
      'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
    ]) {
      expect(teamToolPresentation(name)).toBeDefined()
    }
    expect(teamToolPresentation('bash')).toBeUndefined()
    expect(teamToolPresentation('read_file')).toBeUndefined()
  })
})

describe('spawn_teammate', () => {
  const present = teamToolPresentation('spawn_teammate')!
  it('titles with the teammate name', () => {
    expect(callTitle(present.presentCall!({ name: 'researcher', description: 'd', prompt: 'p' }))).toBe('researcher')
  })
  it('marks a fork context on the title', () => {
    expect(callTitle(present.presentCall!({ name: 'researcher', context: 'fork' }))).toBe('researcher · fork')
  })
  it('falls back when the name is missing', () => {
    expect(present.presentCall!({ description: 'd' })).toBeUndefined()
  })
  it('renders the created member line', () => {
    const view = present.presentResult!({}, jsonResult({ member: { id: 's1', name: 'researcher', role: 'teammate', status: 'provisioning', context: 'fresh', diagnostics: [] } }))
    expect(resultText(view)).toBe('researcher created · provisioning · fresh')
  })
  it('falls back when the result is not the member envelope', () => {
    expect(present.presentResult!({}, jsonResult({ other: 1 }))).toBeUndefined()
  })
})

describe('send_message', () => {
  const present = teamToolPresentation('send_message')!
  it('titles with the target and a message preview', () => {
    expect(callTitle(present.presentCall!({ target: 'researcher', message: '分析项目整体架构' }))).toBe('→ researcher: 分析项目整体架构')
  })
  it('clamps a long message to the first line', () => {
    const title = callTitle(present.presentCall!({ target: 'lead', message: 'x'.repeat(80) }))
    expect(title.startsWith('→ lead: ')).toBe(true)
    expect(title.endsWith('…')).toBe(true)
  })
  it('renders the delivery status', () => {
    expect(resultText(present.presentResult!({}, jsonResult({ messageId: 'm1', status: 'queued' })))).toBe('queued')
  })
})

describe('list_agents', () => {
  const present = teamToolPresentation('list_agents')!
  it('titles as the team roster', () => {
    expect(callTitle(present.presentCall!({}))).toBe('team roster')
  })
  it('renders one line per member', () => {
    const view = present.presentResult!({}, jsonResult([
      { id: 's0', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 's1', name: 'researcher', role: 'teammate', status: 'idle', diagnostics: [] },
    ]))
    expect(resultText(view)).toBe('lead · running\nresearcher · idle')
  })
  it('falls back when a member lacks a status', () => {
    expect(present.presentResult!({}, jsonResult([{ id: 's0', name: 'lead' }]))).toBeUndefined()
  })
})

describe('wait_agent', () => {
  const present = teamToolPresentation('wait_agent')!
  it('titles with the effective timeout', () => {
    expect(callTitle(present.presentCall!({ timeout_ms: 60000 }))).toBe('waiting for any teammate to change · timeout 60s')
    expect(callTitle(present.presentCall!({}))).toBe('waiting for any teammate to change · timeout 30s')
  })
  it('renders the woken outcome', () => {
    expect(resultText(present.presentResult!({}, jsonResult({ timedOut: false })))).toBe('woken by a teammate change')
  })
  it('renders the timeout outcome', () => {
    expect(resultText(present.presentResult!({ timeout_ms: 30000 }, jsonResult({ timedOut: true })))).toBe('timed out after 30s')
  })
  it('renders the no-progress shortcut', () => {
    const view = present.presentResult!({}, jsonResult({ timedOut: false, noProgress: { reason: 'no-active-peer', message: 'No other...' } }))
    expect(resultText(view)).toBe('no active peer to wait for')
  })
})

describe('interrupt_agent', () => {
  const present = teamToolPresentation('interrupt_agent')!
  it('titles with the target', () => {
    expect(callTitle(present.presentCall!({ target: 'researcher' }))).toBe('researcher')
  })
  it('renders the previous status', () => {
    expect(resultText(present.presentResult!({}, jsonResult({ previousStatus: 'running' })))).toBe('interrupted · was running')
  })
})

describe('team_task_create', () => {
  const present = teamToolPresentation('team_task_create')!
  it('titles with the subject', () => {
    expect(callTitle(present.presentCall!({ subject: '分析项目整体架构', description: 'd' }))).toBe('分析项目整体架构')
  })
  it('renders a ready task', () => {
    const view = present.presentResult!({}, jsonResult({ id: 'task-1', revision: 1, subject: 's', description: 'd', status: 'pending', blockedBy: [], writeScopes: [], ready: true }))
    expect(resultText(view)).toBe('task-1 · pending · ready')
  })
  it('renders the blockers of a blocked task', () => {
    const view = present.presentResult!({}, jsonResult({ id: 'task-3', revision: 1, subject: 's', description: 'd', status: 'pending', blockedBy: ['task-1', 'task-2'], writeScopes: [], ready: false }))
    expect(resultText(view)).toBe('task-3 · pending · blocked by task-1, task-2')
  })
})

describe('team_task_list', () => {
  const present = teamToolPresentation('team_task_list')!
  it('titles all tasks by default', () => {
    expect(callTitle(present.presentCall!({}))).toBe('all tasks')
  })
  it('titles a ready-only filter', () => {
    expect(callTitle(present.presentCall!({ ready: true }))).toBe('ready tasks')
  })
  it('titles a status filter', () => {
    expect(callTitle(present.presentCall!({ status: 'in_progress' }))).toBe('status=in_progress')
  })
  it('renders one board line per task with panel markers', () => {
    const view = present.presentResult!({}, jsonResult({ tasks: [
      { id: 'task-1', revision: 2, subject: '分析项目整体架构', description: '', status: 'completed', ownerName: 'code-analyst', blockedBy: [], writeScopes: [], ready: true },
      { id: 'task-2', revision: 1, subject: '写架构文档', description: '', status: 'in_progress', ownerName: 'doc-writer', blockedBy: [], writeScopes: [], ready: true },
      { id: 'task-3', revision: 1, subject: '集成验证', description: '', status: 'pending', blockedBy: ['task-1'], writeScopes: [], ready: false },
    ] }))
    expect(resultText(view)).toBe(
      '✔ task-1 分析项目整体架构 (code-analyst · completed)\n'
      + '◼ task-2 写架构文档 (doc-writer · in_progress)\n'
      + '⊘ task-3 集成验证 (unowned · pending)',
    )
  })
  it('renders an empty board', () => {
    expect(resultText(present.presentResult!({}, jsonResult({ tasks: [] })))).toBe('no tasks')
  })
})

describe('team_task_get', () => {
  const present = teamToolPresentation('team_task_get')!
  it('titles with the task id', () => {
    expect(callTitle(present.presentCall!({ task_id: 'task-1' }))).toBe('task-1')
  })
  it('renders the task detail over two lines', () => {
    const view = present.presentResult!({}, jsonResult({ id: 'task-1', revision: 3, subject: '分析项目整体架构', description: '', status: 'in_progress', ownerName: 'code-analyst', blockedBy: [], writeScopes: [], ready: true }))
    expect(resultText(view)).toBe('task-1 ◼ 分析项目整体架构\nin_progress · owner code-analyst · rev 3')
  })
  it('includes blockers in the detail line', () => {
    const view = present.presentResult!({}, jsonResult({ id: 'task-3', revision: 1, subject: '集成验证', description: '', status: 'pending', blockedBy: ['task-1'], writeScopes: [], ready: false }))
    expect(resultText(view)).toBe('task-3 ⊘ 集成验证\npending · unowned · rev 1 · blocked by task-1')
  })
})

describe('team_task_update', () => {
  const present = teamToolPresentation('team_task_update')!
  it('titles with the task id and action', () => {
    expect(callTitle(present.presentCall!({ task_id: 'task-1', expected_revision: 1, action: 'claim' }))).toBe('task-1 · claim')
  })
  it('renders a claim transition with the new owner', () => {
    const view = present.presentResult!({ action: 'claim' }, jsonResult({ id: 'task-1', revision: 4, subject: 's', description: '', status: 'in_progress', ownerName: 'code-analyst', blockedBy: [], writeScopes: [], ready: true }))
    expect(resultText(view)).toBe('task-1 → in_progress · code-analyst · rev 4')
  })
  it('renders a completion without the owner', () => {
    const view = present.presentResult!({ action: 'complete' }, jsonResult({ id: 'task-1', revision: 5, subject: 's', description: '', status: 'completed', ownerName: 'code-analyst', blockedBy: [], writeScopes: [], ready: true }))
    expect(resultText(view)).toBe('task-1 → completed · rev 5')
  })
  it('renders a delete', () => {
    const view = present.presentResult!({ action: 'delete' }, jsonResult({ id: 'task-1', revision: 6, subject: 's', description: '', status: 'deleted', blockedBy: [], writeScopes: [], ready: false }))
    expect(resultText(view)).toBe('task-1 deleted')
  })
})

describe('failure fallback', () => {
  it('returns undefined on an error result so the raw path renders red', () => {
    const present = teamToolPresentation('spawn_teammate')!
    expect(present.presentResult!({}, { content: [{ type: 'text', text: 'spawn refused' }], isError: true })).toBeUndefined()
  })
  it('returns undefined when the result body is not JSON', () => {
    const present = teamToolPresentation('team_task_list')!
    expect(present.presentResult!({}, { content: [{ type: 'text', text: 'not json' }], isError: false })).toBeUndefined()
  })
})
