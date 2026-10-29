// Formulário do link do plano (página pública /plano/:token).
import { normalizePhone } from './phone.js';
import { validateCpf } from './utils.js';

export const PLAN_LINK_REGIONS = { florianopolis: 'Florianópolis', online: 'Online' };

// Região que veio no link (?regiao=); qualquer outro valor é ignorado.
export function regionFromLink(value) {
  const region = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLAN_LINK_REGIONS, region) ? region : '';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = value => String(value || '').replace(/\D/g, '');

// Mesmos valores do formulário interno de prospect (vazio = prefere não informar).
export const PLAN_LINK_GENDERS = { feminino: 'Feminino', masculino: 'Masculino', outro: 'Outro' };

// Data de nascimento digitada como dd/mm/aaaa (o preenchimento automático do
// navegador pode trazer AAAA-MM-DD, convertido antes da máscara).
export function maskBirthDate(value) {
  let text = String(value || '').trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) text = `${iso[3]}${iso[2]}${iso[1]}`;
  const numbers = digits(text).slice(0, 8);
  if (numbers.length <= 2) return numbers;
  if (numbers.length <= 4) return `${numbers.slice(0, 2)}/${numbers.slice(2)}`;
  return `${numbers.slice(0, 2)}/${numbers.slice(2, 4)}/${numbers.slice(4)}`;
}

// dd/mm/aaaa -> AAAA-MM-DD, ou '' se a data não existe, é anterior a 1900 ou é futura.
export function birthDateToIso(value, now = new Date()) {
  const match = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return '';
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)) return '';
  const iso = `${year}-${month}-${day}`;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return iso >= '1900-01-01' && iso <= today ? iso : '';
}

export function emptyPlanLinkForm() {
  return {
    plan_id: '', coach_id: '', full_name: '', whatsapp: '', email: '', cpf: '', birth_date: '', gender: '',
    address_zip: '', address_street: '', address_number: '', address_complement: '',
    address_neighborhood: '', address_city: '', address_state: '', region: '',
    confirmed: false, website: '',
  };
}

// Parcela mostrada na opção: total dividido pelo máximo de parcelas.
export function installmentText(option) {
  const parts = Math.max(1, Number(option?.max_installments) || 1);
  const total = Number(option?.price_total) || 0;
  return { parts, value: Math.round((total / parts) * 100) / 100 };
}

// Devolve { error } com a primeira pendência ou { body } para a função pública.
export function preparePlanLinkSubmission(form, { token, requestId, now = new Date() }) {
  const fullName = String(form.full_name || '').trim().replace(/\s+/g, ' ');
  if (!form.plan_id) return { error: 'Escolha a duração do plano' };
  if (!form.coach_id) return { error: 'Escolha o treinador' };
  if (fullName.length < 3 || !fullName.includes(' ')) return { error: 'Informe o nome completo' };
  const whatsapp = normalizePhone(form.whatsapp);
  if (!whatsapp) return { error: 'Informe um WhatsApp válido' };
  const email = String(form.email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return { error: 'Informe um e-mail válido' };
  if (!validateCpf(String(form.cpf || ''))) return { error: 'Informe um CPF válido' };
  if (!String(form.birth_date || '').trim()) return { error: 'Informe a data de nascimento' };
  const birthDate = birthDateToIso(form.birth_date, now);
  if (!birthDate) return { error: 'Informe a data de nascimento no formato dia/mês/ano, por exemplo 25/03/1990' };
  if (digits(form.address_zip).length !== 8) return { error: 'Informe o CEP' };
  for (const [field, label] of [
    ['address_street', 'a rua'], ['address_number', 'o número'],
    ['address_neighborhood', 'o bairro'], ['address_city', 'a cidade'],
  ]) {
    if (!String(form[field] || '').trim()) return { error: `Informe ${label}` };
  }
  const state = String(form.address_state || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return { error: 'Informe o estado (UF)' };
  if (!form.confirmed) return { error: 'Confirme que os dados estão corretos' };
  return {
    body: {
      token,
      request_id: requestId,
      plan_id: form.plan_id,
      coach_id: form.coach_id,
      full_name: fullName,
      whatsapp,
      email,
      cpf: digits(form.cpf),
      birth_date: birthDate,
      gender: Object.prototype.hasOwnProperty.call(PLAN_LINK_GENDERS, form.gender) ? form.gender : '',
      region: form.region || null,
      address_zip: digits(form.address_zip),
      address_street: form.address_street.trim(),
      address_number: form.address_number.trim(),
      address_complement: String(form.address_complement || '').trim(),
      address_neighborhood: form.address_neighborhood.trim(),
      address_city: form.address_city.trim(),
      address_state: state,
      confirmed: true,
      website: form.website || '',
    },
  };
}
