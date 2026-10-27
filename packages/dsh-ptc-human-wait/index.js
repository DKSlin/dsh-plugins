/**
 * ptc-human-wait — pause the \`run_code\` execution deadline while the user answers.
 *
 * \`ask_user_question\` (the blocking "legacy" mode) waits for the human
 * indefinitely, but it runs as a nested call inside a \`run_code\` program, and
 * the Node PTC runtime's elapsed execution deadline also covers time spent
 * waiting on nested tools. A slow answer therefore killed the whole program
 * with \`execution deadline reached (120000ms)\` and interrupted the question.
 *
 * This plugin preserves the runtime's normal loop protection. It replaces the
 * runtime's own wall timer with an equivalent one of its own and pauses that
 * timer only while an \`ask_user_question\` dispatch is in flight. A program
 * that never asks still dies at the configured deadline (default 120 s, capped
 * by the deployment maximum); a pending human question does not count against
 * it.
 *
 * Correlation: the PTC transport dispatches nested tools with the run's own
 * \`runController.signal\` — the same AbortSignal it hands to
 * \`ptcRuntime.resolve\` and therefore to \`ptcRuntime.run\`. Matching on that
 * object identifies exactly the run a question belongs to.
 *
 * @module dsh-ptc-human-wait
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ptc-human-wait'
/** The execution service this plugin wraps. */
export const inject = ['ptcRuntime']

/** The nested tool whose wait must not consume the execution deadline. */
const QUESTION_TOOL = 'ask_user_question'
/** Abort reason delivered to the runtime when this plugin's own deadline fires. */
const DEADLINE_REASON = 'execution deadline reached'

/**
 * Wrap the mounted PTC runtime so its execution deadline pauses on question waits.
 * @param ctx - the Host context; must expose \`ptcRuntime\`.
 */
export function apply(ctx) {
  const runtime = ctx.ptcRuntime
  if (runtime === undefined || typeof runtime.resolve !== 'function' || typeof runtime.run !== 'function') {
    throw new Error('ptc-human-wait: the mounted ptcRuntime does not expose resolve()/run()')
  }

  // Read the prototype methods (not the context-tracing proxy wrappers) so the
  // originals can be re-invoked with the CALLER's \`this\`, preserving whatever
  // context the run_code transport resolved the runtime in.
  const prototype = Object.getPrototypeOf(runtime)
  const originalResolve = prototype.resolve
  const originalRun = prototype.run
  if (typeof originalResolve !== 'function' || typeof originalRun !== 'function') {
    throw new Error('ptc-human-wait: cannot reach ptcRuntime prototype methods')
  }

  /** runController signal -> the numeric deadline the runtime resolved for it. */
  const requestedDeadline = new WeakMap()
  /** runController signal -> live deadline state for that run. */
  const runs = new Map()

  const arm = (state) => {
    if (state.remaining <= 0) {
      state.timer = undefined
      state.controller.abort(DEADLINE_REASON)
      return
    }
    state.armedAt = Date.now()
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.controller.abort(DEADLINE_REASON)
    }, state.remaining)
  }

  const pause = (state) => {
    state.claims += 1
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
    state.remaining -= Date.now() - state.armedAt
  }

  const resume = (state) => {
    state.claims -= 1
    if (state.claims > 0 || state.done || state.controller.signal.aborted) return
    arm(state)
  }

  function resolveWithPausableDeadline(request) {
    const resolved = originalResolve.call(this, request)
    // No signal means a question could not be correlated back to this run;
    // keep the runtime's own timer so loop protection never silently vanishes.
    if (resolved.timeoutMs === null || resolved.timeoutMs === undefined || resolved.signal === undefined) {
      return resolved
    }
    // Key on the run's own signal: that identity survives any consumer that
    // copies the resolved spec, and it is the key a nested question dispatch is
    // matched by in the \`tools/execute\` listener below.
    requestedDeadline.set(resolved.signal, resolved.timeoutMs)
    return { ...resolved, timeoutMs: null }
  }

  async function runWithPausableDeadline(spec) {
    const runSignal = spec.signal
    const requested = runSignal === undefined ? undefined : requestedDeadline.get(runSignal)
    if (requested === undefined || runSignal === undefined) return originalRun.call(this, spec)

    const controller = new AbortController()
    const state = {
      controller,
      requested,
      remaining: requested,
      armedAt: 0,
      timer: undefined,
      claims: 0,
      done: false,
    }
    const signal = AbortSignal.any([runSignal, controller.signal])
    arm(state)
    runs.set(runSignal, state)
    try {
      const result = await originalRun.call(this, { ...spec, signal, timeoutMs: null })
      // The runtime classifies its own elapsed expiry as "timeout"; this
      // plugin's abort looks like an ordinary cancel to it, so restore the
      // canonical outcome while keeping the logs and sandbox facts.
      if (controller.signal.aborted && result.error?.kind === 'abort') {
        return {
          ...result,
          error: { kind: 'timeout', message: 'execution deadline reached (' + requested + 'ms)' },
        }
      }
      return result
    } finally {
      state.done = true
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      if (runs.get(runSignal) === state) runs.delete(runSignal)
    }
  }

  runtime.resolve = resolveWithPausableDeadline
  runtime.run = runWithPausableDeadline

  // Outermost \`tools/execute\` listener: the original run signal is still on
  // \`exec.signal\` before any other wrapper can replace it.
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== QUESTION_TOOL) return next()
    const state = runs.get(exec.signal)
    if (state === undefined) return next()
    pause(state)
    try {
      return await next()
    } finally {
      resume(state)
    }
  }, { prepend: true })

  // Restore the untouched prototype methods when the row unloads, but only when
  // our own patch is still the one installed.
  ctx.effect(() => () => {
    if (Object.getOwnPropertyDescriptor(runtime, 'resolve')?.value === resolveWithPausableDeadline) {
      delete runtime.resolve
    }
    if (Object.getOwnPropertyDescriptor(runtime, 'run')?.value === runWithPausableDeadline) {
      delete runtime.run
    }
    runs.clear()
  })
}
