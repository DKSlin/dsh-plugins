/**
 * Browser half of dsh-system-prefix.
 *
 * The Plugin Manager page renders this as the row's own configuration page
 * (`plugins.row.config`), passing the Host-owned `form` (`state` + `mutate`).
 * The page keeps a local draft and only writes on Save; the Host persists the
 * volatile fields into the profile patch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-system-prefix',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace owned by this plugin. */
    const NS = 'system-prompt-prefix'
    /** Key matches the bundle package name plus the row id in cordis.patch.yml. */
    const ROW_KEY = 'dsh-system-prefix#system-prompt-prefix'

    const zh = {
      summary: '在系统提示词最顶部插入一句可配置的话。',
      enabledLabel: '启用置顶句',
      enabledHint: '开启后，新会话的系统提示词第一段就是下面这句话。',
      on: '已开启',
      off: '已关闭',
      textLabel: '插入的句子',
      textHint: '仅对之后新建的顶层会话生效；已有会话保持创建时的内容。',
      placeholder: '输入要放在系统提示词最顶部的话',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      reset: '恢复默认',
      saveFailed: '保存失败，请检查设置是否可写后重试。',
      unavailable: '当前部署没有提供这项配置。',
      loading: '正在读取配置…',
      readOnly: '当前部署的设置为只读。',
      applies: '仅影响之后新建的顶层会话',
    }

    const en = {
      summary: 'Prepend one configurable sentence to the system prompt.',
      enabledLabel: 'Enable the top sentence',
      enabledHint: 'When enabled, every new session starts with the sentence below.',
      on: 'On',
      off: 'Off',
      textLabel: 'Sentence',
      textHint: 'Applies to new top-level sessions only; existing sessions keep what they started with.',
      placeholder: 'Write the sentence to place at the very top of the system prompt',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      reset: 'Restore default',
      saveFailed: 'The deployment did not accept the change. Check that settings are writable and retry.',
      unavailable: 'This deployment does not expose that configuration.',
      loading: 'Reading configuration…',
      readOnly: 'This deployment stores settings read-only.',
      applies: 'Affects new top-level sessions only',
    }

    const CSS = `
.dsh-spp {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dsh-spp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}
.dsh-spp-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}
.dsh-spp-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  margin-bottom: 7px;
}
.dsh-spp-hint {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-spp-field { display: block; }
.dsh-spp-textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 152px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.65;
}
.dsh-spp-textarea::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-spp-textarea:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary);
}
.dsh-spp-textarea:disabled { opacity: .6; cursor: default; }
.dsh-spp-switch {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-spp-switch:disabled { opacity: .5; cursor: default; }
.dsh-spp-track {
  position: relative;
  width: 36px;
  height: 20px;
  flex: none;
  border-radius: 10px;
  background: var(--dsw-alias-border-l2);
  transition: background .15s ease;
}
.dsh-spp-track[data-on="true"] { background: var(--dsw-alias-brand-primary); }
.dsh-spp-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
  transition: transform .15s ease;
}
.dsh-spp-track[data-on="true"] .dsh-spp-thumb { transform: translateX(16px); }
.dsh-spp-switchLabel { color: var(--dsw-alias-label-secondary); }
.dsh-spp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
.dsh-spp-note {
  margin-right: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dsh-spp-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-spp-ok {
  margin: 0;
  color: var(--dsw-alias-state-success-primary);
  font-size: 12px;
  line-height: 1.55;
}
.dsh-spp-notice {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
}
`

    function Notice({ text }) {
      return h('div', { className: 'dsh-spp' }, h('style', null, CSS), h('p', {
        className: 'dsh-spp-notice',
        role: 'status',
      }, text))
    }

    function PrefixPage(props) {
      if (props.view === 'summary') {
        return h('span', null, props.t('summary'))
      }
      return h(PrefixForm, props)
    }

    function PrefixForm(props) {
      const { t, form } = props
      const state = form && form.state
      const value = state && state.value && typeof state.value === 'object' ? state.value : {}
      const incomingText = typeof value.text === 'string' ? value.text : ''
      const incomingEnabled = value.enabled !== false
      const revision = state && state.revision
      const writable = !state || state.writable !== false

      const [text, setText] = useState(incomingText)
      const [enabled, setEnabled] = useState(incomingEnabled)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      // A new Host revision (our save, a reset, or another editor) replaces the draft.
      useEffect(() => {
        setText(incomingText)
        setEnabled(incomingEnabled)
        setError('')
      }, [revision])

      const dirty = text !== incomingText || enabled !== incomingEnabled

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
        run([
          { op: 'set', path: ['text'], value: text },
          { op: 'set', path: ['enabled'], value: enabled },
        ])
      }

      const reset = () => {
        if (!writable || busy) return
        run([{ op: 'unset', path: ['text'] }])
      }

      if (!form) return h(Notice, { text: t('unavailable') })
      if (state && state.status === 'loading') return h(Notice, { text: t('loading') })
      if (state && (state.status === 'unavailable' || state.value === undefined)) {
        return h(Notice, { text: t('unavailable') })
      }

      return h('div', { className: 'dsh-spp' },
        h('style', null, CSS),
        h('div', { className: 'dsh-spp-head' },
          h('div', null,
            h('div', { className: 'dsh-spp-title' }, t('enabledLabel')),
            h('div', { className: 'dsh-spp-hint' }, t('enabledHint')),
          ),
          h('button', {
            type: 'button',
            role: 'switch',
            className: 'dsh-spp-switch',
            'aria-checked': enabled,
            disabled: !writable || busy,
            onClick: () => {
              setEnabled((current) => !current)
              setError('')
              setNotice('')
            },
          },
            h('span', { className: 'dsh-spp-track', 'data-on': String(enabled) },
              h('span', { className: 'dsh-spp-thumb' }),
            ),
            h('span', { className: 'dsh-spp-switchLabel' }, t(enabled ? 'on' : 'off')),
          ),
        ),
        h('label', { className: 'dsh-spp-field' },
          h('span', { className: 'dsh-spp-label' }, t('textLabel')),
          h('textarea', {
            className: 'dsh-spp-textarea',
            value: text,
            rows: 7,
            spellCheck: false,
            disabled: !writable || busy,
            placeholder: t('placeholder'),
            onChange: (event) => {
              setText(event.currentTarget.value)
              setError('')
              setNotice('')
            },
          }),
        ),
        h('div', { className: 'dsh-spp-hint' }, t('textHint')),
        error ? h('p', { className: 'dsh-spp-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'dsh-spp-ok', role: 'status' }, notice) : null,
        h('div', { className: 'dsh-spp-actions' },
          h('span', { className: 'dsh-spp-note' }, writable ? t('applies') : t('readOnly')),
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
        }, PrefixPage))
      },
    }
  },
})
