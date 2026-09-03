import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ArrowRight, BarChart3, CalendarDays, RefreshCw, Repeat2,
  TrendingDown, TrendingUp, UserMinus, UserPlus, UserRoundCheck, Users,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, CartesianGrid, ComposedChart, Legend, Line,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { AssessmentContract, AssessmentPlan } from '@/api/entities';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePageData } from '@/hooks/usePageData';
import {
  buildAssessmentYearlyIndicators,
  getAssessmentIndicatorYears,
} from '@/lib/assessment-yearly-indicators';
import { cn, formatCurrency } from '@/lib/utils';

async function loadAssessmentIndicators() {
  const [contracts, plans] = await Promise.all([
    AssessmentContract.list('-created_at'),
    AssessmentPlan.list(),
  ]);
  return { contracts, plans };
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');
}

function formatPercent(value) {
  return `${(Number(value) || 0).toFixed(1)}%`;
}

function formatCompactCurrency(value) {
  const amount = Number(value) || 0;
  if (Math.abs(amount) >= 1000) return `R$ ${(amount / 1000).toFixed(1)} mil`;
  return formatCurrency(amount);
}

function MetricCard({ icon: Icon, label, value, sub, tone = 'slate' }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    orange: 'bg-orange-50 text-orange-700 border-orange-100',
    violet: 'bg-violet-50 text-violet-700 border-violet-100',
    red: 'bg-red-50 text-red-700 border-red-100',
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 truncate">{value}</p>
            <p className="text-[11px] text-muted-foreground mt-1 truncate">{sub}</p>
          </div>
          <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center shrink-0', tones[tone])}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyChart({ label }) {
  return (
    <div className="h-72 flex items-center justify-center border border-dashed rounded-lg bg-gray-50 text-sm text-muted-foreground px-6 text-center">
      {label}
    </div>
  );
}

function MovementTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row?.available) return null;

  return (
    <div className="bg-white border shadow-lg rounded-lg p-3 text-xs min-w-48">
      <p className="font-semibold text-gray-900 mb-2">{label}{row.isPartial ? ' · parcial' : ''}</p>
      <div className="space-y-1 text-gray-600">
        <p className="flex justify-between gap-6"><span>Entradas</span><b className="text-emerald-700">+{row.entries}</b></p>
        <p className="flex justify-between gap-6"><span>Retornos</span><b className="text-orange-700">+{row.returns}</b></p>
        <p className="flex justify-between gap-6"><span>Saídas reais</span><b className="text-red-700">−{row.exits}</b></p>
        <p className="flex justify-between gap-6 border-t pt-1 mt-1"><span>Base ativa</span><b>{row.baseEnd}</b></p>
      </div>
    </div>
  );
}

function MrrTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row?.available) return null;

  return (
    <div className="bg-white border shadow-lg rounded-lg p-3 text-xs min-w-44">
      <p className="font-semibold text-gray-900 mb-1.5">{label}{row.isPartial ? ' · parcial' : ''}</p>
      <p className="flex justify-between gap-6 text-emerald-700"><span>MRR contratado</span><b>{formatCurrency(row.mrr)}</b></p>
    </div>
  );
}

export default function Indicators() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(String(currentYear));
  const { data, loading, refreshing, refresh } = usePageData({
    key: 'assessment-yearly-indicators:v1',
    loader: loadAssessmentIndicators,
    initialData: { contracts: [], plans: [] },
    tags: ['assessment_contracts', 'assessment_plans'],
    onError: error => {
      console.error('Erro ao carregar indicadores da assessoria:', error);
      toast.error('Erro ao carregar indicadores da assessoria');
    },
  });

  const years = useMemo(
    () => getAssessmentIndicatorYears(data.contracts, new Date()),
    [data.contracts],
  );
  const selectedYear = years.includes(Number(year)) ? Number(year) : currentYear;
  const indicators = useMemo(
    () => buildAssessmentYearlyIndicators(data.contracts, data.plans, { year: selectedYear }),
    [data.contracts, data.plans, selectedYear],
  );
  const { summary, months } = indicators;
  const hasMovement = months.some(month => month.available && (month.entries || month.returns || month.exits || month.baseEnd));
  const hasMrr = months.some(month => month.available && month.mrr > 0);

  const refreshPage = async () => {
    try {
      await refresh({ force: true });
      toast.success('Indicadores atualizados');
    } catch {
      // usePageData already reports the loading error to the operator.
    }
  };

  if (loading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-muted-foreground">
        <RefreshCw className="w-5 h-5 text-blue-600 animate-spin mr-2" />
        Carregando indicadores...
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">Indicadores da Assessoria</h2>
            <p className="text-sm text-muted-foreground">Leitura mensal da base e da retenção</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={refreshPage}
            disabled={refreshing}
            title="Atualizar indicadores"
            aria-label="Atualizar indicadores"
          >
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          </Button>
          <Button variant="outline" asChild>
            <Link to="/assessoria/auditoria">
              Auditoria <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
        <div className="w-full sm:w-48">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Ano</label>
          <Select value={String(selectedYear)} onValueChange={setYear}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {years.map(option => <SelectItem key={option} value={String(option)}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <CalendarDays className="w-3.5 h-3.5" /> Dados até {formatDate(indicators.asOfDate)}
        </p>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-6 gap-3">
        <MetricCard icon={Users} label="Base no fim" value={summary.baseEnd} sub={`início: ${summary.baseStart}`} tone="blue" />
        <MetricCard icon={UserPlus} label="Entradas" value={`+${summary.entries}`} sub="novos alunos" tone="emerald" />
        <MetricCard icon={UserRoundCheck} label="Retornos" value={`+${summary.returns}`} sub="ex-alunos reativados" tone="orange" />
        <MetricCard icon={Repeat2} label="Renovações" value={summary.renewals} sub="retenção" tone="violet" />
        <MetricCard icon={UserMinus} label="Saídas reais" value={`−${summary.exits}`} sub="sem troca ou estorno" tone="red" />
        <MetricCard icon={summary.netGrowth >= 0 ? TrendingUp : TrendingDown} label="Saldo" value={`${summary.netGrowth >= 0 ? '+' : ''}${summary.netGrowth}`} sub={summary.isPartial ? 'mês atual parcial' : 'no período'} tone={summary.netGrowth >= 0 ? 'emerald' : 'red'} />
      </div>

      <div className="grid xl:grid-cols-2 gap-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="w-4 h-4 text-blue-600" />
              Fluxo de alunos por mês
            </CardTitle>
          </CardHeader>
          <CardContent>
            {hasMovement ? (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={months} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="movement" allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={34} />
                    <YAxis yAxisId="base" orientation="right" allowDecimals={false} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={34} />
                    <Tooltip content={<MovementTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                    <Bar yAxisId="movement" dataKey="entries" name="Entradas" fill="#16a34a" radius={[4, 4, 0, 0]} maxBarSize={24} />
                    <Bar yAxisId="movement" dataKey="returns" name="Retornos" fill="#f97316" radius={[4, 4, 0, 0]} maxBarSize={24} />
                    <Bar yAxisId="movement" dataKey="exits" name="Saídas" fill="#dc2626" radius={[4, 4, 0, 0]} maxBarSize={24} />
                    <Line yAxisId="base" type="monotone" dataKey="baseEnd" name="Base ativa" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : <EmptyChart label="Ainda não há movimentação suficiente neste ano." />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-600" />
                MRR contratado
              </CardTitle>
              <span className="text-sm font-semibold text-emerald-700">{formatCompactCurrency(summary.mrr)}</span>
            </div>
          </CardHeader>
          <CardContent>
            {hasMrr ? (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={months} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="assessmentYearlyMrr" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#059669" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="#059669" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={value => formatCompactCurrency(value).replace('R$ ', '')} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={56} />
                    <Tooltip content={<MrrTooltip />} />
                    <Area type="monotone" dataKey="mrr" name="MRR contratado" stroke="#059669" strokeWidth={2.5} fill="url(#assessmentYearlyMrr)" connectNulls={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : <EmptyChart label="Ainda não há MRR suficiente neste ano." />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Resumo mensal</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[830px] text-sm">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="text-left py-3 pr-3 font-medium">Mês</th>
                  <th className="text-right py-3 px-2 font-medium">Base inicial</th>
                  <th className="text-right py-3 px-2 font-medium">Entradas</th>
                  <th className="text-right py-3 px-2 font-medium">Retornos</th>
                  <th className="text-right py-3 px-2 font-medium">Renovações</th>
                  <th className="text-right py-3 px-2 font-medium">Saídas</th>
                  <th className="text-right py-3 px-2 font-medium">Saldo</th>
                  <th className="text-right py-3 px-2 font-medium">Base final</th>
                  <th className="text-right py-3 px-2 font-medium">Churn</th>
                  <th className="text-right py-3 pl-2 font-medium">MRR</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {months.map(item => {
                  const muted = !item.available;
                  return (
                    <tr key={item.key} className={cn('hover:bg-gray-50', muted && 'text-muted-foreground')}>
                      <td className="py-3 pr-3 font-medium">
                        <span>{item.label}</span>
                        {item.isPartial && <span className="ml-1.5 text-[10px] font-semibold text-amber-700">parcial</span>}
                        {!item.available && <span className="ml-1.5 text-[10px] font-medium">{item.isFuture ? 'futuro' : 'sem histórico'}</span>}
                      </td>
                      <td className="py-3 px-2 text-right">{item.baseStart ?? '—'}</td>
                      <td className="py-3 px-2 text-right text-emerald-700">{item.entries == null ? '—' : `+${item.entries}`}</td>
                      <td className="py-3 px-2 text-right text-orange-700">{item.returns == null ? '—' : `+${item.returns}`}</td>
                      <td className="py-3 px-2 text-right text-violet-700">{item.renewals ?? '—'}</td>
                      <td className="py-3 px-2 text-right text-red-700">{item.exits == null ? '—' : `−${item.exits}`}</td>
                      <td className={cn('py-3 px-2 text-right font-semibold', item.netGrowth >= 0 ? 'text-emerald-700' : 'text-red-700')}>
                        {item.netGrowth == null ? '—' : `${item.netGrowth >= 0 ? '+' : ''}${item.netGrowth}`}
                      </td>
                      <td className="py-3 px-2 text-right font-semibold">{item.baseEnd ?? '—'}</td>
                      <td className="py-3 px-2 text-right">{item.churnRate == null ? '—' : formatPercent(item.churnRate)}</td>
                      <td className="py-3 pl-2 text-right font-semibold text-emerald-700">{item.mrr == null ? '—' : formatCurrency(item.mrr)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
