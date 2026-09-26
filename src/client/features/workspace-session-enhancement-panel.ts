import { createElement } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD,
  DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import {
  dshFormRootStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/** 工作区会话增强的单列设置面板。 */
export function WorkspaceSessionEnhancementPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = snapshot.value?.workspaceSessionEnhancement
    ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const updateSetting = (field: 'showAdapterLogo' | 'showArchivedSessions' | 'showSubscriptionUsage' | 'showQuickPhrases', nextValue: boolean): void => {
    void services.settings.mutate([{
      op: 'set',
      path: [CODINGNS_WORKSPACE_SESSION_ENHANCEMENT_FIELD, field],
      value: nextValue,
    }]).then(() => notify({ kind: 'success', message: '工作区会话设置已保存' })).catch((cause: unknown) => {
      notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  return createElement('div', {
    'aria-disabled': disabled,
    style: {
      ...dshFormRootStyle,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      opacity: disabled ? 0.5 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
    },
  },
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showLogo')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.logoDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showLogo'),
        checked: value.showAdapterLogo,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showAdapterLogo', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showSubscriptionUsage')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.subscriptionUsageDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showSubscriptionUsage'),
        checked: value.showSubscriptionUsage,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showSubscriptionUsage', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showArchivedSessions')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.archivedSessionsDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showArchivedSessions'),
        checked: value.showArchivedSessions,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showArchivedSessions', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
    createElement('label', {
      style: dshSettingsListRowStyle,
    },
      createElement('span', { style: { minWidth: 0 } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('workspace.showQuickPhrases')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, t('workspace.quickPhrasesDescription')),
      ),
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': t('workspace.showQuickPhrases'),
        checked: value.showQuickPhrases,
        disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => updateSetting('showQuickPhrases', event.currentTarget.checked),
        style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
      }),
    ),
  )
}
