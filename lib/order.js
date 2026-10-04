/**
 * Pure ordering rules for the Workspace recency sorter.
 *
 * These functions turn Host Workspace records plus Session list summaries into
 * the Workspace display order, and turn an order change into the smallest set
 * of `insertBefore` writes that realizes it. They perform no I/O and import
 * nothing, so every rule here is directly unit-testable.
 *
 * @module dsh-workspace-recency-order/order
 */

/** Why a Workspace received the ranking key it did. */
export const RANK_SESSION = 'session'
export const RANK_CREATED = 'createdAt'
export const RANK_TOP = 'empty-top'
export const RANK_BOTTOM = 'empty-bottom'

/**
 * Read a timestamp in any spelling a Workspace record or Session summary uses.
 * @param {unknown} value Epoch milliseconds, or an ISO-8601 string.
 * @returns {number | undefined} Epoch milliseconds, or undefined when unreadable.
 */
export function toEpoch(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Project Session list summaries into `sessionId -> activity time`.
 *
 * A summary's `updatedAt` is the Host's durable list-ordering time: the later
 * of the Session's creation instant and its last user message. That is exactly
 * the relative time the sidebar prints on a Session row, so ranking on it makes
 * the Workspace order agree with what the reader sees.
 *
 * Subagent child Sessions are skipped by default because the browser never
 * renders them as rows; their only contribution would be their spawn instant.
 *
 * @param {readonly { sessionId?: unknown, updatedAt?: unknown, origin?: unknown }[]} summaries Session list items.
 * @param {{ countSubagentSessions?: boolean }} [options] Ranking options.
 * @returns {Map<string, number>} Newest known activity per Session id.
 */
export function sessionActivity(summaries, options = {}) {
  const countSubagent = options.countSubagentSessions === true
  const activity = new Map()
  for (const summary of summaries ?? []) {
    if (!summary || typeof summary !== 'object') continue
    const id = summary.sessionId
    if (typeof id !== 'string' || id === '') continue
    if (!countSubagent && summary.origin === 'subagent') continue
    const at = toEpoch(summary.updatedAt)
    if (at === undefined) continue
    const previous = activity.get(id)
    if (previous === undefined || at > previous) activity.set(id, at)
  }
  return activity
}

/**
 * Rank one Workspace by the newest activity among the Sessions it accounts for.
 *
 * A Workspace with no known Session falls back to the configured empty
 * placement: its own creation instant, or a pinned end of the list.
 *
 * @param {{ sessionIds?: readonly unknown[], createdAt?: unknown }} workspace Workspace record.
 * @param {ReadonlyMap<string, number>} activity Session activity projection.
 * @param {{ emptyWorkspace?: 'createdAt' | 'bottom' | 'top' }} [options] Ranking options.
 * @returns {{ key: number, basis: string }} Ranking key and the rule that produced it.
 */
export function workspaceRank(workspace, activity, options = {}) {
  let newest
  for (const sessionId of workspace?.sessionIds ?? []) {
    const at = typeof sessionId === 'string' ? activity.get(sessionId) : undefined
    if (at === undefined) continue
    if (newest === undefined || at > newest) newest = at
  }
  if (newest !== undefined) return { key: newest, basis: RANK_SESSION }
  switch (options.emptyWorkspace) {
    case 'top': return { key: 0, basis: RANK_TOP }
    case 'bottom': return { key: 0, basis: RANK_BOTTOM }
    default: return { key: toEpoch(workspace?.createdAt) ?? Number.NEGATIVE_INFINITY, basis: RANK_CREATED }
  }
}

/**
 * Rank every Workspace into the order the sidebar should show.
 *
 * Session-backed Workspaces sort by activity (`desc` = newest first). Empty
 * Workspaces either take part using their creation instant, or are pinned to
 * one end of the result regardless of direction — the placement is absolute,
 * because "bottom" must not become "top" when the direction flips. Ties break
 * by newer creation instant and then by the incoming registry position, so the
 * result is total and stable.
 *
 * @param {readonly { id?: unknown, createdAt?: unknown, sessionIds?: readonly unknown[] }[]} workspaces Workspaces in current registry order.
 * @param {ReadonlyMap<string, number> | readonly object[]} activityOrSummaries Session activity projection, or Session summaries to project.
 * @param {{ direction?: 'desc' | 'asc', emptyWorkspace?: 'createdAt' | 'bottom' | 'top', countSubagentSessions?: boolean }} [options] Ranking options.
 * @returns {{ order: string[], ranks: Map<string, { key: number, basis: string, createdAt: number, index: number }> }} Ordered Workspace ids and their ranking facts.
 */
export function rankWorkspaces(workspaces, activityOrSummaries, options = {}) {
  const activity = activityOrSummaries instanceof Map
    ? activityOrSummaries
    : sessionActivity(activityOrSummaries, options)
  const ascending = options.direction === 'asc'
  const leading = []
  const trailing = []
  const ranked = []
  const ranks = new Map()

  ;(workspaces ?? []).forEach((workspace, index) => {
    const id = String(workspace?.id)
    const rank = workspaceRank(workspace, activity, options)
    const row = { id, index, createdAt: toEpoch(workspace?.createdAt) ?? 0, ...rank }
    ranks.set(id, row)
    if (rank.basis === RANK_TOP) leading.push(row)
    else if (rank.basis === RANK_BOTTOM) trailing.push(row)
    else ranked.push(row)
  })

  // Newer creation instant first, then the incoming registry position. Used
  // both for equal ranking keys and for the two pinned end partitions.
  const stable = (left, right) => (right.createdAt - left.createdAt) || (left.index - right.index)
  ranked.sort((left, right) => {
    if (left.key !== right.key) return ascending ? left.key - right.key : right.key - left.key
    return stable(left, right)
  })
  leading.sort(stable)
  trailing.sort(stable)

  return { order: [...leading, ...ranked, ...trailing].map((row) => row.id), ranks }
}

/**
 * Whether two id sequences are the same order.
 * @param {readonly string[]} left First order.
 * @param {readonly string[]} right Second order.
 * @returns {boolean} True when both hold the same ids in the same positions.
 */
export function sameOrder(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Remove one id and reinsert it immediately before an anchor, mirroring the
 * Host's `insertBefore` semantics on a local list.
 * @param {string[]} list Mutable order being simulated.
 * @param {string} id Id to move.
 * @param {string | undefined} anchor Id to land before; undefined appends.
 * @returns {void}
 */
function moveBefore(list, id, anchor) {
  const at = list.indexOf(id)
  if (at === -1) return
  list.splice(at, 1)
  const insertAt = anchor === undefined ? list.length : list.indexOf(anchor)
  list.splice(insertAt === -1 ? list.length : insertAt, 0, id)
}

/**
 * Grow the correct prefix one slot at a time.
 *
 * Cheapest when Workspaces advance toward the front — the shape a recency sort
 * produces most often, where one row climbs and everything else shifts down.
 * @param {readonly string[]} current Current order.
 * @param {readonly string[]} target Target order.
 * @returns {{ id: string, before?: string }[]} Writes to issue, in order.
 */
function planFromFront(current, target) {
  const list = [...current]
  const moves = []
  for (let index = 0; index < target.length; index += 1) {
    const id = target[index]
    if (list[index] === id) continue
    // Slots before `index` already hold the target prefix, so `id` can only
    // sit later in the list; landing it on the occupant of this slot is exact.
    const before = list[index]
    if (before === undefined) continue
    moveBefore(list, id, before)
    moves.push({ id, before })
  }
  return moves
}

/**
 * Settle the correct suffix one slot at a time.
 *
 * Cheapest when Workspaces sink toward the back, which is the shape an
 * ascending direction produces.
 * @param {readonly string[]} current Current order.
 * @param {readonly string[]} target Target order.
 * @returns {{ id: string, before?: string }[]} Writes to issue, in order.
 */
function planFromBack(current, target) {
  const list = [...current]
  const moves = []
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const id = target[index]
    const anchor = index + 1 < target.length ? target[index + 1] : undefined
    if (anchor === undefined) {
      if (list[list.length - 1] === id) continue
      moveBefore(list, id, undefined)
      moves.push({ id })
      continue
    }
    const at = list.indexOf(id)
    const anchorAt = list.indexOf(anchor)
    if (at !== -1 && anchorAt !== -1 && at + 1 === anchorAt) continue
    moveBefore(list, id, anchor)
    moves.push({ id, before: anchor })
  }
  return moves
}

/**
 * Plan the `insertBefore` writes that turn one order into another.
 *
 * Both directions are correct on their own; each is minimal for the shape it
 * was built for and wasteful for the other, so the shorter plan wins. A single
 * Workspace landing anywhere therefore costs exactly one durable write, which
 * is what a recency sort produces on almost every event.
 *
 * The returned moves must be applied in order, and only over ids the current
 * order holds: an id absent from `currentOrder` is ignored rather than planned
 * into a write the Host would reject.
 *
 * @param {readonly string[]} currentOrder Current registry order.
 * @param {readonly string[]} desiredOrder Target order.
 * @returns {{ id: string, before?: string }[]} Writes to issue, in order.
 */
export function planMoves(currentOrder, desiredOrder) {
  const current = [...(currentOrder ?? [])]
  const present = new Set(current)
  const target = []
  for (const id of desiredOrder ?? []) {
    if (present.has(id)) target.push(id)
  }
  if (target.length === 0) return []
  const forward = planFromFront(current, target)
  const backward = planFromBack(current, target)
  return forward.length <= backward.length ? forward : backward
}
