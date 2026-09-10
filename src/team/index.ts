/**
 * The team coordination plugin: registers the `team_send` relay tool and the
 * `/team` command. Teammates coordinate purely through messages (team_send);
 * dependencies are expressed in duty descriptions rather than a shared task
 * board, eliminating the whole-list-replacement race. User visibility comes
 * from the subagent roster and coordinator reports.
 * @module dsh-terminal/team
 */

import { createUserMessage, defineTool, z } from '../dsh-adapter/services.ts'
import type { Agent, Context, SubagentListEntry } from '../dsh-adapter/types.ts'

export const name = 'tool-team'

export const inject = ['tools', 'subagents', 'commands']

/** Plugin config: reserved for later milestones (takes no settings). */
export interface Config {}

/** Schemastery configuration for the team plugin consumer. */
export const Config: z<Config> = z.object({})

/**
 * Build the relayed message envelope. The protocol-level sender of a relay is
 * the coordinator (the only legal adjacent sender for a sibling), so the
 * actual originator is attributed in the content instead. Exported for the
 * unit suite.
 * @param origin - the originating teammate's label.
 * @param message - the self-contained message text.
 * @returns the envelope text delivered to the target's inbox.
 */
export function relayEnvelope(origin: string, message: string): string {
  return `Message from ${origin} (relayed): ${message}`
}

/** One parsed `/team` argument: a teammate label and its duty. */
export interface TeamRole {
  label: string
  duty: string
}

/**
 * Parse the `/team` argument list: comma-separated `role:duty` pairs, or
 * whitespace-separated `role:duty` tokens when no comma is present. Labels
 * must be unique — they address teammates in `team_send` and the roster.
 * Exported for the unit suite.
 * @param rawInput - the exact text following the command name.
 * @returns the parsed roles.
 * @throws on an empty list, a missing duty, or a duplicated label.
 */
export function parseTeamRoles(rawInput: string): TeamRole[] {
  const trimmed = rawInput.trim()
  if (trimmed === '') throw new Error('usage: /team role:duty, role:duty ...')
  const segments = /[，,]/.test(trimmed)
    ? trimmed.split(/[，,]/)
    : trimmed.split(/\s+/)
  const roles: TeamRole[] = []
  const labels = new Set<string>()
  for (const segment of segments) {
    const part = segment.trim()
    if (part === '') continue
    const colon = part.indexOf(':')
    if (colon <= 0) throw new Error(`invalid team role ${JSON.stringify(part)}: expected role:duty`)
    const label = part.slice(0, colon).trim()
    const duty = part.slice(colon + 1).trim()
    if (label === '' || duty === '') throw new Error(`invalid team role ${JSON.stringify(part)}: role and duty must both be non-empty`)
    if (labels.has(label)) throw new Error(`duplicate team role label ${JSON.stringify(label)}`)
    labels.add(label)
    roles.push({ label, duty })
  }
  if (roles.length === 0) throw new Error('usage: /team role:duty, role:duty ...')
  return roles
}

/** The fixed team discipline every teammate prompt must carry. */
export const TEAM_DISCIPLINE = [
  '- Respond in Chinese',
  '- To hand a deliverable to another teammate, use team_send(to: <teammate label>, message: <self-contained content>) — the recipient sees only this message, not your transcript',
  "- If your duty depends on another teammate's output, wait for their team_send message before starting your work",
  '- When your duty is done, report your completion to the coordinator (via send_message). Do NOT decide on your own when your work is finished — the coordinator decides when the team is done and will notify you to stop. Keep cooperating with teammates as needed until the coordinator tells you to stop.',
].join('\n')

/**
 * The standard teammate prompt: role identity, the fixed team discipline
 * (hand off via team_send, wait for dependencies), and the role's duty.
 * Exported for the unit suite.
 * @param label - the teammate's roster label.
 * @param duty - the role's duty description.
 * @returns the complete teammate prompt.
 */
export function rolePrompt(label: string, duty: string): string {
  return [`You are the team's ${label}.`, 'Team discipline:', TEAM_DISCIPLINE, `Your duty: ${duty}`].join('\n')
}

/**
 * The `/team` spawn instruction handed to the coordinator model: the roster
 * with duties, the discipline template every teammate prompt must carry, and
 * the coordinator's own role — so the model spawns with full knowledge instead
 * of discovering the team after the fact. Exported for the unit suite.
 * @param roles - the parsed roster.
 * @returns the complete instruction text.
 */
export function teamInstruction(roles: readonly TeamRole[]): string {
  const roster = roles.map((role) => `- ${role.label} (duty: ${role.duty})`).join('\n')
  return [
    'Assemble the team and start the collaboration.',
    '',
    'Respond to the user in Chinese.',
    '',
    "You are the team coordinator. Spawn the following teammates one by one with the subagent tool (background mode). For each teammate, set the subagent tool's `description` parameter to EXACTLY the role name below — this becomes the teammate's display label, so do not wrap, prefix, or rephrase it:",
    roster,
    '',
    "Every teammate's prompt must include the following team discipline verbatim, followed by that teammate's duty:",
    TEAM_DISCIPLINE,
    '',
    "Coordinator duties: watch for teammate messages, coordinate when a teammate stalls, and aggregate the final results for the user. Do not perform teammates' tasks yourself; teammates hand off directly via team_send. Communicate with teammates using send_message (not team_send — that is for teammates only). Wait for teammate notifications; do not poll list_agents repeatedly. Teammate messages arrive automatically — you do not need to send extra messages to wake idle teammates. You decide when the team's work is complete: watch teammates' messages, and when you judge all work is done, notify teammates to stop (via send_message), then aggregate the final results once.",
  ].join('\n')
}

/**
 * Register the `team_send` relay tool on `ctx.tools` and the `/team` command.
 * @param ctx - registrant context carrying the tool and command registries.
 * @param _config - reserved; takes no settings.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.tools.register(defineTool({
    name: 'team_send',
    description:
      'Send a message to another teammate. Delivery is relayed through the coordinator (the star topology\'s '
      + 'only legal adjacent path), attributed to you in the message envelope, and lands in the target\'s inbox '
      + 'for its next turn. Make the message self-contained — the target sees only this text, not your transcript.',
    parameters: {
      to: { type: 'string', required: true, description: 'The target teammate\'s label (as shown in the team roster).' },
      message: { type: 'string', required: true, description: 'The self-contained message content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Message relayed to ${value.delivered}.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('team_send requires an owning agent session')
      const parentId = agent.session.header.parentSession
      if (parentId === undefined) {
        throw new Error('team_send is for teammates; the coordinator delivers with send_message directly')
      }
      const coordinator = ctx.get('agents')?.get(parentId)
      if (!coordinator) throw new Error('the coordinator is offline; team_send cannot relay')
      const roster = (await ctx.subagents.listChildren(parentId))
        .filter((entry): entry is Extract<SubagentListEntry, { kind: 'child' }> => entry.kind === 'child')
      const target = roster.find((entry) => entry.label === args.to)
      if (target === undefined) {
        const known = roster.map((entry) => entry.label ?? String(entry.id)).join(', ')
        throw new Error(`no teammate named ${JSON.stringify(args.to)}; roster: ${known === '' ? '(empty)' : known}`)
      }
      // Attribute the actual originator in the envelope: the protocol sender
      // is the coordinator, the only legal adjacent sender for a sibling.
      const origin = roster.find((entry) => entry.id === agent.session.id)?.label ?? String(agent.session.id)
      await ctx.subagents.sendMessage(coordinator, target.id, [
        { type: 'text', text: relayEnvelope(origin, args.message) },
      ], { signal: exec.signal })
      return { delivered: args.to }
    },
    presentCall: (args) => ({ card: 'generic', title: `Relay message to ${args.to}`, kind: 'other' }),
  }))

  ctx.get('commands')?.register({
    name: 'team',
    description: 'Spawn a teammate roster with the standard team discipline.',
    input: { hint: 'role:duty, role:duty ...' },
    handler(invocation) {
      let roles: TeamRole[]
      try {
        roles = parseTeamRoles(invocation.rawInput)
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
      // Syntactic sugar, not deterministic spawn: the instruction rides into
      // the coordinator's own context as a user message, so the model spawns
      // the teammates with full knowledge of the roster, the discipline, and
      // its own coordinator role — no post-hoc role discovery.
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: teamInstruction(roles) }],
        source: { kind: 'user' },
      }))
      return {
        kind: 'success',
        text: `Team instructions queued for ${roles.map((role) => role.label).join(', ')} — the coordinator will spawn them now.`,
      }
    },
  })
}
