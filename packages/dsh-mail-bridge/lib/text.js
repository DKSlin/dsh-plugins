/**
 * mail-bridge 的纯文本工具：邮件正文的分割、短码提取、答案解析。
 * 不依赖任何第三方包，便于单独测试。
 *
 * @module dsh-mail-bridge/text
 */

/** 通知正文里的引用分隔提示，回复侧用它判断是否为自己发出的通知。 */
export const QUOTE_HINT = '以下为原始通知，回复时无需删除'

/**
 * 从正文里取出用户新写的内容。
 * 先按短码标记截断，再去掉引用与签名，避免手机客户端把原文当成指令。
 * @param body - 收到的邮件纯文本正文。
 * @param code - 该邮件的短码。
 * @returns 去掉引用后的回复正文，可能为空串。
 */
export function extractReply(body, code) {
  const marker = new RegExp(`\\[\\s*DSH\\s*[:：]\\s*${code}\\s*\\]`, 'i')
  const index = body.search(marker)
  const head = index >= 0 ? body.slice(0, index) : body
  return stripSignature(stripQuoted(head)).trim()
}

/** 常见手机客户端签名行。 */
const SIGNATURE_LINE = /^(发自我的|发自 ?iPhone|发自 ?iPad|发送自我的|sent from my|sent from mail for|get outlook for|sent via)/i

/**
 * 去掉正文末尾的手机签名，最多连续三行。
 * 只处理末尾，避免误伤正文中间的相同字样。
 * @param text - 已去掉引用块的正文。
 */
export function stripSignature(text) {
  const lines = String(text).split(/\r?\n/)
  let removed = 0
  while (lines.length > 0 && removed < 3) {
    const last = lines[lines.length - 1].trim()
    if (last === '') {
      lines.pop()
      continue
    }
    if (SIGNATURE_LINE.test(last)) {
      lines.pop()
      removed += 1
      continue
    }
    break
  }
  return lines.join('\n')
}

/**
 * 逐行丢弃引用块与签名。
 * 各家客户端的分隔形态不同，这里只保留第一段未引用内容。
 * @param text - 原始正文。
 */
export function stripQuoted(text) {
  const kept = []
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*>/.test(line)) break
    if (/^\s*-{2,}\s*$/.test(line)) break
    if (/原始邮件|Original Message|Forwarded message|转发邮件/i.test(line)) break
    if (/^\s*(在|On)\s.{0,80}(写道|wrote)\s*[:：]?\s*$/i.test(line)) break
    if (/^\s*(发件人|From)\s*[:：]/i.test(line)) break
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * 判断这封邮件是不是我们自己发出的通知原件。
 * 通知没有 Re 前缀，且正文含引用提示。
 * @param subject - 邮件主题。
 * @param body - 邮件正文。
 */
export function isOwnNotification(subject, body) {
  if (/^\s*(re|回复|答复|aw|sv)\s*[:：]/i.test(subject)) return false
  return String(body).includes(QUOTE_HINT)
}

/**
 * 从主题或正文提取短码。
 * @param text - 主题或正文。
 * @returns 小写短码，未找到时返回 undefined。
 */
export function extractCode(text) {
  const match = /\[\s*DSH\s*[:：]\s*([0-9a-z]{3,10})\s*\]/i.exec(String(text ?? ''))
  return match ? match[1].toLowerCase() : undefined
}

/**
 * 把一段回复解析成结构化答案。
 * 单问题直接用整段；多问题时每行对应一个问题。
 * @param reply - 用户回复的正文。
 * @param questions - 待答问题列表。
 */
export function buildAnswer(reply, questions) {
  const lines = String(reply)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const answers = []
  if (questions.length === 1) {
    answers.push(answerItem(questions[0], reply))
  } else if (lines.length >= questions.length) {
    questions.forEach((question, index) => answers.push(answerItem(question, lines[index])))
  } else {
    questions.forEach((question, index) => answers.push(answerItem(question, index === 0 ? reply : '')))
  }
  return { answers }
}

/**
 * 单个问题的答案：序号映射到选项标签，剩余文字作为补充说明。
 * @param question - 一个问题定义。
 * @param raw - 该问题对应的回复片段。
 */
export function answerItem(question, raw) {
  const text = String(raw ?? '').trim()
  const id = question?.id ?? ''
  const options = Array.isArray(question?.options) ? question.options : []
  if (options.length === 0) {
    return { id, selected: [], ...(text.length > 0 ? { custom: text } : {}) }
  }
  const limit = question.multiSelect === true ? options.length : 1
  const parts = text.split(/[\s,，;；、]+/).filter((part) => part.length > 0)
  const selected = []
  let consumed = 0
  for (const part of parts) {
    if (selected.length >= limit) break
    if (!/^\d+$/.test(part)) break
    const index = Number(part) - 1
    if (index < 0 || index >= options.length) break
    selected.push(clean(options[index].label))
    consumed += 1
  }
  if (selected.length === 0) {
    return { id, selected: [], ...(text.length > 0 ? { custom: text } : {}) }
  }
  const remainder = parts.slice(consumed).join(' ').trim()
  return { id, selected, ...(remainder.length > 0 ? { custom: remainder } : {}) }
}

/**
 * 取会话里最后一条 assistant 消息的 text 块，不含推理内容。
 * @param session - 会话对象，需提供 deriveMessages()。
 * @param maxChars - 最大字符数。
 */
export function lastAssistantText(session, maxChars) {
  let messages
  try {
    messages = session?.deriveMessages?.() ?? []
  } catch {
    return ''
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n\n')
      .trim()
    if (text.length > 0) return maxChars > 0 ? truncate(text, maxChars) : text
  }
  return ''
}

/** 去掉多余空白与控制字符。 */
export function clean(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把 HTML 正文粗略转成纯文本。 */
export function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

/** 按码点截断，避免切断代理对。 */
export function truncate(value, max) {
  const chars = [...value]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value
}
