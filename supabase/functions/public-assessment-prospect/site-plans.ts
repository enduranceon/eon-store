// Planos que cada coach vende no site: um por modalidade e duração. Coach sem
// plano escolhido numa modalidade segue com os planos gerais do site
// (available_online), como antes.

export interface PublicPlan {
  id: string;
  name: string | null;
  period: string | null;
  period_months: number | null;
  price_monthly: number | string;
  price_total: number | string;
  enrollment_fee: number | string | null;
  max_installments: number | null;
  modality_id: string;
  active?: boolean;
}

export interface SitePlanRow {
  coach_id: string;
  modality_id: string;
  period_months: number;
  // O banco devolve o plano ligado como objeto; o tipo do cliente diz lista.
  plan: PublicPlan | PublicPlan[] | null;
}

export interface PublicCoach {
  id: string;
  name: string;
  modality_ids: string[] | null;
}

export interface CoachSitePlan {
  modality_id: string;
  period_months: number;
  plan_id: string;
  plan: Omit<PublicPlan, "active">;
}

// Junta a cada coach os planos dele no site, só os ativos e das modalidades
// que ele atende, em ordem de modalidade e duração.
export function attachSitePlans<T extends PublicCoach>(
  coaches: T[],
  rows: SitePlanRow[],
): Array<T & { site_plans: CoachSitePlan[] }> {
  return coaches.map((coach) => {
    const modalities = Array.isArray(coach.modality_ids)
      ? coach.modality_ids
      : [];
    const site_plans = rows
      .map((row) => ({
        ...row,
        plan: Array.isArray(row.plan) ? row.plan[0] ?? null : row.plan,
      }))
      .filter((row) =>
        row.coach_id === coach.id && row.plan && row.plan.active !== false &&
        row.plan.modality_id === row.modality_id &&
        row.plan.period_months === row.period_months &&
        modalities.includes(row.modality_id)
      )
      .sort((a, b) =>
        a.modality_id.localeCompare(b.modality_id) ||
        a.period_months - b.period_months
      )
      .map((row) => {
        const { active: _active, ...plan } = row.plan as PublicPlan;
        return {
          modality_id: row.modality_id,
          period_months: row.period_months,
          plan_id: plan.id,
          plan,
        };
      });
    return { ...coach, site_plans };
  });
}

// O plano pode ser vendido pelo site com este coach: da modalidade dele e, ou
// um plano geral do site, ou o plano escolhido para ele.
export function planAllowedForCoach(
  plan: { id: string; modality_id: string; available_online: boolean | null },
  coach: { modality_ids: string[] | null } | null,
  coachSitePlanIds: string[],
): "ok" | "plan" | "coach" {
  if (!coach) return "coach";
  const modalities = Array.isArray(coach.modality_ids) ? coach.modality_ids : [];
  if (!modalities.includes(plan.modality_id)) return "coach";
  if (plan.available_online === true || coachSitePlanIds.includes(plan.id)) {
    return "ok";
  }
  return "plan";
}
