/** The team task list validation: the constraints the schema cannot express. */

import { describe, expect, it } from 'vitest'
import { parseTeamRoles, relayEnvelope, rolePrompt, teamInstruction, toTeamTasks } from '../src/team/index.ts'

const task = (partial: Partial<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; owner: string; blockedBy: string[] }> = {}) => ({
  id: 't1',
  content: 'do the thing',
  status: 'pending' as const,
  ...partial,
})

describe('toTeamTasks', () => {
  it('normalizes a valid list, trimming ids and content', () => {
    const tasks = toTeamTasks([
      task({ id: ' t1 ', content: ' task one ' }),
      task({ id: 't2', content: 'task two', status: 'in_progress', owner: 'arch', blockedBy: ['t1'] }),
    ])
    expect(tasks).toEqual([
      { id: 't1', content: 'task one', status: 'pending' },
      { id: 't2', content: 'task two', status: 'in_progress', owner: 'arch', blockedBy: ['t1'] },
    ])
  })

  it('rejects empty or duplicated ids', () => {
    expect(() => toTeamTasks([task({ id: '  ' })])).toThrow('`id` must be a non-empty string')
    expect(() => toTeamTasks([task(), task({ content: 'other' })])).toThrow('duplicate id')
  })

  it('rejects empty or duplicated content', () => {
    expect(() => toTeamTasks([task({ content: '  ' })])).toThrow('`content` must be a non-empty string')
    expect(() => toTeamTasks([task(), task({ id: 't2' })])).toThrow('duplicate content')
  })

  it('rejects a blockedBy reference to an unknown id', () => {
    expect(() => toTeamTasks([task({ blockedBy: ['ghost'] })])).toThrow('depends on unknown id')
  })
})

describe('relayEnvelope', () => {
  it('attributes the originator in the envelope text', () => {
    expect(relayEnvelope('researcher', 'findings ready')).toBe(
      'Message from researcher (relayed): findings ready',
    )
  })
})

describe('parseTeamRoles', () => {
  it('parses comma-separated role:duty pairs (both comma styles)', () => {
    expect(parseTeamRoles('researcher:调研流程, architect:设计接口')).toEqual([
      { label: 'researcher', duty: '调研流程' },
      { label: 'architect', duty: '设计接口' },
    ])
    expect(parseTeamRoles('a:do x，b:do y')).toHaveLength(2)
  })

  it('parses whitespace-separated tokens when no comma is present', () => {
    expect(parseTeamRoles('researcher:调研 architect:设计')).toEqual([
      { label: 'researcher', duty: '调研' },
      { label: 'architect', duty: '设计' },
    ])
  })

  it('rejects empty input, missing duties, and duplicated labels', () => {
    expect(() => parseTeamRoles('  ')).toThrow('usage:')
    expect(() => parseTeamRoles('researcher')).toThrow('expected role:duty')
    expect(() => parseTeamRoles('researcher:, architect:x')).toThrow('non-empty')
    expect(() => parseTeamRoles('a:x, a:y')).toThrow('duplicate team role label')
  })
})

describe('rolePrompt', () => {
  it('carries the role identity, discipline, and duty', () => {
    const prompt = rolePrompt('architect', '设计新接口')
    expect(prompt).toContain("You are the team's architect")
    expect(prompt).toContain('Respond in Chinese')
    expect(prompt).toContain('team_task_read')
    expect(prompt).toContain('team_send')
    expect(prompt).toContain('Your duty: 设计新接口')
  })
})

describe('teamInstruction', () => {
  it('carries the roster, discipline template, and coordinator role', () => {
    const instruction = teamInstruction([
      { label: 'researcher', duty: '调研' },
      { label: 'architect', duty: '设计' },
    ])
    expect(instruction).toContain('You are the team coordinator')
    expect(instruction).toContain('Respond to the user in Chinese')
    expect(instruction).toContain('researcher (duty: 调研) → shared task t1')
    expect(instruction).toContain('architect (duty: 设计) → shared task t2')
    expect(instruction).toContain('team_task_read')
    expect(instruction).toContain('team_task_write')
    expect(instruction).toContain("Do not perform teammates' tasks yourself")
  })
})
