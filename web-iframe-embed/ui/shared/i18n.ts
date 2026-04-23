import enLocale from '../../src/locales/en.json';
import zhLocale from '../../src/locales/zh.json';

type LocaleMessages = Record<string, string>;

const MESSAGES: Record<string, LocaleMessages> = {
  en: enLocale,
  zh: zhLocale,
};

function getCurrentLanguage(): string {
  if (typeof window === 'undefined') {
    return 'en';
  }

  const locale = new URLSearchParams(window.location.search).get('_locale') ?? 'en';
  const normalized = locale.toLowerCase();
  return normalized.startsWith('zh') ? 'zh' : 'en';
}

export function t(key: string, fallback?: string, values?: Record<string, string | number>): string {
  const language = getCurrentLanguage();
  const template = MESSAGES[language]?.[key] ?? MESSAGES.en?.[key] ?? fallback ?? key;

  if (!values) {
    return template;
  }

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token: string) => {
    const value = values[token];
    return value === undefined ? match : String(value);
  });
}
