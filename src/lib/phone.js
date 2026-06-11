import { parsePhoneNumberFromString, AsYouType, isValidPhoneNumber } from 'libphonenumber-js';

const DEFAULT_COUNTRY = 'BR';

/**
 * Normaliza um telefone para E.164 (`+5548996048041`).
 * Retorna null se inválido ou vazio.
 * Aceita entrada com formatação livre: `(48) 99604-8041`, `48996048041`,
 * `+55 48 99604 8041`, etc. Numeros sem `+` e sem código de país são
 * interpretados com `defaultCountry`.
 */
export function normalizePhone(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const parsed = parsePhoneNumberFromString(str, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // formato E.164 — sempre inicia com '+'
}

/**
 * Valida um telefone (em qualquer formato).
 */
export function isValidPhone(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (!raw) return false;
  try {
    return isValidPhoneNumber(String(raw).trim(), defaultCountry);
  } catch {
    return false;
  }
}

/**
 * Formata um telefone para exibição.
 * - Mesmo país do default: formato nacional `(48) 99604-8041`
 * - País diferente: formato internacional `+1 415 555 2671`
 */
export function formatPhoneDisplay(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (!raw) return '';
  const parsed = parsePhoneNumberFromString(String(raw), defaultCountry);
  if (!parsed) return String(raw);
  if (parsed.country === defaultCountry) return parsed.formatNational();
  return parsed.formatInternational();
}

/**
 * Formata progressivamente enquanto o usuário digita (sem fixar país):
 * - se o input começa com `+`, usa o país detectado
 * - caso contrário usa `defaultCountry`
 */
export function formatPhoneInput(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (!raw) return '';
  const formatter = new AsYouType(defaultCountry);
  return formatter.input(String(raw));
}

/**
 * Para uso em `wa.me/{digits}` — retorna apenas dígitos sem `+`.
 * Aceita E.164 ou input livre.
 */
export function phoneDigitsForWhatsApp(raw, defaultCountry = DEFAULT_COUNTRY) {
  const e164 = normalizePhone(raw, defaultCountry);
  if (e164) return e164.replace(/\D/g, '');
  // Fallback legado: número salvo sem código → tenta com prefixo BR
  const onlyDigits = String(raw || '').replace(/\D/g, '');
  if (!onlyDigits) return '';
  if (onlyDigits.startsWith('55')) return onlyDigits;
  return '55' + onlyDigits;
}

/**
 * Tenta extrair o país de um telefone armazenado.
 * Útil para filtros/exibição de bandeira.
 */
export function phoneCountry(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(String(raw), defaultCountry);
  return parsed?.country || null;
}
