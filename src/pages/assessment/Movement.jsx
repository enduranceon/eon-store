import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, Info, Minus, Repeat2, RefreshCw,
  TrendingDown, TrendingUp, UserMinus, UserPlus, UserRoundCheck, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import ContextTabs from '@/components/layout/ContextTabs';
import { supabase } from '@/api/db';
import { loadAssessmentMetricContracts, loadAssessmentMetricPlans } from '@/lib/assessment-metric-data';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePageData } from '@/hooks/usePageData';
import { studentProfilePath } from '@/lib/customer-profile';
import {
  MOVEMENT_KINDS,
  MOVEMENT_PERIODS,
  buildAssessmentMovement,
  movementPeriod,
} from '@/lib/assessment-movement';
import { cn, formatDate, todayLocalStr } from '@/lib/utils';

const INITIAL_DATA = { contracts: [], plans: [], coaches: [], modalities: [], customers: [] };

async function fetchAllRows(table, columns) {
  const rows = [];
  let cursor = null;
  while (true) {
    let query = supabase.from(table).select(columns).order('id', { ascending: true }).limit(1000);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < 1000) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

async function loadMovementData() {
  const [contracts, plans, coaches, modalities, customers] = await Promise.all([
    loadAssessmentMetricContracts(supabase),
    loadAssessmentMetricPlans(supabase),
    fetchAllRows('assessment_coaches', 'id,name,active'),
    fetchAllRows('assessment_modalities', 'id,name'),
    fetchAllRows('presale_customers', 'id,full_name'),
  ]);
  return { contracts, plans, coaches, modalities, customers };
}

const KPI_CARDS = [
  { key: 'baseStart', icon: Users, tone: 'slate', sub: 'ativos no dia anterior' },
  { key: 'entries', icon: UserPlus, tone: 'emerald', sub: 'novos alunos', sign: '+' },
  { key: 'returns', icon: UserRoundCheck, tone: 'orange', sub: 'ex-alunos que voltaram', sign: '+' },
  { key: 'renewals', icon: Repeat2, tone: 'violet', sub: 'retenção' },
  { key: 'exits', icon: UserMinus, tone: 'red', sub: 'saídas reais', sign: '−', lowerIsBetter: true },
  { key: 'baseEnd', icon: Users, tone: 'blue', sub: 'ativos no último dia' },
];

const TONES = {
  blue: 'bg-blue-50 text-blue-700 border-blue-100',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  orange: 'bg-orange-50 text-orange-700 border-orange-100',
  violet: 'bg-violet-50 text-violet-700 border-violet-100',
  red: 'bg-red-50 text-red-700 border-red-100',
  slate: 'bg-slate-50 text-slate-700 border-slate-200',
};

function formatPercent(value) {
  return `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;
}

function Delta({ current, previous, lowerIsBetter = false, percent = false }) {
  const diff = (Number(current) || 0) - (Number(previous) || 0);
  if (Math.abs(diff) < (percent ? 0.05 : 1)) {
    return <span className="inline-flex items-center gap-0.5 text-muted-foreground"><Minus className="w-3 h-3" /> igual</span>;
  }
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight;
  const text = percent ? `${diff > 0 ? '+' : ''}${diff.toFixed(1).replace('.', ',')} p.p.` : `${diff > 0 ? '+' : ''}${diff}`;
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-medium', good ? 'text-emerald-700' : 'text-red-700')}>
      <Icon className="w-3 h-3" /> {text}
    </span>
  );
}

function KpiCard({ icon: Icon, tone, label, value, sub, previousLabel, previousValue, delta, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Card className={cn(onClick && 'transition hover:border-blue-300 hover:shadow-md')}>
      <Tag
        type={onClick ? 'button' : undefined}
        onClick={onClick}
        className={cn('block w-full p-4 text-left', onClick && 'cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 rounded-xl')}
        aria-label={onClick ? `${label}: ${value}. Ver a lista` : undefined}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
            <p className="text-[11px] text-muted-foreground mt-1 truncate">{sub}</p>
          </div>
          <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', TONES[tone])}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-1 border-t pt-2 text-[11px]">
          <span className="text-muted-foreground">{previousLabel}: <b className="text-gray-700">{previousValue}</b></span>
          {delta}
        </div>
        {onClick && <p className="mt-1 text-[11px] font-medium text-blue-700">Ver quem →</p>}
      </Tag>
    </Card>
  );
}

function CountButton({ value, onClick, tone }) {
  if (!value) return <span className="text-gray-300">0</span>;
  return (
    <button type="button" onClick={onClick}
      className={cn('min-w-8 rounded-md px-2 py-1 font-semibold hover:bg-blue-50 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500', tone)}>
      {value}
    </button>
  );
}

function BreakdownTable({ title, rows, nameOf, onOpen }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Sem movimento no período.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 text-left font-medium">Nome</th>
                  <th className="py-2 text-right font-medium">Base início</th>
                  <th className="py-2 text-right font-medium">Entradas</th>
                  <th className="py-2 text-right font-medium">Retornos</th>
                  <th className="py-2 text-right font-medium">Saídas</th>
                  <th className="py-2 text-right font-medium">Saldo</th>
                  <th className="py-2 text-right font-medium">Churn</th>
                  <th className="py-2 text-right font-medium">Base fim</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map(row => {
                  const name = nameOf(row.key);
                  const open = kind => onOpen(kind, row.lists[kind], name);
                  return (
                    <tr key={row.key || 'none'} className="hover:bg-gray-50">
                      <td className="py-2 font-medium text-gray-900">{name}</td>
                      <td className="py-2 text-right"><CountButton value={row.baseStart} onClick={() => open('baseStart')} /></td>
                      <td className="py-2 text-right"><CountButton value={row.entries} onClick={() => open('entries')} tone="text-emerald-700" /></td>
                      <td className="py-2 text-right"><CountButton value={row.returns} onClick={() => open('returns')} tone="text-orange-700" /></td>
                      <td className="py-2 text-right"><CountButton value={row.exits} onClick={() => open('exits')} tone="text-red-700" /></td>
                      <td className={cn('py-2 text-right font-semibold', row.net > 0 ? 'text-emerald-700' : row.net < 0 ? 'text-red-700' : 'text-gray-500')}>
                        {row.net > 0 ? '+' : ''}{row.net}
                      </td>
                      <td className="py-2 text-right text-gray-700">{row.baseStart ? formatPercent(row.churnRate) : '—'}</td>
                      <td className="py-2 text-right"><CountButton value={row.baseEnd} onClick={() => open('baseEnd')} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PeopleDialog({ data, onClose, names }) {
  if (!data) return null;
  const { kind, rows, scope, label } = data;
  const isExit = kind === 'exits';
  const sorted = rows.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))
    || names.customer(a.customerId).localeCompare(names.customer(b.customerId), 'pt-BR'));
  const dateTitle = kind === 'exits' ? 'Saída' : kind === 'baseStart' || kind === 'baseEnd' ? 'Início do contrato' : 'Início';
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {MOVEMENT_KINDS[kind].label} · {label}{scope ? ` · ${scope}` : ''}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {MOVEMENT_KINDS[kind].list}: <b className="text-gray-900">{rows.length}</b> {rows.length === 1 ? 'pessoa' : 'pessoas'}.
        </p>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Ninguém neste período.</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 text-left font-medium">Pessoa</th>
                    <th className="py-2 text-left font-medium">Contrato</th>
                    <th className="py-2 text-left font-medium">Coach</th>
                    <th className="py-2 text-left font-medium">Modalidade · plano</th>
                    <th className="py-2 text-left font-medium">{dateTitle}</th>
                    {isExit && <th className="py-2 text-left font-medium">Motivo</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {sorted.map(row => (
                    <tr key={`${row.customerId}:${row.contractId}`} className="align-top">
                      <td className="py-2 font-medium">
                        {row.customerId
                          ? <Link to={studentProfilePath(row.customerId)} className="text-blue-700 hover:underline">{names.customer(row.customerId)}</Link>
                          : names.customer(row.customerId)}
                      </td>
                      <td className="py-2">
                        <Link to={`/assessoria/contratos/${row.contractId}`} className="text-blue-700 hover:underline">{row.contractNumber || 'Ver'}</Link>
                      </td>
                      <td className="py-2 text-gray-700">{names.coach(row.coachId)}</td>
                      <td className="py-2 text-gray-700">{[names.modality(row.modalityId), row.planName].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="py-2 whitespace-nowrap text-gray-700">{row.date ? formatDate(row.date) : '—'}</td>
                      {isExit && <td className="py-2 text-gray-700">{row.reason || '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 sm:hidden">
              {sorted.map(row => (
                <li key={`${row.customerId}:${row.contractId}`} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    {row.customerId
                      ? <Link to={studentProfilePath(row.customerId)} className="font-semibold text-blue-700">{names.customer(row.customerId)}</Link>
                      : <span className="font-semibold">{names.customer(row.customerId)}</span>}
                    <span className="shrink-0 text-xs text-muted-foreground">{row.date ? formatDate(row.date) : ''}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[names.coach(row.coachId), names.modality(row.modalityId), row.planName].filter(Boolean).join(' · ')}
                  </p>
                  {isExit && row.reason && <p className="mt-1 text-xs text-gray-700">Motivo: {row.reason}</p>}
                  <Link to={`/assessoria/contratos/${row.contractId}`} className="mt-1 inline-block text-xs text-blue-700">{row.contractNumber || 'Ver contrato'} →</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Movement() {
  const [params, setParams] = useSearchParams();
  const today = todayLocalStr();
  const periodValue = MOVEMENT_PERIODS.some(option => option.value === params.get('periodo')) ? params.get('periodo') : 'month';
  const customFrom = params.get('de') || '';
  const customTo = params.get('ate') || '';
  const coachId = params.get('coach') || '';
  const modalityId = params.get('modalidade') || '';
  const [people, setPeople] = useState(null);

  const { data, loading, refreshing, refresh } = usePageData({
    key: 'assessment-movement:v1',
    loader: loadMovementData,
    initialData: INITIAL_DATA,
    tags: ['assessment_contracts', 'assessment_plans', 'assessment_coaches', 'assessment_modalities', 'presale_customers'],
    onError: error => {
      console.error('Erro ao carregar entradas e saídas:', error);
      toast.error('Erro ao carregar entradas e saídas');
    },
  });

  const { from: periodFrom, to: periodTo } = movementPeriod(periodValue, today, { from: customFrom, to: customTo });
  // O React Compiler memoriza o cálculo pelos filtros e pelos dados.
  const movement = buildAssessmentMovement(data.contracts, data.plans, {
    from: periodFrom,
    to: periodTo,
    asOf: today,
    coachId: coachId || undefined,
    modalityId: modalityId || undefined,
  });

  const names = useMemo(() => {
    const customers = new Map(data.customers.map(row => [row.id, row.full_name]));
    const coaches = new Map(data.coaches.map(row => [row.id, row.name]));
    const modalities = new Map(data.modalities.map(row => [row.id, row.name]));
    return {
      customer: id => customers.get(id) || 'Pessoa sem cadastro',
      coach: id => (id ? coaches.get(id) || 'Coach removido' : 'Sem coach'),
      modality: id => (id ? modalities.get(id) || 'Modalidade removida' : 'Sem modalidade'),
    };
  }, [data.customers, data.coaches, data.modalities]);

  const setParam = updates => {
    const next = new URLSearchParams(params);
    Object.entries(updates).forEach(([key, value]) => {
      if (value) next.set(key, value);
      else next.delete(key);
    });
    setParams(next, { replace: true });
  };
  const choosePeriod = value => {
    if (value === 'custom') {
      setParam({ periodo: 'custom', de: customFrom || periodFrom, ate: customTo || periodTo });
    } else {
      setParam({ periodo: value === 'month' ? '' : value, de: '', ate: '' });
    }
  };
  const scopeLabel = [coachId && names.coach(coachId), modalityId && names.modality(modalityId)].filter(Boolean).join(' · ');
  const openPeople = (kind, rows = movement.lists[kind], scope = scopeLabel) => {
    setPeople({ kind, rows, scope, label: movement.label });
  };
  const usedCoaches = data.coaches.filter(coach => coach.active || coach.id === coachId);
  const { kpis, previous } = movement;

  if (loading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-muted-foreground">
        <RefreshCw className="w-5 h-5 text-blue-600 animate-spin mr-2" /> Carregando entradas e saídas...
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <ContextTabs group="assessment" current="/assessoria/movimento" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Entradas e saídas</h2>
          <p className="text-sm text-muted-foreground">Quem entrou, voltou, renovou e saiu no período. Clique num número para ver as pessoas.</p>
        </div>
        <Button variant="outline" size="icon" onClick={() => refresh({ force: true })} disabled={refreshing}
          title="Atualizar" aria-label="Atualizar">
          <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
        </Button>
      </div>

      <section aria-label="Filtros" className="space-y-3 rounded-xl border bg-white p-3 sm:p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Período">
          {MOVEMENT_PERIODS.map(option => (
            <Button key={option.value} size="sm" variant={periodValue === option.value ? 'default' : 'outline'}
              aria-pressed={periodValue === option.value} onClick={() => choosePeriod(option.value)}>
              {option.label}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {periodValue === 'custom' && (
            <>
              <div>
                <label htmlFor="movement-from" className="mb-1 block text-xs font-medium text-muted-foreground">De</label>
                <Input id="movement-from" type="date" value={customFrom} max={today}
                  onChange={event => setParam({ de: event.target.value })} />
              </div>
              <div>
                <label htmlFor="movement-to" className="mb-1 block text-xs font-medium text-muted-foreground">Até</label>
                <Input id="movement-to" type="date" value={customTo} max={today}
                  onChange={event => setParam({ ate: event.target.value })} />
              </div>
            </>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Coach</label>
            <Select value={coachId || 'all'} onValueChange={value => setParam({ coach: value === 'all' ? '' : value })}>
              <SelectTrigger aria-label="Coach"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os coaches</SelectItem>
                {usedCoaches.map(coach => <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Modalidade</label>
            <Select value={modalityId || 'all'} onValueChange={value => setParam({ modalidade: value === 'all' ? '' : value })}>
              <SelectTrigger aria-label="Modalidade"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as modalidades</SelectItem>
                {data.modalities.map(modality => <SelectItem key={modality.id} value={modality.id}>{modality.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarDays className="w-3.5 h-3.5" />
          Período: <b className="text-gray-800">{movement.label}</b>
          <span>· comparando com {previous.label}</span>
          {movement.requestedTo && movement.requestedTo > movement.to && <span>· dados até hoje</span>}
          {(coachId || modalityId) && (
            <button type="button" className="ml-1 text-blue-700 hover:underline" onClick={() => setParam({ coach: '', modalidade: '' })}>
              limpar coach e modalidade
            </button>
          )}
        </p>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {KPI_CARDS.slice(0, 5).map(card => (
          <KpiCard key={card.key} icon={card.icon} tone={card.tone} label={MOVEMENT_KINDS[card.key].label}
            value={`${card.sign && kpis[card.key] ? card.sign : ''}${kpis[card.key]}`} sub={card.sub}
            previousLabel={previous.label} previousValue={previous.kpis[card.key]}
            delta={<Delta current={kpis[card.key]} previous={previous.kpis[card.key]} lowerIsBetter={card.lowerIsBetter} />}
            onClick={() => openPeople(card.key)} />
        ))}
        <KpiCard icon={kpis.net >= 0 ? TrendingUp : TrendingDown} tone={kpis.net >= 0 ? 'emerald' : 'red'} label="Saldo"
          value={`${kpis.net > 0 ? '+' : ''}${kpis.net}`} sub="entradas + retornos − saídas"
          previousLabel={previous.label} previousValue={previous.kpis.net}
          delta={<Delta current={kpis.net} previous={previous.kpis.net} />} />
        <KpiCard icon={TrendingDown} tone={kpis.churnRate > 5 ? 'red' : 'slate'} label="Churn"
          value={formatPercent(kpis.churnRate)} sub="saídas ÷ base no início"
          previousLabel={previous.label} previousValue={formatPercent(previous.kpis.churnRate)}
          delta={<Delta current={kpis.churnRate} previous={previous.kpis.churnRate} lowerIsBetter percent />}
          onClick={() => openPeople('exits')} />
        {KPI_CARDS.slice(5).map(card => (
          <KpiCard key={card.key} icon={card.icon} tone={card.tone} label={MOVEMENT_KINDS[card.key].label}
            value={kpis[card.key]} sub={card.sub}
            previousLabel={previous.label} previousValue={previous.kpis[card.key]}
            delta={<Delta current={kpis[card.key]} previous={previous.kpis[card.key]} />}
            onClick={() => openPeople(card.key)} />
        ))}
      </div>

      <div className="space-y-5">
        <BreakdownTable title="Por coach" rows={movement.byCoach} nameOf={names.coach}
          onOpen={(kind, rows, name) => openPeople(kind, rows, [name, modalityId && names.modality(modalityId)].filter(Boolean).join(' · '))} />
        <BreakdownTable title="Por modalidade" rows={movement.byModality} nameOf={names.modality}
          onOpen={(kind, rows, name) => openPeople(kind, rows, [coachId && names.coach(coachId), name].filter(Boolean).join(' · '))} />
      </div>

      <section aria-label="Como contamos" className="rounded-lg border border-blue-100 bg-blue-50/60 p-4 text-xs leading-relaxed text-slate-700">
        <p className="flex items-center gap-1.5 font-semibold text-slate-900"><Info className="w-3.5 h-3.5" /> Como contamos</p>
        <div className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          <p><b>Entradas:</b> primeiro contrato da pessoa começando no período. <b>Retornos:</b> ex-aluno que volta depois de mais de 45 dias sem contrato.</p>
          <p><b>Saídas:</b> cancelamento ou não renovação efetiva no período, sem outro contrato em até 45 dias. Troca de plano, venda descartada e estorno total não contam.</p>
          <p><b>Base:</b> pessoas com contrato vigente no dia anterior ao início e no último dia do período. <b>Churn:</b> saídas ÷ base no início.</p>
          <p>Cada pessoa conta uma vez por número. Coach e modalidade são os do contrato que entrou ou saiu. As mesmas regras da tela{' '}
            <Link to="/assessoria/indicadores" className="text-blue-700 hover:underline">Evolução <ArrowRight className="inline w-3 h-3" /></Link>.</p>
        </div>
      </section>

      <PeopleDialog data={people} onClose={() => setPeople(null)} names={names} />
    </div>
  );
}
