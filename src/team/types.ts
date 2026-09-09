/**
 * Team task vocabulary: the payload type of the `team/task-write` event and
 * the `teamTasks` projection. The declaration merges that bind this type into
 * the upstream event and projection maps live in the adapter
 * (`src/dsh-adapter/effects.ts`), keeping upstream module names out of this
 * directory. The shared task list is whole-list replaced like the todo list,
 * but entries carry the identity a team needs: stable id (claiming across
 * whole-list writes), owner (the teammate that claimed it), and blockedBy
 * (task-level dependencies).
 * @module dsh-terminal/src/team/types
 */

/** One entry in the team's shared task list. */
export interface TeamTask {
  /** Stable identity; survives whole-list replacement so claiming holds. */
  id: string
  /** What the task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. */
  status: 'pending' | 'in_progress' | 'completed'
  /** The teammate label that claimed the task; absent while unclaimed. */
  owner?: string | undefined
  /** Ids of tasks that must complete before this one may start. */
  blockedBy?: string[] | undefined
}
