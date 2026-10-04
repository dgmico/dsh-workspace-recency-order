/**
 * Workspace recency order — a Host plugin that keeps the DSH sidebar's
 * Workspace order sorted by each Workspace's most recent Session activity.
 *
 * How it works
 * ------------
 * The browser renders Workspace sections in the exact order the Host registry
 * hands them over (`deriveGroups` walks the projected `WorkspaceView[]` as
 * given), so this plugin never touches the shipped sidebar UI. It reads the
 * authoritative inputs, computes the order the reader expects, and writes any
 * difference through the official `workspaceRegistry.insertBefore` mutation.
 * The Host then publishes the ordinary `order` increment, and every open
 * client follows.
 *
 * Ranking key: for each Workspace, the newest `updatedAt` among the Sessions it
 * accounts for — the same value the sidebar prints as a row's relative time.
 * Subagent child Sessions are ignored because the browser never renders them.
 *
 * Triggers: `api-session/activity` (a user message advanced a Session),
 * `api-session/added` / `api-session/removed`, and `domain/changed` filtered to
 * the workspace domain. All of them funnel through one debounced reconcile that
 * is idempotent: it writes only when the computed order differs from the
 * current one.
 *
 * @module dsh-workspace-recency-order
 */
import { planMoves, rankWorkspaces, sameOrder } from './order.js'

/** Plugin name, as the loader row and logs report it. */
export const name = 'workspace-recency-order'

/** Host Services this plugin reads; the loader starts it only once they exist. */
export const inject = ['workspaceRegistry', 'sessionController']

/** Every option, its default, and how a value is accepted. */
const SPEC = {
  enabled: {
    type: 'boolean',
    default: true,
    description: '关闭后插件保持加载但不排序（也可在插件页直接停用本行）',
  },
  direction: {
    type: 'enum',
    values: ['desc', 'asc'],
    default: 'desc',
    description: 'desc = 最近活跃的工作区在最上；asc = 最久未动的在最上',
  },
  emptyWorkspace: {
    type: 'enum',
    values: ['createdAt', 'bottom', 'top'],
    default: 'createdAt',
    description: '没有任何会话的工作区怎么放：按自身创建时间参与排序 / 固定沉底 / 固定置顶',
  },
  countSubagentSessions: {
    type: 'boolean',
    default: false,
    description: '子代理会话（浏览器不显示为行）是否也参与工作区活跃度计算',
  },
  debounceMs: {
    type: 'number',
    min: 0,
    max: 60000,
    default: 400,
    description: '会话事件到实际重排之间的合并窗口，毫秒',
  },
  sweepMs: {
    type: 'number',
    min: 0,
    default: 300000,
    description: '兜底巡检间隔，毫秒；0 表示关闭。事件漏掉时靠它收敛',
  },
  skipWhenSessionListEmpty: {
    type: 'boolean',
    default: true,
    description: '读不到任何会话时放弃本轮排序，避免启动早期用不完整数据改写顺序',
  },
}

/** Resolved defaults, shared by the Config schema and the runtime reader. */
const DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(SPEC).map(([key, spec]) => [key, spec.default])),
)

/**
 * Report whether one raw value satisfies its option specification.
 * @param {{ type: string, values?: readonly unknown[], min?: number, max?: number }} spec Option specification.
 * @param {unknown} value Raw configured value.
 * @returns {boolean} True when the value is acceptable.
 */
function accepts(spec, value) {
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number'
        && Number.isFinite(value)
        && value >= (spec.min ?? Number.NEGATIVE_INFINITY)
        && value <= (spec.max ?? Number.POSITIVE_INFINITY)
    case 'enum':
      return Array.isArray(spec.values) && spec.values.includes(value)
    default:
      return false
  }
}

/**
 * Merge one raw config object with the defaults, ignoring only absent keys.
 * @param {unknown} input Raw config from the loader row.
 * @returns {typeof DEFAULTS} Resolved options.
 */
export function resolveOptions(input) {
  const source = input && typeof input === 'object' ? input : {}
  const options = { ...DEFAULTS }
  for (const key of Object.keys(SPEC)) {
    if (key in source && accepts(SPEC[key], source[key])) options[key] = source[key]
  }
  return options
}

/**
 * The plugin Config as a Standard Schema, so this package needs no runtime
 * dependency to be configurable. A wrong-typed value is reported as an issue
 * and fails the loader row loudly, exactly as a schemastery field would.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-workspace-recency-order',
    /**
     * Validate one raw config object.
     * @param {unknown} input Raw config from the loader row.
     * @returns {{ value: typeof DEFAULTS } | { issues: { message: string, path: string[] }[] }} Result or issues.
     */
    validate(input) {
      const source = input === undefined || input === null ? {} : input
      /** @type {{ message: string, path: string[] }[]} */
      const issues = []
      if (typeof source !== 'object' || Array.isArray(source)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const [key, value] of Object.entries(source)) {
        const spec = SPEC[key]
        if (spec === undefined) {
          issues.push({ message: `unknown option "${key}"`, path: [key] })
          continue
        }
        if (!accepts(spec, value)) {
          const expected = spec.type === 'enum'
            ? `one of ${spec.values.map((entry) => JSON.stringify(entry)).join(', ')}`
            : spec.type
          issues.push({ message: `expected ${expected}, received ${JSON.stringify(value)}`, path: [key] })
        }
      }
      if (issues.length > 0) return { issues }
      return { value: resolveOptions(source) }
    },
  },
}

/**
 * Build a logger that never takes the plugin down when logging is unavailable.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {string} label Logger name.
 * @returns {{ info: Function, warn: Function, debug: Function }} Logger facade.
 */
function createLogger(ctx, label) {
  let logger
  try {
    logger = ctx.logger?.(label)
  } catch {
    logger = undefined
  }
  const fallback = (level) => (...args) => {
    if (level === 'debug') return
    // eslint-disable-next-line no-console -- last resort before the logger service exists
    console[level === 'info' ? 'log' : 'warn'](`[${label}]`, ...args)
  }
  return {
    info: logger?.info?.bind(logger) ?? fallback('info'),
    warn: logger?.warn?.bind(logger) ?? fallback('warn'),
    debug: logger?.debug?.bind(logger) ?? fallback('debug'),
  }
}

/**
 * Keep the Workspace registry order equal to the recency ranking.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context carrying `workspaceRegistry` and `sessionController`.
 * @param {unknown} config Raw config from the loader row.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const logger = createLogger(ctx, name)
  if (!options.enabled) {
    logger.info('disabled by config; Workspace order will not be managed')
    return
  }

  const abort = new AbortController()
  /** @type {{ timer: ReturnType<typeof setTimeout> | null, sweep: ReturnType<typeof setInterval> | null, running: boolean, dirty: boolean, applying: boolean, disposed: boolean }} */
  const state = {
    timer: null,
    sweep: null,
    running: false,
    dirty: false,
    applying: false,
    disposed: false,
  }

  /**
   * Read the current Host Session list.
   * @returns {Promise<readonly object[] | undefined>} Summaries, or undefined when the read failed.
   */
  async function readSummaries() {
    try {
      const value = await ctx.sessionController.list({}, abort.signal)
      return Array.isArray(value?.items) ? value.items : []
    } catch (error) {
      if (!state.disposed) logger.warn('could not read the Session list:', error?.message ?? error)
      return undefined
    }
  }

  /**
   * Compute the desired Workspace order and write whatever differs.
   * @param {string} reason Short trigger name, for logs.
   * @returns {Promise<void>} Resolution after every write settles.
   */
  async function reconcile(reason) {
    const workspaces = ctx.workspaceRegistry.list()
    if (workspaces.length < 2) return

    const summaries = await readSummaries()
    if (summaries === undefined) return
    if (summaries.length === 0 && options.skipWhenSessionListEmpty) {
      logger.debug('skipped (%s): no Sessions are known yet', reason)
      return
    }

    const rows = workspaces.map((workspace) => ({
      id: String(workspace.id),
      createdAt: workspace.createdAt,
      sessionIds: workspace.sessionIds,
    }))
    const currentOrder = rows.map((row) => row.id)
    const { order: desiredOrder } = rankWorkspaces(rows, summaries, options)
    if (sameOrder(currentOrder, desiredOrder)) return

    const moves = planMoves(currentOrder, desiredOrder)
    if (moves.length === 0) return

    logger.info('reordering %d Workspace(s) (%s): %s -> %s', moves.length, reason, currentOrder.join(','), desiredOrder.join(','))
    state.applying = true
    try {
      for (const move of moves) {
        await ctx.workspaceRegistry.insertBefore(move.id, move.before)
      }
    } finally {
      state.applying = false
    }
  }

  /**
   * Run one reconcile, coalescing anything that arrives while it is in flight.
   * @param {string} reason Short trigger name, for logs.
   * @returns {Promise<void>} Resolution after the queue drains.
   */
  async function run(reason) {
    if (state.disposed) return
    if (state.running) {
      state.dirty = true
      return
    }
    state.running = true
    try {
      let current = reason
      do {
        state.dirty = false
        await reconcile(current)
        current = 'coalesced'
      } while (state.dirty && !state.disposed)
    } catch (error) {
      logger.warn('reorder failed:', error?.message ?? error)
    } finally {
      state.running = false
    }
  }

  /**
   * Queue one debounced reconcile.
   * @param {string} reason Short trigger name, for logs.
   * @returns {void}
   */
  function schedule(reason) {
    if (state.disposed || state.timer !== null) return
    state.timer = setTimeout(() => {
      state.timer = null
      void run(reason)
    }, options.debounceMs)
    state.timer.unref?.()
  }

  ctx.on('api-session/activity', () => schedule('activity'))
  ctx.on('api-session/added', () => schedule('session-added'))
  ctx.on('api-session/removed', () => schedule('session-removed'))
  ctx.on('domain/changed', (change) => {
    // Our own writes come back through this same event; ignoring them while a
    // write set is in flight keeps one reconcile from queuing the next.
    if (state.applying) return
    if (change?.domain !== 'workspace') return
    schedule('workspace-changed')
  })

  if (options.sweepMs > 0) {
    state.sweep = setInterval(() => schedule('sweep'), options.sweepMs)
    state.sweep.unref?.()
  }

  ctx.effect(() => () => {
    state.disposed = true
    abort.abort()
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.sweep !== null) {
      clearInterval(state.sweep)
      state.sweep = null
    }
  }, `${name}.lifecycle`)

  logger.info(
    'managing Workspace order (direction=%s, empty=%s, sweep=%dms)',
    options.direction,
    options.emptyWorkspace,
    options.sweepMs,
  )
  schedule('startup')
}
