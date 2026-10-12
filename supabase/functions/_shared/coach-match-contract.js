// Shared by the coach questionnaire, admin review and public match catalog.
// Eligibility (modality, site plans, public visibility) stays in assessment_coaches.
export const MATCH_VERSION = 1;
export const MATCH_GOALS = ['start', 'evolve', 'race', 'routine'];
export const MATCH_LEVELS = ['beginner', 'regular', 'experienced'];
export const MATCH_STYLES = ['close', 'balanced', 'autonomy'];
export const MATCH_FORMATS = ['florianopolis', 'online'];

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- Strip non-printable input from public profile text.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function validFocus(value, allowed) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 &&
    value.every(item => allowed.includes(item)) && new Set(value).size === value.length;
}

export function validateCoachMatchAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== MATCH_VERSION) {
    return { ok: false, error: 'Versão do formulário inválida.' };
  }
  if (!validFocus(input.focus_goals, MATCH_GOALS)) {
    return { ok: false, error: 'Escolha um ou dois objetivos com os quais mais trabalha.' };
  }
  if (!validFocus(input.focus_levels, MATCH_LEVELS)) {
    return { ok: false, error: 'Escolha um ou dois momentos do atleta.' };
  }
  if (!Array.isArray(input.service_formats) || input.service_formats.length < 1 ||
      input.service_formats.length > 2 || new Set(input.service_formats).size !== input.service_formats.length ||
      !input.service_formats.every(item => MATCH_FORMATS.includes(item))) {
    return { ok: false, error: 'Indique se atende em Florianópolis, online ou nos dois formatos.' };
  }
  if (!MATCH_STYLES.includes(input.communication_style)) {
    return { ok: false, error: 'Escolha como costuma acompanhar seus alunos.' };
  }
  const approach = cleanText(input.approach, 320);
  const experience = cleanText(input.experience, 320);
  if (approach.length < 30) {
    return { ok: false, error: 'Conte um pouco mais sobre seu jeito de trabalhar (mínimo de 30 caracteres).' };
  }
  if (typeof input.approach !== 'string' || input.approach.trim().length > 320 ||
      typeof input.experience !== 'string' || input.experience.trim().length > 320) {
    return { ok: false, error: 'Os textos devem ter no máximo 320 caracteres.' };
  }
  return {
    ok: true,
    answers: {
      version: MATCH_VERSION,
      focus_goals: [...input.focus_goals],
      focus_levels: [...input.focus_levels],
      service_formats: [...input.service_formats],
      communication_style: input.communication_style,
      approach,
      experience,
    },
  };
}

export function publicCoachMatchAnswers(input) {
  const parsed = validateCoachMatchAnswers(input);
  return parsed.ok ? parsed.answers : null;
}
