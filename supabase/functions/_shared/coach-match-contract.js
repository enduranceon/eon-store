// Shared by the coach questionnaire, admin review and public match catalog.
// Eligibility (modality, site plans, public visibility) stays in assessment_coaches.
export const MATCH_VERSION = 2;
export const LEGACY_MATCH_VERSION = 1;
export const MATCH_GOALS = ['health', 'start', 'performance', 'return', 'high_performance'];
export const MATCH_LEVELS = ['beginner', 'intermediate', 'advanced'];
export const MATCH_STYLES = ['close', 'balanced', 'autonomy'];
export const MATCH_AGES = ['up_to_30', 'age_31_50', 'age_51_plus'];
export const MATCH_GENDERS = ['female', 'male'];
export const MATCH_FORMATS = ['florianopolis', 'online'];

const LEGACY_GOALS = ['start', 'evolve', 'race', 'routine'];
const LEGACY_LEVELS = ['beginner', 'regular', 'experienced'];

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- Keep legacy v1 submissions safe during rollback.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function validLegacyFocus(value, allowed) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 &&
    value.every(item => allowed.includes(item)) && new Set(value).size === value.length;
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validFormats(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 &&
    value.every(item => MATCH_FORMATS.includes(item)) && new Set(value).size === value.length;
}

function validPriority(value, allowed, noPreference) {
  if (!hasExactKeys(value, ['primary', 'secondary'])) return false;
  const hasNoPreference = typeof noPreference === 'string';
  const primaryAllowed = allowed.includes(value.primary) ||
    (hasNoPreference && value.primary === noPreference);
  if (!primaryAllowed || (value.secondary !== null && !allowed.includes(value.secondary))) return false;
  if (hasNoPreference && value.primary === noPreference) return value.secondary === null;
  return value.secondary === null || value.secondary !== value.primary;
}

export function validateCoachMatchV2Answers(input) {
  if (!hasExactKeys(input, ['version', 'service_formats', 'focus_goals', 'focus_levels',
    'communication_style', 'age_groups', 'gender_preference']) || input.version !== MATCH_VERSION) {
    return { ok: false, error: 'Versão do formulário inválida.' };
  }
  if (!validFormats(input.service_formats)) {
    return { ok: false, error: 'Indique se atende em Florianópolis, online ou nos dois formatos.' };
  }
  if (!validPriority(input.focus_goals, MATCH_GOALS)) {
    return { ok: false, error: 'Revise o objetivo principal e o opcional.' };
  }
  if (!validPriority(input.focus_levels, MATCH_LEVELS)) {
    return { ok: false, error: 'Revise o momento técnico principal e o opcional.' };
  }
  if (!validPriority(input.communication_style, MATCH_STYLES)) {
    return { ok: false, error: 'Revise a forma de acompanhamento principal e a opcional.' };
  }
  if (!validPriority(input.age_groups, MATCH_AGES, 'no_preference')) {
    return { ok: false, error: 'Revise a afinidade de faixa etária.' };
  }
  if (!validPriority(input.gender_preference, MATCH_GENDERS, 'no_preference')) {
    return { ok: false, error: 'Revise a afinidade de gênero.' };
  }
  return {
    ok: true,
    answers: {
      version: MATCH_VERSION,
      service_formats: [...input.service_formats],
      focus_goals: { ...input.focus_goals },
      focus_levels: { ...input.focus_levels },
      communication_style: { ...input.communication_style },
      age_groups: { ...input.age_groups },
      gender_preference: { ...input.gender_preference },
    },
  };
}

export function validateLegacyCoachMatchAnswers(input) {
  if (!hasExactKeys(input, ['version', 'focus_goals', 'focus_levels', 'service_formats',
    'communication_style', 'approach', 'experience']) || input.version !== LEGACY_MATCH_VERSION ||
      !validLegacyFocus(input.focus_goals, LEGACY_GOALS) ||
      !validLegacyFocus(input.focus_levels, LEGACY_LEVELS) || !validFormats(input.service_formats) ||
      !MATCH_STYLES.includes(input.communication_style)) {
    return { ok: false, error: 'Respostas antigas inválidas.' };
  }
  const approach = cleanText(input.approach, 320);
  const experience = cleanText(input.experience, 320);
  if (approach.length < 30 || typeof input.approach !== 'string' || input.approach.trim().length > 320 ||
      typeof input.experience !== 'string' || input.experience.trim().length > 320) {
    return { ok: false, error: 'Respostas antigas inválidas.' };
  }
  return { ok: true, answers: {
    version: LEGACY_MATCH_VERSION,
    focus_goals: [...input.focus_goals], focus_levels: [...input.focus_levels],
    service_formats: [...input.service_formats], communication_style: input.communication_style,
    approach, experience,
  } };
}

export function validateCoachMatchAnswers(input) {
  return input?.version === LEGACY_MATCH_VERSION
    ? validateLegacyCoachMatchAnswers(input)
    : validateCoachMatchV2Answers(input);
}

export function publicCoachMatchAnswers(input) {
  // The public catalog remains legacy-only. V2 contains demographic affinity
  // preferences and must only be evaluated server-side by a future matcher.
  const parsed = validateLegacyCoachMatchAnswers(input);
  return parsed.ok ? parsed.answers : null;
}
