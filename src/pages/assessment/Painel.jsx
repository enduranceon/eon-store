import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Users, FileText, AlertTriangle, TrendingUp, RefreshCw,
  ChevronRight, CheckCircle2, Clock, XCircle, RotateCcw,
  UserPlus, UserMinus, Activity, Award, TrendingDown,
  MessageCircle, Check, CalendarClock, Zap,
} from 'lucide-react';
import { supabase } from '@/api/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  AssessmentContract, AssessmentPlan, AssessmentModality,
  AssessmentCoach, PreSaleCustomer, RenewalRule, ContractRenewalAction,
} from '@/api/entities';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr, utcToLocalDateStr, renderMessageTemplate } from '@/lib/utils';
import { toast } from 'sonner';

// Calcula end_date a partir de start_date + duração do plano
function addPeriod(startStr, plan) {
  const d = new Date(startStr + 'T12:00:00');
  const months = plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
  d.setMonth(d.getMonth() + months);
  return toLocalDateStr(d);
}

function periodLabel(plan) {
  const m = plan?.period_months
    || { mensal: 1, trimestral: 3, semestral: 6, anual: 12 }[plan?.period]
    || 1;
  const names = { 1: '1 mês', 2: '2 meses', 3: '3 meses', 6: '6 meses', 12: '12 meses' };
  return names[m] || `${m} meses`;
}

// Wrapper local que adiciona periodLabel ao contexto pro template util
function renderTemplate(template, ctx) {
  return renderMessageTemplate(template, { ...ctx, periodLabel: periodLabel(ctx.plan) });
}

const STATUS_CLS = {
  active:    'bg-green-100 text-green-700',
  overdue:   'bg-red-100 text-red-700',
  on_leave:  'bg-amber-100 text-amber-700',
  finished:  'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-500',
};
const STATUS_LABEL = {
  active: 'Ativo', overdue: 'Atrasado', on_leave: 'Licença',
  finished: 'Concluído', cancelled: 'Cancelado',
};

export default function Painel() {
  const navigate = useNavigate();
  const [contracts,   setContracts]   = useState([]);
  const [plans,       setPlans]       = useState([]);
  const [modalities,  setModalities]  = useState([]);
  const [coaches,     setCoaches]     = useState([]);
  const [customers,   setCustomers]   = useState([]);
  const [rules,       setRules]       = useState([]);
  const [actionsLog,  setActionsLog]  = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [renewing,    setRenewing]    = useState(false);
  const [actingId,    setActingId]    = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Failsafe: nunca trava em "Carregando..." por mais de 10s
    const failsafe = setTimeout(() => {
      console.warn('Painel: timeout 10s — forçando saída do loading');
      setLoading(false);
    }, 10000);
    try {
      const [c, p, m, co, cu, rl, al] = await Promise.all([
        AssessmentContract.list('-created_at').catch(e => { console.error('contracts:', e); return []; }),
        AssessmentPlan.list().catch(e => { console.error('plans:', e); return []; }),
        AssessmentModality.list().catch(e => { console.error('modalities:', e); return []; }),
        AssessmentCoach.list().catch(e => { console.error('coaches:', e); return []; }),
        PreSaleCustomer.list('full_name').catch(e => { console.error('customers:', e); return []; }),
        RenewalRule.filter({ active: true }, 'order_index').catch(e => { console.error('rules:', e); return []; }),
        ContractRenewalAction.list().catch(e => { console.error('actions:', e); return []; }),
      ]);

      // Auto-transição: contratos active com end_date < hoje → overdue
      const nowStr = todayLocalStr();
      const toMarkOverdue = c.filter(ct =>
        ct.status === 'active' && ct.end_date < nowStr
      );
      if (toMarkOverdue.length > 0) {
        await Promise.allSettled(
          toMarkOverdue.map(ct => AssessmentContract.update(ct.id, { status: 'overdue' }))
        );
        toMarkOverdue.forEach(ct => { ct.status = 'overdue'; });
      }

      setContracts(c); setPlans(p); setModalities(m);
      setCoaches(co);  setCustomers(cu);
      setRules(rl);    setActionsLog(al);
    } catch (e) {
      console.error('Erro ao carregar Painel:', e);
      toast.error('Erro ao carregar painel: ' + (e.message || 'desconhecido'));
    } finally {
      clearTimeout(failsafe);
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const today      = todayLocalStr();
  const in30days   = (() => { const d = new Date(); d.setDate(d.getDate() + 30); return toLocalDateStr(d); })();

  const active     = contracts.filter(c => ['active', 'overdue', 'on_leave'].includes(c.status));
  const overdue    = contracts.filter(c => c.status === 'overdue');
  const expiring   = contracts.filter(c => c.status === 'active' && c.end_date >= today && c.end_date <= in30days);

  const monthlyRevenue = active.reduce((acc, c) => {
    const p = plans.find(pl => pl.id === c.plan_id);
    return acc + (p ? Number(p.price_monthly) : 0);
  }, 0);

  // Contratos com auto_renewal que já venceram e ainda não foram renovados
  const pendingRenewal = contracts.filter(c =>
    c.auto_renewal &&
    !c.renewal_generated &&
    c.end_date < today &&
    !['cancelled'].includes(c.status)
  );

  // ── Processar renovações automáticas ────────────────────────────────────────
  const processRenewals = async () => {
    if (pendingRenewal.length === 0) return;
    // Avisa se algum contrato tem pagamento em aberto
    const withOpenPayment = pendingRenewal.filter(c =>
      c.payment_status && !['paid', 'refunded', 'cancelled'].includes(c.payment_status)
    );
    if (withOpenPayment.length > 0) {
      const confirmed = confirm(
        `⚠️ Atenção:\n\n` +
        `${withOpenPayment.length} de ${pendingRenewal.length} contrato(s) ainda têm pagamento em aberto.\n\n` +
        `Renovar mesmo assim?\n\n` +
        `(Os contratos antigos ficarão pendentes em "Pagamentos em aberto" no perfil de cada aluno)`
      );
      if (!confirmed) return;
    }
    setRenewing(true);
    let ok = 0; let fail = 0;
    for (const c of pendingRenewal) {
      try {
        const plan = plans.find(p => p.id === c.plan_id);
        if (!plan) { fail++; continue; }
        const newStart = c.end_date; // começa no dia seguinte ao vencimento
        const newEnd   = addPeriod(newStart, plan);
        await AssessmentContract.create({
          customer_id:       c.customer_id,
          coach_id:          c.coach_id,
          plan_id:           c.plan_id,
          start_date:        newStart,
          end_date:          newEnd,
          original_end_date: newEnd,
          due_date:          newEnd,
          installments:      c.installments,
          enrollment_fee:    0,
          auto_renewal:      true,
          parent_contract_id: c.id,
          notes:             `Renovação automática de ${c.contract_number}`,
        });
        await AssessmentContract.update(c.id, { renewal_generated: true, status: 'finished' });
        ok++;
      } catch { fail++; }
    }
    toast.success(`${ok} contrato${ok !== 1 ? 's' : ''} renovado${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} com erro` : ''}!`);
    load();
    setRenewing(false);
  };

  // ── Enrich helper ────────────────────────────────────────────────────────────
  const enrich = (c) => {
    const plan     = plans.find(p => p.id === c.plan_id);
    const modality = plan && modalities.find(m => m.id === plan.modality_id);
    const coach    = coaches.find(co => co.id === c.coach_id);
    const customer = customers.find(cu => cu.id === c.customer_id);
    return { ...c, plan, modality, coach, customer };
  };

  // Dias entre hoje e o vencimento (negativo = já passou)
  const daysToDate = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / 86400000);
  };

  // ── Régua: calcula ações pendentes ─────────────────────────────────────────
  // Renewal: triggera no contract.end_date (só contratos vigentes)
  // Payment: triggera no contract.due_date (inclui cancelados com saldo aberto)
  const computeActions = (ruleType) => {
    const tipoRules = rules.filter(r => (r.rule_type || 'renewal') === ruleType);
    if (!tipoRules.length) return [];

    // Universo de contratos pra avaliar
    let pool;
    if (ruleType === 'payment') {
      // Inclui ativos E cancelados COM saldo em aberto. Exclui contratos já pagos.
      pool = contracts.filter(c => {
        if (c.payment_status === 'paid') return false;
        if (c.payment_status === 'refunded') return false;
        // Cancelado SEM saldo? Pula
        if (c.status === 'cancelled' && !c.asaas_charge_id) return false;
        return true;
      });
    } else {
      // Renewal só age em contratos vigentes
      pool = active;
    }

    if (!pool.length) return [];
    const results = [];
    for (const c of pool) {
      const refDate = ruleType === 'payment' ? c.due_date : c.end_date;
      const daysUntil = daysToDate(refDate);
      if (daysUntil === null) continue;
      for (const r of tipoRules) {
        const triggerThreshold = -r.days_offset;
        if (daysUntil > triggerThreshold) continue;
        const alreadyDone = actionsLog.some(a =>
          a.contract_id === c.id && a.rule_id === r.id
        );
        if (alreadyDone) continue;
        results.push({
          contract: c,
          rule: r,
          daysUntilEnd: daysUntil,
          ruleType,
          ...enrich(c),
        });
      }
    }
    return results.sort((a, b) => {
      if (a.rule.order_index !== b.rule.order_index) return a.rule.order_index - b.rule.order_index;
      return a.daysUntilEnd - b.daysUntilEnd;
    });
  };

  const renewalActions = computeActions('renewal');
  const paymentActions = computeActions('payment');

  // Agrupa por regra dentro de cada tipo
  const groupByRule = (actions) =>
    rules
      .filter(r => actions.some(a => a.rule.id === r.id))
      .map(r => ({ rule: r, items: actions.filter(a => a.rule.id === r.id) }))
      .filter(g => g.items.length > 0);

  const renewalByRule = groupByRule(renewalActions);
  const paymentByRule = groupByRule(paymentActions);

  // Renderiza um grupo de ações da régua (mesmo layout pros dois tipos)
  const renderReguaGroup = ({ rule, items }, ruleType) => {
    const isCharge = rule.action_type === 'generate_charge_and_whatsapp';
    return (
      <div key={rule.id}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">{rule.icon}</span>
          <p className="text-sm font-semibold" style={{ color: rule.color }}>{rule.name}</p>
          <span className="text-[10px] font-bold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
            {rule.days_offset < 0 ? `${Math.abs(rule.days_offset)}d antes` :
             rule.days_offset === 0 ? 'no dia' :
             `${rule.days_offset}d depois`}
          </span>
          <span className="text-xs text-muted-foreground">· {items.length} contrato{items.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="space-y-2">
          {items.map(item => {
            const isActing = actingId === `${item.contract.id}:${item.rule.id}`;
            const refLabel = ruleType === 'payment' ? 'cobrança' : 'vencimento';
            const daysLabel = item.daysUntilEnd === 0 ? `${refLabel} hoje`
                            : item.daysUntilEnd > 0 ? `${refLabel} em ${item.daysUntilEnd}d`
                            : `${Math.abs(item.daysUntilEnd)}d em atraso`;
            return (
              <div key={`${item.contract.id}-${item.rule.id}`}
                className="flex items-center gap-3 p-3 rounded-lg border bg-gray-50/40 hover:bg-white hover:shadow-sm transition-all"
                style={{ borderLeftWidth: 4, borderLeftColor: rule.color }}>
                <div className="flex-1 min-w-0">
                  <Link to={`/assessoria/contratos/${item.contract.id}`}
                    className="font-medium text-sm hover:text-blue-600 truncate block">
                    {item.customer?.full_name || '—'}
                  </Link>
                  <p className="text-xs text-muted-foreground capitalize">
                    {item.modality?.name} · {item.plan?.name?.trim() || periodLabel(item.plan)}
                    {' · '}
                    <span className={item.daysUntilEnd < 0 ? 'text-red-600 font-semibold' : ''}>
                      {daysLabel}
                    </span>
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {isCharge ? (
                    <Button size="sm" variant="default"
                      onClick={() => generateChargeAndWhatsApp(item)} disabled={isActing}>
                      <Zap className="w-3.5 h-3.5 mr-1" />
                      {isActing ? '...' : 'Gerar PIX + WhatsApp'}
                    </Button>
                  ) : (
                    <Button size="sm" variant="default"
                      className="bg-green-600 hover:bg-green-700"
                      onClick={() => sendWhatsApp(item)}>
                      <MessageCircle className="w-3.5 h-3.5 mr-1" />
                      WhatsApp
                    </Button>
                  )}
                  <Button size="sm" variant="outline"
                    onClick={() => markAsDone(item)} disabled={isActing}
                    title="Marcar como feito (sem enviar)">
                    <Check className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Handlers da régua ───────────────────────────────────────────────────────
  const sendWhatsApp = (item) => {
    const phone = '55' + (item.customer?.whatsapp || '').replace(/\D/g, '');
    if (!phone || phone.length < 12) return toast.error('Aluno sem WhatsApp cadastrado');
    const msg = renderTemplate(item.rule.message_template, {
      customer: item.customer,
      plan:     item.plan,
      modality: item.modality,
      contract: item.contract,
      daysUntilEnd: item.daysUntilEnd,
    });
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const generateChargeAndWhatsApp = async (item) => {
    if (!item.customer?.cpf) return toast.error('Cadastre o CPF do aluno antes de gerar cobrança');
    setActingId(item.contract.id + ':' + item.rule.id);
    try {
      // Gera cobrança no Asaas (mesma edge function usada no detalhe)
      const { data, error } = await supabase.functions.invoke('generate-assessment-charge', {
        body: {
          contract_id:  item.contract.id,
          installments: item.contract.installments,
          cpf:          item.customer.cpf,
          billing_type: 'PIX',
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success('Cobrança PIX gerada! Abrindo WhatsApp...');
      // Recarrega contratos para pegar o link novo
      await load();
      // Pega o contrato atualizado e envia
      const fresh = (await AssessmentContract.list('-created_at')).find(c => c.id === item.contract.id);
      const phone = '55' + (item.customer?.whatsapp || '').replace(/\D/g, '');
      const msg = renderTemplate(item.rule.message_template, {
        customer: item.customer,
        plan:     item.plan,
        modality: item.modality,
        contract: fresh || item.contract,
        daysUntilEnd: item.daysUntilEnd,
      });
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
    } catch (e) {
      toast.error('Erro ao gerar cobrança: ' + (e.message || 'desconhecido'));
    } finally { setActingId(null); }
  };

  const markAsDone = async (item) => {
    setActingId(item.contract.id + ':' + item.rule.id);
    try {
      await ContractRenewalAction.create({
        contract_id: item.contract.id,
        rule_id:     item.rule.id,
        rule_type:   item.rule.rule_type || 'renewal',
        status:      'done',
      });
      toast.success('Marcado como feito');
      await load();
    } catch (e) { toast.error(e.message); }
    finally { setActingId(null); }
  };

  // Alunos únicos ativos
  const activeStudentIds = new Set(active.map(c => c.customer_id));

  // Receita por modalidade
  const revenueByModality = modalities.map(m => {
    const mContracts = active.filter(c => {
      const p = plans.find(pl => pl.id === c.plan_id);
      return p?.modality_id === m.id;
    });
    return {
      name:    m.name,
      count:   mContracts.length,
      revenue: mContracts.reduce((acc, c) => {
        const p = plans.find(pl => pl.id === c.plan_id);
        return acc + (p ? Number(p.price_monthly) : 0);
      }, 0),
    };
  }).filter(m => m.count > 0).sort((a, b) => b.revenue - a.revenue);

  // ── Movimentação do mês ───────────────────────────────────────────────────
  const monthStart = (() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
    return toLocalDateStr(d);
  })();
  const monthLabel = new Date().toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

  // Contratos criados nesse mês (usa data LOCAL, não UTC)
  const contratosNoMes  = contracts.filter(c => utcToLocalDateStr(c.created_at) >= monthStart);
  const novosContratos  = contratosNoMes.filter(c => !c.parent_contract_id);
  const renovacoesNoMes = contratosNoMes.filter(c => !!c.parent_contract_id);
  const idsAntesDoMes = new Set(
    contracts.filter(c => utcToLocalDateStr(c.created_at) < monthStart).map(c => c.customer_id)
  );
  const alunosNovosUnicos = new Set(
    novosContratos.filter(c => !idsAntesDoMes.has(c.customer_id)).map(c => c.customer_id)
  );

  // Saídas: contratos que viraram cancelled nesse mês
  const saidasNoMes = contracts.filter(c =>
    c.status === 'cancelled' && utcToLocalDateStr(c.updated_at) >= monthStart
  );

  // Churn rate (proxy): saídas / (ativos + saídas)
  const churnDenom = active.length + saidasNoMes.length;
  const churnRate  = churnDenom > 0 ? (saidasNoMes.length / churnDenom) * 100 : 0;

  // Saldo líquido (novos contratos - saídas)
  const saldoLiquido = novosContratos.length - saidasNoMes.length;

  // ── Performance por coach ──────────────────────────────────────────────────
  const coachStats = coaches
    .filter(co => co.active !== false)
    .map(co => {
      const cContracts = contracts.filter(c => c.coach_id === co.id);
      const cAtivos    = cContracts.filter(c => ['active', 'overdue', 'on_leave'].includes(c.status));
      const cNovos     = cContracts.filter(c =>
        utcToLocalDateStr(c.created_at) >= monthStart && !c.parent_contract_id
      );
      const cRenov     = cContracts.filter(c =>
        utcToLocalDateStr(c.created_at) >= monthStart && !!c.parent_contract_id
      );
      const cSaidas    = cContracts.filter(c =>
        c.status === 'cancelled' && utcToLocalDateStr(c.updated_at) >= monthStart
      );
      const cMrr = cAtivos.reduce((acc, c) => {
        const p = plans.find(pl => pl.id === c.plan_id);
        return acc + (p ? Number(p.price_monthly) : 0);
      }, 0);
      return {
        coach:   co,
        ativos:  cAtivos.length,
        novos:   cNovos.length,
        renov:   cRenov.length,
        saidas:  cSaidas.length,
        mrr:     cMrr,
      };
    })
    .filter(s => s.ativos > 0 || s.novos > 0 || s.saidas > 0)
    .sort((a, b) => b.mrr - a.mrr);

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando painel...</div>;

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Painel da Assessoria</h2>
          <p className="text-sm text-muted-foreground">Visão geral em tempo real</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Atualizar
        </Button>
      </div>

      {/* Alerta de renovações pendentes */}
      {pendingRenewal.length > 0 && (
        <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-amber-600 shrink-0" />
            <p className="text-sm font-semibold text-amber-800">
              {pendingRenewal.length} contrato{pendingRenewal.length !== 1 ? 's' : ''} com renovação automática pendente
            </p>
          </div>
          <Button
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 text-white shrink-0"
            onClick={processRenewals}
            disabled={renewing}
          >
            {renewing ? 'Renovando...' : 'Processar renovações'}
          </Button>
        </div>
      )}

      {/* ── Régua de Renovação ──────────────────────────────────────────────── */}
      {renewalByRule.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-purple-600" />
                Régua de Renovação ({renewalActions.length})
              </CardTitle>
              <Link to="/assessoria/regua" className="text-xs text-blue-600 hover:underline">
                Editar régua →
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">Baseado no vencimento do contrato</p>
          </CardHeader>
          <CardContent className="space-y-5">
            {renewalByRule.map(group => renderReguaGroup(group, 'renewal'))}
          </CardContent>
        </Card>
      )}

      {/* ── Régua de Pagamento ──────────────────────────────────────────────── */}
      {paymentByRule.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-blue-600" />
                Régua de Pagamento ({paymentActions.length})
              </CardTitle>
              <Link to="/assessoria/regua" className="text-xs text-blue-600 hover:underline">
                Editar régua →
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">Baseado na data de cobrança das parcelas</p>
          </CardHeader>
          <CardContent className="space-y-5">
            {paymentByRule.map(group => renderReguaGroup(group, 'payment'))}
          </CardContent>
        </Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-100 rounded-lg flex items-center justify-center">
                <Users className="w-4.5 h-4.5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Alunos ativos</p>
                <p className="text-2xl font-bold text-gray-900">{activeStudentIds.size}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-4.5 h-4.5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Receita mensal</p>
                <p className="text-2xl font-bold text-green-700">{formatCurrency(monthlyRevenue)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={overdue.length > 0 ? 'border-red-200' : ''}>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${overdue.length > 0 ? 'bg-red-100' : 'bg-gray-100'}`}>
                <AlertTriangle className={`w-4.5 h-4.5 ${overdue.length > 0 ? 'text-red-500' : 'text-gray-400'}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Inadimplentes</p>
                <p className={`text-2xl font-bold ${overdue.length > 0 ? 'text-red-600' : 'text-gray-900'}`}>{overdue.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={expiring.length > 0 ? 'border-amber-200' : ''}>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${expiring.length > 0 ? 'bg-amber-100' : 'bg-gray-100'}`}>
                <Clock className={`w-4.5 h-4.5 ${expiring.length > 0 ? 'text-amber-600' : 'text-gray-400'}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Vencendo em 30d</p>
                <p className={`text-2xl font-bold ${expiring.length > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{expiring.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dois alertas lado a lado */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Contratos em atraso */}
        <Card className={overdue.length > 0 ? 'border-red-200' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <XCircle className="w-4 h-4 text-red-500" />
              Inadimplentes ({overdue.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overdue.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4 flex items-center justify-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Nenhum contrato em atraso
              </p>
            ) : (
              <div className="divide-y max-h-64 overflow-y-auto">
                {overdue.map(c => { const e = enrich(c); return (
                  <Link key={c.id} to={`/assessoria/contratos/${c.id}`} className="flex items-center gap-3 py-2 hover:bg-red-50 rounded px-1 -mx-1">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{e.customer?.full_name || '—'}</p>
                      <p className="text-xs text-muted-foreground capitalize">{e.modality?.name} · {periodLabel(e.plan)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono text-blue-700">{c.contract_number}</p>
                      <p className="text-xs text-red-600">vence {formatDate(c.end_date)}</p>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  </Link>
                ); })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Contratos vencendo em 30 dias */}
        <Card className={expiring.length > 0 ? 'border-amber-200' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-500" />
              Vencendo em 30 dias ({expiring.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {expiring.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4 flex items-center justify-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Nenhum contrato vencendo em breve
              </p>
            ) : (
              <div className="divide-y max-h-64 overflow-y-auto">
                {expiring.sort((a, b) => a.end_date.localeCompare(b.end_date)).map(c => { const e = enrich(c); return (
                  <Link key={c.id} to={`/assessoria/contratos/${c.id}`} className="flex items-center gap-3 py-2 hover:bg-amber-50 rounded px-1 -mx-1">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{e.customer?.full_name || '—'}</p>
                      <p className="text-xs text-muted-foreground capitalize">{e.modality?.name} · {periodLabel(e.plan)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-mono text-blue-700">{c.contract_number}</p>
                      <p className="text-xs text-amber-600 font-medium">vence {formatDate(c.end_date)}</p>
                    </div>
                    {c.auto_renewal
                      ? <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium shrink-0">auto</span>
                      : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    }
                  </Link>
                ); })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Movimentação do mês ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-600" />
            Movimentação · <span className="capitalize text-muted-foreground font-normal">{monthLabel}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Novos contratos */}
            <div className="rounded-xl border border-green-200 bg-green-50/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <UserPlus className="w-4 h-4 text-green-600" />
                <p className="text-xs text-green-700 font-medium">Novos contratos</p>
              </div>
              <p className="text-2xl font-bold text-green-700">{novosContratos.length}</p>
              <p className="text-xs text-green-600 mt-0.5">
                {alunosNovosUnicos.size} aluno{alunosNovosUnicos.size !== 1 ? 's' : ''} novo{alunosNovosUnicos.size !== 1 ? 's' : ''}
              </p>
            </div>

            {/* Renovações */}
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <RotateCcw className="w-4 h-4 text-blue-600" />
                <p className="text-xs text-blue-700 font-medium">Renovações</p>
              </div>
              <p className="text-2xl font-bold text-blue-700">{renovacoesNoMes.length}</p>
              <p className="text-xs text-blue-600 mt-0.5">retenção</p>
            </div>

            {/* Saídas */}
            <div className={`rounded-xl border p-3 ${saidasNoMes.length > 0 ? 'border-red-200 bg-red-50/50' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-2 mb-1">
                <UserMinus className={`w-4 h-4 ${saidasNoMes.length > 0 ? 'text-red-600' : 'text-gray-400'}`} />
                <p className={`text-xs font-medium ${saidasNoMes.length > 0 ? 'text-red-700' : 'text-muted-foreground'}`}>Saídas</p>
              </div>
              <p className={`text-2xl font-bold ${saidasNoMes.length > 0 ? 'text-red-600' : 'text-gray-500'}`}>{saidasNoMes.length}</p>
              <p className="text-xs text-muted-foreground mt-0.5">cancelados</p>
            </div>

            {/* Churn % */}
            <div className={`rounded-xl border p-3 ${churnRate > 5 ? 'border-red-200 bg-red-50/50' : churnRate > 2 ? 'border-amber-200 bg-amber-50/50' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-2 mb-1">
                <TrendingDown className={`w-4 h-4 ${churnRate > 5 ? 'text-red-600' : churnRate > 2 ? 'text-amber-600' : 'text-gray-400'}`} />
                <p className="text-xs font-medium text-muted-foreground">Taxa de churn</p>
              </div>
              <p className={`text-2xl font-bold ${churnRate > 5 ? 'text-red-600' : churnRate > 2 ? 'text-amber-600' : 'text-gray-700'}`}>
                {churnRate.toFixed(1)}%
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                saldo: <span className={saldoLiquido >= 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                  {saldoLiquido >= 0 ? '+' : ''}{saldoLiquido}
                </span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Performance por coach ─────────────────────────────────────────────── */}
      {coachStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Award className="w-4 h-4 text-purple-600" />
              Performance por coach
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="overflow-x-auto -mx-6 px-6">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left py-2 font-medium">Coach</th>
                    <th className="text-right py-2 font-medium">Ativos</th>
                    <th className="text-right py-2 font-medium" title="Novos contratos esse mês">Novos</th>
                    <th className="text-right py-2 font-medium" title="Renovações esse mês">Renov.</th>
                    <th className="text-right py-2 font-medium" title="Cancelamentos esse mês">Saídas</th>
                    <th className="text-right py-2 font-medium">MRR</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {coachStats.map(s => (
                    <tr key={s.coach.id} className="hover:bg-gray-50">
                      <td className="py-2.5">
                        <p className="font-medium">{s.coach.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{s.coach.role}</p>
                      </td>
                      <td className="py-2.5 text-right font-bold text-blue-700">{s.ativos}</td>
                      <td className="py-2.5 text-right">
                        {s.novos > 0
                          ? <span className="text-green-600 font-semibold">+{s.novos}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 text-right">
                        {s.renov > 0
                          ? <span className="text-blue-600 font-semibold">↻{s.renov}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 text-right">
                        {s.saidas > 0
                          ? <span className="text-red-600 font-semibold">−{s.saidas}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2.5 text-right font-semibold text-green-700">{formatCurrency(s.mrr)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 font-semibold bg-gray-50/50">
                    <td className="py-2.5">Total</td>
                    <td className="py-2.5 text-right text-blue-700">{coachStats.reduce((s, c) => s + c.ativos, 0)}</td>
                    <td className="py-2.5 text-right text-green-600">
                      {coachStats.reduce((s, c) => s + c.novos, 0) > 0
                        ? `+${coachStats.reduce((s, c) => s + c.novos, 0)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-blue-600">
                      {coachStats.reduce((s, c) => s + c.renov, 0) > 0
                        ? `↻${coachStats.reduce((s, c) => s + c.renov, 0)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-red-600">
                      {coachStats.reduce((s, c) => s + c.saidas, 0) > 0
                        ? `−${coachStats.reduce((s, c) => s + c.saidas, 0)}` : '—'}
                    </td>
                    <td className="py-2.5 text-right text-green-700">
                      {formatCurrency(coachStats.reduce((s, c) => s + c.mrr, 0))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Receita por modalidade */}
      {revenueByModality.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-blue-600" />
              Receita por modalidade
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {revenueByModality.map(m => (
                <div key={m.name}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium capitalize">{m.name}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground text-xs">{m.count} aluno{m.count !== 1 ? 's' : ''}</span>
                      <span className="font-bold text-green-700">{formatCurrency(m.revenue)}/mês</span>
                    </div>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${Math.round((m.revenue / monthlyRevenue) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              <div className="pt-2 border-t flex justify-between text-sm font-semibold">
                <span>Total</span>
                <span className="text-green-700">{formatCurrency(monthlyRevenue)}/mês</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Contratos ativos */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-600" />
              Contratos ativos ({active.length})
            </CardTitle>
            <Button size="sm" onClick={() => navigate('/assessoria/contratos/novo')}>
              + Novo contrato
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Nenhum contrato ativo</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b">
                  <tr>
                    <th className="text-left py-2 px-1 font-medium text-muted-foreground text-xs">Aluno</th>
                    <th className="text-left py-2 px-1 font-medium text-muted-foreground text-xs">Modalidade</th>
                    <th className="text-left py-2 px-1 font-medium text-muted-foreground text-xs">Coach</th>
                    <th className="text-right py-2 px-1 font-medium text-muted-foreground text-xs">Vencimento</th>
                    <th className="text-center py-2 px-1 font-medium text-muted-foreground text-xs">Status</th>
                    <th className="text-center py-2 px-1 font-medium text-muted-foreground text-xs">Auto</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {active.map(c => { const e = enrich(c); return (
                    <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/assessoria/contratos/${c.id}`)}>
                      <td className="py-2.5 px-1 font-medium">{e.customer?.full_name || '—'}</td>
                      <td className="py-2.5 px-1 text-muted-foreground text-xs capitalize">{e.modality?.name} · {periodLabel(e.plan)}</td>
                      <td className="py-2.5 px-1 text-muted-foreground text-xs">{e.coach?.name || '—'}</td>
                      <td className="py-2.5 px-1 text-right text-xs">{formatDate(c.end_date)}</td>
                      <td className="py-2.5 px-1 text-center">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_CLS[c.status] || ''}`}>
                          {STATUS_LABEL[c.status] || c.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-1 text-center">
                        {c.auto_renewal
                          ? <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">auto</span>
                          : <span className="text-xs text-gray-300">—</span>
                        }
                      </td>
                      <td className="py-2.5 px-1"><ChevronRight className="w-3.5 h-3.5 text-muted-foreground" /></td>
                    </tr>
                  ); })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
