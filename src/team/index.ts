/**
 * The team task list plugin: registers the `team_task_write` /
 * `team_task_read` tools and the `teamTasks` projection unit. The shared list
 * lives in the coordinator session's log — for a teammate (a child session)
 * that is its `parentSession`, for the main agent its own session — so event
 * sourcing provides persistence, replay, and resume reconciliation for free.
 *
 * Whole-list replacement mirrors `todo_write`: every write carries the
 * complete list, replay is last-write-wins, and there is no partial update.
 * Unlike the single-owner todo list, entries carry team identity: a stable
 * `id` (claiming survives whole-list writes), an `owner` label, and
 * `blockedBy` task dependencies. Concurrency is deliberately lock-free —
 * last-write-wins with claim discipline expressed in the tool description.
 * @module dsh-terminal/team
 */

import { z as zod } from 'zod'
import { createUserMessage, defineTool, z } from '../dsh-adapter/services.ts'
import type { Agent, Context, SubagentListEntry } from '../dsh-adapter/types.ts'
import type { TeamTask } from './types.ts'

export const name = 'tool-team'

export const inject = ['tools', 'sessionProjections', 'subagents', 'commands']

/** Plugin config: reserved for later milestones (M1 takes no settings). */
export interface Config {}

/** Schemastery configuration for the team plugin consumer. */
export const Config: z<Config> = z.object({})

/** One task as the model submits it (schema-checked; ids/content validated in execute). */
interface TeamTaskInput {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string | undefined
  blockedBy?: string[] | undefined
}

/** Wire payload schema of the `teamTasks` projection (whole list or pre-first-write null). */
const teamTasksProjectionSchema = zod.union([
  zod.array(zod.object({
    id: zod.string(),
    content: zod.string(),
    status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
    owner: zod.string().optional(),
    blockedBy: zod.array(zod.string()).optional(),
  })),
  zod.null(),
])

/**
 * Validate the value constraints the ParameterSchemaSpec cannot express and
 * build the canonical {@link TeamTask}[]: non-empty unique ids, trimmed
 * non-empty unique content, and `blockedBy` entries that reference existing
 * ids. Exported for the unit suite.
 * @param raw - the model-submitted list, already schema-checked.
 * @returns the canonical list.
 * @throws when an id/content is empty, duplicated, or a dependency dangles.
 */
export function toTeamTasks(raw: readonly TeamTaskInput[]): TeamTask[] {
  const tasks: TeamTask[] = []
  const ids = new Set<string>()
  const contents = new Set<string>()
  for (const task of raw) {
    const id = task.id.trim()
    if (id.length === 0) throw new Error('invalid team task: `id` must be a non-empty string')
    if (ids.has(id)) throw new Error(`invalid team tasks: duplicate id ${JSON.stringify(id)}`)
    ids.add(id)
    const content = task.content.trim()
    if (content.length === 0) throw new Error('invalid team task: `content` must be a non-empty string')
    if (contents.has(content)) throw new Error(`invalid team tasks: duplicate content ${JSON.stringify(content)}`)
    contents.add(content)
    tasks.push({
      id,
      content,
      status: task.status,
      ...task.owner === undefined ? {} : { owner: task.owner },
      ...task.blockedBy === undefined ? {} : { blockedBy: task.blockedBy },
    })
  }
  for (const task of tasks) {
    for (const dependency of task.blockedBy ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`invalid team tasks: task ${JSON.stringify(task.id)} depends on unknown id ${JSON.stringify(dependency)}`)
      }
    }
  }
  return tasks
}

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
  '- Before starting work, use team_task_read to check the shared task list; claim tasks whose owner is you and which are not blocked, and update status via team_task_write (whole-list replacement; read before writing; never modify the content text)',
  '- Mark a task completed as soon as it is done',
  '- To hand a deliverable to another teammate, use team_send(to: <teammate label>, message: <self-contained content>) — the recipient sees only this message, not your transcript',
  '- A blocked task waits until its blockedBy dependencies are resolved',
].join('\n')

/**
 * The standard teammate prompt: role identity, the fixed team discipline
 * (claim via team_task_read/team_task_write, hand off via team_send, respect
 * blockedBy), and the role's duty. Exported for the unit suite.
 * @param label - the teammate's roster label.
 * @param duty - the role's duty description.
 * @returns the complete teammate prompt.
 */
export function rolePrompt(label: string, duty: string): string {
  return [`You are the team's ${label}.`, 'Team discipline:', TEAM_DISCIPLINE, `Your duty: ${duty}`].join('\n')
}

/**
 * The `/team` spawn instruction handed to the coordinator model: the roster
 * with duties, the discipline template every teammate prompt must carry, the
 * initial task-list directive, and the coordinator's own role — so the model
 * spawns with full knowledge instead of discovering the team after the fact.
 * Exported for the unit suite.
 * @param roles - the parsed roster.
 * @returns the complete instruction text.
 */
export function teamInstruction(roles: readonly TeamRole[]): string {
  const roster = roles.map((role, index) => `- ${role.label} (duty: ${role.duty}) → shared task t${index + 1}`).join('\n')
  return [
    'Assemble the team and start the collaboration.',
    '',
    'Respond to the user in Chinese.',
    '',
    'You are the team coordinator. Spawn the following teammates one by one with the subagent tool (background mode); their labels must match these names exactly:',
    roster,
    '',
    "Every teammate's prompt must include the following team discipline verbatim, followed by that teammate's duty:",
    TEAM_DISCIPLINE,
    '',
    'Then create the shared task list with team_task_write: one task per teammate (ids t1, t2, ...; owner pre-assigned to the teammate; status pending; express ordering with blockedBy where duties depend on each other).',
    '',
    "Coordinator duties: watch the team task board, coordinate when dependencies resolve or a teammate stalls, and aggregate the final results for the user. Do not perform teammates' tasks yourself; teammates hand off directly via team_send.",
  ].join('\n')
}

/**
 * Register the two team tools on `ctx.tools` and the `teamTasks` unit on
 * `ctx.sessionProjections`.
 * @param ctx - registrant context carrying the tool and projection registries.
 * @param _config - reserved; M1 takes no settings.
 */
export function apply(ctx: Context, _config: Config): void {
  ctx.sessionProjections.register({
    key: 'teamTasks',
    stateSchema: teamTasksProjectionSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'team/task-write') return event.data.tasks
      return state
    },
    wire: {
      viewSchema: teamTasksProjectionSchema,
      view: (state) => state,
    },
    stateVersion: 1,
  })

  /** The session that owns the shared list: a child reads its parent's, the main agent its own. */
  const listSession = (agent: Agent) => {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return agent.session
    return ctx.get('sessions')?.get(parentId)
  }

  ctx.tools.register(defineTool({
    name: 'team_task_write',
    description:
      'Replace the team\'s shared task list with the COMPLETE list — whole-list replacement, no partial updates. '
      + 'Each task carries a stable id, content, status, the owner label of the teammate that claimed it, and '
      + 'blockedBy ids of tasks that must finish first. Claim a task by reading the current list first '
      + '(team_task_read) and setting owner only on tasks without one; concurrent writers are last-write-wins, '
      + 'so re-read before every write.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: 'The COMPLETE team task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable task identity; survives whole-list replacement.' },
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'], description: 'pending | in_progress | completed.' },
            owner: { type: 'string', description: 'The teammate label that claimed this task.' },
            blockedBy: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must complete before this one may start.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated team tasks: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const tasks = toTeamTasks(args.tasks)
      if (!exec.agent) throw new Error('team_task_write requires an owning agent session')
      const session = listSession(exec.agent)
      if (!session) throw new Error('team_task_write could not resolve the coordinator session')
      session.append('team/task-write', { tasks })
      const count = (status: TeamTask['status']) => tasks.filter((task) => task.status === status).length
      return Promise.resolve({
        count: tasks.length,
        counts: { pending: count('pending'), inProgress: count('in_progress'), completed: count('completed') },
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Update team tasks', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'team_task_read',
    description: 'Read the team\'s current shared task list. Read before claiming or writing — the list is whole-list replaced and concurrent writers are last-write-wins.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
                owner: { type: 'string' },
                blockedBy: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tasks.length === 0
          ? 'The team task list is empty.'
          : value.tasks.map((task) => `[${task.status}] ${task.id}: ${task.content}${task.owner === undefined ? '' : ` (@${task.owner})`}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      if (!exec.agent) throw new Error('team_task_read requires an owning agent session')
      const session = listSession(exec.agent)
      if (!session) throw new Error('team_task_read could not resolve the coordinator session')
      let tasks: TeamTask[] = []
      for (const event of session.snapshotEvents()) {
        if (event.type === 'team/task-write') tasks = event.data.tasks
      }
      return Promise.resolve({
        tasks: tasks.map((task) => ({
          id: task.id,
          content: task.content,
          status: task.status,
          ...task.owner === undefined ? {} : { owner: task.owner },
          ...task.blockedBy === undefined ? {} : { blockedBy: task.blockedBy },
        })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Read team tasks', kind: 'other' }),
  }))

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
    description: 'Spawn a teammate roster with the standard team discipline and an initial task list.',
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
