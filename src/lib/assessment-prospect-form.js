import { normalizePhone } from './phone.js';

export const PROSPECT_GENDERS = { masculino: 'Masculino', feminino: 'Feminino', outro: 'Outro' };

export function prepareManualProspect(form, maxInstallments, today) {
  const fullName = form.full_name.trim();
  if (fullName.length < 2 || fullName.length > 200) return { error: 'Informe um nome entre 2 e 200 caracteres' };
  const whatsapp = normalizePhone(form.whatsapp);
  if (!whatsapp || whatsapp.replace(/\D/g, '').length > 13) return { error: 'Informe um WhatsApp válido' };
  const email = form.email.trim() || null;
  if (email && (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: 'Informe um e-mail válido ou deixe o campo vazio' };
  const cpf = form.cpf.replace(/\D/g, '') || null;
  if (cpf && cpf.length !== 11) return { error: 'Informe os 11 dígitos do CPF ou deixe o campo vazio' };
  const gender = form.gender || null;
  if (gender && !Object.hasOwn(PROSPECT_GENDERS, gender)) return { error: 'Selecione um gênero válido' };
  const birthDate = form.birth_date || null;
  if (birthDate) {
    const date = new Date(`${birthDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== birthDate || birthDate < '1900-01-01' || birthDate > today) {
      return { error: 'Informe uma data de nascimento válida, entre 1900 e hoje' };
    }
  }
  if (!form.plan_id) return { error: 'Selecione o plano' };
  if (!form.coach_id) return { error: 'Selecione o coach' };
  const installments = Number(form.installments);
  if (!Number.isInteger(installments) || installments < 1 || installments > maxInstallments) {
    return { error: `Informe uma quantidade inteira de parcelas, entre 1 e ${maxInstallments}` };
  }
  const notes = form.notes.trim() || null;
  if (notes && notes.length > 2000) return { error: 'As observações devem ter até 2000 caracteres' };
  return { payload: { fullName, whatsapp, email, cpf, gender, birthDate, planId: form.plan_id, coachId: form.coach_id, installments, notes } };
}
