/**
 * The adapter's type surface: every upstream type the terminal uses,
 * re-exported from the pinned @deepseek-ai packages. UI and driver modules
 * import these re-exports instead of the upstream packages directly; the
 * boundary gate enforces it, so a version bump touches only this directory.
 * @module dsh-terminal/src/dsh-adapter/types
 */

export type { Context } from '@deepseek-ai/cordis'
export type { AssistantStreamRecord, ContentBlock, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
export type { SessionEvent } from '@deepseek-ai/dsh-session'
export type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
export type { ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
export type { Agent, AgentSetup, AssistantStreamFrame, ModelSelection } from '@deepseek-ai/dsh-agent'
export type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
export type { CommandDescriptor, default as CommandRuntime } from '@deepseek-ai/dsh-commands'
// The 0.2.2 line dropped the SessionProjectionStateMap augmentations, so the
// registry's stateOf reads come back untyped; the driver casts to these faces.
// The goal cell is publicly exported; the team state is not (its projection
// module stays internal), so its structural face is declared here from the
// publicly exported snapshots.
export type { GoalProjectionState } from '@deepseek-ai/dsh-goal/types'
import type { TeamMemberSnapshot, TeamTaskSnapshot } from '@deepseek-ai/dsh-experimental-agent-team'
export type { TeamMemberSnapshot, TeamTaskSnapshot }

/** The structural face of the `agentTeam` session projection the team panel reads. */
export interface AgentTeamProjectionState {
  readonly members: readonly TeamMemberSnapshot[]
  readonly tasks: readonly TeamTaskSnapshot[]
}
