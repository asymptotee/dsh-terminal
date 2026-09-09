/**
 * M2 session-event fold: durable session events become display frames in a
 * seq-ordered stream. The fold is pure and replayable — folding the same
 * event sequence twice yields the same frames and the same rendered lines —
 * so a resumed session rebuilds its display by replaying the log, and live
 * events append through the same path.
 * @module dsh-terminal/src/frames
 */

import type { ContentBlock, MessageSource, SessionEvent, TodoItem, ToolCallView, ToolResult, ToolResultView } from './dsh-adapter/types.ts'
import {
  contentToText,
  renderCommandLine,
  renderInterruptedLine,
  renderNoticeLines,
  renderPlanLines,
  renderToolCallLines,
  renderToolResultLines,
  renderUserLine,
} from './render.ts'

/** One display unit in the terminal session stream. */
export type Frame =
  | { kind: 'user'; seq: number; text: string }
  | {
    kind: 'assistant'
    seq: number
    turn: number
    step: number
    text: string
    streaming: boolean
    /** The folded reasoning stream; seconds resolve at the commit or close point. */
    thinking?: { text: string; startedAt: number; seconds: number }
  }
  | {
    kind: 'tool'
    seq: number
    turn: number
    step: number
    callId: string
    name: string
    /** The parsed call arguments; undefined when the logged JSON was malformed. */
    args: unknown
    call: ToolCallView
    /** The completed card; absent while the call is pending. */
    result?: ToolResultView
    /** The raw result content, the fallback when the result view carries none. */
    resultContent?: readonly ContentBlock[]
    /** The result block reported failure; the UI renders it in red. */
    isError?: boolean
  }
  | {
    kind: 'command'
    seq: number
    commandId: string
    name: string
    /** Verbatim input after the command name; absent when recordInput is false. */
    args?: string
    /** The settled outcome; absent while the handler runs. */
    done?: { kind: 'success' | 'error'; text?: string }
  }
  | {
    kind: 'notice'
    seq: number
    /** The one-line account: the notice source's summary, or the relay content's opening text. */
    summary: string
    /** The remaining message text; absent when the message carries only the account. */
    body?: string
  }
  | {
    /** The user-interruption marker appended at a user-cancelled turn end. */
    kind: 'interrupted'
    seq: number
  }

/** The fold's adopted display state: the stream plus the open/pending registries. */
export interface FrameState {
  /** The display stream in log order. */
  readonly frames: readonly Frame[]
  /** The standing todo plan; cleared on turn/start. */
  readonly plan: readonly TodoItem[] | undefined
  /** The step whose model call is in flight; the thinking indicator's clock source. */
  readonly activeStep: { turn: number; step: number; startedAt: number } | undefined
  /** Open (streaming) assistant frame index by `${turn}:${step}`. */
  readonly openAssistant: ReadonlyMap<string, number>
  /** Pending tool frame index by callId. */
  readonly pendingTools: ReadonlyMap<string, number>
  /** Pending command frame index by commandId. */
  readonly pendingCommands: ReadonlyMap<string, number>
}

/** The presentation surface the fold reads off a registered tool. */
export interface ToolPresentation {
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}

/** What the fold needs from the environment: the registered tool presentations. */
export interface FoldDeps {
  /** Resolve a tool's presentation by name; absent tools fall back to the generic card. */
  tools: { get(name: string): ToolPresentation | undefined }
}

/** The result of folding one event: the adopted state plus the lines it renders. */
export interface FoldResult {
  state: FrameState
  /** Terminal lines this event renders in the M2 plain-text view. */
  lines: readonly string[]
}

/**
 * The empty display state for a fresh or fully replayed session.
 * @returns an empty fold state.
 */
export function createFrameState(): FrameState {
  return { frames: [], plan: undefined, activeStep: undefined, openAssistant: new Map(), pendingTools: new Map(), pendingCommands: new Map() }
}

const stepKey = (turn: number, step: number): string => `${turn}:${step}`

/** Copy the frame array with one slot replaced (indices stay valid). */
function replaceAt(frames: readonly Frame[], index: number, frame: Frame): readonly Frame[] {
  const next = [...frames]
  next[index] = frame
  return next
}

/** Parse logged call arguments; malformed JSON means no args, not a crash. */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // Older or malformed logged arguments fall back to the generic card.
    return undefined
  }
}

/** Round a thinking span to whole seconds, never negative. */
function thinkingSeconds(thinking: { startedAt: number }, endTime: number): number {
  return Math.max(0, Math.round((endTime - thinking.startedAt) / 1000))
}

/**
 * The terminal-visible injection forms of a message source. The source union
 * is merge-extensible across packages (a subagent settlement notice arrives
 * under a kind this package never imports), so eligibility is read off the
 * shared `form` field: a `notice` states what happened with a one-line
 * account, a `relay` carries another agent's addressed content.
 * @param source - the message's durable source attribution.
 * @returns the visible form, or undefined for model-side-only injections.
 */
function visibleNoticeForm(source: MessageSource): 'notice' | 'relay' | undefined {
  if (!('form' in source)) return undefined
  return source.form === 'notice' || source.form === 'relay' ? source.form : undefined
}

/** The one-line account of a notice-form source; merge-extensible kinds carry the same field. */
function noticeSummary(source: MessageSource): string | undefined {
  return 'form' in source && source.form === 'notice' ? source.summary : undefined
}

/** Fold one terminal-visible injection; a message with no displayable account renders nothing. */
function noticeFrame(
  seq: number,
  source: MessageSource,
  content: readonly ContentBlock[],
): Extract<Frame, { kind: 'notice' }> | undefined {
  const [head, ...rest] = content
  const headIsText = head !== undefined && head.type === 'text'
  const summary = noticeSummary(source) ?? (headIsText ? head.text : '')
  if (summary === '') return undefined
  // Notice content blocks are paragraphs (the account header, then the child's
  // message), so the body joins them one per line rather than concatenated.
  const body = contentToText(headIsText ? rest : content, '\n')
  return { kind: 'notice', seq, summary, ...body === '' ? {} : { body } }
}

/** Join the reasoning blocks of a content sequence; other blocks are dropped. */
function contentToThinking(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
}

/** Close every open assistant frame of a turn boundary, resolving thinking spans. */
function closeOpenAssistant(state: FrameState, endTime: number): { frames: readonly Frame[]; openAssistant: ReadonlyMap<string, number> } {
  let frames = state.frames
  const openAssistant = new Map<string, number>()
  for (const [key, index] of state.openAssistant) {
    const existing = frames[index]
    if (existing !== undefined && existing.kind === 'assistant' && existing.streaming) {
      const closed: Frame = existing.thinking === undefined
        ? { ...existing, streaming: false }
        : { ...existing, streaming: false, thinking: { ...existing.thinking, seconds: thinkingSeconds(existing.thinking, endTime) } }
      frames = replaceAt(frames, index, closed)
    } else {
      openAssistant.set(key, index)
    }
  }
  return { frames, openAssistant }
}

/**
 * Fold one durable session event into the display state.
 * @param state - the adopted frame state.
 * @param event - the durable event to fold.
 * @param deps - registered tool presentations.
 * @returns the adopted next state and the lines it renders.
 */
export function foldEvent(state: FrameState, event: SessionEvent, deps: FoldDeps): FoldResult {
  switch (event.type) {
    case 'user/message': {
      const { source, content } = event.data
      // Notice- and relay-form injections are terminal-visible: a background
      // subagent settling, a job finishing, another agent's report.
      if (visibleNoticeForm(source) !== undefined) {
        const notice = noticeFrame(event.seq, source, content)
        return notice === undefined
          ? { state, lines: [] }
          : {
            state: { ...state, frames: [...state.frames, notice] },
            lines: renderNoticeLines(notice),
          }
      }
      // Injected context and other non-user sources are not terminal echoes.
      if (source.kind !== 'user') return { state, lines: [] }
      const text = contentToText(content)
      if (text === '') return { state, lines: [] }
      return {
        state: { ...state, frames: [...state.frames, { kind: 'user', seq: event.seq, text }] },
        lines: [renderUserLine(text)],
      }
    }
    case 'assistant/chunk': {
      const { turn, step, chunk } = event.data
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return { state, lines: [] }
      const delta = chunk.type === 'text-delta'
      const index = state.openAssistant.get(stepKey(turn, step))
      const existing = index === undefined ? undefined : state.frames[index]
      if (index === undefined || existing === undefined || existing.kind !== 'assistant') {
        const thinking = delta ? undefined : { text: chunk.text, startedAt: event.time, seconds: 0 }
        const frame: Frame = {
          kind: 'assistant',
          seq: event.seq,
          turn,
          step,
          text: delta ? chunk.text : '',
          streaming: true,
          ...thinking === undefined ? {} : { thinking },
        }
        return {
          state: {
            ...state,
            frames: [...state.frames, frame],
            openAssistant: new Map(state.openAssistant).set(stepKey(turn, step), state.frames.length),
          },
          lines: delta ? [chunk.text] : [],
        }
      }
      const updated: Frame = delta
        ? { ...existing, text: existing.text + chunk.text }
        : {
          ...existing,
          thinking: {
            text: (existing.thinking?.text ?? '') + chunk.text,
            startedAt: existing.thinking?.startedAt ?? event.time,
            // Each reasoning delta refreshes the span so the live UI ticks.
            seconds: thinkingSeconds({ startedAt: existing.thinking?.startedAt ?? event.time }, event.time),
          },
        }
      return {
        state: { ...state, frames: replaceAt(state.frames, index, updated) },
        lines: delta ? [chunk.text] : [],
      }
    }
    case 'assistant/message': {
      const { turn, step, message } = event.data
      const text = contentToText(message.content)
      const thinkingText = contentToThinking(message.content)
      const index = state.openAssistant.get(stepKey(turn, step))
      const existing = index === undefined ? undefined : state.frames[index]
      if (index === undefined || existing === undefined || existing.kind !== 'assistant') {
        // No stream preceded this commit: print the committed text itself.
        const thinking = thinkingText === '' ? undefined : { text: thinkingText, startedAt: event.time, seconds: 0 }
        const frame: Frame = {
          kind: 'assistant',
          seq: event.seq,
          turn,
          step,
          text,
          streaming: false,
          ...thinking === undefined ? {} : { thinking },
        }
        return {
          state: { ...state, frames: [...state.frames, frame] },
          lines: text === '' ? [] : [text.endsWith('\n') ? text : text + '\n'],
        }
      }
      const updated: Frame = {
        ...existing,
        text,
        streaming: false,
        ...existing.thinking === undefined
          ? {}
          : { thinking: { ...existing.thinking, seconds: thinkingSeconds(existing.thinking, event.time) } },
      }
      const openAssistant = new Map(state.openAssistant)
      openAssistant.delete(stepKey(turn, step))
      return {
        state: { ...state, frames: replaceAt(state.frames, index, updated), openAssistant },
        // The streamed deltas already went out; close the line unless the
        // committed text already ends on a newline.
        lines: text === '' || text.endsWith('\n') ? [] : ['\n'],
      }
    }
    case 'tool/call': {
      const { turn, step, callId, name, arguments: raw } = event.data
      const args = parseArgs(raw)
      const call = deps.tools.get(name)?.presentCall?.(args)
        ?? { card: 'generic', title: name, rawInput: args === undefined ? raw : args }
      const frame: Frame = { kind: 'tool', seq: event.seq, turn, step, callId, name, args, call }
      return {
        state: {
          ...state,
          frames: [...state.frames, frame],
          pendingTools: new Map(state.pendingTools).set(callId, state.frames.length),
        },
        lines: renderToolCallLines(frame),
      }
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const index = state.pendingTools.get(block.toolCallId)
      const existing = index === undefined ? undefined : state.frames[index]
      // An orphan result (no matching pending call) is not displayable.
      if (index === undefined || existing === undefined || existing.kind !== 'tool' || existing.callId !== block.toolCallId) {
        return { state, lines: [] }
      }
      const { meta } = event.data
      const result = deps.tools.get(existing.name)?.presentResult?.(existing.args, {
        content: block.content,
        isError: block.isError ?? false,
        ...meta === undefined ? {} : { meta },
      })
      const updated: Extract<Frame, { kind: 'tool' }> = {
        ...existing,
        ...result === undefined ? {} : { result },
        resultContent: block.content,
        ...block.isError ? { isError: true } : {},
      }
      const pendingTools = new Map(state.pendingTools)
      pendingTools.delete(block.toolCallId)
      return {
        state: { ...state, frames: replaceAt(state.frames, index, updated), pendingTools },
        lines: renderToolResultLines(updated),
      }
    }
    case 'command/run': {
      // Every command record is human-typed (the source union has one variant).
      const { commandId, name } = event.data
      const frame: Frame = {
        kind: 'command',
        seq: event.seq,
        commandId,
        name,
        ...event.data.args === undefined ? {} : { args: event.data.args },
      }
      return {
        state: {
          ...state,
          frames: [...state.frames, frame],
          pendingCommands: new Map(state.pendingCommands).set(commandId, state.frames.length),
        },
        lines: [renderCommandLine(frame)],
      }
    }
    case 'command/done': {
      const index = state.pendingCommands.get(event.data.commandId)
      const existing = index === undefined ? undefined : state.frames[index]
      if (index === undefined || existing === undefined || existing.kind !== 'command') {
        // An orphan settlement (no matching pending command) is not displayable.
        return { state, lines: [] }
      }
      const updated: Extract<Frame, { kind: 'command' }> = {
        ...existing,
        done: {
          kind: event.data.kind,
          ...event.data.text === undefined ? {} : { text: event.data.text },
        },
      }
      const pendingCommands = new Map(state.pendingCommands)
      pendingCommands.delete(event.data.commandId)
      return {
        state: { ...state, frames: replaceAt(state.frames, index, updated), pendingCommands },
        lines: [],
      }
    }
    case 'todo/write': {
      // A fully completed list is spent: the standing panel hides itself, and
      // the tool card in the stream stays as the settled record.
      const todos = event.data.todos
      const plan = todos.every(todo => todo.status === 'completed') ? undefined : todos
      return {
        state: { ...state, plan },
        lines: renderPlanLines(todos),
      }
    }
    case 'step/start':
      // One step is one model call plus its tool executions; the thinking
      // indicator clocks from here until the step settles.
      return {
        state: { ...state, activeStep: { turn: event.data.turn, step: event.data.step, startedAt: event.time } },
        lines: [],
      }
    case 'step/end':
      // A stale end for an earlier step must not clear a newer step's clock.
      return {
        state: state.activeStep !== undefined
          && state.activeStep.turn === event.data.turn
          && state.activeStep.step === event.data.step
          ? { ...state, activeStep: undefined }
          : state,
        lines: [],
      }
    case 'turn/start': {
      // Turn-scoped plan lifetime: the standing list clears on the next turn.
      const closed = closeOpenAssistant(state, event.time)
      return { state: { ...state, ...closed, plan: undefined }, lines: [] }
    }
    case 'turn/end': {
      const closed = closeOpenAssistant(state, event.time)
      // Only a user-initiated cancel leaves a visible marker; disposal and
      // parent cancels happen while the surface is already tearing down.
      const byUser = event.data.reason.kind === 'aborted'
        && event.data.reason.reason.kind === 'user'
      return {
        state: {
          ...state,
          ...closed,
          activeStep: undefined,
          ...byUser ? { frames: [...closed.frames, { kind: 'interrupted' as const, seq: event.seq }] } : {},
        },
        lines: byUser ? [renderInterruptedLine()] : [],
      }
    }
    default:
      // Log-only families (request/header, seed markers, session lifecycle)
      // render nothing in the terminal stream.
      return { state, lines: [] }
  }
}
