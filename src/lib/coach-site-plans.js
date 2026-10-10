// Planos que o coach vende no site: um por modalidade e duração. Vale só para o
// formulário público; a venda interna continua podendo usar qualquer plano.

const PERIOD_LABEL = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };

export function periodLabel(months) {
  return PERIOD_LABEL[months] || `${months} meses`;
}

export function sitePlanKey(modalityId, months) {
  return `${modalityId}:${months}`;
}

// Durações da modalidade (pelos planos ativos) e os planos de cada uma.
export function sitePlanOptions(plans = [], modalityId) {
  const byPeriod = new Map();
  plans
    .filter(plan => plan.active !== false && plan.modality_id === modalityId && Number(plan.period_months) > 0)
    .forEach(plan => {
      const months = Number(plan.period_months);
      if (!byPeriod.has(months)) byPeriod.set(months, []);
      byPeriod.get(months).push(plan);
    });
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a - b)
    .map(([months, list]) => ({
      months,
      label: periodLabel(months),
      plans: list.sort((a, b) => Number(a.price_monthly) - Number(b.price_monthly)),
    }));
}

// Escolhas atuais do coach, no formato do formulário: { "modalidade:meses": planId }.
export function sitePlanForm(rows = [], coachId) {
  return Object.fromEntries(
    rows
      .filter(row => row.coach_id === coachId)
      .map(row => [sitePlanKey(row.modality_id, row.period_months), row.plan_id]),
  );
}

// O que gravar para o formulário virar o estado salvo. Modalidade que o coach
// deixou de atender perde as escolhas dela.
export function diffSitePlans(rows = [], coachId, selection = {}, modalityIds = []) {
  const existing = rows.filter(row => row.coach_id === coachId);
  const byKey = new Map(existing.map(row => [sitePlanKey(row.modality_id, row.period_months), row]));
  const creates = [];
  const updates = [];
  const deletes = [];
  Object.entries(selection).forEach(([key, planId]) => {
    if (!planId) return;
    const [modalityId, months] = key.split(':');
    if (!modalityIds.includes(modalityId)) return;
    const current = byKey.get(key);
    if (!current) creates.push({ coach_id: coachId, modality_id: modalityId, period_months: Number(months), plan_id: planId });
    else if (current.plan_id !== planId) updates.push({ id: current.id, plan_id: planId });
  });
  existing.forEach(row => {
    const key = sitePlanKey(row.modality_id, row.period_months);
    if (!selection[key] || !modalityIds.includes(row.modality_id)) deletes.push(row.id);
  });
  return { creates, updates, deletes };
}
