/**
 * Integration tests for the plugin wiring, against a fake Host that reproduces
 * the exact `insertBefore` and `domain/changed` behaviour the real registry has.
 *
 * These cover the parts a pure-function test cannot: which events trigger a
 * reconcile, that the plugin does not fight its own writes, that the empty
 * Session list guard holds, and that disposal stops every timer and listener.
 *
 * @module dsh-workspace-recency-order/test/plugin.test
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply as applyPlugin } from '../lib/index.js'

/**
 * Build a fake Host context around one workspace registry.
 * @param {{ id: string, createdAt: string, sessionIds: string[] }[]} workspaces Initial registry order.
 * @param {() => object[]} summaries Current Session list.
 * @returns {object} Fake context plus inspection helpers.
 */
function createHost(workspaces, summaries) {
  const table = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  let order = workspaces.map((workspace) => workspace.id)
  const listeners = new Map()
  const finalizers = []
  const writes = []
  let disposed = false

  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }

  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((entry) => entry !== listener))
      }
    },
    effect(body) {
      const finalize = body()
      if (typeof finalize === 'function') finalizers.push(finalize)
      return { dispose: async () => finalize?.() }
    },
    workspaceRegistry: {
      list() {
        return order.map((id) => table.get(id))
      },
      async insertBefore(id, before) {
        writes.push(before === undefined ? { id } : { id, before })
        const at = order.indexOf(id)
        if (at === -1) throw new Error(`WorkspaceOrderInvalidError: ${id}`)
        order.splice(at, 1)
        const insertAt = before === undefined ? order.length : order.indexOf(before)
        if (insertAt === -1) throw new Error(`WorkspaceOrderInvalidError: ${before}`)
        order.splice(insertAt, 0, id)
        // The real registry publishes the committed order back through the
        // storage domain; a loop here would show up as repeated writes.
        emit('domain/changed', { domain: 'workspace', table: '', operation: 'put', value: {} })
      },
    },
    sessionController: {
      async list(_request, signal) {
        if (disposed) throw new Error('aborted')
        signal?.throwIfAborted()
        return { items: summaries() }
      },
    },
  }

  return {
    ctx,
    writes,
    order: () => [...order],
    emit,
    async dispose() {
      disposed = true
      for (const finalize of finalizers.reverse()) await finalize()
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

/**
 * Let queued timers and microtasks settle.
 * @returns {Promise<void>} Resolution after several macrotask turns.
 */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Three workspaces, ordered alpha/beta/gamma in the registry. */
const WORKSPACES = [
  { id: 'alpha', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['a1'] },
  { id: 'beta', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: ['b1'] },
  { id: 'gamma', createdAt: '2026-01-03T00:00:00.000Z', sessionIds: ['g1'] },
]

/** Session list where gamma is newest and alpha oldest. */
const RECENT_GAMMA = () => [
  { sessionId: 'a1', updatedAt: 100 },
  { sessionId: 'b1', updatedAt: 200 },
  { sessionId: 'g1', updatedAt: 300 },
]

describe('plugin integration', () => {
  it('reorders to recency order on startup', async () => {
    const host = createHost(WORKSPACES, RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0 })
    await settle()
    // gamma is newest, then beta, then alpha: a full reversal of the registry,
    // which the planner realizes in the minimal two writes.
    assert.deepEqual(host.order(), ['gamma', 'beta', 'alpha'])
    assert.deepEqual(host.writes, [{ id: 'gamma', before: 'alpha' }, { id: 'beta', before: 'alpha' }])
    await host.dispose()
  })

  it('reorders when a session reports activity', async () => {
    const summaries = RECENT_GAMMA()
    const host = createHost(WORKSPACES, () => summaries)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    assert.deepEqual(host.order(), ['gamma', 'beta', 'alpha'])

    // The user sends a message in alpha, making it the most recent workspace.
    summaries[0].updatedAt = 400
    const previousWrites = host.writes.length
    host.emit('api-session/activity', 'a1', 400)
    await settle()
    assert.deepEqual(host.order(), ['alpha', 'gamma', 'beta'])
    assert.equal(host.writes.length, previousWrites + 1, `expected one follow-up write, saw ${host.writes.length - previousWrites}`)
    await host.dispose()
  })

  it('writes nothing when the registry order already matches', async () => {
    const ordered = [
      { id: 'gamma', createdAt: '2026-01-03T00:00:00.000Z', sessionIds: ['g1'] },
      { id: 'beta', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: ['b1'] },
      { id: 'alpha', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['a1'] },
    ]
    const host = createHost(ordered, RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    assert.deepEqual(host.writes, [])
    assert.deepEqual(host.order(), ['gamma', 'beta', 'alpha'])
    await host.dispose()
  })

  it('does not fight its own writes after a reorder', async () => {
    const host = createHost(WORKSPACES, RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    const after = host.writes.length
    await settle()
    assert.equal(host.writes.length, after, 'a settled reorder must not keep writing')
    await host.dispose()
  })

  it('holds the order back while no sessions are known', async () => {
    const host = createHost(WORKSPACES, () => [])
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    assert.deepEqual(host.writes, [], 'an empty session list must not rewrite the order')
    assert.deepEqual(host.order(), ['alpha', 'beta', 'gamma'])
    await host.dispose()
  })

  it('still orders by creation instant when the guard is turned off', async () => {
    const host = createHost(WORKSPACES, () => [])
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0, skipWhenSessionListEmpty: false })
    await settle()
    // gamma, beta, alpha by creation instant.
    assert.deepEqual(host.order(), ['gamma', 'beta', 'alpha'])
    await host.dispose()
  })

  it('ignores subagent sessions by default', async () => {
    const host = createHost(WORKSPACES, () => [
      { sessionId: 'a1', updatedAt: 100 },
      { sessionId: 'b1', updatedAt: 200 },
      { sessionId: 'g1', updatedAt: 300 },
      { sessionId: 'child', updatedAt: 9999, origin: 'subagent' },
    ])
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    assert.deepEqual(host.order(), ['gamma', 'beta', 'alpha'])
    await host.dispose()
  })

  it('supports the ascending direction', async () => {
    const host = createHost(WORKSPACES, RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0, direction: 'asc' })
    await settle()
    assert.deepEqual(host.order(), ['alpha', 'beta', 'gamma'])
    await host.dispose()
  })

  it('sinks workspaces without sessions on request', async () => {
    const rows = [
      { id: 'empty', createdAt: '2026-12-31T00:00:00.000Z', sessionIds: [] },
      ...WORKSPACES,
    ]
    const host = createHost(rows, RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0, emptyWorkspace: 'bottom' })
    await settle()
    assert.deepEqual(host.order(), ['gamma', 'beta', 'alpha', 'empty'])
    await host.dispose()
  })

  it('does nothing when disabled', async () => {
    const host = createHost(WORKSPACES, RECENT_GAMMA)
    applyPlugin(host.ctx, { enabled: false })
    await settle()
    assert.deepEqual(host.writes, [])
    assert.equal(host.listenerCount('api-session/activity'), 0)
    await host.dispose()
  })

  it('leaves a single workspace alone', async () => {
    const host = createHost([WORKSPACES[0]], RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    assert.deepEqual(host.writes, [])
    await host.dispose()
  })

  it('survives a failing session list read', async () => {
    const host = createHost(WORKSPACES, () => {
      throw new Error('storage unavailable')
    })
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    assert.deepEqual(host.writes, [])
    await host.dispose()
  })

  it('coalesces a burst of events into one reorder', async () => {
    const host = createHost(WORKSPACES, RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    for (let index = 0; index < 50; index += 1) host.emit('api-session/activity', 'a1', 400 + index)
    await settle()
    // Fifty events must not become fifty reconciles; the reversal itself is
    // two minimal writes and happens once.
    assert.deepEqual(host.order(), ['gamma', 'beta', 'alpha'])
    assert.equal(host.writes.length, 2, `expected one coalesced reorder, saw ${host.writes.length} writes`)
    await host.dispose()
  })

  it('stops reacting once disposed', async () => {
    const host = createHost(WORKSPACES, RECENT_GAMMA)
    applyPlugin(host.ctx, { debounceMs: 0, sweepMs: 0 })
    await settle()
    const settledWrites = host.writes.length
    await host.dispose()
    // The fake keeps the listener registered on purpose: this asserts the
    // plugin's own disposal guard, not cordis's fibre-scoped listener cleanup.
    host.emit('api-session/activity', 'a1', 5000)
    await settle()
    assert.equal(host.writes.length, settledWrites, 'a disposed plugin must not write')
  })
})
