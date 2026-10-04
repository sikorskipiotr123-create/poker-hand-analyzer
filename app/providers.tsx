'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translate, type AppLanguage, type Translate, type TranslationKey, formatNumber, DEFAULT_APP_LANGUAGE, LANGUAGE_STORAGE_KEY, readStoredLanguage } from '../lib/i18n';

type LanguageContextValue = { language: AppLanguage; setLanguage: (language: AppLanguage) => void; t: Translate; number: (value: number, digits?: number) => string };
const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(DEFAULT_APP_LANGUAGE);
  useEffect(() => {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    setLanguageState(readStoredLanguage(stored));
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const setLanguage = useCallback((next: AppLanguage) => {
    setLanguageState(next);
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  }, []);
  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t: (key: TranslationKey, values?: Record<string, string | number>) => translate(language, key, values),
    number: (number: number, digits?: number) => formatNumber(language, number, digits),
  }), [language, setLanguage]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage must be used inside LanguageProvider.');
  return value;
}
