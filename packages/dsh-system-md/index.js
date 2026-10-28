/**
 * project-system-md — a Pi-style project-owned system prompt for DeepSeek Harness.
 *
 * When a session's working directory (or an ancestor up to the project root) holds
 * one of the configured files, that file's text becomes the agent's COMPLETE system
 * prompt: the harness identity, the deployment persona, first-party tool guidance,
 * plan-mode text, skill text and every other prompt section are dropped for that one
 * agent. Agents whose directory holds no such file keep the normal prompt.
 *
 * Mechanism: on `agent/created`, register exactly one `complete: true` section on that
 * new agent's own scope through `ctx.systemPrompt.section()`, with a `text` callback
 * that re-reads the file for every assembly. The assembly waterfall is never
 * intercepted, so other plugins' registrations stay intact — they are simply not
 * rendered while a file is active.
 *
 * @module @local/dsh-system-md
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'project-system-md'
/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Documented defaults; the row's `config` overrides any of them. */
const DEFAULTS = Object.freeze({
  files: Object.freeze(['.dsh/SYSTEM.md', '.pi/SYSTEM.md']),
  searchAncestors: true,
  projectRootMarkers: Object.freeze(['.git']),
  maxDepth: 8,
  maxBytes: 262144,
  ignoreEmptyFile: true,
  keepRuntimeContext: true,
  applyToSubagents: false,
  excludePresets: Object.freeze(['minimal']),
  sectionName: 'project:system-md',
})

/**
 * Register the project system-prompt override.
 * @param ctx - the Host context this row is mounted on.
 * @param config - the row's `config`; see {@link normalizeConfig}.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  /** agent id -> disposer of that agent's section registrations. */
  const owned = new Map()

  // Unloading the plugin must not leave agent-scope registrations behind.
  ctx.effect(() => () => {
    for (const dispose of owned.values()) dispose?.()
    owned.clear()
  })

  ctx.on('agent/created', ({ agent } = {}) => {
    installForAgent(ctx, agent, settings, owned)
  }, { global: true })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    if (agent?.id === undefined) return
    owned.get(agent.id)?.()
    owned.delete(agent.id)
  }, { global: true })
}

/**
 * Validate and normalize one row's config, failing loud on a wrong shape so the
 * misconfiguration shows up as a failed row instead of a silently ignored key.
 * @param config - the raw row config.
 * @returns the effective settings.
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('system-md: config must be an object')
  }
  const maxDepth = raw.maxDepth ?? DEFAULTS.maxDepth
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError('system-md: `maxDepth` must be a non-negative integer')
  }
  const maxBytes = raw.maxBytes ?? DEFAULTS.maxBytes
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('system-md: `maxBytes` must be a positive integer')
  }
  const sectionName = raw.sectionName ?? DEFAULTS.sectionName
  if (typeof sectionName !== 'string' || sectionName.length === 0) {
    throw new TypeError('system-md: `sectionName` must be a non-empty string')
  }
  return {
    files: stringList(raw.files, DEFAULTS.files, 'files'),
    searchAncestors: bool(raw.searchAncestors, DEFAULTS.searchAncestors, 'searchAncestors'),
    projectRootMarkers: stringList(raw.projectRootMarkers, DEFAULTS.projectRootMarkers, 'projectRootMarkers'),
    maxDepth,
    maxBytes,
    ignoreEmptyFile: bool(raw.ignoreEmptyFile, DEFAULTS.ignoreEmptyFile, 'ignoreEmptyFile'),
    keepRuntimeContext: bool(raw.keepRuntimeContext, DEFAULTS.keepRuntimeContext, 'keepRuntimeContext'),
    applyToSubagents: bool(raw.applyToSubagents, DEFAULTS.applyToSubagents, 'applyToSubagents'),
    excludePresets: stringList(raw.excludePresets, DEFAULTS.excludePresets, 'excludePresets'),
    sectionName,
  }
}

/**
 * Find the system-prompt file that owns one session working directory.
 *
 * The nearest candidate wins: the directory itself is checked first, then each
 * ancestor, stopping after the directory that carries a project-root marker so a
 * project file never leaks into an unrelated parent project.
 * @param cwd - the session's absolute working directory.
 * @param config - raw or normalized settings.
 * @returns the absolute file path, or undefined when no candidate exists.
 */
export function resolveSystemFile(cwd, config) {
  const settings = isNormalized(config) ? config : normalizeConfig(config)
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) return undefined
  let dir = cwd
  for (let depth = 0; depth <= settings.maxDepth; depth += 1) {
    for (const relative of settings.files) {
      const candidate = resolve(dir, relative)
      if (isFile(candidate)) return candidate
    }
    if (!settings.searchAncestors) return undefined
    if (settings.projectRootMarkers.some((marker) => isDirectory(join(dir, marker)))) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Read one override file as prompt text, reusing the last successful read while the
 * file is unchanged and while a transient read error lasts.
 * @param file - absolute file path.
 * @param cache - caller-owned `{ mtimeMs, size, text }` record.
 * @param maxBytes - truncation bound in characters.
 * @returns the file text, the last cached text, or `''`.
 */
export function readSystemText(file, cache = {}, maxBytes = DEFAULTS.maxBytes) {
  try {
    const stat = statSync(file)
    if (cache.text !== undefined && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.text
    }
    let text = readFileSync(file, 'utf8')
    if (text.length > maxBytes) {
      text = `${text.slice(0, maxBytes)}\n\n[system-md: truncated at ${maxBytes} characters]`
    }
    cache.mtimeMs = stat.mtimeMs
    cache.size = stat.size
    cache.text = text
    return text
  } catch {
    return cache.text ?? ''
  }
}

/** Install the override section for one freshly created agent. */
function installForAgent(ctx, agent, settings, owned) {
  if (agent?.id === undefined || owned.has(agent.id)) return
  const cwd = agent.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return
  if (!settings.applyToSubagents && !isTopLevel(ctx, agent)) return
  const preset = selectedPreset(ctx, agent)
  if (preset !== undefined && settings.excludePresets.includes(preset)) return
  const file = resolveSystemFile(cwd, settings)
  if (file === undefined) return
  const cache = {}
  if (settings.ignoreEmptyFile && readSystemText(file, cache, settings.maxBytes).trim().length === 0) return
  // Captured once, like dsh-system-prefix captures it for its own section.
  const sentence = prefixSentence(ctx, agent)

  const dispose = agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.systemPrompt.section({
        name: settings.sectionName,
        order: 0,
        complete: true,
        interpolate: false,
        text: () => withSentence(sentence, readSystemText(file, cache, settings.maxBytes)),
      }),
    ]
    if (!settings.keepRuntimeContext) {
      disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
    }
    return () => {
      for (const disposeOne of disposers) disposeOne?.()
    }
  })
  owned.set(agent.id, dispose)
}

/**
 * The sentence dsh-system-prefix keeps at the very top of a new session.
 *
 * This plugin's `complete` section becomes the whole prompt, so that sentence
 * would otherwise be dropped; read it from the provider and prepend it.
 * @param ctx - the plugin context, used when the agent scope cannot resolve the service.
 * @param agent - the agent owning the section.
 * @returns the sentence without surrounding whitespace, or '' when absent or disabled.
 */
function prefixSentence(ctx, agent) {
  for (const scope of [agent?.ctx, ctx]) {
    try {
      const text = scope?.get?.('systemPromptPrefix')?.text?.()
      if (typeof text === 'string') return text.trim()
    } catch {
      // No provider on this scope; try the next one.
    }
  }
  return ''
}

/** Join the optional prefix sentence and the project file into one section text. */
function withSentence(sentence, body) {
  if (sentence.length === 0) return body
  return body.trim().length === 0 ? sentence : `${sentence}\n\n${body}`
}

/** Whether one agent is a runtime root rather than a delegated child. */
function isTopLevel(ctx, agent) {
  const registry = ctx.get?.('agents')
  if (registry === undefined || registry === null || typeof registry.roots !== 'function') return true
  try {
    return registry.roots().some((candidate) => candidate.id === agent.id)
  } catch {
    return true
  }
}

/**
 * The preset id a session selected.
 *
 * The base Session no longer exposes an `events` array, so the header field and
 * the `agentPreset` projection are the supported read paths; the event scan
 * stays as a last-resort fallback for a deployment without session projections.
 * @param ctx - the plugin context, used when the agent scope cannot resolve the service.
 * @param agent - the agent owning the section.
 * @returns the preset id, or undefined when the session uses no preset.
 */
function selectedPreset(ctx, agent) {
  const fromHeader = agent?.session?.header?.agentPreset
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
  for (const scope of [agent?.ctx, ctx]) {
    try {
      const projected = scope?.get?.('sessionProjections')?.stateOf?.(agent.session, 'agentPreset')
      if (typeof projected === 'string' && projected.length > 0) return projected
    } catch {
      // No projection service here; try the next scope, then the log scan.
    }
  }
  const events = agent?.session?.snapshotEvents?.()
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    const preset = event.data?.agentPreset ?? event.agentPreset ?? event.payload?.agentPreset
    if (typeof preset === 'string') return preset
  }
  return undefined
}

function stringList(value, fallback, field) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`system-md: \`${field}\` must be an array of non-empty strings`)
  }
  return [...value]
}

function bool(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`system-md: \`${field}\` must be a boolean`)
  return value
}

function isNormalized(config) {
  return typeof config === 'object' && config !== null && Array.isArray(config.files) && typeof config.maxDepth === 'number'
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
