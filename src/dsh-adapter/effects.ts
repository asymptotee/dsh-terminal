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

export {}
