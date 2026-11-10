import PanelState from '@/components/coach/PanelState';
import { useCoachPanel } from './useCoachPanel';

const percent = value => `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;

const LEGEND = [
  ['Entradas', 'alunos novos no mês'],
  ['Retornos', 'ex-alunos que voltaram'],
  ['Renovações', 'renovações que começaram no mês'],
  ['Saídas', 'saídas reais no mês'],
  ['Churn', 'saídas ÷ alunos no início do mês'],
];

function Movement({ data }) {
  const rows = [...data.monthly].reverse();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Mês a mês</h1>
        <p className="text-sm text-muted-foreground">Entradas e saídas dos seus alunos nos últimos 12 meses.</p>
      </div>
      <div className="hidden overflow-x-auto rounded-lg border bg-white sm:block">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Entradas e saídas dos alunos por mês</caption>
          <thead className="border-b bg-gray-50 text-xs text-slate-600">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-semibold">Mês</th>
              {['Base no início', 'Entradas', 'Retornos', 'Renovações', 'Saídas', 'Base no fim', 'Churn'].map(label => (
                <th key={label} scope="col" className="px-3 py-2 text-right font-semibold">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map(month => (
              <tr key={month.month} className="tabular-nums hover:bg-gray-50">
                <th scope="row" className="px-3 py-2.5 text-left font-medium text-gray-900">{month.label}</th>
                <td className="px-3 py-2.5 text-right">{month.base_start}</td>
                <td className="px-3 py-2.5 text-right text-emerald-700">{month.entries || '—'}</td>
                <td className="px-3 py-2.5 text-right text-orange-700">{month.returns || '—'}</td>
                <td className="px-3 py-2.5 text-right text-violet-700">{month.renewals || '—'}</td>
                <td className="px-3 py-2.5 text-right text-red-700">{month.exits || '—'}</td>
                <td className="px-3 py-2.5 text-right font-semibold">{month.base_end}</td>
                <td className="px-3 py-2.5 text-right">{percent(month.churn_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 sm:hidden" aria-label="Entradas e saídas por mês">
        {rows.map(month => (
          <li key={month.month} className="rounded-lg border bg-white p-3">
            <div className="flex items-baseline justify-between">
              <p className="font-medium text-gray-900">{month.label}</p>
              <p className="text-xs text-muted-foreground">Churn {percent(month.churn_rate)}</p>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center tabular-nums">
              {[
                ['Início', month.base_start, ''],
                ['Entradas', month.entries, 'text-emerald-700'],
                ['Retornos', month.returns, 'text-orange-700'],
                ['Renovações', month.renewals, 'text-violet-700'],
                ['Saídas', month.exits, 'text-red-700'],
                ['Fim', month.base_end, 'font-semibold'],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-md bg-slate-50 py-1.5">
                  <dd className={`text-base ${tone}`}>{value}</dd>
                  <dt className="text-[11px] text-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        {LEGEND.map(([term, meaning]) => (
          <div key={term} className="flex gap-1.5"><dt className="font-semibold text-slate-700">{term}:</dt><dd>{meaning}</dd></div>
        ))}
      </dl>
    </div>
  );
}

export default function CoachMovement() {
  const panel = useCoachPanel();
  return <PanelState panel={panel}>{data => <Movement data={data} />}</PanelState>;
}
