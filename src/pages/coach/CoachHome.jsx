import { Link } from 'react-router-dom';
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { CalendarDays, ChevronRight, RefreshCw, TrendingDown, TrendingUp, UserMinus, UserPlus, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import PanelState from '@/components/coach/PanelState';
import { useAuth } from '@/hooks/useAuth';
import { firstNameOf } from '@/lib/coach-access';
import { formatDate } from '@/lib/utils';
import { useCoachPanel } from './useCoachPanel';

const percent = value => `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;

function StatCard({ icon: Icon, label, value, sub, tone = 'text-blue-700 bg-blue-50 border-blue-100' }) {
  return (
    <Card><CardContent className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>
        </div>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${tone}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
      </div>
    </CardContent></Card>
  );
}

function Overview({ data, name }) {
  const { kpis } = data;
  const green = 'text-emerald-700 bg-emerald-50 border-emerald-100';
  const red = 'text-red-700 bg-red-50 border-red-100';
  const chart = data.monthly.map(month => ({
    label: month.label,
    entries: month.entries + month.returns,
    exits: month.exits,
    active: month.base_end,
  }));
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">{name ? `Olá, ${name}` : 'Visão geral'}</h1>
        <p className="text-sm text-muted-foreground">Seus alunos hoje ({formatDate(data.today)}) e os últimos 12 meses.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard icon={Users} label="Alunos ativos" value={kpis.active} sub="hoje" />
        <StatCard icon={UserPlus} label="Entradas (12 meses)" value={kpis.entries + kpis.returns}
          sub={`${kpis.entries} novos · ${kpis.returns} retornos`} tone={green} />
        <StatCard icon={UserMinus} label="Saídas (12 meses)" value={kpis.exits}
          sub={`churn médio ${percent(kpis.average_churn)} ao mês`} tone={red} />
        <StatCard icon={kpis.net >= 0 ? TrendingUp : TrendingDown} label="Saldo (12 meses)" value={`${kpis.net > 0 ? '+' : ''}${kpis.net}`}
          sub="entradas + retornos − saídas" tone={kpis.net >= 0 ? green : red} />
        <StatCard icon={RefreshCw} label="Renovações (12 meses)" value={kpis.renewals}
          sub={`${kpis.renewals_in_progress} em andamento agora`} tone="text-violet-700 bg-violet-50 border-violet-100" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-base">Alunos ativos por mês</CardTitle></CardHeader>
          <CardContent>
            <div className="h-64" role="img" aria-label={`Alunos ativos por mês nos últimos 12 meses. Hoje: ${kpis.active}.`}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                  <XAxis dataKey="label" interval={0} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
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
            {data.by_modality.length === 0 ? <p className="text-sm text-muted-foreground">Sem alunos ativos.</p> : data.by_modality.map(group => (
              <div key={group.modality} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                <span className="capitalize">{group.modality}</span>
                <b className="tabular-nums">{group.students}</b>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link to="/coach/alunos" className="flex items-center justify-between gap-3 rounded-xl border bg-white p-4 text-sm font-medium hover:shadow-md">
          <span className="inline-flex items-center gap-2"><Users className="h-4 w-4 text-blue-700" aria-hidden="true" /> Ver meus alunos e quem saiu</span>
          <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
        </Link>
        <Link to="/coach/eventos" className="flex items-center justify-between gap-3 rounded-xl border bg-white p-4 text-sm font-medium hover:shadow-md">
          <span className="inline-flex items-center gap-2"><CalendarDays className="h-4 w-4 text-blue-700" aria-hidden="true" /> Ver meus eventos</span>
          <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">Os números seguem as mesmas regras do painel da equipe.</p>
    </div>
  );
}

export default function CoachHome() {
  const { coach } = useAuth();
  const panel = useCoachPanel();
  return <PanelState panel={panel}>{data => <Overview data={data} name={firstNameOf(coach?.name)} />}</PanelState>;
}
