import { attachSitePlans, planAllowedForCoach } from "./site-plans.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const RUN = "11111111-1111-4111-8111-111111111111";
const TRI = "22222222-2222-4222-8222-222222222222";
const plan = (id: string, modality_id: string, period_months: number, active = true) => ({
  id, name: `Plano ${id.slice(0, 4)}`, period: null, period_months,
  price_monthly: 210, price_total: 210 * period_months, enrollment_fee: 0,
  max_installments: period_months, modality_id, active,
});

Deno.test("cada coach recebe só os planos dele no site, ativos e das modalidades que atende", () => {
  const coaches = [
    { id: "c1", name: "Coach Fictício", modality_ids: [RUN] },
    { id: "c2", name: "Outro Coach", modality_ids: [RUN, TRI] },
  ];
  const rows = [
    { coach_id: "c1", modality_id: RUN, period_months: 6, plan: plan("aaaa6", RUN, 6) },
    { coach_id: "c1", modality_id: RUN, period_months: 1, plan: plan("aaaa1", RUN, 1) },
    { coach_id: "c1", modality_id: RUN, period_months: 3, plan: plan("aaaa3", RUN, 3, false) },
    { coach_id: "c1", modality_id: TRI, period_months: 1, plan: plan("bbbb1", TRI, 1) },
    { coach_id: "c2", modality_id: RUN, period_months: 1, plan: null },
    { coach_id: "c2", modality_id: TRI, period_months: 1, plan: [plan("cccc1", TRI, 1)] },
  ];
  const [first, second] = attachSitePlans(coaches, rows);
  assert(first.site_plans.map((row) => row.plan_id).join() === "aaaa1,aaaa6", "wrong plans for c1");
  assert(!("active" in first.site_plans[0].plan), "internal field leaked");
  assert(first.name === "Coach Fictício", "coach fields changed");
  assert(second.site_plans.map((row) => row.plan_id).join() === "cccc1", "plan returned as a list was lost");
});

Deno.test("o site aceita plano geral ou o plano escolhido para o coach", () => {
  const coach = { modality_ids: [RUN] };
  const online = { id: "p1", modality_id: RUN, available_online: true };
  const ownPlan = { id: "p2", modality_id: RUN, available_online: false };
  assert(planAllowedForCoach(online, coach, []) === "ok", "general plan refused");
  assert(planAllowedForCoach(ownPlan, coach, ["p2"]) === "ok", "coach plan refused");
  assert(planAllowedForCoach(ownPlan, coach, ["p9"]) === "plan", "another coach's plan accepted");
  assert(planAllowedForCoach({ ...online, modality_id: TRI }, coach, []) === "coach", "modality not checked");
  assert(planAllowedForCoach(online, null, []) === "coach", "missing coach accepted");
});
