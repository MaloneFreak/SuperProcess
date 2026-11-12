import { Moon, Settings, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { navigate, useSession } from '../../state/session';
import { isDark, useSettings } from '../../state/settings';
import { cx } from '../../lib/util';
import { IconButton, Logo } from './ui';

export function Header(): ReactNode {
  const { t } = useTranslation();
  const theme = useSettings((state) => state.theme);
  const update = useSettings((state) => state.update);
  const route = useSession((state) => state.route);
  const dark = isDark(theme);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
        <button type="button" onClick={() => navigate({ name: 'home' })} className="flex items-center gap-2.5 rounded-lg" aria-label={t('common.home')}>
          <Logo />
          <span className="text-[17px] font-semibold tracking-tight">SuperProcess</span>
        </button>
        <div className="flex-1" />
        <IconButton label={dark ? t('common.lightMode') : t('common.darkMode')} onClick={() => update({ theme: dark ? 'light' : 'dark' })} data-testid="theme-toggle">
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
        <IconButton
          label={t('common.settings')}
          onClick={() => navigate({ name: 'settings' })}
          className={cx(route.name === 'settings' && 'bg-panel2 text-fg')}
          data-testid="open-settings"
        >
          <Settings size={18} />
        </IconButton>
      </div>
    </header>
  );
}
