/**
 * Unit tests for the pure ordering rules and the Config contract.
 *
 * The important one is the randomized move-planner property: for any
 * permutation of Workspaces, applying the planned `insertBefore` writes in
 * order must reproduce the target order exactly. A wrong plan would reorder
 * the user's real sidebar, so this is checked over many permutations rather
 * than a handful of hand-picked cases.
 *
 * @module dsh-workspace-recency-order/test/order.test
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Config, resolveOptions } from '../lib/index.js'
import {
  RANK_BOTTOM,
  RANK_CREATED,
  RANK_SESSION,
  RANK_TOP,
  planMoves,
  rankWorkspaces,
  sameOrder,
  sessionActivity,
  toEpoch,
  workspaceRank,
} from '../lib/order.js'

/**
 * Apply planned moves with the exact `insertBefore` semantics the Host uses.
 * @param {readonly string[]} currentOrder Starting order.
 * @param {readonly { id: string, before?: string }[]} moves Planned writes.
 * @returns {string[]} Resulting order.
 */
function simulate(currentOrder, moves) {
  const list = [...currentOrder]
  for (const move of moves) {
    const at = list.indexOf(move.id)
    assert.notEqual(at, -1, `move names an id outside the order: ${move.id}`)
    list.splice(at, 1)
    const insertAt = move.before === undefined ? list.length : list.indexOf(move.before)
    assert.notEqual(insertAt, -1, `anchor outside the order: ${move.before}`)
    list.splice(insertAt, 0, move.id)
  }
  return list
}

/** Deterministic 32-bit LCG so a failing permutation is reproducible. */
function createRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * Fisher-Yates shuffle over a copy.
 * @param {readonly string[]} input Source ids.
 * @param {() => number} random Uniform generator.
 * @returns {string[]} Shuffled copy.
 */
function shuffle(input, random) {
  const list = [...input]
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[list[index], list[swap]] = [list[swap], list[index]]
  }
  return list
}

/**
 * Build one Session summary row.
 * @param {string} sessionId Session identity.
 * @param {number} updatedAt Activity instant.
 * @param {object} [extra] Extra summary fields.
 * @returns {object} Summary.
 */
function summary(sessionId, updatedAt, extra = {}) {
  return { sessionId, updatedAt, ...extra }
}

describe('toEpoch', () => {
  it('passes finite numbers through and rejects the rest', () => {
    assert.equal(toEpoch(1700000000000), 1700000000000)
    assert.equal(toEpoch(Number.NaN), undefined)
    assert.equal(toEpoch(Number.POSITIVE_INFINITY), undefined)
    assert.equal(toEpoch(undefined), undefined)
    assert.equal(toEpoch(null), undefined)
    assert.equal(toEpoch({}), undefined)
  })

  it('parses ISO-8601 instants, which is how a Workspace reports createdAt', () => {
    assert.equal(toEpoch('2026-10-04T08:00:00.000Z'), Date.parse('2026-10-04T08:00:00.000Z'))
    assert.equal(toEpoch('not a date'), undefined)
  })
})

describe('sessionActivity', () => {
  it('keeps the newest instant per session', () => {
    const activity = sessionActivity([summary('a', 10), summary('a', 30), summary('b', 20)])
    assert.equal(activity.get('a'), 30)
    assert.equal(activity.get('b'), 20)
  })

  it('ignores subagent children, which the browser never renders as rows', () => {
    const activity = sessionActivity([summary('child', 99, { origin: 'subagent' }), summary('root', 5)])
    assert.equal(activity.has('child'), false)
    assert.equal(activity.get('root'), 5)
  })

  it('counts subagent children only when asked', () => {
    const activity = sessionActivity([summary('child', 99, { origin: 'subagent' })], { countSubagentSessions: true })
    assert.equal(activity.get('child'), 99)
  })

  it('survives malformed rows instead of throwing', () => {
    const activity = sessionActivity([null, {}, summary('', 1), summary('ok', 2), summary('bad', 'nope')])
    assert.deepEqual([...activity.entries()], [['ok', 2]])
  })
})

describe('workspaceRank', () => {
  const activity = new Map([['s1', 500]])

  it('uses the newest activity of the sessions the workspace accounts for', () => {
    const rank = workspaceRank({ sessionIds: ['s0', 's1'], createdAt: '2020-01-01T00:00:00.000Z' }, activity)
    assert.deepEqual(rank, { key: 500, basis: RANK_SESSION })
  })

  it('falls back to the workspace creation instant by default', () => {
    const created = Date.parse('2026-01-02T00:00:00.000Z')
    const rank = workspaceRank({ sessionIds: [], createdAt: '2026-01-02T00:00:00.000Z' }, activity, { emptyWorkspace: 'createdAt' })
    assert.deepEqual(rank, { key: created, basis: RANK_CREATED })
  })

  it('honours the pinned empty placements', () => {
    assert.equal(workspaceRank({ sessionIds: [] }, activity, { emptyWorkspace: 'top' }).basis, RANK_TOP)
    assert.equal(workspaceRank({ sessionIds: [] }, activity, { emptyWorkspace: 'bottom' }).basis, RANK_BOTTOM)
  })

  it('treats sessions without a known summary as empty', () => {
    const rank = workspaceRank({ sessionIds: ['unknown'], createdAt: '2026-01-02T00:00:00.000Z' }, activity)
    assert.equal(rank.basis, RANK_CREATED)
  })
})

describe('rankWorkspaces', () => {
  const workspaces = [
    { id: 'alpha', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['a1'] },
    { id: 'beta', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: ['b1'] },
    { id: 'gamma', createdAt: '2026-01-03T00:00:00.000Z', sessionIds: ['g1'] },
  ]

  it('puts the most recently active workspace first', () => {
    const { order } = rankWorkspaces(workspaces, [
      summary('a1', 100),
      summary('b1', 300),
      summary('g1', 200),
    ])
    assert.deepEqual(order, ['beta', 'gamma', 'alpha'])
  })

  it('reverses for ascending direction', () => {
    const { order } = rankWorkspaces(workspaces, [summary('a1', 100), summary('b1', 300), summary('g1', 200)], { direction: 'asc' })
    assert.deepEqual(order, ['alpha', 'gamma', 'beta'])
  })

  it('projects raw summaries when no activity map is supplied', () => {
    const { order } = rankWorkspaces(workspaces, [summary('a1', 900), summary('b1', 300), summary('g1', 200)])
    assert.deepEqual(order, ['alpha', 'beta', 'gamma'])
  })

  it('parks a workspace with no sessions at the bottom on request', () => {
    const rows = [...workspaces, { id: 'empty', createdAt: '2026-12-31T00:00:00.000Z', sessionIds: [] }]
    const { order } = rankWorkspaces(rows, [summary('a1', 100), summary('b1', 300), summary('g1', 200)], { emptyWorkspace: 'bottom' })
    assert.deepEqual(order, ['beta', 'gamma', 'alpha', 'empty'])
  })

  it('lets a brand-new empty workspace rank by its own creation instant by default', () => {
    const rows = [...workspaces, { id: 'fresh', createdAt: '2026-12-31T00:00:00.000Z', sessionIds: [] }]
    const { order } = rankWorkspaces(rows, [summary('a1', 100), summary('b1', 300), summary('g1', 200)])
    assert.equal(order[0], 'fresh')
  })

  it('keeps pinned empty placements absolute when the direction flips', () => {
    const rows = [
      { id: 'old', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['s'] },
      { id: 'empty', createdAt: '2026-12-31T00:00:00.000Z', sessionIds: [] },
    ]
    const bottom = rankWorkspaces(rows, [summary('s', 10)], { emptyWorkspace: 'bottom', direction: 'asc' })
    assert.deepEqual(bottom.order, ['old', 'empty'])
    const top = rankWorkspaces(rows, [summary('s', 10)], { emptyWorkspace: 'top', direction: 'asc' })
    assert.deepEqual(top.order, ['empty', 'old'])
  })

  it('breaks ties by creation instant and then by registry position', () => {
    const rows = [
      { id: 'first', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['f'] },
      { id: 'second', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['s'] },
      { id: 'newer', createdAt: '2026-05-01T00:00:00.000Z', sessionIds: ['n'] },
    ]
    const { order } = rankWorkspaces(rows, [summary('f', 42), summary('s', 42), summary('n', 42)])
    assert.deepEqual(order, ['newer', 'first', 'second'])
  })

  it('reports the ranking facts it used', () => {
    const { ranks } = rankWorkspaces(workspaces, [summary('a1', 100)])
    assert.equal(ranks.get('alpha').basis, RANK_SESSION)
    assert.equal(ranks.get('alpha').key, 100)
    assert.equal(ranks.get('beta').basis, RANK_CREATED)
  })

  it('handles an empty workspace list', () => {
    assert.deepEqual(rankWorkspaces([], []).order, [])
  })
})

describe('sameOrder', () => {
  it('compares positions, not membership', () => {
    assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true)
    assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false)
    assert.equal(sameOrder(['a'], ['a', 'b']), false)
    assert.equal(sameOrder(undefined, []), false)
  })
})

describe('planMoves', () => {
  it('writes nothing when the order already matches', () => {
    assert.deepEqual(planMoves(['a', 'b', 'c'], ['a', 'b', 'c']), [])
  })

  it('costs one write when a workspace advances to the front', () => {
    assert.deepEqual(planMoves(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']), [{ id: 'd', before: 'a' }])
  })

  it('costs one write for a mid-list advance', () => {
    // Both directions find a one-write plan here; either is acceptable, so
    // assert the cost and the outcome rather than one exact formulation.
    const current = ['a', 'b', 'c', 'd']
    const desired = ['b', 'a', 'c', 'd']
    const moves = planMoves(current, desired)
    assert.equal(moves.length, 1)
    assert.deepEqual(simulate(current, moves), desired)
  })

  it('costs one write when a workspace sinks to the back', () => {
    assert.deepEqual(planMoves(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']), [{ id: 'a' }])
  })

  it('costs one write when a workspace sinks mid-list', () => {
    const current = ['a', 'b', 'c', 'd']
    const desired = ['a', 'c', 'd', 'b']
    const moves = planMoves(current, desired)
    assert.equal(moves.length, 1)
    assert.deepEqual(simulate(current, moves), desired)
  })

  it('appends with no anchor when the workspace belongs last', () => {
    const moves = planMoves(['a', 'b', 'c'], ['b', 'c', 'a'])
    assert.deepEqual(moves, [{ id: 'a' }])
    assert.deepEqual(simulate(['a', 'b', 'c'], moves), ['b', 'c', 'a'])
  })

  it('reproduces a full reversal', () => {
    const current = ['a', 'b', 'c']
    const desired = ['c', 'b', 'a']
    assert.deepEqual(simulate(current, planMoves(current, desired)), desired)
  })

  it('never plans a write the Host would reject', () => {
    // A target id outside the current order is dropped rather than turning
    // into an insertBefore the registry would fail as an invalid anchor.
    for (const moves of [planMoves(['a', 'b'], ['a', 'b', 'ghost']), planMoves(['a', 'b'], ['ghost', 'a', 'b']), planMoves([], ['ghost'])]) {
      assert.deepEqual(moves, [])
    }
  })

  it('orders the ids it keeps even when the target omits some', () => {
    // Callers always pass a full permutation; this guards the degenerate case
    // by asserting the only thing that still has to hold — the kept ids end up
    // in target order, and no write names an unknown id.
    const current = ['a', 'b', 'c', 'd']
    const target = ['d', 'b']
    const moves = planMoves(current, target)
    for (const move of moves) {
      assert.ok(current.includes(move.id), `planned an unknown id: ${move.id}`)
      assert.ok(move.before === undefined || current.includes(move.before), `planned an unknown anchor: ${move.before}`)
    }
    const result = simulate(current, moves)
    assert.deepEqual(result.filter((id) => target.includes(id)), target)
  })

  it('reproduces every target order for four workspaces', () => {
    const ids = ['w1', 'w2', 'w3', 'w4']
    const permutations = []
    /**
     * Enumerate every permutation of the ids.
     * @param {string[]} rest Remaining ids.
     * @param {string[]} built Prefix under construction.
     * @returns {void}
     */
    const walk = (rest, built) => {
      if (rest.length === 0) {
        permutations.push([...built])
        return
      }
      rest.forEach((id, index) => walk([...rest.slice(0, index), ...rest.slice(index + 1)], [...built, id]))
    }
    walk(ids, [])
    assert.equal(permutations.length, 24)

    for (const current of permutations) {
      for (const desired of permutations) {
        const moves = planMoves(current, desired)
        assert.deepEqual(simulate(current, moves), desired, `plan failed for ${current.join(',')} -> ${desired.join(',')}`)
        assert.equal(new Set(moves.map((move) => move.id)).size, moves.length, 'a row was moved twice')
        assert.ok(moves.length <= ids.length)
      }
    }
  })

  it('reproduces every target order for six workspaces over many shuffled pairs', () => {
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']
    const random = createRandom(20261004)
    let single = 0
    for (let round = 0; round < 400; round += 1) {
      const current = shuffle(ids, random)
      const desired = shuffle(ids, random)
      const moves = planMoves(current, desired)
      assert.deepEqual(simulate(current, moves), desired, `plan failed for ${current.join(',')} -> ${desired.join(',')}`)
      assert.equal(new Set(moves.map((move) => move.id)).size, moves.length)
      assert.ok(moves.length <= ids.length)
      if (moves.length === 1) single += 1
    }
    assert.ok(single > 0, 'expected some shuffled pairs to need a single write')
  })

  it('needs one write whenever exactly one workspace changes slot', () => {
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']
    for (let from = 0; from < ids.length; from += 1) {
      for (let to = 0; to < ids.length; to += 1) {
        if (from === to) continue
        const current = [...ids]
        const desired = [...ids]
        const [moved] = desired.splice(from, 1)
        desired.splice(to, 0, moved)
        assert.equal(planMoves(current, desired).length, 1, `moving ${moved} from ${from} to ${to} should cost one write`)
      }
    }
  })

  it('writes nothing for a reorder that is already satisfied', () => {
    const random = createRandom(99)
    for (let round = 0; round < 50; round += 1) {
      const current = shuffle(['a', 'b', 'c', 'd', 'e'], random)
      assert.deepEqual(planMoves(current, current), [])
    }
  })
})

describe('Config standard schema', () => {
  const validate = (input) => Config['~standard'].validate(input)

  it('supplies every default for an absent config', () => {
    const result = validate(undefined)
    assert.ok(!result.issues)
    assert.equal(result.value.enabled, true)
    assert.equal(result.value.direction, 'desc')
    assert.equal(result.value.emptyWorkspace, 'createdAt')
    assert.equal(result.value.debounceMs, 400)
    assert.equal(result.value.sweepMs, 300000)
    assert.equal(result.value.countSubagentSessions, false)
    assert.equal(result.value.skipWhenSessionListEmpty, true)
  })

  it('accepts a partial override and fills the rest', () => {
    const result = validate({ direction: 'asc', sweepMs: 0 })
    assert.ok(!result.issues)
    assert.equal(result.value.direction, 'asc')
    assert.equal(result.value.sweepMs, 0)
    assert.equal(result.value.debounceMs, 400)
  })

  it('reports an unknown option instead of silently dropping it', () => {
    const result = validate({ debounceMilliseconds: 10 })
    assert.ok(result.issues)
    assert.match(result.issues[0].message, /unknown option/)
    assert.deepEqual(result.issues[0].path, ['debounceMilliseconds'])
  })

  it('reports a wrong-typed or out-of-range value', () => {
    assert.ok(validate({ enabled: 'yes' }).issues)
    assert.ok(validate({ direction: 'sideways' }).issues)
    assert.ok(validate({ debounceMs: -1 }).issues)
    assert.ok(validate({ debounceMs: 60001 }).issues)
    assert.ok(!validate({ debounceMs: 0 }).issues)
    assert.ok(!validate({ debounceMs: 60000 }).issues)
  })

  it('reports a non-object config', () => {
    assert.ok(validate('nope').issues)
    assert.ok(validate([1, 2]).issues)
  })
})

describe('resolveOptions', () => {
  it('ignores unusable values rather than propagating them', () => {
    const options = resolveOptions({ direction: 'sideways', debounceMs: 'fast', enabled: false })
    assert.equal(options.direction, 'desc')
    assert.equal(options.debounceMs, 400)
    assert.equal(options.enabled, false)
  })

  it('tolerates a missing config', () => {
    assert.equal(resolveOptions(undefined).direction, 'desc')
  })
})
