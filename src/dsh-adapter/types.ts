/**
 * The adapter's type surface: every upstream type the terminal uses,
 * re-exported from the pinned @deepseek-ai packages. UI and driver modules
 * import these re-exports instead of the upstream packages directly; the
 * boundary gate enforces it, so a version bump touches only this directory.
 * @module dsh-terminal/src/dsh-adapter/types
 */

export type { Context } from '@deepseek-ai/cordis'
export type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
export type { SessionEvent } from '@deepseek-ai/dsh-session'
export type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
export type { ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
export type { AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
export type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
export type { default as CommandRuntime } from '@deepseek-ai/dsh-commands'
export type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
