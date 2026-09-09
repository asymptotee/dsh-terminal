/**
 * The adapter's runtime surface: upstream constructors and service bindings
 * the driver calls. Kept separate from the type surface so type-only consumers
 * never drag the runtime modules into their module graph.
 * @module dsh-terminal/src/dsh-adapter/services
 */

export { installModelSelection } from '@deepseek-ai/dsh-agent'
export { createUserMessage } from '@deepseek-ai/dsh-llm'
export { SessionId } from '@deepseek-ai/dsh-session'
export { parseCmdline } from '@deepseek-ai/dsh-cmdline'
export { default as z } from '@deepseek-ai/schemastery'
export { defineTool } from '@deepseek-ai/dsh-tools'
