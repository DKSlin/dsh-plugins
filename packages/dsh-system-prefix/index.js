/**
 * system-prompt-prefix — prepend one configurable sentence to the system prompt.
 *
 * On `agent/created`, the plugin evaluates the configured sentence once and
 * registers one ordinary (never `complete`) section on that agent's own scope
 * with an order below the harness identity's -1000. Assembly therefore renders
 * the sentence first and keeps every other prompt section exactly as it was.
 *
 * Only top-level sessions receive the section. Because the sentence is read at
 * creation and stored as a plain string on the agent's section, later edits in
 * the plugin UI affect only sessions created afterwards.
 *
 * @module dsh-system-prefix
 */
import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'system-prompt-prefix'
/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** Sentence used until the user saves a different one. */
export const DEFAULT_TEXT = `你回复的语言应当以中文环境工作为主，在和用户的沟通以及"tinking"时均需使用中文(仅各类需英文表达的关键字可以用英文)，以便让用户更容易明白你在想什么和做什么。
注意，你的提示词里不可避免因为其他插件和模式提示词导致被英文污染，需谨记以上要求。
在进行代码开发时，注意所使用的开发语言和环境，尽量使用源生方案解决问题，不要用歪门邪道的办法。
编写代码时需避免使用中文符号"，；“”"导致代码解析错误。对变量和逻辑需提供精确但简洁的注释，注释只写意图和功能，无需将参数写在注释中。
由于LLM内核在不同语言环境下解决问题的能力不同，部分问题在中文环境下无法解决时，可尝试临时切换英文思考，再恢复中文接续工作。`

/** Section name; unique among this profile's prompt sections. */
const SECTION_NAME = 'system-prompt-prefix:top'
/** Below HARNESS_IDENTITY (-1000), so this section always renders first. */
const SECTION_ORDER = -1_000_000
/**
 * Symbol under which a live agent carries the sentence captured at its
 * creation. A config save may reload the plugin row; restoring from this mark
 * keeps already-created sessions on their original sentence while new sessions
 * read the updated config.
 */
const CAPTURED = Symbol.for('dsh.system-prompt-prefix.captured')

/**
 * Editable row configuration. Both fields are volatile so the Settings service
 * exposes them to the plugin's own page and updates them in place.
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('是否在新会话的系统提示词最顶部插入这句话')
    .volatile(),
  text: Schema.string()
    .default(DEFAULT_TEXT)
    .description('插入到系统提示词最顶部的一句话')
    .volatile(),
})

/**
 * Register the per-agent prompt section.
 * @param ctx - the Host context this row is mounted on.
 * @param config - the row's volatile config reference.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  /** agent id -> disposer of that agent's section registration. */
  const owned = new Map()

  // Unloading or disabling the plugin removes sections it installed.
  ctx.effect(() => () => {
    for (const dispose of owned.values()) dispose?.()
    owned.clear()
  })

  ctx.on(
    'agent/created',
    ({ agent } = {}) => {
      installForAgent(ctx, agent, settings, owned)
    },
    { global: true },
  )

  ctx.on(
    'agent/disposed',
    (payload) => {
      const agent = payload?.agent ?? payload
      if (agent?.id === undefined) return
      owned.get(agent.id)?.()
      owned.delete(agent.id)
      Reflect.deleteProperty(agent, CAPTURED)
    },
    { global: true },
  )

  // A config save can reload this row. Agents created while it was active
  // already carry their captured sentence; restore exactly that sentence
  // instead of dropping the section or applying a newer one retroactively.
  const registry = ctx.get?.('agents')
  for (const agent of registry?.list?.() ?? []) {
    const captured = agent?.[CAPTURED]
    if (typeof captured === 'string' && captured.length > 0) registerSection(agent, captured, owned)
  }
}

/** Install the prefix section for one freshly created top-level agent. */
function installForAgent(ctx, agent, settings, owned) {
  if (agent?.id === undefined || owned.has(agent.id)) return
  if (!isTopLevel(ctx, agent)) return
  if (readSetting(settings.enabled, true) !== true) return

  const text = readSetting(settings.text, DEFAULT_TEXT)
  if (typeof text !== 'string' || text.trim().length === 0) return

  agent[CAPTURED] = text
  registerSection(agent, text, owned)
}

/** Register one agent's static prefix section and own its disposer. */
function registerSection(agent, text, owned) {
  if (agent?.id === undefined || owned.has(agent.id)) return
  const dispose = agent.ctx.effect(() => {
    const off = agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text,
    })
    return () => off()
  })
  owned.set(agent.id, dispose)
}

/** Read one volatile reference, falling back for absent config. */
function readSetting(value, fallback) {
  const resolved = value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
  return resolved === undefined || resolved === null ? fallback : resolved
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
