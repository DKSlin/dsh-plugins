/**
 * Browser half of dsh-mail-bridge.
 *
 * The Plugin Manager renders this as the row's own configuration page
 * (`plugins.row.config`), passing the Host-owned `form` (`state` + `mutate`).
 * The page keeps a local draft and only writes on Save; the Host persists the
 * volatile fields into the profile patch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mail-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace owned by this plugin. */
    const NS = 'mail-bridge'
    /** Key matches the bundle package name plus the row id in cordis.patch.yml. */
    const ROW_KEY = 'dsh-mail-bridge#mail-bridge'

    const zh = {
      summary: '把每轮回复和待答问题发到邮箱，回复邮件即可继续会话。',
      title: '邮箱账号',
      hint: '授权码在邮箱设置里单独生成，不是登录密码。',
      senderLabel: '发信邮箱',
      senderPlaceholder: 'bot@example.com',
      passwordLabel: '发信授权码',
      passwordPlaceholder: '留空表示沿用已保存的值',
      notifyLabel: '通知接收邮箱',
      notifyPlaceholder: 'you@example.com',
      whitelistLabel: '白名单邮箱',
      whitelistHint: '只有这些地址发来的邮件才会驱动会话，用逗号或换行分隔。',
      whitelistPlaceholder: 'you@example.com, another@example.com',
      privacy: '配置保存在本机 profile 中，不会随插件发布。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      reset: '恢复默认',
      saveFailed: '保存失败，请检查设置是否可写后重试。',
      unavailable: '当前部署没有提供这项配置。',
      loading: '正在读取配置…',
      readOnly: '当前部署的设置为只读。',
      restart: '保存后自动重启邮件通道',
    }

    const en = {
      summary: 'Emails each finished turn and every pending question; replying continues the session.',
      title: 'Mail account',
      hint: 'The authorization code is generated in your mail settings - it is not your password.',
      senderLabel: 'Sender address',
      senderPlaceholder: 'bot@example.com',
      passwordLabel: 'Authorization code',
      passwordPlaceholder: 'Leave blank to keep the saved value',
      notifyLabel: 'Notify address',
      notifyPlaceholder: 'you@example.com',
      whitelistLabel: 'Allowed senders',
      whitelistHint: 'Only mail from these addresses may drive a session. Separate with commas or newlines.',
      whitelistPlaceholder: 'you@example.com, another@example.com',
      privacy: 'Stored in this machine\u2019s profile, never in the published plugin.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      reset: 'Restore default',
      saveFailed: 'The deployment did not accept the change. Check that settings are writable and retry.',
      unavailable: 'This deployment does not expose that configuration.',
      loading: 'Reading configuration…',
      readOnly: 'This deployment stores settings read-only.',
      restart: 'Saving restarts the mail channel',
    }

    const CSS = `
.dsh-mb {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dsh-mb-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}
.dsh-mb-hint {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-mb-field { display: block; }
.dsh-mb-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  margin-bottom: 7px;
}
.dsh-mb-input {
  box-sizing: border-box;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
}
.dsh-mb-input::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-mb-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary);
}
.dsh-mb-input:disabled { opacity: .6; cursor: default; }
.dsh-mb-textarea {
  min-height: 72px;
  resize: vertical;
}
.dsh-mb-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
.dsh-mb-note {
  margin-right: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-mb-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-mb-ok {
  margin: 0;
  color: var(--dsw-alias-state-success-primary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-mb-notice {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
}
`

    function Notice({ text }) {
      return h('div', { className: 'dsh-mb' }, h('style', null, CSS), h('p', {
        className: 'dsh-mb-notice',
        role: 'status',
      }, text))
    }

    function MailBridgePage(props) {
      if (props.view === 'summary') {
        return h('span', null, props.t('summary'))
      }
      return h(MailBridgeForm, props)
    }

    function MailBridgeForm(props) {
      const { t, form } = props
      const state = form && form.state
      const value = state && state.value && typeof state.value === 'object' ? state.value : {}
      const incoming = {
        sender: typeof value.sender === 'string' ? value.sender : '',
        notifyTo: typeof value.notifyTo === 'string' ? value.notifyTo : '',
        whitelist: typeof value.whitelist === 'string' ? value.whitelist : '',
      }
      const revision = state && state.revision
      const writable = !state || state.writable !== false

      const [sender, setSender] = useState(incoming.sender)
      const [password, setPassword] = useState('')
      const [notifyTo, setNotifyTo] = useState(incoming.notifyTo)
      const [whitelist, setWhitelist] = useState(incoming.whitelist)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      // A new Host revision (our save, a reset, or another editor) replaces the draft.
      useEffect(() => {
        setSender(incoming.sender)
        setNotifyTo(incoming.notifyTo)
        setWhitelist(incoming.whitelist)
        setPassword('')
        setError('')
      }, [revision])

      const dirty =
        sender !== incoming.sender ||
        notifyTo !== incoming.notifyTo ||
        whitelist !== incoming.whitelist ||
        password.length > 0

      const run = async (ops) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          if (!form || typeof form.mutate !== 'function') throw new Error(t('unavailable'))
          const accepted = await form.mutate(ops, revision)
          if (accepted) setNotice(t('saved'))
          else setError(t('saveFailed'))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const save = () => {
        if (!writable || busy) return
        const ops = [
          { op: 'set', path: ['sender'], value: sender.trim() },
          { op: 'set', path: ['notifyTo'], value: notifyTo.trim() },
          { op: 'set', path: ['whitelist'], value: whitelist.trim() },
        ]
        // 留空表示"保持原授权码"，避免把已保存的密钥覆盖成空串。
        if (password.length > 0) ops.push({ op: 'set', path: ['password'], value: password.trim() })
        run(ops)
      }

      const reset = () => {
        if (!writable || busy) return
        run([
          { op: 'unset', path: ['sender'] },
          { op: 'unset', path: ['password'] },
          { op: 'unset', path: ['notifyTo'] },
          { op: 'unset', path: ['whitelist'] },
        ])
      }

      if (!form) return h(Notice, { text: t('unavailable') })
      if (state && state.status === 'loading') return h(Notice, { text: t('loading') })
      if (state && (state.status === 'unavailable' || state.value === undefined)) {
        return h(Notice, { text: t('unavailable') })
      }

      const field = (label, element, hint) =>
        h('label', { className: 'dsh-mb-field' },
          h('span', { className: 'dsh-mb-label' }, label),
          element,
          hint ? h('div', { className: 'dsh-mb-hint' }, hint) : null,
        )

      return h('div', { className: 'dsh-mb' },
        h('style', null, CSS),
        h('div', null,
          h('div', { className: 'dsh-mb-title' }, t('title')),
          h('div', { className: 'dsh-mb-hint' }, t('hint')),
        ),
        field(t('senderLabel'), h('input', {
          className: 'dsh-mb-input',
          type: 'email',
          value: sender,
          spellCheck: false,
          autoComplete: 'off',
          disabled: !writable || busy,
          placeholder: t('senderPlaceholder'),
          onChange: (event) => {
            setSender(event.currentTarget.value)
            setError('')
            setNotice('')
          },
        })),
        field(t('passwordLabel'), h('input', {
          className: 'dsh-mb-input',
          type: 'password',
          value: password,
          spellCheck: false,
          autoComplete: 'new-password',
          disabled: !writable || busy,
          placeholder: t('passwordPlaceholder'),
          onChange: (event) => {
            setPassword(event.currentTarget.value)
            setError('')
            setNotice('')
          },
        }), t('privacy')),
        field(t('notifyLabel'), h('input', {
          className: 'dsh-mb-input',
          type: 'email',
          value: notifyTo,
          spellCheck: false,
          autoComplete: 'off',
          disabled: !writable || busy,
          placeholder: t('notifyPlaceholder'),
          onChange: (event) => {
            setNotifyTo(event.currentTarget.value)
            setError('')
            setNotice('')
          },
        })),
        field(t('whitelistLabel'), h('textarea', {
          className: 'dsh-mb-input dsh-mb-textarea',
          value: whitelist,
          rows: 3,
          spellCheck: false,
          disabled: !writable || busy,
          placeholder: t('whitelistPlaceholder'),
          onChange: (event) => {
            setWhitelist(event.currentTarget.value)
            setError('')
            setNotice('')
          },
        }), t('whitelistHint')),
        error ? h('p', { className: 'dsh-mb-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'dsh-mb-ok', role: 'status' }, notice) : null,
        h('div', { className: 'dsh-mb-actions' },
          h('span', { className: 'dsh-mb-note' }, writable ? t('restart') : t('readOnly')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: !writable || busy,
            onClick: reset,
          }, t('reset')),
          h(Button, {
            variant: 'primary',
            size: 'sm',
            disabled: !writable || busy || !dirty,
            onClick: save,
          }, busy ? t('saving') : t('save')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          locale: NS,
        }, MailBridgePage))
      },
    }
  },
})
