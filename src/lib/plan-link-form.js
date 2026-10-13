// Formulário do link do plano (página pública /plano/:token).
import { normalizePhone } from './phone.js';
import { validateCpf } from './utils.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = value => String(value || '').replace(/\D/g, '');

export function emptyPlanLinkForm() {
  return {
    plan_id: '', coach_id: '', full_name: '', whatsapp: '', email: '', cpf: '',
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
export function preparePlanLinkSubmission(form, { token, requestId }) {
  const fullName = String(form.full_name || '').trim().replace(/\s+/g, ' ');
  if (!form.plan_id) return { error: 'Escolha a duração do plano' };
  if (!form.coach_id) return { error: 'Escolha o treinador' };
  if (fullName.length < 3 || !fullName.includes(' ')) return { error: 'Informe o nome completo' };
  const whatsapp = normalizePhone(form.whatsapp);
  if (!whatsapp) return { error: 'Informe um WhatsApp válido' };
  const email = String(form.email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return { error: 'Informe um e-mail válido' };
  if (!validateCpf(String(form.cpf || ''))) return { error: 'Informe um CPF válido' };
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
