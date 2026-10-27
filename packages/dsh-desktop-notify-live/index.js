/**
 * desktop-notify — Windows toast (bottom-right bubble) plus a ding when the
 * agent either asks the user a question or finishes a turn.
 *
 * It is a pure observer: the `user-questions/request` waterfall is delegated
 * with `next()` untouched and is installed with `prepend` so it always runs
 * before the answerer that claims the request and never calls `next()`.
 * Turn completion is read from the durable `session/event` feed (the
 * `turn/end` event), never from polling.
 *
 * The OS-facing part lives in `notify.ps1` (Windows PowerShell 5.1 + WinRT
 * toast). The Host spawns it detached per notification; a failure there can
 * never affect the agent loop.
 *
 * @module @local/dsh-desktop-notify
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'desktop-notify'

/** Documented defaults; the row's `config` overrides any of them. */
const DEFAULTS = Object.freeze({
  enabled: true,
  notifyOnQuestion: true,
  notifyOnTurnEnd: true,
  notifyOnError: true,
  sound: true,
  soundFile: '',
  topLevelOnly: true,
  appId: 'com.deepseek.dsh',
  icon: '',
  skipWhenFocused: false,
  questionMaxChars: 120,
  titleMaxChars: 60,
  minIntervalMs: 700,
})

/** The notification helper next to this module. */
const SCRIPT = fileURLToPath(new URL('./notify.ps1', import.meta.url))

/** Windows PowerShell (5.1), which has the WinRT toast projection and SoundPlayer. */
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/**
 * Register the notification listeners.
 * @param ctx - the Host context this row is mounted on.
 * @param config - the row's `config`; see {@link normalizeConfig}.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) return
  receipt(`plugin loaded (pid ${process.pid})`)

  /** Last notification per kind+session, to swallow duplicate emits. */
  const lastFired = new Map()

  const emit = (kind, sessionId, title, body) => {
    const key = `${kind}:${sessionId ?? ''}`
    const now = Date.now()
    const previous = lastFired.get(key)
    if (previous !== undefined && now - previous < settings.minIntervalMs) return
    lastFired.set(key, now)
    // Keep the map from growing across many sessions.
    if (lastFired.size > 64) {
      for (const [entryKey, at] of lastFired) {
        if (now - at > 60_000) lastFired.delete(entryKey)
      }
    }
    receipt(`sending ${kind}: ${body}`)
    spawnToast(settings, title, body)
  }

  ctx.on(
    'user-questions/request',
    (request, next) => {
      try {
        if (settings.notifyOnQuestion) {
          const questions = Array.isArray(request?.questions) ? request.questions : []
          const agentId = request?.agent?.id
          if (!settings.topLevelOnly || isRootAgent(ctx, agentId)) {
            const body = describeQuestion(questions, settings)
            if (body) emit('question', agentId, toastTitle(), body)
          }
        }
      } catch (error) {
        receipt(`question listener failed: ${String(error)}`)
      }
      return next()
    },
    { global: true, prepend: true },
  )

  ctx.on(
    'session/event',
    (session, event) => {
      try {
        if (!settings.notifyOnTurnEnd) return
        if (event?.type !== 'turn/end') return
        const sessionId = session?.id ?? session?.header?.id
        if (settings.topLevelOnly && !isRootAgent(ctx, sessionId)) return
        const reason = event?.data?.reason
        const kind = reason?.kind
        let body
        if (kind === 'error') {
          if (!settings.notifyOnError) return
          body = withSessionTitle(ctx, session, '本轮出错', settings)
        } else if (kind === 'max-tokens') {
          body = withSessionTitle(ctx, session, '本轮达到输出上限', settings)
        } else if (kind === 'completed' || kind === undefined) {
          body = withSessionTitle(ctx, session, '本轮回复完成', settings)
        } else {
          // `aborted` / `blocked`: the user did it themselves — stay quiet.
          return
        }
        emit('turn', sessionId, toastTitle(), body)
      } catch (error) {
        receipt(`turn listener failed: ${String(error)}`)
      }
    },
    { global: true },
  )
}

/**
 * Validate and normalize one row's config, failing loud on a wrong shape so a
 * misconfiguration shows up as a failed row instead of a silently ignored key.
 * @param config - the raw row config.
 * @returns the effective settings.
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('desktop-notify: config must be an object')
  }
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled, 'enabled'),
    notifyOnQuestion: bool(raw.notifyOnQuestion, DEFAULTS.notifyOnQuestion, 'notifyOnQuestion'),
    notifyOnTurnEnd: bool(raw.notifyOnTurnEnd, DEFAULTS.notifyOnTurnEnd, 'notifyOnTurnEnd'),
    notifyOnError: bool(raw.notifyOnError, DEFAULTS.notifyOnError, 'notifyOnError'),
    sound: bool(raw.sound, DEFAULTS.sound, 'sound'),
    soundFile: text(raw.soundFile, DEFAULTS.soundFile, 'soundFile'),
    topLevelOnly: bool(raw.topLevelOnly, DEFAULTS.topLevelOnly, 'topLevelOnly'),
    appId: text(raw.appId, DEFAULTS.appId, 'appId'),
    icon: text(raw.icon, defaultIcon(), 'icon'),
    skipWhenFocused: bool(raw.skipWhenFocused, DEFAULTS.skipWhenFocused, 'skipWhenFocused'),
    questionMaxChars: positiveInt(raw.questionMaxChars, DEFAULTS.questionMaxChars, 'questionMaxChars'),
    titleMaxChars: positiveInt(raw.titleMaxChars, DEFAULTS.titleMaxChars, 'titleMaxChars'),
    minIntervalMs: positiveInt(raw.minIntervalMs, DEFAULTS.minIntervalMs, 'minIntervalMs'),
  }
}

/** The installed app icon, when the Host runs from the packaged desktop app. */
function defaultIcon() {
  try {
    const candidate = join(dirname(process.execPath), 'resources', 'icon.png')
    return existsSync(candidate) ? candidate : ''
  } catch {
    return ''
  }
}

/** Whether one agent/session id is a live root agent (not a delegated child). */
function isRootAgent(ctx, id) {
  if (id === undefined || id === null) return true
  const agents = ctx.get?.('agents')
  if (agents === undefined || agents === null || typeof agents.roots !== 'function') return true
  try {
    return agents.roots().some((agent) => agent.id === id)
  } catch {
    return true
  }
}

/** Compose the toast title line. */
function toastTitle() {
  return 'DeepSeek Harness'
}

/** Compose a body line that names the session when a title is available. */
function withSessionTitle(ctx, session, action, settings) {
  let title
  try {
    title = ctx.get?.('sessionTitle')?.get(session)?.title
  } catch {
    title = undefined
  }
  const suffix = typeof title === 'string' ? truncate(clean(title), settings.titleMaxChars) : ''
  return suffix ? `${action} · ${suffix}` : action
}

/** Compose the question body from the first question of the request. */
function describeQuestion(questions, settings) {
  const first = questions[0]
  if (first === undefined) return ''
  const text = truncate(clean(first.question ?? first.header ?? ''), settings.questionMaxChars)
  if (text.length === 0) return ''
  const extra = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
  return `需要你回答：${text}${extra}`
}

/** Strip control characters a toast XML document would reject. */
function clean(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Truncate by Unicode code point so a surrogate pair is never split. */
function truncate(value, max) {
  const chars = [...value]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value
}

/** Append one diagnostic line to the receipt log (best effort). */
function receipt(line) {
  try {
    appendFileSync(join(tmpdir(), 'dsh-desktop-notify.log'), `${new Date().toISOString()} | ${line}\n`)
  } catch {
    // Diagnostics are optional.
  }
}

/** Spawn the detached Windows PowerShell notification helper. */
function spawnToast(settings, title, body) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    SCRIPT,
    '-Title',
    title,
    '-Body',
    body,
    '-AppId',
    settings.appId,
  ]
  if (settings.icon) args.push('-Icon', settings.icon)
  if (settings.soundFile) args.push('-SoundFile', settings.soundFile)
  if (!settings.sound) args.push('-NoSound')
  if (settings.skipWhenFocused) {
    args.push('-SkipWhenFocused', '-AppExe', process.execPath)
  }
  try {
    const child = execFile(
      POWERSHELL,
      args,
      { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 },
      () => {},
    )
    child.on('error', () => {})
    child.unref?.()
  } catch {
    // Ignore: a missing notification must not disturb the agent loop.
  }
}

function bool(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`desktop-notify: \`${field}\` must be a boolean`)
  return value
}

function text(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new TypeError(`desktop-notify: \`${field}\` must be a string`)
  return value
}

function positiveInt(value, fallback, field) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`desktop-notify: \`${field}\` must be a positive integer`)
  }
  return value
}
