/** The driver's subagent roster: folding direct-child events into panel rows, labels, and the fade lifecycle. */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SUBAGENT_FADE_MS } from '../../src/index.ts'
// Side-effect type import: the `subagent/descriptor` event kind the child
// sessions append in the panel tests declaration-merges into the session map.
import type {} from '@deepseek-ai/dsh-subagent'
import { bench } from '../helpers/bench.ts'

describe('subagent panel', () => {
  it('lists a direct child with its descriptor label, activity, and tokens', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-1'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: '调研包结构' })
    child.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'thinking' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
      stream: [],
      usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 50 },
    }, { surfaceOp: 'append' })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-1'), name: 'grep', arguments: '{"pattern":"x"}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({
      childId: 'child-1',
      label: '调研包结构',
      activity: 'grep',
      inputTokens: 150,
      fading: false,
    })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('folds a multiline command title into a one-line semicolon activity', async () => {
    const test = await bench({
      tools: { get: () => ({ presentCall: () => ({ card: 'terminal', title: 'set -u\ncd /work\n\nwc -l *.txt\n' }) }) },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('child-1'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-1'), name: 'bash', arguments: '{}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Newlines fold to `; `, the interior blank line drops, the trailing
    // newline leaves no dangling separator — one physical panel row.
    expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({
      activity: 'set -u; cd /work; wc -l *.txt',
    })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps the shortened-id label until the descriptor arrives', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-x'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-1'), name: 'grep', arguments: '{}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({ childId: 'child-x', label: 'subagent child-x' })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('ignores unrelated sessions and deeper descendants', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const unrelated = test.ctx.sessions.create(SessionId('other'))
    unrelated.append('turn/start', { turn: 1 })
    const grandchild = test.ctx.sessions.create(SessionId('grand'), {
      meta: { parentSession: SessionId('other'), origin: 'subagent' },
    })
    grandchild.append('turn/start', { turn: 1 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.views.at(-1)?.subagents).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('fades the row of a settled child after its delay', async () => {
    vi.useFakeTimers()
    try {
      const test = await bench({ afterPrompt: () => {} })
      const child = test.ctx.sessions.create(SessionId('child-2'), {
        meta: { parentSession: test.agent.session.id, origin: 'subagent' },
      })
      child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-2'), name: 'grep', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(0)
      // No Agent exists for the child, so the first tick marks the row as fading.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.views.at(-1)?.subagents).toEqual([expect.objectContaining({ childId: 'child-2', fading: true })])
      await vi.advanceTimersByTimeAsync(SUBAGENT_FADE_MS)
      expect(test.views.at(-1)?.subagents).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('navigates the panel and opens the child transcript view', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-3'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: '调研包结构' })
    child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-3'), name: 'grep', arguments: '{}' })
    await new Promise(resolve => setTimeout(resolve, 0))
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    // Enter on the main row returns to the main view but keeps the cursor
    // until Esc dismisses it.
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelMove(1)
    // The selection clamps at the last child row.
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    test.handlers.onPanelEnter()
    const opened = test.views.at(-1)?.openSubagent
    expect(opened?.childId).toBe('child-3')
    expect(opened?.label).toBe('调研包结构')
    expect(opened?.state.frames).toMatchObject([{ kind: 'tool', name: 'grep' }])
    // A one-shot child never offers continuation prompts.
    expect(opened?.continuable).toBeUndefined()
    // Enter keeps the navigation position: the panel still owns the keys and
    // the opened child's row stays highlighted.
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    expect(test.views.at(-1)?.panelNav).toBe(true)
    // Esc lands on the main input in one press: the child closes and every
    // cursor goes with it.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    expect(test.views.at(-1)?.panelNav).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('switches to another child from the child view through panel navigation', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const childA = test.ctx.sessions.create(SessionId('child-a'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    childA.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'A' })
    const childB = test.ctx.sessions.create(SessionId('child-b'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    childB.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'B' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Open A's transcript from the roster panel; Enter keeps the navigation
    // position, so the panel still owns the keys on A's highlighted row.
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-a')
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    expect(test.views.at(-1)?.panelNav).toBe(true)
    // Re-entering navigation (↓ from the child editor) keeps the current row;
    // moving down and Enter switches the open transcript to B.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.panelNav).toBe(true)
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.subagentSelected).toBe(2)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-b')
    // The switch keeps the navigation position: the panel still owns the keys,
    // so ↑↓/Enter keeps walking the roster.
    expect(test.views.at(-1)?.panelNav).toBe(true)
    expect(test.views.at(-1)?.subagentSelected).toBe(2)
    // A continuable child keeps the two-step ladder: the first Esc drops into
    // its editor (the browsing session ends, the ❯ goes with it), the second
    // returns to the main input.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-b')
    expect(test.views.at(-1)?.panelNav).toBeUndefined()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    // Re-entering starts on the main row; Enter there returns to the main
    // view but keeps the cursor until Esc dismisses it.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.subagentSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps the panel engaged when entering a child from the retained-cursor state', async () => {
    const test = await bench({ afterPrompt: () => {} })
    const child = test.ctx.sessions.create(SessionId('child-r'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'R' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // ↓ then Enter on the main row: home view, the cursor retained on main.
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.subagentSelected).toBe(0)
    expect(test.views.at(-1)?.openSubagent).toBeUndefined()
    // Move onto the child and Enter: the panel must keep the keys, so the ❯
    // and the focused surface stay together instead of the caret jumping into
    // the child editor.
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-r')
    expect(test.views.at(-1)?.panelNav).toBe(true)
    expect(test.views.at(-1)?.subagentSelected).toBe(1)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('labels an opened teammate with its roster name, not the spawn description', async () => {
    const test = await bench({
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? {
            members: [{ id: 'm-1', name: 'product-manager', description: 'PM：定义需求与验收', phase: 'active' }],
            tasks: [],
          }
          : undefined,
      },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('m-1'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'PM：定义需求与验收' })
    await new Promise(resolve => setTimeout(resolve, 0))
    // The team panel leads navigation; open the member from its row.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.teamSelected).toBe(0)
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    const opened = test.views.at(-1)?.openSubagent
    expect(opened?.childId).toBe('m-1')
    expect(opened?.label).toBe('product-manager')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('flags a continuable child and reconciles its prompt echo by rpcId', async () => {
    const prompts: { requestId: string; parentSessionId: string; childSessionId: string; mode: string; delivery: string; content: readonly unknown[] }[] = []
    const test = await bench({
      subagents: {
        prompt: (request: typeof prompts[number]) => {
          prompts.push(request)
          return Promise.resolve({ messageId: 'msg-1' })
        },
      },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('child-p'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: '长期助手' })
    await new Promise(resolve => setTimeout(resolve, 0))
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    const opened = test.views.at(-1)?.openSubagent
    expect(opened?.childId).toBe('child-p')
    expect(opened?.continuable).toBe(true)
    // The optimistic echo renders before any durable event, and the request
    // carries the seam's literal contract — the terminal's single send
    // gesture always steers.
    test.handlers.onChildPrompt('换个思路')
    expect(test.views.at(-1)?.openSubagent?.pending).toEqual([expect.objectContaining({ text: '换个思路' })])
    expect(prompts).toHaveLength(1)
    const [request] = prompts
    expect(request).toMatchObject({
      parentSessionId: test.agent.session.id,
      childSessionId: 'child-p',
      mode: 'continuable',
      delivery: 'steer',
      content: [{ type: 'text', text: '换个思路' }],
    })
    expect(typeof request.requestId).toBe('string')
    expect(request.requestId).not.toBe('')
    // The child's durable user/message carries the requestId as its source
    // rpcId; the local echo drops and the committed frame takes its place.
    const message = createUserMessage({ content: [{ type: 'text', text: '换个思路' }], source: { kind: 'user' } })
    child.append('user/message', { ...message, source: { kind: 'user', rpcId: request.requestId } as typeof message.source }, { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const settled = test.views.at(-1)?.openSubagent
    expect(settled?.pending).toBeUndefined()
    expect(settled?.state.frames).toMatchObject([{ kind: 'user', text: '换个思路' }])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('steers every child prompt and withdraws the echo of a rejected one', async () => {
    const deliveries: string[] = []
    let failing = false
    const test = await bench({
      subagents: {
        prompt: (request: { delivery: string }) => {
          deliveries.push(request.delivery)
          return failing
            ? Promise.reject({ code: 'subagent/not-resumable', message: 'subagent cannot be resumed' })
            : Promise.resolve({ messageId: 'msg-2' })
        },
      },
      afterPrompt: () => {},
    })
    const child = test.ctx.sessions.create(SessionId('child-q'), {
      meta: { parentSession: test.agent.session.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', { version: 2, mode: 'continuable', provider: 'spawn', label: 'q' })
    await new Promise(resolve => setTimeout(resolve, 0))
    test.handlers.onPanelOpen()
    test.handlers.onPanelMove(1)
    test.handlers.onPanelEnter()
    test.handlers.onChildPrompt('插一句')
    expect(deliveries).toEqual(['steer'])
    // A rejected prompt withdraws its own echo and raises the localized notice;
    // the earlier accepted echo stays.
    failing = true
    test.handlers.onChildPrompt('再来一句')
    await new Promise(resolve => setTimeout(resolve, 0))
    const view = test.views.at(-1)
    expect(view?.overlay).toEqual({ kind: 'notice', text: '发送失败：该子代理不支持续聊（one-shot）' })
    expect(view?.openSubagent?.pending).toEqual([expect.objectContaining({ text: '插一句' })])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps an opened child out of the fade removal', async () => {
    vi.useFakeTimers()
    try {
      const test = await bench({ afterPrompt: () => {} })
      const child = test.ctx.sessions.create(SessionId('child-4'), {
        meta: { parentSession: test.agent.session.id, origin: 'subagent' },
      })
      child.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('cc-4'), name: 'grep', arguments: '{}' })
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onPanelOpen()
      test.handlers.onPanelMove(1)
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(1_000 + SUBAGENT_FADE_MS)
      // The viewed child stays in the roster, so the open view survives the fade.
      expect(test.views.at(-1)?.openSubagent?.childId).toBe('child-4')
      // Esc closes the child in one press; the fade can then take the row.
      test.handlers.onPanelBack()
      expect(test.views.at(-1)?.openSubagent).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(test.views.at(-1)?.subagents).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

