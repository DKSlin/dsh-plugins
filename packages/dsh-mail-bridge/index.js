/**
 * mail-bridge — 把每轮的最终回复与提问用邮件推到手机，并接受邮件回复继续会话。
 *
 * 两个方向：
 *  - 出：`session/event` 的 `turn/end` 取最后一条 assistant 的 text 块；
 *        `user-questions/request` 取待答问题。二者都以带短码的邮件发出。
 *  - 入：IMAP 轮询小号收件箱，按短码找回会话，剥掉引用后回灌。
 *        待答问题优先调用 `userQuestions.answer()`，否则用 `sessionController.prompt()`。
 *
 * 插件只做观察与投递，不注册工具，也不进入模型上下文。
 * 凭证放在 profile 目录的 mail-bridge.json，不写进本包的 patch。
 *
 * @module dsh-mail-bridge
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as imapflowModule from 'imapflow'
import * as mailparserModule from 'mailparser'
import nodemailer from 'nodemailer'
import Schema from '@deepseek-ai/schemastery'
import {
  QUOTE_HINT,
  buildAnswer,
  clean,
  extractCode,
  extractReply,
  isOwnNotification,
  lastAssistantText,
  stripHtml,
// 版本参数用于击穿模块缓存：修改 lib/text.js 后递增这里，重载才会读取新代码。
} from './lib/text.js?v=6'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'mail-bridge'

/**
 * 可在设置页编辑的配置。全部声明为 volatile，设置页保存后原地更新。
 * 留空的字段会回退到 profile 目录的 mail-bridge.json。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用邮件桥').volatile(),
  sender: Schema.string().default('').description('发信邮箱（同时用于收信）').volatile(),
  password: Schema.string().default('').description('邮箱授权码').volatile(),
  notifyTo: Schema.string().default('').description('通知接收邮箱').volatile(),
  whitelist: Schema.string().default('').description('允许驱动的发件地址，逗号分隔').volatile(),
  pollMs: Schema.number().default(30000).description('收信轮询间隔（毫秒）').volatile(),
  maxChars: Schema.number().default(0).description('正文长度上限，0 表示不限制').volatile(),
})

const ImapFlow = imapflowModule.ImapFlow ?? imapflowModule.default?.ImapFlow
const simpleParser = mailparserModule.simpleParser ?? mailparserModule.default?.simpleParser

/** 文档化默认值，行的 config 与 profile 配置文件可覆盖。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  smtp: Object.freeze({ host: 'smtp.qq.com', port: 465, secure: true, user: '', pass: '' }),
  imap: Object.freeze({ host: 'imap.qq.com', port: 993, secure: true, user: '', pass: '', mailbox: 'INBOX' }),
  from: '',
  to: '',
  whitelist: [],
  pollMs: 45000,
  maxChars: 0,
  topLevelOnly: true,
  minIntervalMs: 2000,
  startupNotify: true,
  failureNotify: true,
  codeLength: 4,
})

/**
 * 挂载插件。
 * @param ctx - 该行所在的 Host 上下文。
 * @param config - 行的 config，与 profile 配置文件合并后使用。
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config, ctx)
  receipt(`apply 已执行 (v6): 配置目录=${profileDirectory(ctx)} to=${settings.to || '(空)'} 白名单=${settings.whitelist.join(',')} maxChars=${settings.maxChars}`)
  if (!settings.enabled) return
  if (!settings.to || !settings.smtp.user || !settings.smtp.pass) {
    receipt('缺少 to 或 SMTP 凭证，插件保持空闲')
    return
  }

  const state = loadState(settings.statePath)
  receipt(`已加载短码: ${Object.keys(state.codes).join(',') || '(空)'} 状态文件=${settings.statePath}`)
  const transport = nodemailer.createTransport({
    host: settings.smtp.host,
    port: settings.smtp.port,
    secure: settings.smtp.secure,
    auth: { user: settings.smtp.user, pass: settings.smtp.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  })
  // 未监听的 error 事件会抛出到进程，这里只记录，绝不让邮件通道影响 Host。
  transport.on('error', (error) => receipt(`SMTP 连接错误: ${describe(error)}`))

  /** 待答问题：短码 -> 等待中的调用。 */
  const pendingQuestions = new Map()
  /** 最近发送时刻：去重键 -> 时间戳。 */
  const lastSent = new Map()
  /** 串行化发信，避免并发连接。 */
  let sendChain = Promise.resolve()
  let polling = false

  const deliver = async (mail) => {
    sendChain = sendChain
      .then(() => sendMail(settings, transport, mail))
      .catch((error) => receipt(`发信失败: ${describe(error)}`))
    return sendChain
  }

  const throttled = (key) => {
    const now = Date.now()
    const previous = lastSent.get(key)
    if (previous !== undefined && now - previous < settings.minIntervalMs) return true
    lastSent.set(key, now)
    if (lastSent.size > 128) {
      for (const [entry, at] of lastSent) {
        if (now - at > 120_000) lastSent.delete(entry)
      }
    }
    return false
  }

  // 出向一：一轮结束，取最后一段正文。
  ctx.on(
    'session/event',
    (session, event) => {
      try {
        if (event?.type !== 'turn/end') return
        const kind = event?.data?.reason?.kind
        if (kind === 'aborted' || kind === 'blocked') return
        const sessionId = session?.id
        if (typeof sessionId !== 'string') return
        if (settings.topLevelOnly && !isRootSession(ctx, sessionId)) return
        const text = lastAssistantText(session, settings.maxChars)
        if (text.length === 0) return
        if (throttled(`turn:${sessionId}`)) return
        const title = titleOf(ctx, sessionId) ?? ''
        const code = allocateCode(state, sessionId, title, settings.codeLength)
        saveState(settings.statePath, state)
        const label = kind === 'error' ? '本轮出错' : kind === 'max-tokens' ? '本轮达到输出上限' : '本轮回复完成'
        deliver({
          subject: `[DSH:${code}] ${label}${title ? ` · ${title}` : ''}`,
          text: [
            `${label}${title ? `（${title}）` : ''}`,
            '',
            text,
            '',
            `--- ${QUOTE_HINT} ---`,
            `[DSH:${code}]`,
          ].join('\n'),
        })
      } catch (error) {
        receipt(`turn 监听失败: ${describe(error)}`)
      }
    },
    { global: true },
  )

  // 出向二：agent 在等回答。只观察后放行，答案从邮件侧旁路提交。
  ctx.on(
    'user-questions/request',
    (request, next) => {
      try {
        const questions = Array.isArray(request?.questions) ? request.questions : []
        const agent = request?.agent
        const callId = request?.wait?.callId
        const sessionId = agent?.id
        if (questions.length > 0 && typeof sessionId === 'string') {
          const title = titleOf(ctx, sessionId) ?? ''
          const code = allocateCode(state, sessionId, title, settings.codeLength)
          saveState(settings.statePath, state)
          if (callId !== undefined && throttled(`ask:${code}`) === false) {
            pendingQuestions.set(code, { agent, callId, questions, at: Date.now() })
          }
          if (throttled(`ask-mail:${code}`) === false) {
            deliver({
              subject: `[DSH:${code}] 需要你回答${title ? ` · ${title}` : ''}`,
              text: buildQuestionBody(code, title, questions),
            })
          }
        }
      } catch (error) {
        receipt(`提问监听失败: ${describe(error)}`)
      }
      return next()
    },
    { global: true, prepend: true },
  )

  if (settings.startupNotify) {
    deliver({
      subject: '[DSH:boot] 邮件桥已启用',
      text: [
        'DeepSeek Harness 的邮件桥已连接到本邮箱。',
        '',
        '之后每轮回复结束、或 agent 需要你选择时，都会收到一封带短码的邮件；',
        '直接回复该邮件（保留主题）即可让对应会话继续工作。',
        '',
        `发信账号：${settings.smtp.user}`,
        `轮询间隔：${Math.round(settings.pollMs / 1000)} 秒`,
      ].join('\n'),
    })
  }

  /** 正在进行的轮询连接；重载或卸载时必须由我们主动销毁。 */
  let activeClient

  /** 拉取一封或几封未读邮件并处理。 */
  const poll = async () => {
    if (polling) return
    polling = true
    let client
    // 看门狗：任何一步挂住都会在此时限后销毁连接，避免 polling 永久卡住。
    const watchdog = setTimeout(() => {
      try {
        client?.close()
      } catch {
        // 已关闭时忽略。
      }
    }, 60_000)
    try {
      client = new ImapFlow({
        host: settings.imap.host,
        port: settings.imap.port,
        secure: settings.imap.secure,
        auth: { user: settings.imap.user, pass: settings.imap.pass },
        logger: false,
        emitLogs: false,
        socketTimeout: 45_000,
        greetingTimeout: 20_000,
      })
      // imapflow 在 socket 超时会 emit error；没有监听器时 Node 会抛出并杀死进程。
      client.on('error', (error) => receipt(`IMAP 连接错误: ${describe(error)}`))
      activeClient = client
      await client.connect()
      if (!client.usable) {
        receipt('IMAP 连接建立后不可用，跳过本轮')
        return
      }
      const lock = await client.getMailboxLock(settings.imap.mailbox)
      try {
        const seenUids = []
        let handled = 0
        for await (const message of client.fetch({ seen: false }, { source: true, uid: true }, { uid: true })) {
          if (handled >= 10) break
          handled += 1
          seenUids.push(message.uid)
          try {
            await handleInbound(message, { ctx, settings, state, pendingQuestions, deliver })
          } catch (error) {
            receipt(`处理邮件失败: ${describe(error)}`)
          }
        }
        for (const uid of seenUids) {
          try {
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
          } catch (error) {
            receipt(`标记已读失败: ${describe(error)}`)
          }
        }
      } finally {
        lock.release()
      }
    } catch (error) {
      receipt(`IMAP 轮询失败: ${describe(error)}`)
    } finally {
      clearTimeout(watchdog)
      // 直接销毁连接：logout 需要往返，QQ 侧断开时会一直挂着。
      try {
        client?.close()
      } catch {
        // 已关闭时忽略。
      }
      if (activeClient === client) activeClient = undefined
      polling = false
    }
  }

  poll()
  const timer = setInterval(poll, settings.pollMs)
  // cordis 4 没有 dispose 事件行重载或卸载时只执行 effect 返回的清理函数。
  // 不清理会留下第二个轮询器和在途 socket 设置页每保存一次就多一份。
  ctx.effect(() => () => {
    clearInterval(timer)
    try {
      activeClient?.close()
    } catch {
      // 已关闭时忽略。
    }
    activeClient = undefined
    try {
      transport.close?.()
    } catch {
      // 已关闭时忽略。
    }
  })
}

/**
 * 处理一封收取到的邮件。
 * @param message - imapflow 的 fetch 条目，含原始字节与 uid。
 * @param env - 插件运行期状态与依赖。
 */
async function handleInbound(message, env) {
  const { ctx, settings, state, pendingQuestions, deliver } = env
  const parsed = await simpleParser(message.source)
  const subject = parsed.subject ?? ''
  const messageId = String(parsed.messageId ?? '').trim()
  const body = parsed.text ?? (typeof parsed.html === 'string' ? stripHtml(parsed.html) : '')

  // 白名单先于一切解析，避免陌生地址驱动本机 agent。
  const senders = (parsed.from?.value ?? []).map((entry) => normalizeAddress(entry?.address))
  if (!senders.some((address) => settings.whitelist.includes(address))) {
    receipt(`拒绝非白名单发件人: ${JSON.stringify(senders)} 白名单=${JSON.stringify(settings.whitelist)}`)
    return
  }

  const code = extractCode(subject) ?? extractCode(body)
  if (code === undefined) {
    receipt(`跳过无短码邮件: ${subject.slice(0, 40)}`)
    return
  }
  if (code === 'boot') {
    receipt('收到启动自检回信，忽略')
    return
  }
  if (isOwnNotification(subject, body)) {
    receipt(`跳过自己发出的通知: ${code}`)
    return
  }
  const reply = extractReply(body, code)
  if (reply.length === 0) {
    receipt(`短码 ${code} 的回复正文为空，忽略`)
    return
  }

  const entry = state.codes[code]
  if (entry === undefined) {
    receipt(`未知短码: ${code}`)
    await deliver({
      subject: `[DSH:${code}] 无法送达：短码不存在`,
      text: `收到一条回复，但短码 ${code} 没有对应的会话。\n\n请确认主题里的短码是否完整，或重新从通知邮件回复。`,
    })
    return
  }

  const pending = pendingQuestions.get(code)
  if (pending !== undefined) {
    const answer = buildAnswer(reply, pending.questions)
    let accepted = false
    try {
      accepted = ctx.get('userQuestions')?.answer(pending.agent, pending.callId, answer) === true
    } catch (error) {
      receipt(`提交答案失败: ${describe(error)}`)
    }
    if (accepted) {
      pendingQuestions.delete(code)
      receipt(`短码 ${code} 的询问已由邮件回答`)
      return
    }
    pendingQuestions.delete(code)
    receipt(`短码 ${code} 的询问已过期，转为普通消息`)
  }

  const controller = ctx.get('sessionController')
  if (typeof controller?.prompt !== 'function') {
    receipt('sessionController 不可用，无法回灌')
    return
  }
  try {
    await controller.prompt(
      {
        requestId: requestIdOf(messageId),
        sessionId: entry.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: settings.maxChars > 0 ? reply.slice(0, settings.maxChars) : reply }],
      },
      AbortSignal.timeout(20_000),
    )
    entry.at = Date.now()
    saveState(settings.statePath, state)
    receipt(`短码 ${code} 的消息已投递到会话 ${entry.sessionId}`)
  } catch (error) {
    receipt(`回灌失败: ${describe(error)}`)
    if (settings.failureNotify) {
      await deliver({
        subject: `[DSH:${code}] 投递失败`,
        text: `你的回复没能送进对应会话。\n\n原因：${describe(error)}\n\n会话可能已被删除或归档，可重新从主界面继续。`,
      })
    }
  }
}

/** 用邮件 Message-ID 派生幂等 requestId：同一封邮件重复拉取不会重复插入消息。 */
function requestIdOf(messageId) {
  if (!messageId) return randomUUID()
  const digest = createHash('sha1').update(messageId).digest('hex')
  return `mail:${digest.slice(0, 32)}`
}

/** 发送一封纯文本邮件。 */
async function sendMail(settings, transport, mail) {
  await transport.sendMail({
    from: settings.from || settings.smtp.user,
    to: settings.to,
    subject: mail.subject,
    text: mail.text,
  })
  receipt(`已发送: ${mail.subject}`)
}

/** 组合一条提问通知的正文，选项带序号方便回复。 */
function buildQuestionBody(code, title, questions) {
  const lines = [`agent 需要你的选择${title ? `（${title}）` : ''}`, '']
  questions.forEach((question, questionIndex) => {
    const prefix = questions.length > 1 ? `${questionIndex + 1}. ` : ''
    lines.push(`${prefix}${clean(question.question ?? '')}`)
    const options = Array.isArray(question.options) ? question.options : []
    options.forEach((option, optionIndex) => {
      const detail = option.description ? ` — ${clean(option.description)}` : ''
      lines.push(`   ${optionIndex + 1}) ${clean(option.label)}${detail}`)
    })
    lines.push('')
  })
  lines.push('回复方式：直接回复本邮件，写序号（如 2），或写你自己的答案。')
  lines.push('多个问题时每行回答一个。')
  lines.push('')
  lines.push(`--- ${QUOTE_HINT} ---`)
  lines.push(`[DSH:${code}]`)
  return lines.join('\n')
}

/** 读取或分配一个稳定短码。 */
function allocateCode(state, sessionId, title, baseLength) {
  for (const [code, entry] of Object.entries(state.codes)) {
    if (entry.sessionId === sessionId) {
      entry.title = title || entry.title
      entry.at = Date.now()
      return code
    }
  }
  const digest = createHash('sha1').update(sessionId).digest('hex')
  for (let length = baseLength; length <= baseLength + 4; length += 1) {
    const candidate = toBase36(digest, length)
    if (state.codes[candidate] === undefined) {
      state.codes[candidate] = { sessionId, title, at: Date.now() }
      return candidate
    }
  }
  const fallback = toBase36(createHash('sha1').update(`${sessionId}:${Date.now()}`).digest('hex'), baseLength + 6)
  state.codes[fallback] = { sessionId, title, at: Date.now() }
  return fallback
}

/** 把十六进制摘要折成指定长度的 base36 短串。 */
function toBase36(hex, length) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let value = BigInt(`0x${hex.slice(0, 16)}`)
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out = alphabet[Number(value % 36n)] + out
    value /= 36n
  }
  return out
}

/** 会话是否是一个顶层 agent（排除子 agent）。 */
function isRootSession(ctx, sessionId) {
  const agents = ctx.get?.('agents')
  if (agents === undefined || typeof agents?.roots !== 'function') return true
  try {
    return agents.roots().some((agent) => agent?.id === sessionId)
  } catch {
    return true
  }
}

/** 读取会话标题，失败时返回 undefined。 */
function titleOf(ctx, sessionId) {
  try {
    const sessions = ctx.get?.('sessions')
    const session = sessions?.get?.(sessionId)
    return ctx.get?.('sessionTitle')?.get?.(session)?.title
  } catch {
    return undefined
  }
}

/**
 * 解引用 volatile 配置，并丢弃空值。
 * 设置页留空的字段交给配置文件兜底，而不是覆盖成空字符串。
 * @param value - 行 config，可能是 volatile 引用。
 */
function definedConfig(value) {
  const raw = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  if (raw === null || typeof raw !== 'object') return {}
  const out = {}
  for (const [key, item] of Object.entries(raw)) {
    const resolved = item !== null && typeof item === 'object' && typeof item.get === 'function' ? item.get() : item
    if (resolved === undefined || resolved === null) continue
    if (typeof resolved === 'string' && resolved.trim().length === 0) continue
    out[key] = resolved
  }
  return out
}

/** 统一地址形态：去空白、去尖括号、去零宽字符、转小写。 */
function normalizeAddress(value) {
  return String(value ?? '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .trim()
    .replace(/^<+|>+$/g, '')
    .toLowerCase()
}

/** 合并默认值、配置文件与行 config，逐键覆盖。 */
function resolveSettings(config, ctx) {
  const directory = profileDirectory(ctx)
  const file = readJson(join(directory, 'mail-bridge.json'))
  const merged = mergeDeep(DEFAULTS, file, definedConfig(config))

  // 扁平写法优先，方便按"发信邮箱 / 授权码 / 通知邮箱 / 白名单"四项直接填。
  const flatSender = String(merged.sender ?? '').trim()
  const flatPassword = merged.password === undefined ? undefined : resolveSecret(merged.password)
  const flatTo = String(merged.notifyTo ?? merged.to ?? '').trim()
  const to = flatTo
  return {
    enabled: merged.enabled !== false,
    smtp: {
      host: String(merged.smtp?.host ?? DEFAULTS.smtp.host),
      port: Number(merged.smtp?.port ?? DEFAULTS.smtp.port),
      secure: merged.smtp?.secure !== false,
      user: flatSender || String(merged.smtp?.user ?? '').trim(),
      pass: flatPassword || resolveSecret(merged.smtp?.pass),
    },
    imap: {
      host: String(merged.imap?.host ?? DEFAULTS.imap.host),
      port: Number(merged.imap?.port ?? DEFAULTS.imap.port),
      secure: merged.imap?.secure !== false,
      user: String(merged.imap?.user ?? '').trim() || flatSender || String(merged.smtp?.user ?? '').trim(),
      pass: resolveSecret(merged.imap?.pass) || flatPassword || resolveSecret(merged.smtp?.pass),
      mailbox: String(merged.imap?.mailbox ?? DEFAULTS.imap.mailbox),
    },
    from: String(merged.from ?? '').trim(),
    to,
    whitelist: normalizeWhitelist(merged.whitelist, to),
    pollMs: Math.max(15_000, Number(merged.pollMs ?? DEFAULTS.pollMs)),
    maxChars: Math.max(0, Number(merged.maxChars ?? DEFAULTS.maxChars)),
    topLevelOnly: merged.topLevelOnly !== false,
    minIntervalMs: Math.max(0, Number(merged.minIntervalMs ?? DEFAULTS.minIntervalMs)),
    startupNotify: merged.startupNotify !== false,
    failureNotify: merged.failureNotify !== false,
    codeLength: Math.max(3, Math.min(8, Number(merged.codeLength ?? DEFAULTS.codeLength))),
    statePath: join(directory, 'mail-bridge.state.json'),
    configPath: join(directory, 'mail-bridge.json'),
  }
}

/** 支持 "env:NAME" 形式的凭证引用。 */
function resolveSecret(value) {
  const text = String(value ?? '').trim()
  if (text.startsWith('env:')) return String(process.env[text.slice(4)] ?? '').trim()
  return text
}

/**
 * 白名单可以写成字符串（逗号、分号或换行分隔）或数组。
 * @param value - 配置里的原始值。
 * @param to - 通知邮箱，白名单缺省时用它兜底。
 */
function normalizeWhitelist(value, to) {
  const list = []
  if (typeof value === 'string') {
    for (const part of value.split(/[\s,;，；、]+/)) {
      const address = normalizeAddress(part)
      if (address.length > 0) list.push(address)
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      const address = normalizeAddress(item)
      if (address.length > 0) list.push(address)
    }
  }
  if (list.length > 0) return [...new Set(list)]
  return to.length > 0 ? [normalizeAddress(to)] : []
}

/**
 * profile 目录：优先用 Host 注入的 profileContext，其次环境变量，最后用户目录。
 * 配置文件与状态文件都落在这里，不进插件包。
 * @param ctx - 插件所在的 Host 上下文。
 */
function profileDirectory(ctx) {
  try {
    const context = ctx?.get?.('profileContext')
    if (typeof context?.dir === 'string' && context.dir.length > 0) return context.dir
  } catch {
    // 服务不可用，继续回退。
  }
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function loadState(path) {
  const raw = readJson(path)
  const codes = raw.codes && typeof raw.codes === 'object' ? raw.codes : {}
  return { codes }
}

function saveState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, undefined, 2), 'utf8')
  } catch (error) {
    receipt(`状态写入失败: ${describe(error)}`)
  }
}

function mergeDeep(...sources) {
  const out = {}
  for (const source of sources) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = mergeDeep(out[key], value)
      } else {
        out[key] = value
      }
    }
  }
  return out
}

/** 单行错误描述，避免把凭证写进日志。 */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 追加一行诊断日志。 */
function receipt(line) {
  try {
    appendFileSync(join(tmpdir(), 'dsh-mail-bridge.log'), `${new Date().toISOString()} | ${line}\n`)
  } catch {
    // 日志是可选的。
  }
}
