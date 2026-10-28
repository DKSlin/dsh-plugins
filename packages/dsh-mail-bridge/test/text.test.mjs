/**
 * mail-bridge 纯函数测试：集中覆盖邮件回复的切分与答案解析。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  QUOTE_HINT,
  buildAnswer,
  extractCode,
  extractReply,
  isOwnNotification,
  lastAssistantText,
} from '../lib/text.js'

/** QQ 邮箱 App 的回复形态：新内容 + 原始邮件分隔。 */
const QQ_REPLY = [
  '把超时改成 30 秒',
  '',
  '------------------ 原始邮件 ------------------',
  '发件人: "DSH" <bot@example.com>',
  '主题: [DSH:ab12] 本轮回复完成',
  '',
  '本轮回复完成',
  '',
  `--- ${QUOTE_HINT} ---`,
  '[DSH:ab12]',
].join('\n')

/** Gmail 的英文引用形态。 */
const GMAIL_REPLY = ['continue please', '', 'On Tue, Oct 28, 2026 at 11:00 AM DSH <bot@example.com> wrote:', '> done', '[DSH:ab12]'].join(
  '\n',
)

/** 引用被折叠、只剩新内容的形态。 */
const BARE_REPLY = '继续'

test('从 QQ 邮箱引用中取出新内容', () => {
  assert.equal(extractReply(QQ_REPLY, 'ab12'), '把超时改成 30 秒')
})

test('从 Gmail 引用中取出新内容', () => {
  assert.equal(extractReply(GMAIL_REPLY, 'ab12'), 'continue please')
})

test('没有引用时保留全文', () => {
  assert.equal(extractReply(BARE_REPLY, 'ab12'), '继续')
})

test('剥离 iPhone 签名', () => {
  const body = '这轮结论我看到了。\n\n发自我的iPhone'
  assert.equal(extractReply(body, 'ab12'), '这轮结论我看到了。')
})

test('剥离英文签名与多余空行', () => {
  const body = 'looks good\n\nSent from my iPhone\n'
  assert.equal(extractReply(body, 'ab12'), 'looks good')
})

test('正文中间的相同字样不受影响', () => {
  const body = '发自我的iPhone 这个签名格式要处理一下\n还有第二行'
  assert.equal(extractReply(body, 'ab12'), '发自我的iPhone 这个签名格式要处理一下\n还有第二行')
})

test('没有短码标记时也不丢内容', () => {
  assert.equal(extractReply('改一下端口\n第二行', 'zz99'), '改一下端口\n第二行')
})

test('识别自己发出的通知原件', () => {
  const body = `本轮回复完成\n\n--- ${QUOTE_HINT} ---\n[DSH:ab12]`
  assert.equal(isOwnNotification('[DSH:ab12] 本轮回复完成', body), true)
  assert.equal(isOwnNotification('Re: [DSH:ab12] 本轮回复完成', body), false)
  assert.equal(isOwnNotification('回复：[DSH:ab12] 本轮回复完成', body), false)
})

test('提取短码，兼容中英文冒号', () => {
  assert.equal(extractCode('Re: [DSH:ab12] 完成'), 'ab12')
  assert.equal(extractCode('[DSH：Z9K2] 需要你回答'), 'z9k2')
  assert.equal(extractCode('普通主题'), undefined)
})

test('单选题用序号映射到选项标签，剩余文字作为补充', () => {
  const questions = [
    {
      id: 'q1',
      question: '选哪个',
      options: [{ label: '继续' }, { label: '停止' }],
    },
  ]
  assert.deepEqual(buildAnswer('2', questions), { answers: [{ id: 'q1', selected: ['停止'] }] })
  assert.deepEqual(buildAnswer('2 顺便改端口', questions), {
    answers: [{ id: 'q1', selected: ['停止'], custom: '顺便改端口' }],
  })
  assert.deepEqual(buildAnswer('自定义答案', questions), {
    answers: [{ id: 'q1', selected: [], custom: '自定义答案' }],
  })
})

test('多选支持多个序号', () => {
  const questions = [
    {
      id: 'q1',
      question: '选几个',
      multiSelect: true,
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    },
  ]
  assert.deepEqual(buildAnswer('1,3', questions), {
    answers: [{ id: 'q1', selected: ['A', 'C'] }],
  })
})

test('多个问题按行对应', () => {
  const questions = [
    { id: 'q1', question: '第一个', options: [{ label: '是' }, { label: '否' }] },
    { id: 'q2', question: '第二个', options: [{ label: '甲' }, { label: '乙' }] },
  ]
  assert.deepEqual(buildAnswer('1\n2', questions), {
    answers: [
      { id: 'q1', selected: ['是'] },
      { id: 'q2', selected: ['乙'] },
    ],
  })
})

test('只取 text 块，跳过推理内容', () => {
  const session = {
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '思考中' }] },
      { role: 'assistant', content: [{ type: 'text', text: '最终回复' }] },
    ],
  }
  assert.equal(lastAssistantText(session, 100), '最终回复')
})

test('没有正文时返回空串', () => {
  const session = { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }] }] }
  assert.equal(lastAssistantText(session, 100), '')
})
