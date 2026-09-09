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
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type { TeamTask } from '../team/types.ts'

/**
 * The team task vocabulary bound into the upstream maps. This package owns
 * these merges (rather than an upstream package owning them) because the team
 * list is a local feature; the adapter hosts the augmentation so upstream
 * module names stay inside the boundary.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-team snapshot; latest write wins on replay. Log-only UI state. */
    'team/task-write': {
      tasks: TeamTask[]
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    teamTasks: TeamTask[] | null
  }
  interface SessionProjectionMap {
    /**
     * The team's current whole task list (the latest `team/task-write`
     * snapshot), or `null` before the first write. Whole-value rule: every
     * write carries the complete replacement list, so the fold is last-wins.
     */
    teamTasks: TeamTask[] | null
  }
}

export {}
