/** The driver's jobs surfaces: the footer summary, the Background list, the detail view, and the two-step kill. */

import { describe, expect, it, vi } from 'vitest'
import { bench } from '../helpers/bench.ts'

describe('jobs surfaces', () => {
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  type FakeJob = {
    id: string
    kind: string
    label: string
    status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
    progress?: string
    detail?: string
    startedAt: number
    finishedAt?: number
  }
  type FakeEvent =
    | { type: 'registered' | 'progress' | 'stopping' | 'removed'; job: FakeJob }
    | { type: 'settled'; job: FakeJob; cause: 'producer' | 'kill' | 'teardown' }
    | { type: 'output'; id: string; total: number }

  /** A scripted registry: the rows list() returns, the chunks readAt hands
   *  out from any offset, and the captured listener the test fires events at. */
  function fakeRegistry() {
    const rows: FakeJob[] = []
    const output = new Map<string, string>()
    let listener: ((event: FakeEvent) => void) | undefined
    const reads: { id: string; from: number }[] = []
    const kills: { id: string; reason: string | undefined }[] = []
    return {
      rows,
      output,
      reads,
      kills,
      emit(event: FakeEvent): void {
        // Mirror the registry: lifecycle events also move list(); the test
        // mutates `rows` itself where the case needs it.
        listener?.(event)
      },
      registry: {
        list: () => rows.map(row => ({ ...row })),
        readAt: (id: string, from: number) => {
          reads.push({ id, from })
          const text = output.get(id) ?? ''
          return { chunks: from < text.length ? [{ text: text.slice(from) }] : [], next: text.length, lossy: false }
        },
        kill: (id: string, _caller: unknown, reason?: string) => {
          kills.push({ id, reason })
          return 'requested' as const
        },
        events: {
          subscribe: (_filter: unknown, l: (event: FakeEvent) => void) => {
            listener = l
            return () => { listener = undefined }
          },
        },
      },
    }
  }

  const runningJob = (id: string, over?: Partial<FakeJob>): FakeJob =>
    ({ id, kind: 'bash', label: `sleep 300 && echo ${id}`, status: 'running', startedAt: Date.now() - 12_000, ...over })

  it('counts live jobs in the footer and moves settled rows to the history', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-1'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // The seeded list() shows the running job as the footer's summary segment.
    expect(test.views.at(-1)?.status?.jobs?.segments).toEqual([{ word: 'shell', count: 1 }])
    // A progress event still lands in the row (the detail below reads it back).
    fake.rows[0] = runningJob('bash-1', { progress: '42%' })
    fake.emit({ type: 'progress', job: fake.rows[0] })
    await settle()
    expect(test.views.at(-1)?.status?.jobs?.segments).toHaveLength(1)
    // Open the list, then settle: the row moves to the history section while
    // the footer (live counts only) drops the segment.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.status?.jobs?.selected).toBe(true)
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.jobsList?.active).toHaveLength(1)
    const settledJob: FakeJob = { ...runningJob('bash-1'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() }
    fake.rows[0] = settledJob
    fake.emit({ type: 'settled', job: settledJob, cause: 'producer' })
    await settle()
    expect(test.views.at(-1)?.status?.jobs).toBeUndefined()
    expect(test.views.at(-1)?.jobsList?.active).toHaveLength(0)
    expect(test.views.at(-1)?.jobsList?.earlier).toHaveLength(1)
    // Enter on the history row opens its detail: settled state, frozen clock.
    test.handlers.onPanelEnter()
    await settle()
    const detail = test.views.at(-1)?.openJob
    expect(detail?.status).toBe('completed')
    expect(detail?.detail).toBe('exit code: 0')
    expect(detail?.elapsedMs).toBeGreaterThanOrEqual(12_000)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('keeps the settled history across ticks without reviving the footer', async () => {
    // The registry's list() retains settled jobs until the owner is disposed —
    // the driver keeps them as the Background list's history while the footer
    // counts live jobs only, so ticks must not resurrect the segment.
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-9'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.status?.jobs?.segments).toHaveLength(1)
      // Open the list (its entry needs a live job), then settle the job.
      test.handlers.onPanelOpen()
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(0)
      const done: FakeJob = { ...runningJob('bash-9'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() }
      fake.rows[0] = done
      fake.emit({ type: 'settled', job: done, cause: 'producer' })
      await vi.advanceTimersByTimeAsync(0)
      // The list keeps the row under the earlier header, ticks on end.
      expect(test.views.at(-1)?.jobsList?.earlier).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(test.views.at(-1)?.jobsList?.earlier).toHaveLength(1)
      expect(test.views.at(-1)?.status?.jobs).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a row the registry removes', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-2'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.status?.jobs?.segments).toHaveLength(1)
      // A foreground bash promoted then removed before settlement vanishes at once.
      fake.rows.length = 0
      fake.emit({ type: 'removed', job: runningJob('bash-2') })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.status?.jobs).toBeUndefined()
      // A live job the registry silently drops from list() goes too.
      fake.rows.push(runningJob('bash-3'))
      fake.emit({ type: 'registered', job: fake.rows[0] })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.status?.jobs?.segments).toHaveLength(1)
      fake.rows.length = 0
      await vi.advanceTimersByTimeAsync(2_000)
      expect(test.views.at(-1)?.status?.jobs).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the Background list on Enter, then the detail, and reads output incrementally', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-4'))
    fake.output.set('bash-4', 'line one\n')
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // ↓ selects the footer's rung (the blue segment); Enter opens the list.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.status?.jobs?.selected).toBe(true)
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.jobsList?.active[0]?.id).toBe('bash-4')
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    // Enter again opens the selected row's detail, read from offset 0.
    test.handlers.onPanelEnter()
    await settle()
    let detail = test.views.at(-1)?.openJob
    expect(detail?.jobId).toBe('bash-4')
    expect(detail?.title).toBe('Shell details')
    expect(detail?.labelField).toBe('Command')
    expect(detail?.output).toBe('line one\n')
    expect(detail?.lossy).toBe(false)
    // New bytes land with an output pulse; the read resumes from the cursor.
    fake.output.set('bash-4', 'line one\nline two\n')
    fake.emit({ type: 'output', id: 'bash-4', total: 19 })
    await settle()
    detail = test.views.at(-1)?.openJob
    expect(detail?.output).toBe('line one\nline two\n')
    expect(fake.reads.at(-1)).toEqual({ id: 'bash-4', from: 9 })
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('shows an empty detail output for a subagent job with no output ring', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('subagent-1', { kind: 'subagent', label: '调研包结构' }))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    test.handlers.onPanelEnter()
    await settle()
    const detail = test.views.at(-1)?.openJob
    expect(detail?.title).toBe('Subagent details')
    expect(detail?.labelField).toBe('Task')
    expect(detail?.label).toBe('调研包结构')
    expect(detail?.output).toBe('')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('arms the kill from the list then kills on the second press within the window', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-9'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onPanelOpen()
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(0)
      // The first x only arms: the list flags it, no kill yet.
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobsList?.killArmed).toBe(true)
      expect(fake.kills).toHaveLength(0)
      // The second x within the window kills with the terminal's reason.
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.kills).toEqual([{ id: 'bash-9', reason: 'stopped from the terminal' }])
      expect(test.views.at(-1)?.jobsList?.killArmed).toBe(false)
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disarms the kill gesture once the re-arm window lapses', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-10'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onPanelOpen()
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobsList?.killArmed).toBe(true)
      // Past the window the arm lapses (the projection re-derives it); the next
      // x only re-arms instead of killing.
      await vi.advanceTimersByTimeAsync(4_000)
      expect(test.views.at(-1)?.jobsList?.killArmed).toBe(false)
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.kills).toHaveLength(0)
      expect(test.views.at(-1)?.jobsList?.killArmed).toBe(true)
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not arm a kill for a settled job', async () => {
    const fake = fakeRegistry()
    fake.rows.push({ ...runningJob('bash-11'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() })
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // The registry lists the settled job, but the footer needs a live one —
    // entering through the rung is impossible, so no kill can arm.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.status?.jobs?.selected).toBeUndefined()
    test.handlers.onJobKill()
    await settle()
    expect(fake.kills).toHaveLength(0)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('joins the navigation ladder last and leaves on ↑ at the rung', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-5'), runningJob('bash-6'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // With only jobs present, ↓ lands the cursor on the footer's rung.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.status?.jobs?.selected).toBe(true)
    // The rung is one row: ↓ has no lower rung, ↑ leaves the panel.
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.status?.jobs?.selected).toBe(true)
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.status?.jobs?.selected).toBeUndefined()
    // The list walks its rows: newest registration leads.
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.jobsList?.active.map(row => row.id)).toEqual(['bash-6', 'bash-5'])
    expect(test.views.at(-1)?.jobsList?.selected).toBe(1)
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.jobsList?.selected).toBe(2)
    // Clamped at the row count.
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.jobsList?.selected).toBe(2)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('prefers every other panel over the jobs ladder rung', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-7'))
    const test = await bench({
      jobs: fake.registry,
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => key === 'agentTeam'
          ? { members: [{ id: 'm-1', name: 'lead', description: 'd', phase: 'active' }], tasks: [] }
          : undefined,
      },
      afterPrompt: () => {},
    })
    await settle()
    // With a team present, ↓ enters the team panel; jobs stay unfocused.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.teamSelected).toBe(0)
    expect(test.views.at(-1)?.status?.jobs?.selected).toBeUndefined()
    // The footer's jobs segment still counts the live job.
    expect(test.views.at(-1)?.status?.jobs?.segments).toEqual([{ word: 'shell', count: 1 }])
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('ladders ← back to the list while Esc closes to the input', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-8'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openJob).toBeDefined()
    // ← steps back one layer: the detail closes onto the list, cursor intact.
    test.handlers.onJobBack()
    await settle()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    expect(test.views.at(-1)?.jobsList).toBeDefined()
    expect(test.views.at(-1)?.jobsList?.selected).toBe(1)
    // Esc from the detail leaves the whole jobs navigation at once — the
    // list underneath closes with it, no stop anywhere on the way down.
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.openJob).toBeDefined()
    test.handlers.onPanelBack()
    await settle()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    expect(test.views.at(-1)?.jobsList).toBeUndefined()
    expect(test.views.at(-1)?.status?.jobs?.selected).toBeUndefined()
    // Esc from the Background list (no detail open) closes the same way.
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.jobsList).toBeDefined()
    test.handlers.onPanelBack()
    await settle()
    expect(test.views.at(-1)?.jobsList).toBeUndefined()
    expect(test.views.at(-1)?.status?.jobs?.selected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('walks sibling jobs from the list, not from the detail', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-20'), runningJob('bash-21'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    test.handlers.onPanelEnter()
    await settle()
    // Display order is newest first: the first row is bash-21.
    expect(test.views.at(-1)?.openJob?.jobId).toBe('bash-21')
    // ← returns to the list; the arrows walk its rows; Enter reopens the
    // detail on the newly selected job.
    test.handlers.onJobBack()
    await settle()
    test.handlers.onPanelMove(1)
    await settle()
    expect(test.views.at(-1)?.jobsList?.selected).toBe(2)
    test.handlers.onPanelMove(1)
    await settle()
    expect(test.views.at(-1)?.jobsList?.selected).toBe(2)
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.openJob?.jobId).toBe('bash-20')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })
})
