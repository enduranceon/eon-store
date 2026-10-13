// Planos agrupados: cada grupo ("Corrida - Essencial") reúne as durações do
// mesmo plano. Cada duração continua sendo um plano próprio no banco; o grupo
// organiza a tela de Planos e dá o link do plano para WhatsApp.

const LEGACY_PERIODS = { 1: 'mensal', 3: 'trimestral', 6: 'semestral', 12: 'anual' };
const DURATION_LABELS = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };

export const DEFAULT_DURATIONS = [1, 3, 6];

export function planMonths(plan) {
  return Number(plan?.period_months)
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
}

export function durationLabel(months) {
  return DURATION_LABELS[Number(months)] || `${months} meses`;
}

// Por modalidade: grupos com as durações em ordem, e os planos sem grupo.
export function groupPlansByFamily(plans = [], families = [], { showInactive = false } = {}) {
  const visible = plan => showInactive || plan.active;
  const familyIds = new Set(families.map(family => family.id));
  const byModality = new Map();
  const slot = modalityId => {
    if (!byModality.has(modalityId)) byModality.set(modalityId, { families: [], loose: [] });
    return byModality.get(modalityId);
  };
  const sortedFamilies = [...families].sort((a, b) =>
    Number(b.active) - Number(a.active) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
  for (const family of sortedFamilies) {
    const familyPlans = plans
      .filter(plan => plan.family_id === family.id && visible(plan))
      .sort((a, b) => planMonths(a) - planMonths(b) || Number(b.active) - Number(a.active));
    if (!showInactive && !family.active && familyPlans.length === 0) continue;
    slot(family.modality_id).families.push({ family, plans: familyPlans });
  }
  for (const plan of plans) {
    if (plan.family_id && familyIds.has(plan.family_id)) continue;
    if (!visible(plan)) continue;
    slot(plan.modality_id).loose.push(plan);
  }
  for (const group of byModality.values()) {
    group.loose.sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR') || planMonths(a) - planMonths(b));
  }
  return byModality;
}

// Coach e região escolhidos antes de copiar vão no endereço e já chegam preenchidos.
export function planLinkUrl(origin, token, { coach = '', region = '' } = {}) {
  const base = `${String(origin).replace(/\/$/, '')}/plano/${token}`;
  const query = new URLSearchParams();
  if (coach) query.set('coach', coach);
  if (region) query.set('regiao', region);
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

export function emptyFamilyForm(modalityId = '', revenueCenterId = '') {
  return {
    name: '',
    modality_id: modalityId,
    enrollment_fee: '0',
    revenue_center_id: revenueCenterId,
    available_online: false,
    durations: Object.fromEntries(DEFAULT_DURATIONS.map(months => [
      months,
      { enabled: true, total: '', installments: String(months) },
    ])),
  };
}

const money = value => Math.round(Number(value) * 100) / 100;

// Novo plano com as durações de uma vez: devolve { error } ou o grupo e os
// planos no formato da API.
export function prepareFamilyPlans(form) {
  const name = String(form.name || '').trim().replace(/\s+/g, ' ');
  if (!form.modality_id) return { error: 'Escolha a modalidade' };
  if (name.length < 2) return { error: 'Dê um nome ao plano' };
  if (!form.revenue_center_id) return { error: 'Escolha o centro de receita' };
  const enrollmentFee = form.enrollment_fee === '' ? 0 : Number(form.enrollment_fee);
  if (!Number.isFinite(enrollmentFee) || enrollmentFee < 0) return { error: 'Matrícula inválida' };
  const plans = [];
  for (const [key, duration] of Object.entries(form.durations || {})) {
    if (!duration.enabled) continue;
    const months = Number(key);
    const total = Number(String(duration.total).replace(',', '.'));
    const installments = Number(duration.installments);
    if (!Number.isFinite(total) || total <= 0) return { error: `Informe o valor total do ${durationLabel(months).toLowerCase()}` };
    if (!Number.isInteger(installments) || installments < 1 || installments > 12) {
      return { error: `Parcelas do ${durationLabel(months).toLowerCase()}: de 1 a 12` };
    }
    plans.push({
      name: `${name} - ${durationLabel(months)}`,
      modality_id: form.modality_id,
      period: LEGACY_PERIODS[months] || `${months}m`,
      period_months: months,
      price_monthly: money(total / months),
      price_total: money(total),
      max_installments: installments,
      enrollment_fee: money(enrollmentFee),
      revenue_center_id: form.revenue_center_id,
      active: true,
      available_online: !!form.available_online,
    });
  }
  if (plans.length === 0) return { error: 'Marque ao menos uma duração' };
  plans.sort((a, b) => a.period_months - b.period_months);
  return { family: { modality_id: form.modality_id, name }, plans };
}
