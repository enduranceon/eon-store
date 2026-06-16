import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, TrendingUp, Award, RefreshCw, ChevronDown, ChevronUp,
  Star, Shield, Zap, FileCheck, ArrowRight, Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/api/db';
import { formatCurrency, todayLocalStr } from '@/lib/utils';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function daysInMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function clamp(date, start, end) {
  // retorna quantos dias do contrato estão dentro do mês
  const s = date.monthStart > start ? date.monthStart : start;
  const e = date.monthEnd   < end   ? date.monthEnd   : end;
  if (s > e) return 0;
  return Math.round((e - s) / 86400000) + 1;
}

function activeDaysInMonth(startDate, endDate, yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd   = new Date(y, m, 0);
  const cs = new Date(startDate);
  const ce = endDate ? new Date(endDate) : new Date('2099-12-31');

  const s = cs > monthStart ? cs : monthStart;
  const e = ce < monthEnd   ? ce : monthEnd;
  if (s > e) return 0;
  return Math.round((e - s) / 86400000) + 1;
}

function getTier(tiers, totalStudents) {
  return [...tiers]
    .sort((a, b) => b.min_students - a.min_students)
    .find(t => totalStudents >= t.min_students) || tiers[0];
}

const ROLE_LABEL = { junior: 'Junior', pleno: 'Pleno', senior: 'Senior' };
const ROLE_COLOR = {
  junior: 'bg-gray-100 text-gray-600',
  pleno:  'bg-blue-100 text-blue-700',
  senior: 'bg-purple-100 text-purple-700',
};
const TIER_COLOR = {
  base:    'text-gray-500',
  bronze:  'text-amber-600',
  silver:  'text-slate-500',
  gold:    'text-yellow-600',
  diamond: 'text-cyan-600',
};
const TIER_ICON = {
  base:    Shield,
  bronze:  Award,
  silver:  Award,
  gold:    Star,
  diamond: Zap,
};

// ─────────────────────────────────────────────────────────────────
// COMPONENTE DO COACH
// ─────────────────────────────────────────────────────────────────

function CoachRepasseCard({ entry, expanded, onToggle }) {
  const TierIcon = TIER_ICON[entry.tier?.tier_name] || Shield;

  return (
    <Card className={cn('border transition-shadow', expanded && 'shadow-md')}>
      <CardContent className="p-0">
        {/* Header clicável */}
        <button
          className="w-full text-left p-4 flex items-center gap-4"
          onClick={onToggle}
        >
          <div className="w-10 h-10 bg-blue-50 rounded-full flex items-center justify-center shrink-0">
            <Award className="w-5 h-5 text-blue-600" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900">{entry.coach.name}</span>
              <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', ROLE_COLOR[entry.coach.role])}>
                {ROLE_LABEL[entry.coach.role]}
              </span>
              <span className={cn('text-xs font-medium flex items-center gap-1', TIER_COLOR[entry.tier?.tier_name])}>
                <TierIcon className="w-3 h-3" />
                {entry.tier?.tier_name}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
              <span>{entry.ownStudents} aluno{entry.ownStudents !== 1 ? 's' : ''} próprio{entry.ownStudents !== 1 ? 's' : ''}</span>
              {entry.ledStudents > 0 && <span>· {entry.ledStudents} liderado{entry.ledStudents !== 1 ? 's' : ''}</span>}
              {entry.coLedStudents > 0 && <span>· {entry.coLedStudents} co-liderado{entry.coLedStudents !== 1 ? 's' : ''}</span>}
            </div>
          </div>

          <div className="text-right shrink-0">
            <p className="text-lg font-bold text-gray-900">{formatCurrency(entry.total)}</p>
            <p className="text-xs text-gray-400">previsão do mês</p>
          </div>

          {expanded
            ? <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" />
            : <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
          }
        </button>

        {/* Detalhes expandidos */}
        {expanded && (
          <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-3">
            {/* Linha de faixa atual */}
            {entry.tier && (
              <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600">
                <span className="font-medium">Faixa atual:</span> {entry.tier.tier_name} ({entry.totalPlatformStudents} alunos na plataforma) ·
                Incremento +{formatCurrency(entry.tier.incremento)}/aluno ·
                Bônus líder +{formatCurrency(entry.tier.bonus_lider)}/aluno ·
                Bônus co-líder +{formatCurrency(entry.tier.bonus_co_lider)}/aluno
              </div>
            )}

            {/* Tabela por aluno */}
            {entry.breakdown.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-2">DETALHAMENTO</p>
                <div className="space-y-1">
                  {entry.breakdown.map((row, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-gray-50 last:border-0">
                      <div className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                        row.type === 'own'     ? 'bg-blue-500' :
                        row.type === 'led'     ? 'bg-green-500' :
                        'bg-amber-400'
                      )} />
                      <span className="flex-1 text-gray-700 truncate">{row.studentName}</span>
                      <span className="text-gray-400 shrink-0">{row.modality} · {row.daysActive}d/{row.daysInMonth}d</span>
                      <span className={cn('font-semibold shrink-0',
                        row.type === 'own'     ? 'text-blue-700' :
                        row.type === 'led'     ? 'text-green-700' :
                        'text-amber-600'
                      )}>
                        {formatCurrency(row.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Totais por categoria */}
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="text-center bg-blue-50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Próprios</p>
                <p className="font-bold text-blue-700 text-sm">{formatCurrency(entry.ownTotal)}</p>
              </div>
              <div className="text-center bg-green-50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Liderança</p>
                <p className="font-bold text-green-700 text-sm">{formatCurrency(entry.ledTotal)}</p>
              </div>
              <div className="text-center bg-amber-50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Co-liderança</p>
                <p className="font-bold text-amber-600 text-sm">{formatCurrency(entry.coLedTotal)}</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// PÁGINA PRINCIPAL
// ─────────────────────────────────────────────────────────────────

export default function Repasse() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [data, setData] = useState({
    coaches: [], contracts: [], plans: [], modalities: [],
    customers: [], repasse: [], tiers: [], todayStr: todayLocalStr(),
  });

  const load = useCallback(async () => {
    const todayStr = todayLocalStr();
    const curMonth = todayStr.slice(0, 7);

    const [coachesRes, contractsRes, plansRes, modalitiesRes, customersRes, repasseRes, tiersRes] = await Promise.all([
      supabase.from('assessment_coaches').select('id, name, role, leader_id, co_leader_ids'),
      supabase.from('assessment_contracts')
        .select('id, coach_id, plan_id, customer_id, status, start_date, end_date')
        .in('status', ['active', 'overdue']),
      supabase.from('assessment_plans').select('id, modality_id, price_monthly'),
      supabase.from('assessment_modalities').select('id, name'),
      supabase.from('presale_customers').select('id, full_name'),
      supabase.from('assessment_coach_repasse').select('id, coach_role, modality_id, repasse_value'),
      supabase.from('assessment_growth_tiers').select('*').order('min_students'),
    ]);

    setData({
      coaches:    coachesRes.data    || [],
      contracts:  contractsRes.data  || [],
      plans:      plansRes.data      || [],
      modalities: modalitiesRes.data || [],
      customers:  customersRes.data  || [],
      repasse:    repasseRes.data    || [],
      tiers:      tiersRes.data      || [],
      todayStr,
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    load().catch(console.error).finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load().catch(console.error);
    setRefreshing(false);
  };

  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Mapas de lookup ──────────────────────────────────────────
  const planMap      = useMemo(() => Object.fromEntries(data.plans.map(p => [p.id, p])), [data.plans]);
  const modalityMap  = useMemo(() => Object.fromEntries(data.modalities.map(m => [m.id, m])), [data.modalities]);
  const customerMap  = useMemo(() => Object.fromEntries(data.customers.map(c => [c.id, c])), [data.customers]);
  const repasseMap   = useMemo(() => {
    const map = {};
    data.repasse.forEach(r => { map[`${r.coach_role}:${r.modality_id}`] = Number(r.repasse_value); });
    return map;
  }, [data.repasse]);

  // ── Cálculo principal ────────────────────────────────────────
  const coachEntries = useMemo(() => {
    const curMonth = data.todayStr.slice(0, 7);
    const totalDays = daysInMonth(curMonth);
    const totalPlatformStudents = data.contracts.length;
    const tier = getTier(data.tiers, totalPlatformStudents);

    return data.coaches.map(coach => {
      // Contratos próprios (coach é o treinador direto)
      const ownContracts = data.contracts.filter(c => c.coach_id === coach.id);

      // Coaches que este coach lidera diretamente (leader_id === coach.id)
      const directReports = data.coaches.filter(c => c.leader_id === coach.id);

      // Contratos dos liderados diretos
      const ledContracts = data.contracts.filter(c =>
        directReports.some(r => r.id === c.coach_id)
      );

      // Coaches de segundo nível (liderados pelos liderados)
      const secondLevelReports = data.coaches.filter(c =>
        directReports.some(r => r.id === c.leader_id)
      );

      // Contratos dos co-liderados (2º nível)
      const coLedContracts = data.contracts.filter(c =>
        secondLevelReports.some(r => r.id === c.coach_id)
      );

      // Função que calcula o valor de um contrato pra um tipo de relação
      const calcContract = (contract, type) => {
        const plan     = planMap[contract.plan_id];
        if (!plan) return null;
        const modality = modalityMap[plan.modality_id];
        const customer = customerMap[contract.customer_id];
        const days     = activeDaysInMonth(contract.start_date, contract.end_date, curMonth);
        if (days <= 0) return null;

        const proportion = days / totalDays;

        let value = 0;
        if (type === 'own') {
          const base = repasseMap[`${coach.role}:${plan.modality_id}`] || 0;
          value = proportion * (base + (tier?.incremento || 0));
        } else if (type === 'led') {
          value = proportion * (tier?.bonus_lider || 0);
        } else {
          value = proportion * (tier?.bonus_co_lider || 0);
        }

        return {
          type,
          studentName:  customer?.full_name || '—',
          modality:     modality?.name || '—',
          daysActive:   days,
          daysInMonth:  totalDays,
          value,
        };
      };

      const ownBreakdown    = ownContracts.map(c => calcContract(c, 'own')).filter(Boolean);
      const ledBreakdown    = ledContracts.map(c => calcContract(c, 'led')).filter(Boolean);
      const coLedBreakdown  = coLedContracts.map(c => calcContract(c, 'co_led')).filter(Boolean);

      const breakdown = [...ownBreakdown, ...ledBreakdown, ...coLedBreakdown];

      const ownTotal   = ownBreakdown.reduce((s, r) => s + r.value, 0);
      const ledTotal   = ledBreakdown.reduce((s, r) => s + r.value, 0);
      const coLedTotal = coLedBreakdown.reduce((s, r) => s + r.value, 0);
      const total      = ownTotal + ledTotal + coLedTotal;

      return {
        coach,
        tier,
        totalPlatformStudents,
        ownStudents:    ownContracts.length,
        ledStudents:    ledContracts.length,
        coLedStudents:  coLedContracts.length,
        breakdown,
        ownTotal,
        ledTotal,
        coLedTotal,
        total,
      };
    }).sort((a, b) => b.total - a.total);
  }, [data, planMap, modalityMap, customerMap, repasseMap]);

  const totalRepasse = useMemo(() => coachEntries.reduce((s, e) => s + e.total, 0), [coachEntries]);

  const curMonth = data.todayStr.slice(0, 7);
  const [y, m] = curMonth.split('-');
  const curMonthLabel = new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const currentTier = getTier(data.tiers, data.contracts.length);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Repasse de coaches</h1>
          <p className="text-sm text-gray-500 mt-0.5 capitalize">{curMonthLabel} · Previsão até final do mês</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          Atualizar
        </Button>
      </div>

      {/* ── Banner previsão ────────────────────────────────── */}
      <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
        <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-blue-900 font-medium">Esta página é uma previsão em tempo real</p>
          <p className="text-xs text-blue-700 mt-0.5">
            Os valores são calculados com base nos contratos ativos agora e não estão salvos em lugar nenhum.
            No fim do mês, gere o <strong>Fechamento Mensal</strong> para congelar os valores, adicionar ajustes e registrar o pagamento dos coaches.
          </p>
        </div>
        <Link
          to="/assessoria/fechamento"
          className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 px-3 py-1.5 rounded-lg transition-colors"
        >
          <FileCheck className="w-3.5 h-3.5" />
          Ir para Fechamento
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {/* ── KPIs ───────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500">Total previsto</p>
            <p className="text-2xl font-bold text-gray-900 mt-0.5">{formatCurrency(totalRepasse)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500">Alunos na plataforma</p>
            <p className="text-2xl font-bold text-gray-900 mt-0.5">{data.contracts.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div>
              <p className="text-xs text-gray-500">Faixa atual</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {currentTier && (() => {
                  const Icon = TIER_ICON[currentTier.tier_name] || Shield;
                  return (
                    <>
                      <Icon className={cn('w-4 h-4', TIER_COLOR[currentTier.tier_name])} />
                      <span className={cn('text-xl font-bold capitalize', TIER_COLOR[currentTier.tier_name])}>
                        {currentTier.tier_name}
                      </span>
                    </>
                  );
                })()}
              </div>
              {currentTier && (
                <p className="text-xs text-gray-400 mt-0.5">
                  Incremento: +{formatCurrency(currentTier.incremento)}/aluno
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Faixas ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Faixas de crescimento
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left text-gray-400 font-medium px-4 py-2">Faixa</th>
                  <th className="text-right text-gray-400 font-medium px-4 py-2">Mín. alunos</th>
                  <th className="text-right text-gray-400 font-medium px-4 py-2">Incremento</th>
                  <th className="text-right text-gray-400 font-medium px-4 py-2">Bônus líder</th>
                  <th className="text-right text-gray-400 font-medium px-4 py-2">Bônus co-líder</th>
                </tr>
              </thead>
              <tbody>
                {data.tiers.map(t => {
                  const Icon = TIER_ICON[t.tier_name] || Shield;
                  const isActive = currentTier?.tier_name === t.tier_name;
                  return (
                    <tr key={t.id} className={cn('border-b border-gray-50 last:border-0', isActive && 'bg-blue-50/50')}>
                      <td className="px-4 py-2">
                        <div className={cn('flex items-center gap-1.5 font-semibold capitalize', TIER_COLOR[t.tier_name])}>
                          <Icon className="w-3.5 h-3.5" />
                          {t.tier_name}
                          {isActive && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-semibold ml-1">atual</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right text-gray-600">{t.min_students}</td>
                      <td className="px-4 py-2 text-right text-gray-700 font-medium">{formatCurrency(t.incremento)}</td>
                      <td className="px-4 py-2 text-right text-green-700 font-medium">{formatCurrency(t.bonus_lider)}</td>
                      <td className="px-4 py-2 text-right text-amber-600 font-medium">{formatCurrency(t.bonus_co_lider)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── Cards por coach ──────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Users className="w-4 h-4 text-gray-400" />
            Previsão por coach
          </h2>
          <button
            className="text-xs text-blue-600 hover:underline"
            onClick={() => {
              const allIds = new Set(data.coaches.map(c => c.id));
              setExpandedIds(prev => prev.size === allIds.size ? new Set() : allIds);
            }}
          >
            {expandedIds.size === data.coaches.length ? 'Recolher todos' : 'Expandir todos'}
          </button>
        </div>
        <div className="space-y-2">
          {coachEntries.map(entry => (
            <CoachRepasseCard
              key={entry.coach.id}
              entry={entry}
              expanded={expandedIds.has(entry.coach.id)}
              onToggle={() => toggleExpand(entry.coach.id)}
            />
          ))}
        </div>
      </div>

    </div>
  );
}
