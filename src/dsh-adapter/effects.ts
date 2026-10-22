/**
 * Declaration-merge side effects. These packages extend the session event map,
 * the cordis event map, or the Loader/cmdline Context surface purely through
 * declaration merging; importing this module pulls every merge into the
 * program. No runtime code.
 * @module dsh-terminal/src/dsh-adapter/effects
 */

import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type {} from '@deepseek-ai/dsh-subagent'
// Pulls in the `ctx.sessionProjections` registry surface and the
// SessionProjectionStateMap the Agent Teams merge extends.
import type {} from '@deepseek-ai/dsh-session-projection'
// Pulls in the Agent Teams declaration merges: the `agentTeam` session
// projection key and the `team/*` session event types, so the driver can read
// the authoritative team state and recognize team events on the session bus.
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
// Pulls in the durable workflow-record event merge (the four
// `tool-workflow/*` session events) so the driver can fold workflow runs.
// Must be the /types subpath: the package root re-exports no types and
// instead merges JobKindMap into @deepseek-ai/dsh-jobs, a package this tree
// does not carry.
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
// Pulls in the `goal` session-projection key (the stateOf type the driver reads
// for the standing goal) and the `goal/activation-changed` cordis event (the
// only signal of an armed/disarmed continuation flip). Must be the /types
// subpath: the package root re-exports the host-coupled domain vocabulary and
// drags dsh-agent/dsh-llm/dsh-typert into the program, while /types is the pure
// client-safe outlet. The durable `goal/change` session-event merge lives in the
// root, but the driver never needs it typed — it folds nothing itself, matching
// live goal events by prefix and reading the projection through stateOf.
import type {} from '@deepseek-ai/dsh-goal/types'
// Pulls in the background-jobs merges: the `ctx.jobs` registry on the cordis
// Context plus the JobView/JobEvent vocabulary the driver shapes into rows.
// Root import is safe here — unlike dsh-goal, jobs has no separate /types
// outlet, and a type-only root import emits nothing at runtime.
import type {} from '@deepseek-ai/dsh-jobs'
// Pulls in the user-questions merges the runner's question answerer needs:
// the `user-questions/request` waterfall event on the cordis Events map, the
// `userQuestions` session-projection key, and the `user-question-reply`
// MessageSourceMap entry. Must be the /types subpath: the package root
// re-exports the host-coupled service (ctx.userQuestions on the cordis
// Context plus runtime classes) that would drag the service's implementation
// into the program, while /types is the pure client-safe outlet. The runner
// reads the service structurally via ctx.get, so the Context merge is not
// needed — only the waterfall event type.
import type {} from '@deepseek-ai/dsh-user-questions/types'

export {}
