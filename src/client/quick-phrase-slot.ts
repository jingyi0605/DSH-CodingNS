import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { CodingNsSettings, QuickPhrase } from '../shared/contracts/config.js'
import type { CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import { useCodingNsTranslator, type CodingNsLocale } from './locale.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'

type QuickPhraseSlotProps = PropsRuntime<'conversation.input.overlay'> & {
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly locale: CodingNsLocale
}

/** 在输入框右侧覆盖层挂载插件自己的快捷会话入口。 */
export function registerQuickPhraseSlot(
  slots: SlotRegistry,
  settings: CodingNsSettingsStore<CodingNsSettings>,
  locale: CodingNsLocale,
): () => void {
  const t = locale.bind('codingns')
  return slots.inject('conversation.input.overlay', () => slots.register({
    name: 'conversation.input.overlay',
    id: 'codingns4dsh-quick-phrases',
    order: 0,
    label: t('workspace.quickPhrasesTrigger'),
    inject: () => ({ settings, locale }),
  }, QuickPhraseSlot))
}

function QuickPhraseSlot(props: QuickPhraseSlotProps): ReactElement | null {
  const t = useCodingNsTranslator(props.locale)
  const draft = props.useInput((value: InputState) => value.draft)
  const [phrases, setPhrases] = useState<readonly QuickPhrase[]>(() => readQuickPhrases(props.settings))
  const [open, setOpen] = useState(false)
  const [newPhrase, setNewPhrase] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    const sync = (): void => setPhrases(readQuickPhrases(props.settings))
    sync()
    return props.settings.subscribe(sync)
  }, [props.settings])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [open])

  const persistPhrases = (next: readonly QuickPhrase[]): void => {
    setPhrases(next)
    setSaving(true)
    void props.settings.mutate([{
      op: 'set',
      path: ['workspaceSessionEnhancement', 'quickPhrases'],
      value: next,
    }]).then(() => setSaveError(false)).catch(() => setSaveError(true)).finally(() => setSaving(false))
  }

  const addPhrase = (): void => {
    const text = newPhrase.trim()
    if (text === '' || saving) return
    const id = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `quick-${Date.now()}-${Math.random().toString(36).slice(2)}`
    persistPhrases([...phrases, { id, text }])
    setNewPhrase('')
  }

  const removePhrase = (id: string): void => {
    if (!saving) persistPhrases(phrases.filter((phrase) => phrase.id !== id))
  }

  const movePhrase = (fromId: string, toId: string): void => {
    if (fromId === toId || saving) return
    const from = phrases.findIndex((phrase) => phrase.id === fromId)
    const to = phrases.findIndex((phrase) => phrase.id === toId)
    if (from < 0 || to < 0) return
    const next = [...phrases]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    persistPhrases(next)
  }

  const enabled = props.settings.getSnapshot().value?.workspaceSessionEnhancement?.showQuickPhrases
    ?? true
  if (!enabled || draft.length > 0) {
    return null
  }

  return createElement('div', { style: quickPhraseRootStyle },
    createElement('button', {
      type: 'button',
      'aria-label': t('workspace.quickPhrasesTrigger'),
      title: t('workspace.quickPhrasesTrigger'),
      'aria-haspopup': 'dialog',
      'aria-expanded': open,
      onClick: () => setOpen((value) => !value),
      style: quickPhraseTriggerStyle,
    }, createElement('svg', {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      'aria-hidden': true,
    },
      createElement('path', { d: 'M7 8h10' }),
      createElement('path', { d: 'M7 12h8' }),
      createElement('path', { d: 'M7 16h5' }),
      createElement('path', { d: 'M5 5h14v14H9l-4 4V5z' }),
    )),
    open && createElement('div', {
      role: 'dialog',
      'aria-label': t('workspace.quickPhrasesDialogLabel'),
      'aria-modal': true,
      style: quickPhraseOverlayStyle,
      onPointerDown: () => setOpen(false),
    }, createElement('div', {
      style: quickPhraseDialogStyle,
      onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    },
      createElement('div', { style: quickPhraseHeaderStyle },
        createElement('div', { style: { minWidth: 0 } },
          createElement('strong', { style: quickPhraseTitleStyle }, t('workspace.quickPhrasesTitle')),
          createElement('p', { style: quickPhraseHintStyle }, t('workspace.quickPhrasesHint')),
        ),
        createElement('button', {
          type: 'button',
          'aria-label': t('workspace.quickPhrasesClose'),
          title: t('workspace.quickPhrasesClose'),
          onClick: () => setOpen(false),
          style: quickPhraseCloseStyle,
        }, '×'),
      ),
      createElement('div', { style: quickPhraseAddRowStyle },
        createElement('input', {
          type: 'text',
          value: newPhrase,
          disabled: saving,
          placeholder: t('workspace.quickPhrasesPlaceholder'),
          onChange: (event: { currentTarget: { value: string } }) => setNewPhrase(event.currentTarget.value),
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addPhrase()
            }
          },
          style: quickPhraseAddInputStyle,
        }),
        createElement('button', {
          type: 'button',
          disabled: saving || newPhrase.trim() === '',
          onClick: addPhrase,
          style: quickPhraseAddButtonStyle,
        }, t('workspace.quickPhrasesAdd')),
      ),
      saveError && createElement('div', { role: 'alert', style: quickPhraseSaveErrorStyle }, t('workspace.quickPhrasesSaveFailed')),
      phrases.length === 0
        ? createElement('div', { role: 'status', style: quickPhraseEmptyStyle }, t('workspace.quickPhrasesEmpty'))
        : createElement('div', { style: quickPhraseListStyle }, ...phrases.map((phrase) => createElement('div', {
          key: phrase.id,
          draggable: !saving,
          onDragStart: () => setDraggingId(phrase.id),
          onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
          onDrop: () => {
            if (draggingId !== null) movePhrase(draggingId, phrase.id)
            setDraggingId(null)
          },
          onDragEnd: () => setDraggingId(null),
          style: { ...quickPhraseItemStyle, ...(draggingId === phrase.id ? quickPhraseDraggingStyle : {}) },
        },
          createElement('button', {
            type: 'button',
            onClick: () => {
              props.inputActions.setDraft(phrase.text)
              setOpen(false)
            },
            style: quickPhraseTextButtonStyle,
          }, phrase.text),
          createElement('span', { role: 'img', 'aria-label': t('workspace.quickPhrasesDrag'), title: t('workspace.quickPhrasesDrag'), style: quickPhraseDragHandleStyle }, '⋮⋮'),
          createElement('button', {
            type: 'button',
            disabled: saving,
            'aria-label': t('workspace.quickPhrasesDelete'),
            title: t('workspace.quickPhrasesDelete'),
            onClick: () => removePhrase(phrase.id),
            style: quickPhraseDeleteStyle,
          }, '×'),
        )),
      ),
    )),
  )
}

function readQuickPhrases(settings: CodingNsSettingsStore<CodingNsSettings>): readonly QuickPhrase[] {
  const value = settings.getSnapshot().value?.workspaceSessionEnhancement?.quickPhrases
  if (!Array.isArray(value)) return []
  return value.filter((phrase): phrase is QuickPhrase => (
    typeof phrase?.id === 'string' && phrase.id.length > 0
    && typeof phrase.text === 'string' && phrase.text.length > 0
  ))
}

const quickPhraseRootStyle = {
  position: 'absolute' as const,
  top: '50%',
  right: 68,
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  transform: 'translateY(-50%)',
}
const quickPhraseTriggerStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  padding: 0,
  border: 0,
  borderRadius: 8,
  color: dshThemeColor.labelSecondary,
  background: 'transparent',
  cursor: 'pointer',
}
const quickPhraseOverlayStyle = {
  position: 'fixed' as const,
  inset: 0,
  zIndex: 1400,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  background: dshThemeColor.overlay,
}
const quickPhraseDialogStyle = {
  ...dshPopupSurfaceStyle,
  width: 'min(100%, 720px)',
  maxHeight: 'min(720px, 90vh)',
  overflow: 'auto' as const,
  boxSizing: 'border-box' as const,
  padding: 24,
  borderRadius: 12,
}
const quickPhraseHeaderStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, paddingBottom: 16, borderBottom: `1px solid ${dshThemeColor.border}` }
const quickPhraseTitleStyle = { display: 'block', color: dshThemeColor.labelPrimary, fontSize: 20, lineHeight: 1.3 }
const quickPhraseHintStyle = { margin: '6px 0 0', color: dshThemeColor.labelSecondary, fontSize: 13, lineHeight: 1.5 }
const quickPhraseCloseStyle = { width: 32, height: 32, flex: '0 0 auto', border: 0, borderRadius: 16, color: dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, fontSize: 24, lineHeight: 1, cursor: 'pointer' }
const quickPhraseAddRowStyle = { display: 'flex', gap: 8, paddingTop: 16 }
const quickPhraseAddInputStyle = { flex: '1 1 auto', minWidth: 0, minHeight: 36, boxSizing: 'border-box' as const, padding: '8px 10px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, color: dshThemeColor.labelPrimary, background: dshThemeColor.inputBackground, fontSize: 13 }
const quickPhraseAddButtonStyle = { flex: '0 0 auto', minHeight: 36, padding: '8px 14px', border: 0, borderRadius: 8, color: dshThemeColor.switchThumb, background: dshThemeColor.accent, fontSize: 13, cursor: 'pointer' }
const quickPhraseListStyle = { display: 'flex', flexDirection: 'column' as const, gap: 8, paddingTop: 16 }
const quickPhraseItemStyle = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 48, padding: '7px 8px 7px 14px', boxSizing: 'border-box' as const, border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, color: dshThemeColor.labelPrimary, background: dshThemeColor.surfaceSubtle }
const quickPhraseDraggingStyle = { opacity: 0.55, borderColor: dshThemeColor.accent }
const quickPhraseTextButtonStyle = { flex: '1 1 auto', minWidth: 0, padding: 0, border: 0, color: dshThemeColor.labelPrimary, background: 'transparent', textAlign: 'left' as const, fontSize: 13, lineHeight: 1.5, cursor: 'pointer', overflowWrap: 'anywhere' as const }
const quickPhraseDragHandleStyle = { flex: '0 0 24px', color: dshThemeColor.labelTertiary, textAlign: 'center' as const, fontSize: 18, lineHeight: 1, cursor: 'grab', userSelect: 'none' as const }
const quickPhraseDeleteStyle = { width: 30, height: 30, flex: '0 0 30px', padding: 0, border: 0, borderRadius: 8, color: dshThemeColor.error, background: 'transparent', fontSize: 20, lineHeight: 1, cursor: 'pointer' }
const quickPhraseSaveErrorStyle = { color: dshThemeColor.error, fontSize: 12, lineHeight: 1.4 }
const quickPhraseEmptyStyle = { padding: '28px 0 10px', color: dshThemeColor.labelSecondary, textAlign: 'center' as const, fontSize: 13 }
