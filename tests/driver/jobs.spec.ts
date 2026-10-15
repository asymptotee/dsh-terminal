/** The driver's jobs panel: the registry roster, its linger lifecycle, the detail view, and the two-step kill. */

import { describe, expect, it, vi } from 'vitest'
import { bench } from '../helpers/bench.ts'

describe('jobs panel', () => {
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

  it('shows registered jobs, tracks progress, and lingers settled rows', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-1'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // The seeded list() shows the running job with its live elapsed.
    let jobs = test.views.at(-1)?.jobs
    expect(jobs?.rows).toHaveLength(1)
    expect(jobs?.rows[0]).toMatchObject({ id: 'bash-1', kind: 'bash', status: 'running' })
    expect(jobs?.rows[0]?.elapsedMs).toBeGreaterThanOrEqual(12_000)
    // A progress event updates the row in place.
    fake.rows[0] = runningJob('bash-1', { progress: '42%' })
    fake.emit({ type: 'progress', job: fake.rows[0] })
    await settle()
    expect(test.views.at(-1)?.jobs?.rows[0]?.progress).toBe('42%')
    // Settlement keeps the row (lingering) with its terminal detail frozen.
    const settledJob: FakeJob = { ...runningJob('bash-1'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() }
    fake.rows[0] = settledJob
    fake.emit({ type: 'settled', job: settledJob, cause: 'producer' })
    await settle()
    jobs = test.views.at(-1)?.jobs
    expect(jobs?.rows[0]?.status).toBe('completed')
    expect(jobs?.rows[0]?.detail).toBe('exit code: 0')
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('retires a settled job the registry keeps listing after the linger window', async () => {
    // The registry's list() retains settled jobs until the owner is disposed —
    // the linger clock must run off the driver's own settledAt stamp, not off
    // the row's absence from list() (regression: three completed sleep jobs
    // pinned the panel forever because every tick re-stamped settledAt).
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      const done: FakeJob = { ...runningJob('bash-9'), status: 'completed', detail: 'exit code: 0', finishedAt: Date.now() }
      fake.rows.push(done)
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
      expect(test.views.at(-1)?.jobs?.rows[0]?.status).toBe('completed')
      // Still listed by the registry, but past the linger window: retired.
      await vi.advanceTimersByTimeAsync(6_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      // The registry still lists it on every following tick; the tombstone
      // keeps it retired — without it the next list() re-adds the row with a
      // fresh settledAt and the panel oscillates forever (the revive bug).
      await vi.advanceTimersByTimeAsync(3_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a row the registry removes and retires lingerers after the window', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-2'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
      // A foreground bash promoted then removed before settlement vanishes at once.
      fake.rows.length = 0
      fake.emit({ type: 'removed', job: runningJob('bash-2') })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      // A settled job lingers through the window, then the tick retires it.
      fake.rows.push({ ...runningJob('bash-3'), status: 'completed', finishedAt: Date.now() })
      fake.emit({ type: 'registered', job: fake.rows[0] })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
      fake.rows.length = 0
      await vi.advanceTimersByTimeAsync(6_000)
      expect(test.views.at(-1)?.jobs).toBeUndefined()
      test.handlers.onExit()
      await test.exited
      await test.ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the job detail on Enter and reads its output incrementally', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-4'))
    fake.output.set('bash-4', 'line one\n')
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // Enter on the first row opens its full-screen detail, read from offset 0.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    test.handlers.onPanelEnter()
    await settle()
    let detail = test.views.at(-1)?.openJob
    expect(detail?.jobId).toBe('bash-4')
    expect(detail?.title).toBe('Command details')
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
    // Enter on the same row again toggles the detail closed.
    test.handlers.onPanelEnter()
    await settle()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
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

  it('arms the kill gesture then kills on the second press within the window', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRegistry()
      fake.rows.push(runningJob('bash-9'))
      const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
      await vi.advanceTimersByTimeAsync(0)
      test.handlers.onPanelOpen()
      test.handlers.onPanelEnter()
      await vi.advanceTimersByTimeAsync(0)
      // The first x only arms: the detail flags it, no kill yet.
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(true)
      expect(fake.kills).toHaveLength(0)
      // The second x within the window kills with the terminal's reason.
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.kills).toEqual([{ id: 'bash-9', reason: 'stopped from the terminal' }])
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(false)
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
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(true)
      // Past the window the arm lapses (the projection re-derives it); the next
      // x only re-arms instead of killing.
      await vi.advanceTimersByTimeAsync(4_000)
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(false)
      test.handlers.onJobKill()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.kills).toHaveLength(0)
      expect(test.views.at(-1)?.openJob?.killArmed).toBe(true)
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
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    await settle()
    const detail = test.views.at(-1)?.openJob
    expect(detail?.killable).toBe(false)
    test.handlers.onJobKill()
    await settle()
    expect(fake.kills).toHaveLength(0)
    expect(test.views.at(-1)?.openJob?.killArmed).toBe(false)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('joins the navigation ladder last and leaves on ↑ at the first row', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-5'), runningJob('bash-6'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    // With only jobs present, ↓ lands the cursor on the first job.
    test.handlers.onPanelOpen()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.jobsSelected).toBe(2)
    // Clamped at the row count.
    test.handlers.onPanelMove(1)
    expect(test.views.at(-1)?.jobsSelected).toBe(2)
    // ↑ at the first row exits navigation; the open detail closes with it.
    test.handlers.onPanelMove(-1)
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openJob?.jobId).toBe('bash-5')
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    test.handlers.onPanelMove(-1)
    expect(test.views.at(-1)?.jobsSelected).toBeUndefined()
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
    expect(test.views.at(-1)?.jobsSelected).toBeUndefined()
    // The jobs roster still renders below the team panel.
    expect(test.views.at(-1)?.jobs?.rows).toHaveLength(1)
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })

  it('steps out of the job detail to the roster, then to the input', async () => {
    const fake = fakeRegistry()
    fake.rows.push(runningJob('bash-8'))
    const test = await bench({ jobs: fake.registry, afterPrompt: () => {} })
    await settle()
    test.handlers.onPanelOpen()
    test.handlers.onPanelEnter()
    expect(test.views.at(-1)?.openJob).toBeDefined()
    // The first Esc closes the detail back to the roster (the cursor stays).
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.openJob).toBeUndefined()
    expect(test.views.at(-1)?.jobsSelected).toBe(1)
    // The second Esc leaves the panel to the main input.
    test.handlers.onPanelBack()
    expect(test.views.at(-1)?.jobsSelected).toBeUndefined()
    test.handlers.onExit()
    await test.exited
    await test.ctx.fiber.dispose()
  })
})
