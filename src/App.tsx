import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Header } from './ui/components/Header';
import { HomePage } from './ui/pages/Home';
import { ResultPage } from './ui/pages/Result';
import { SettingsPage } from './ui/pages/SettingsPage';
import { SetupPage } from './ui/pages/Setup';
import { WorkingPage } from './ui/pages/Working';
import { navigate, parseRoute, refreshHistory, useSession } from './state/session';
import { isDark, useSettings } from './state/settings';
import { cx } from './lib/util';

export function App(): ReactNode {
  const { i18n } = useTranslation();
  const route = useSession((state) => state.route);
  const work = useSession((state) => state.work);
  const toasts = useSession((state) => state.toasts);
  const theme = useSettings((state) => state.theme);
  const language = useSettings((state) => state.uiLanguage);
  const onboarded = useSettings((state) => state.onboarded);

  // Theme: follow the setting, and the system when it says "system".
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.classList.toggle('dark', isDark(theme));
    };
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
    document.documentElement.lang = language;
  }, [i18n, language]);

  useEffect(() => {
    const onHash = (): void => useSession.setState({ route: parseRoute(location.hash) });
    addEventListener('hashchange', onHash);
    void refreshHistory();
    return () => removeEventListener('hashchange', onHash);
  }, []);

  // First run goes through the setup; a reload in the middle of an analysis goes home.
  useEffect(() => {
    if (!onboarded && route.name !== 'setup') navigate({ name: 'setup' });
    else if (route.name === 'working' && !work) navigate({ name: 'home' });
  }, [onboarded, route.name, work]);

  const setup = route.name === 'setup' || !onboarded;
  return (
    <div className="flex min-h-full flex-col">
      {!setup && <Header />}
      <main className="flex-1">
        {setup ? (
          <SetupPage />
        ) : route.name === 'settings' ? (
          <SettingsPage />
        ) : route.name === 'working' ? (
          <WorkingPage />
        ) : route.name === 'analysis' ? (
          <ResultPage id={route.id} />
        ) : (
          <HomePage />
        )}
      </main>
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cx(
              'pointer-events-auto max-w-[min(92vw,560px)] animate-rise rounded-xl border px-4 py-2.5 text-[13.5px] font-medium shadow-pop',
              item.tone === 'error' ? 'border-bad/30 bg-bad-soft text-fg' : 'border-line bg-panel text-fg',
            )}
            data-testid="toast"
          >
            {item.text}
          </div>
        ))}
      </div>
    </div>
  );
}
