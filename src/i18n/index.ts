// 언어 결정과 메시지 번역. 사람에게 보이는 CLI 문구는 전부 en.json / ko.json 한 곳에 모은다.
// 우선순위: --lang > VEC0KIT_LANG > LC_ALL > LC_MESSAGES > LANG, 한국어(ko…)가 아니면 영어.
import en from "./en.json" with { type: "json" };
import ko from "./ko.json" with { type: "json" };

export type Lang = "en" | "ko";
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export const MESSAGES: Record<Lang, Record<string, string>> = { en, ko };

/** 환경 변수 값 하나를 언어로: "ko", "ko_KR.UTF-8", "ko-KR" → ko, 나머지 → en */
function fromLocale(value: string): Lang {
  return /^ko([_\-.@]|$)/i.test(value.trim()) ? "ko" : "en";
}

/**
 * CLI 언어 결정. cliLang 은 --lang 값(검증은 호출하는 쪽에서 en|ko 로 한다).
 * POSIX 와 같이 LC_ALL > LC_MESSAGES > LANG 에서 처음 비어 있지 않은 값을 쓴다.
 */
export function resolveLang(cliLang: string | undefined, env: NodeJS.ProcessEnv = process.env): Lang {
  if (cliLang) return fromLocale(cliLang);
  for (const name of ["VEC0KIT_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = env[name];
    if (value && value.trim() !== "") return fromLocale(value);
  }
  return "en";
}

/** {name} 자리에 값을 넣는다. 키가 없으면 영어, 그것도 없으면 키 자체(테스트가 두 언어 키 집합이 같은지 확인한다). */
export function createTranslator(lang: Lang): Translate {
  const table = MESSAGES[lang];
  return (key, params = {}) => {
    const template = table[key] ?? MESSAGES.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
  };
}

export function hasMessage(key: string): boolean {
  return key in MESSAGES.en;
}
