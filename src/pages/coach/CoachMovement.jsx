import { useState } from 'react';
import { RefreshCw, Sparkles, TrendingDown, TrendingUp, UserMinus, UserPlus } from 'lucide-react';
import { BaseTrend, FlowChart, FlowLegend } from '@/components/coach/charts';
import { PageHeader, Panel, Pill, Segmented, StatTile } from '@/components/coach/kit';
import PanelState from '@/components/coach/PanelState';
import { periodSentence, periodSummary } from '@/lib/coach-ui';
import { cn } from '@/lib/utils';
import { useCoachPanel } from './useCoachPanel';

const percent = value => `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;
const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`;
const netTone = value => (value > 0 ? 'text-emerald-700' : value < 0 ? 'text-red-700' : 'text-slate-500');

const PERIODS = [
  { value: 6, label: '6 meses' },
  { value: 12, label: '12 meses' },
];

const LEGEND = [
  ['Entradas', 'alunos novos no mês'],
  ['Retornos', 'ex-alunos que voltaram'],
  ['Renovações', 'renovações que começaram no mês'],
  ['Saídas', 'saídas reais no mês'],
  ['Saldo', 'entradas + retornos − saídas'],
  ['Churn', 'saídas ÷ alunos no início do mês'],
];

function MonthTable({ rows, currentLabel }) {
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm sm:block">
      <table className="w-full min-w-[44rem] text-sm">
        <caption className="sr-only">Entradas e saídas dos alunos por mês</caption>
        <thead className="border-b bg-slate-50 text-xs text-slate-600">
          <tr>
            <th scope="col" className="px-4 py-3 text-left font-semibold">Mês</th>
            {['Início', 'Entradas', 'Retornos', 'Renovações', 'Saídas', 'Saldo', 'Fim', 'Churn'].map(label => (
              <th key={label} scope="col" className="px-3 py-3 text-right font-semibold">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(month => (
            <tr key={month.month} className={cn('tabular-nums hover:bg-slate-50', month.label === currentLabel && 'bg-blue-50/40')}>
              <th scope="row" className="px-4 py-3 text-left font-semibold text-slate-900">
                <span className="inline-flex items-center gap-2">{month.label}{month.label === currentLabel && <Pill tone="info">em andamento</Pill>}</span>
              </th>
              <td className="px-3 py-3 text-right text-slate-600">{month.base_start}</td>
              <td className="px-3 py-3 text-right font-medium text-emerald-700">{month.entries || <span className="text-slate-300">—</span>}</td>
              <td className="px-3 py-3 text-right font-medium text-teal-700">{month.returns || <span className="text-slate-300">—</span>}</td>
              <td className="px-3 py-3 text-right font-medium text-violet-700">{month.renewals || <span className="text-slate-300">—</span>}</td>
              <td className="px-3 py-3 text-right font-medium text-rose-700">{month.exits || <span className="text-slate-300">—</span>}</td>
              <td className={cn('px-3 py-3 text-right font-semibold', netTone(month.net))}>{signed(month.net)}</td>
              <td className="px-3 py-3 text-right font-bold text-slate-900">{month.base_end}</td>
              <td className="px-3 py-3 text-right text-slate-600">{percent(month.churn_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthCards({ rows, currentLabel }) {
  return (
    <ul className="space-y-3 sm:hidden" aria-label="Entradas e saídas por mês">
      {rows.map(month => (
        <li key={month.month} className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold text-slate-900">{month.label}{month.label === currentLabel && <Pill tone="info">em andamento</Pill>}</p>
            <p className={cn('text-sm font-bold tabular-nums', netTone(month.net))}>{signed(month.net)}</p>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {month.base_start} → <b className="text-slate-800">{month.base_end}</b> alunos · churn {percent(month.churn_rate)}
          </p>
          <dl className="mt-3 grid grid-cols-4 gap-2 text-center tabular-nums">
            {[
              ['Entradas', month.entries, 'text-emerald-700'],
              ['Retornos', month.returns, 'text-teal-700'],
              ['Renovações', month.renewals, 'text-violet-700'],
              ['Saídas', month.exits, 'text-rose-700'],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-xl bg-slate-50 px-1 py-2">
                <dd className={cn('text-lg font-bold leading-none', value ? tone : 'text-slate-300')}>{value}</dd>
                <dt className="mt-1 text-[10px] font-medium text-slate-500">{label}</dt>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Movement({ data }) {
  const [months, setMonths] = useState(12);
  const slice = data.monthly.slice(-months);
  const summary = periodSummary(data.monthly, months);
  const rows = [...slice].reverse();
  const currentLabel = data.monthly[data.monthly.length - 1]?.label;
  const gained = summary.entries + summary.returns;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Evolução"
        subtitle="Como a sua base de alunos andou mês a mês."
        actions={<Segmented label="Período" value={months} onChange={setMonths} options={PERIODS} />}
      />

      <section aria-label="Resumo do período" className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-blue-600 shadow-sm"><Sparkles className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0 space-y-2">
            <p className="text-[15px] font-medium leading-snug text-slate-900">{periodSentence(summary, months)}</p>
            <div className="flex flex-wrap gap-2">
              {summary.best && <Pill tone="success">Melhor mês: {summary.best.label} ({signed(summary.best.net)})</Pill>}
              {summary.worst && <Pill tone="danger">Mais saídas: {summary.worst.label} ({summary.worst.exits})</Pill>}
              <Pill tone="neutral">{summary.startBase} → {summary.endBase} alunos no período</Pill>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={UserPlus} label="Entraram" value={gained} sub={`${summary.entries} novos · ${summary.returns} ${summary.returns === 1 ? 'voltou' : 'voltaram'}`} accent={{ bar: 'bg-emerald-500', icon: 'text-emerald-600' }} />
        <StatTile icon={RefreshCw} label="Renovaram" value={summary.renewals} sub="renovações no período" accent={{ bar: 'bg-violet-500', icon: 'text-violet-600' }} />
        <StatTile icon={UserMinus} label="Saíram" value={summary.exits} sub={`${percent(summary.averageChurn)} ao mês em média`} accent={{ bar: 'bg-rose-500', icon: 'text-rose-600' }} />
        <StatTile
          icon={summary.net >= 0 ? TrendingUp : TrendingDown}
          label="Saldo"
          value={signed(summary.net)}
          sub="entradas + retornos − saídas"
          accent={summary.net >= 0 ? { bar: 'bg-blue-500', icon: 'text-blue-600' } : { bar: 'bg-rose-500', icon: 'text-rose-600' }}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Alunos ativos no fim de cada mês" description="A linha sobe quando entra mais gente do que sai.">
          <BaseTrend monthly={slice} height={200} ariaLabel={`Alunos ativos no fim de cada mês, de ${summary.firstLabel} a ${summary.lastLabel}: de ${summary.startBase} para ${summary.endBase}.`} />
        </Panel>
        <Panel title="Entradas e saídas" description="Para cima, quem entrou ou voltou. Para baixo, quem saiu.">
          <FlowChart monthly={slice} height={200} ariaLabel={`Entradas e saídas por mês de ${summary.firstLabel} a ${summary.lastLabel}: ${gained} entradas e ${summary.exits} saídas.`} />
          <div className="mt-3"><FlowLegend /></div>
        </Panel>
      </div>

      <section aria-label="Mês a mês" className="space-y-3">
        <h2 className="text-[15px] font-semibold text-slate-900">Mês a mês</h2>
        <MonthTable rows={rows} currentLabel={currentLabel} />
        <MonthCards rows={rows} currentLabel={currentLabel} />
      </section>

      <details className="group rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm">
        <summary className="cursor-pointer text-sm font-medium text-slate-700 marker:text-slate-400">Como ler esses números</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs text-slate-600 sm:grid-cols-2">
          {LEGEND.map(([term, meaning]) => (
            <div key={term} className="flex gap-1.5"><dt className="font-semibold text-slate-800">{term}:</dt><dd>{meaning}</dd></div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-slate-500">O mês em andamento ainda não terminou, então os números dele podem mudar até o fim do mês. Os números seguem as mesmas regras do painel da equipe.</p>
      </details>
    </div>
  );
}

export default function CoachMovement() {
  const panel = useCoachPanel();
  return <PanelState panel={panel}>{data => <Movement data={data} />}</PanelState>;
}
