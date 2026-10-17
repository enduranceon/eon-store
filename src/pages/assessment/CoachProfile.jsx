import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, BarChart3, ClipboardList, DollarSign, Globe, Hourglass, RefreshCw,
  TrendingDown, TrendingUp, UserMinus, UserPlus, Users, Wallet,
} from 'lucide-react';
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { supabase } from '@/api/db';
import { AssessmentCoach, AssessmentCoachSitePlan, AssessmentCoachWaitlist } from '@/api/entities';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import CoachWaitlistPanel, { AvailabilityBadge } from '@/components/assessment/CoachWaitlistPanel';
import { usePageData } from '@/hooks/usePageData';
import { loadAssessmentMetricContracts, loadAssessmentMetricPlans } from '@/lib/assessment-metric-data';
import { periodLabel as sitePeriodLabel } from '@/lib/coach-site-plans';
import { buildCoachProfile } from '@/lib/coach-profile';
import { isOpenWaitlistEntry } from '@/lib/coach-waitlist';
import { studentProfilePath } from '@/lib/customer-profile';
import { fetchAllPages } from '@/lib/fetch-all-pages';
import { cn, formatCompetence, formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { commissionAmountText, summarizeOrderCommissions } from '@/lib/product-commission';

const ROLE_LABEL = { junior: 'Junior', pleno: 'Pleno', senior: 'Senior' };
const TABS = ['geral', 'alunos', 'movimento', 'recebimentos', 'funil', 'espera', 'site'];
const SITUATION_TONES = {
  overdue: 'bg-red-50 text-red-700 border-red-200',
  leave: 'bg-sky-50 text-sky-700 border-sky-200',
  renewal: 'bg-violet-50 text-violet-700 border-violet-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};
const INITIAL_DATA = {
  coach: null, contracts: [], plans: [], modalities: [], customers: [], closings: [],
  statementItems: [], pendingRepasse: [], sitePlans: [], waitlist: [], productCommissions: [],
};

async function readAll(buildQuery) {
  const { data, error } = await fetchAllPages(buildQuery);
  if (error) throw error;
  return data;
}

async function loadCoachProfile(coachId) {
  const [coach, contracts, plans, modalities, customers, closings, statementItems, pendingRepasse, sitePlans, waitlist, productCommissions] = await Promise.all([
    AssessmentCoach.get(coachId),
    loadAssessmentMetricContracts(supabase),
    loadAssessmentMetricPlans(supabase),
    readAll(() => supabase.from('assessment_modalities').select('id,name').order('id')),
    readAll(() => supabase.from('presale_customers').select('id,full_name').order('id')),
    readAll(() => supabase.from('payout_monthly_closings').select('id,competence,status').order('id')),
    readAll(() => supabase.from('payout_monthly_statement_items').select('id,closing_id,amount').eq('coach_id', coachId).order('id')),
    readAll(() => supabase.from('payout_pending_repasse').select('id,amount').eq('coach_id', coachId).eq('status', 'open').order('id')),
    AssessmentCoachSitePlan.list(),
    AssessmentCoachWaitlist.list('created_at'),
    readAll(() => supabase.from('product_commissions')
      .select('id,order_type,order_id,order_number,customer_name,product_name,quantity,commission_type,commission_value,amount,kind,reason,competence,closing_id,created_at')
      .eq('coach_id', coachId).order('id')),
  ]);
  return {
    coach, contracts, plans, modalities, customers, closings, statementItems, pendingRepasse, productCommissions,
    sitePlans: sitePlans.filter(row => row.coach_id === coachId),
    waitlist: waitlist.filter(row => row.coach_id === coachId),
  };
}

function percent(value) {
  return `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;
}

function StatCard({ icon: Icon, label, value, sub, tone = 'text-blue-700 bg-blue-50 border-blue-100' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 tabular-nums">{value}</p>
            {sub && <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>}
          </div>
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border', tone)}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Empty({ children }) {
  return <p className="rounded-lg border border-dashed bg-white p-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function Table({ head, children }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="w-full text-sm">
        <thead className="border-b bg-gray-50">
          <tr>{head.map(([label, align]) => (
            <th key={label} className={cn('px-3 py-2.5 font-medium text-muted-foreground', align === 'right' ? 'text-right' : 'text-left')}>{label}</th>
          ))}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

function PersonLink({ id, name }) {
  if (!id) return <span>{name || 'Pessoa'}</span>;
  return <Link to={studentProfilePath(id)} className="font-medium text-gray-900 hover:text-blue-700 hover:underline">{name || 'Pessoa'}</Link>;
}

export default function CoachProfile() {
  const { coachId } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('aba')) ? params.get('aba') : 'geral';
  const today = todayLocalStr();

  const { data, loading, refreshing, refresh } = usePageData({
    key: `assessment-coach-profile:${coachId}:v1`,
    loader: () => loadCoachProfile(coachId),
    initialData: INITIAL_DATA,
    tags: ['assessment_contracts', 'assessment_plans', 'assessment_coaches', 'presale_customers', 'payout_monthly_closings', 'assessment_coach_site_plans', 'assessment_coach_waitlist', 'product_commissions'],
    onError: error => {
      console.error('Erro ao carregar o perfil do coach:', error);
      toast.error('Erro ao carregar o perfil do coach');
    },
  });

  const names = useMemo(() => {
    const customers = new Map(data.customers.map(row => [row.id, row.full_name]));
    const modalities = new Map(data.modalities.map(row => [row.id, row.name]));
    return {
      customer: id => customers.get(id) || '',
      modality: id => modalities.get(id) || 'Sem modalidade',
    };
  }, [data.customers, data.modalities]);

  // Comissões de produtos do coach, mais recentes primeiro.
  const commissions = useMemo(() => {
    const { list } = summarizeOrderCommissions(data.productCommissions || [], data.coach ? { [data.coach.id]: data.coach } : {});
    const sum = rows => rows.reduce((total, row) => total + row.amount, 0);
    return {
      list: [...list].reverse(),
      open: sum(list.filter(row => !row.closing_id)),
      included: sum(list.filter(row => row.closing_id)),
    };
  }, [data.productCommissions, data.coach]);

  const profile = useMemo(() => (data.coach ? buildCoachProfile({
    coachId,
    contracts: data.contracts,
    plans: data.plans,
    today,
    closings: data.closings,
    statementItems: data.statementItems,
    pendingRepasse: data.pendingRepasse,
  }) : null), [coachId, data, today]);

  const students = useMemo(() => (profile?.students || [])
    .map(student => ({ ...student, name: names.customer(student.customerId) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [profile, names]);

  if (loading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-muted-foreground">
        <RefreshCw className="w-5 h-5 text-blue-600 animate-spin mr-2" /> Carregando perfil do coach...
      </div>
    );
  }
  if (!data.coach || !profile) {
    return (
      <div className="space-y-3">
        <Link to="/assessoria/coaches" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline"><ArrowLeft className="w-4 h-4" /> Equipe</Link>
        <Empty>Coach não encontrado.</Empty>
      </div>
    );
  }

  const { coach } = data;
  const { kpis } = profile;
  const openWaitlist = data.waitlist.filter(isOpenWaitlistEntry).length;
  const chart = profile.monthly.map(month => ({
    label: month.label.split(' ')[0],
    active: month.baseEnd,
    entries: month.entries + month.returns,
    exits: month.exits,
  }));
  const setTab = value => setParams(current => {
    const next = new URLSearchParams(current);
    if (value === 'geral') next.delete('aba'); else next.set('aba', value);
    return next;
  }, { replace: true });

  return (
    <div className="space-y-5 pb-8">
      <Link to="/assessoria/coaches" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">
        <ArrowLeft className="w-4 h-4" /> Equipe
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold text-gray-900">{coach.name}</h2>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">{ROLE_LABEL[coach.role] || coach.role}</span>
            {!coach.active && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">Inativo</span>}
            {coach.active && <AvailabilityBadge coach={coach} />}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {(coach.modality_ids || []).map(names.modality).join(' · ') || 'Sem modalidade'}
            {' · '}{coach.active && coach.public_visible ? 'Aparece no site' : 'Fora do site'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/assessoria/movimento?coach=${coach.id}`}><BarChart3 className="w-4 h-4 mr-1.5" /> Entradas e saídas</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/assessoria/coaches/${coach.id}/match`}><ClipboardList className="w-4 h-4 mr-1.5" /> Formulário de match</Link>
          </Button>
          <Button variant="outline" size="icon" onClick={() => refresh({ force: true })} disabled={refreshing} title="Atualizar" aria-label="Atualizar">
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="geral">Visão geral</TabsTrigger>
          <TabsTrigger value="alunos">Alunos ({kpis.active})</TabsTrigger>
          <TabsTrigger value="movimento">Mês a mês</TabsTrigger>
          <TabsTrigger value="recebimentos">Recebimentos</TabsTrigger>
          <TabsTrigger value="funil">Prospects e renovações ({profile.prospects.length + profile.renewals.length})</TabsTrigger>
          <TabsTrigger value="espera">Lista de espera ({openWaitlist})</TabsTrigger>
          <TabsTrigger value="site">Site</TabsTrigger>
        </TabsList>

        <TabsContent value="geral" className="mt-4 space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={Users} label="Alunos ativos" value={kpis.active} sub="hoje" />
            <StatCard icon={Wallet} label="Carteira por mês" value={formatCurrency(kpis.monthlyRevenue)} sub="mensalidade dos alunos ativos"
              tone="text-emerald-700 bg-emerald-50 border-emerald-100" />
            <StatCard icon={UserPlus} label="Entradas (12 meses)" value={kpis.entries + kpis.returns}
              sub={`${kpis.entries} novos · ${kpis.returns} retornos`} tone="text-emerald-700 bg-emerald-50 border-emerald-100" />
            <StatCard icon={UserMinus} label="Saídas (12 meses)" value={kpis.exits}
              sub={`churn médio ${percent(kpis.averageChurn)} ao mês`} tone="text-red-700 bg-red-50 border-red-100" />
            <StatCard icon={kpis.net >= 0 ? TrendingUp : TrendingDown} label="Saldo (12 meses)" value={`${kpis.net > 0 ? '+' : ''}${kpis.net}`}
              sub="entradas + retornos − saídas" tone={kpis.net >= 0 ? 'text-emerald-700 bg-emerald-50 border-emerald-100' : 'text-red-700 bg-red-50 border-red-100'} />
            <StatCard icon={RefreshCw} label="Renovações (12 meses)" value={kpis.renewals} sub={`${profile.renewals.length} em andamento agora`}
              tone="text-violet-700 bg-violet-50 border-violet-100" />
            <StatCard icon={Hourglass} label="Lista de espera" value={openWaitlist} sub={`${profile.prospects.length} prospects em negociação`}
              tone="text-amber-700 bg-amber-50 border-amber-100" />
            <StatCard icon={DollarSign} label="Repasse em aberto" value={formatCurrency(profile.pending.total)}
              sub={`${profile.pending.count} pendência${profile.pending.count === 1 ? '' : 's'} de pagamento`} tone="text-slate-700 bg-slate-50 border-slate-200" />
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle className="text-base">Alunos ativos por mês</CardTitle></CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chart} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                      <YAxis yAxisId="flow" allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={34} />
                      <YAxis yAxisId="base" orientation="right" allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={34} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                      <Bar yAxisId="flow" dataKey="entries" name="Entradas e retornos" fill="#16a34a" radius={[4, 4, 0, 0]} maxBarSize={20} />
                      <Bar yAxisId="flow" dataKey="exits" name="Saídas" fill="#dc2626" radius={[4, 4, 0, 0]} maxBarSize={20} />
                      <Line yAxisId="base" type="monotone" dataKey="active" name="Alunos ativos" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Por modalidade</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {profile.byModality.length === 0 ? <p className="text-sm text-muted-foreground">Sem alunos ativos.</p> : profile.byModality.map(group => (
                  <div key={group.modalityId || 'none'} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                    <span className="capitalize">{names.modality(group.modalityId)}</span>
                    <span className="text-right"><b className="tabular-nums">{group.students}</b> <span className="text-muted-foreground">· {formatCurrency(group.monthlyRevenue)}/mês</span></span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="alunos" className="mt-4 space-y-5">
          <section className="space-y-2">
            <h3 className="font-semibold text-gray-900">Ativos hoje ({students.length})</h3>
            {students.length === 0 ? <Empty>Nenhum aluno ativo.</Empty> : (
              <Table head={[['Aluno'], ['Plano'], ['Fim do contrato'], ['Mensalidade', 'right'], ['Situação']]}>
                {students.map(student => (
                  <tr key={student.contractId} className="hover:bg-gray-50">
                    <td className="px-3 py-2.5"><PersonLink id={student.customerId} name={student.name} /></td>
                    <td className="px-3 py-2.5 text-muted-foreground">{student.planName || names.modality(student.modalityId)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{student.endDate ? formatDate(student.endDate) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(student.monthlyValue)}</td>
                    <td className="px-3 py-2.5">
                      <Link to={`/assessoria/contratos/${student.renewalContractId || student.contractId}`}
                        className={cn('inline-block rounded-full border px-2 py-0.5 text-xs font-medium hover:underline', SITUATION_TONES[student.situation.key])}>
                        {student.situation.label}
                      </Link>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </section>
          <section className="space-y-2">
            <h3 className="font-semibold text-gray-900">Saíram nos últimos 12 meses ({profile.exits.length})</h3>
            <p className="text-xs text-muted-foreground">Só saídas reais: troca de plano, venda descartada e estorno total não entram.</p>
            {profile.exits.length === 0 ? <Empty>Nenhuma saída no período.</Empty> : (
              <Table head={[['Aluno'], ['Saída'], ['Plano'], ['Motivo']]}>
                {profile.exits.map(exit => (
                  <tr key={exit.contractId} className="hover:bg-gray-50">
                    <td className="px-3 py-2.5"><PersonLink id={exit.customerId} name={names.customer(exit.customerId)} /></td>
                    <td className="px-3 py-2.5 tabular-nums">{formatDate(exit.date)}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{exit.planName}</td>
                    <td className="px-3 py-2.5">{exit.reason || <span className="text-muted-foreground">Sem motivo registrado</span>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </section>
        </TabsContent>

        <TabsContent value="movimento" className="mt-4 space-y-2">
          <Table head={[['Mês'], ['Base no início', 'right'], ['Entradas', 'right'], ['Retornos', 'right'], ['Renovações', 'right'], ['Saídas', 'right'], ['Base no fim', 'right'], ['Churn', 'right']]}>
            {[...profile.monthly].reverse().map(month => (
              <tr key={month.month} className="hover:bg-gray-50 tabular-nums">
                <td className="px-3 py-2.5 font-medium">{month.label}</td>
                <td className="px-3 py-2.5 text-right">{month.baseStart}</td>
                <td className="px-3 py-2.5 text-right text-emerald-700">{month.entries || '—'}</td>
                <td className="px-3 py-2.5 text-right text-orange-700">{month.returns || '—'}</td>
                <td className="px-3 py-2.5 text-right text-violet-700">{month.renewals || '—'}</td>
                <td className="px-3 py-2.5 text-right text-red-700">{month.exits || '—'}</td>
                <td className="px-3 py-2.5 text-right font-semibold">{month.baseEnd}</td>
                <td className="px-3 py-2.5 text-right">{percent(month.churnRate)}</td>
              </tr>
            ))}
          </Table>
          <Link to={`/assessoria/movimento?coach=${coach.id}`} className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">
            Ver quem entrou e saiu em Entradas e saídas <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </TabsContent>

        <TabsContent value="recebimentos" className="mt-4 space-y-4">
          {profile.pending.count > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {formatCurrency(profile.pending.total)} de repasse esperando o pagamento do aluno ({profile.pending.count} pendência{profile.pending.count === 1 ? '' : 's'}).
              Entra no fechamento do mês em que o aluno pagar.
            </p>
          )}
          {profile.payouts.length === 0 ? <Empty>Nenhum fechamento com repasse para este coach.</Empty> : (
            <Table head={[['Competência'], ['Fechamento'], ['Lançamentos', 'right'], ['Repasse', 'right'], ['']]}>
              {profile.payouts.map(row => (
                <tr key={row.closingId} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 font-medium">{formatCompetence(row.competence)}</td>
                  <td className="px-3 py-2.5">{row.statusLabel}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.items}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{formatCurrency(row.total)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <Link to={`/assessoria/fechamento/${row.closingId}/extrato/${coach.id}`} className="text-blue-700 hover:underline">Extrato</Link>
                  </td>
                </tr>
              ))}
            </Table>
          )}

          <section className="space-y-2">
            <h3 className="font-semibold text-gray-900">Comissões de produtos</h3>
            {commissions.list.length === 0 ? (
              <Empty>Nenhuma comissão de produto. Ela aparece quando um aluno deste coach paga um produto com comissão.</Empty>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {formatCurrency(commissions.open)} aguardando o próximo fechamento · {formatCurrency(commissions.included)} já levados ao repasse.
                </p>
                <Table head={[['Ref.'], ['Venda'], ['Produto'], ['Valor', 'right'], ['Situação']]}>
                  {commissions.list.slice(0, 30).map(entry => (
                    <tr key={entry.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5 tabular-nums">{entry.competenceLabel}</td>
                      <td className="px-3 py-2.5">
                        <Link
                          to={entry.order_type === 'stock' ? `/estoque/pedidos/${entry.order_id}` : `/pedidos/${entry.order_id}`}
                          className="font-mono text-xs text-blue-700 hover:underline"
                        >
                          {entry.order_number || 'Pedido'}
                        </Link>
                        {entry.customer_name && <span className="block text-xs text-muted-foreground">{entry.customer_name}</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {entry.product_name} · {entry.quantity} un. · {entry.ruleLabel}
                        {entry.kind === 'adjustment' && <span className="block text-xs text-muted-foreground">Ajuste: {entry.reason}</span>}
                      </td>
                      <td className={cn('px-3 py-2.5 text-right font-semibold tabular-nums', entry.amount < 0 && 'text-red-600')}>
                        {commissionAmountText(entry.amount)}
                      </td>
                      <td className="px-3 py-2.5">{entry.statusLabel}</td>
                    </tr>
                  ))}
                </Table>
              </>
            )}
          </section>
        </TabsContent>

        <TabsContent value="funil" className="mt-4 space-y-5">
          <section className="space-y-2">
            <h3 className="font-semibold text-gray-900">Prospects em negociação ({profile.prospects.length})</h3>
            {profile.prospects.length === 0 ? <Empty>Nenhum prospect aberto com este coach.</Empty> : (
              <Table head={[['Pessoa'], ['Etapa'], ['Plano'], ['Desde']]}>
                {profile.prospects.map(prospect => (
                  <tr key={prospect.contractId} className="hover:bg-gray-50">
                    <td className="px-3 py-2.5"><PersonLink id={prospect.customerId} name={names.customer(prospect.customerId)} /></td>
                    <td className="px-3 py-2.5">{prospect.stageLabel}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{prospect.planName}</td>
                    <td className="px-3 py-2.5 tabular-nums">{formatDate(String(prospect.createdAt).slice(0, 10))}</td>
                  </tr>
                ))}
              </Table>
            )}
            <Link to="/assessoria/prospects" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">Abrir o quadro de Prospects <ArrowRight className="w-3.5 h-3.5" /></Link>
          </section>
          <section className="space-y-2">
            <h3 className="font-semibold text-gray-900">Renovações em andamento ({profile.renewals.length})</h3>
            {profile.renewals.length === 0 ? <Empty>Nenhuma renovação em andamento.</Empty> : (
              <Table head={[['Aluno'], ['Etapa'], ['Plano'], ['Contrato atual termina']]}>
                {profile.renewals.map(renewal => (
                  <tr key={renewal.contractId} className="hover:bg-gray-50">
                    <td className="px-3 py-2.5">
                      <PersonLink id={renewal.customerId} name={names.customer(renewal.customerId)} />
                      {renewal.coachChange === 'arriving' && <span className="ml-2 text-xs text-emerald-700">vem de outro coach</span>}
                      {renewal.coachChange === 'leaving' && <span className="ml-2 text-xs text-amber-700">vai para outro coach</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link to={`/assessoria/contratos/${renewal.contractId}`} className="text-blue-700 hover:underline">{renewal.stageLabel}</Link>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{renewal.planName}</td>
                    <td className="px-3 py-2.5 tabular-nums">{renewal.endsOn ? formatDate(renewal.endsOn) : '—'}</td>
                  </tr>
                ))}
              </Table>
            )}
            <Link to="/assessoria/renovacoes" className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline">Abrir o quadro de Renovações <ArrowRight className="w-3.5 h-3.5" /></Link>
          </section>
        </TabsContent>

        <TabsContent value="espera" className="mt-4">
          <CoachWaitlistPanel coachId={coach.id} />
        </TabsContent>

        <TabsContent value="site" className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Card><CardContent className="space-y-1 p-4 text-sm">
              <p className="flex items-center gap-2 font-semibold"><Globe className="w-4 h-4 text-violet-600" /> No site</p>
              <p>{coach.active && coach.public_visible ? 'Aparece no formulário do site.' : 'Não aparece no site.'}</p>
              <p>{coach.accepting_new_students === false
                ? 'Não recebe novos alunos: o site mostra a lista de espera no lugar do cadastro.'
                : 'Recebe novos alunos pelo site.'}</p>
              <p className="text-xs text-muted-foreground">Para mudar, edite o coach em <Link to="/assessoria/coaches" className="text-blue-700 hover:underline">Equipe</Link>.</p>
            </CardContent></Card>
            <Card><CardContent className="space-y-1 p-4 text-sm">
              <p className="flex items-center gap-2 font-semibold"><ClipboardList className="w-4 h-4 text-blue-600" /> Perfil de match</p>
              <p>Respostas do coach que o site usa para indicar o treinador certo.</p>
              <Link to={`/assessoria/coaches/${coach.id}/match`} className="inline-flex items-center gap-1 text-blue-700 hover:underline">Abrir o formulário de match <ArrowRight className="w-3.5 h-3.5" /></Link>
            </CardContent></Card>
          </div>
          <section className="space-y-2">
            <h3 className="font-semibold text-gray-900">Planos que vende no site</h3>
            {data.sitePlans.length === 0 ? <Empty>Usa os planos gerais do site.</Empty> : (
              <Table head={[['Modalidade'], ['Duração'], ['Plano'], ['Mensal', 'right']]}>
                {[...data.sitePlans]
                  .sort((a, b) => names.modality(a.modality_id).localeCompare(names.modality(b.modality_id)) || a.period_months - b.period_months)
                  .map(row => {
                    const plan = data.plans.find(item => item.id === row.plan_id);
                    return (
                      <tr key={row.id}>
                        <td className="px-3 py-2.5 capitalize">{names.modality(row.modality_id)}</td>
                        <td className="px-3 py-2.5">{sitePeriodLabel(row.period_months)}</td>
                        <td className="px-3 py-2.5">{plan?.name || 'Plano'}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{plan ? formatCurrency(Number(plan.price_monthly)) : '—'}</td>
                      </tr>
                    );
                  })}
              </Table>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
