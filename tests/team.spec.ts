/** The team coordination helpers: relay envelope, role parsing, and the spawn instruction. */

import { describe, expect, it } from 'vitest'
import { parseTeamRoles, relayEnvelope, rolePrompt, teamInstruction } from '../src/team/index.ts'

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
    expect(prompt).toContain('team_send')
    expect(prompt).toContain('report your completion to the coordinator')
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
    expect(instruction).toContain("set the subagent tool's `description` parameter to EXACTLY the role name")
    expect(instruction).toContain('researcher (duty: 调研)')
    expect(instruction).toContain('architect (duty: 设计)')
    expect(instruction).toContain('team_send')
    expect(instruction).toContain("Do not perform teammates' tasks yourself")
    expect(instruction).toContain('Communicate with teammates using send_message (not team_send')
    expect(instruction).toContain('do not poll list_agents repeatedly')
    expect(instruction).toContain('you do not need to send extra messages to wake idle teammates')
    expect(instruction).toContain("You decide when the team's work is complete")
  })
})
