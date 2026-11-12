import i18n, { type TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import es from './locales/es.json';
import ptBR from './locales/pt-BR.json';

export const resources = {
  en: { translation: en },
  'pt-BR': { translation: ptBR },
  es: { translation: es },
} as const;

export function initI18n(language: string): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources,
      lng: language,
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  }
  return i18n;
}

/** The interface locale closest to a BCP-47 code ("pt-PT" → "pt-BR", "fr" → "en"). */
export function closestLocale(code: string): keyof typeof resources {
  const lower = code.toLowerCase();
  if (lower.startsWith('pt')) return 'pt-BR';
  if (lower.startsWith('es')) return 'es';
  return 'en';
}

/**
 * A translator fixed to the language of a document (a report can be written
 * in a language other than the interface language).
 */
export function translatorFor(language: string): TFunction {
  return i18n.getFixedT(closestLocale(language));
}

export default i18n;
