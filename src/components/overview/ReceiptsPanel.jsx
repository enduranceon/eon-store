import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatDate } from '@/lib/utils';
import { RECEIPT_MONTH_STATE, selectMonthReceipts } from '@/lib/overview-receipts';
import { financialMovementDate } from '@/lib/financial-dashboard';
import { loadReceiptsYear } from './overview-loader';
import OverviewDetailDialog from './OverviewDetailDialog';

const MONTH_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_LONG = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

const STATE_LABEL = {
  [RECEIPT_MONTH_STATE.REALIZED]: 'Fechado',
  [RECEIPT_MONTH_STATE.PARTIAL]: 'Parcial',
  [RECEIPT_MONTH_STATE.FUTURE]: 'Futuro',
  [RECEIPT_MONTH_STATE.INSUFFICIENT]: 'Sem histórico',
};

function compact(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-white p-3 text-xs shadow-lg">
      <p className="mb-1.5 font-semibold">{label}</p>
      {payload.map(item => (
        <div key={item.dataKey} className="flex justify-between gap-6" style={{ color: item.color }}>
          <span>{item.name}</span><b>{formatCurrency(item.value)}</b>
        </div>
      ))}
    </div>
  );
}

// Recebimentos do ano: quanto entrou por mês (planos, eventos, loja), líquido de taxa.
// Não é caixa nem resultado: o sistema ainda não controla saídas. Escolher ano ou
// mês aqui não muda os cartões do topo (eles são sempre de hoje).
export default function ReceiptsPanel({ block, today, onRetry }) {
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [other, setOther] = useState({ year: null, status: 'idle' }); // ano diferente do corrente
  const [month, setMonth] = useState(today.slice(0, 7));
  const [showReceipts, setShowReceipts] = useState(false);

  const coverageFrom = block?.status === 'ok' ? block.data.coverageFrom : null;
  const firstYear = coverageFrom ? Math.min(Number(coverageFrom.slice(0, 4)), currentYear) : currentYear;
  const years = useMemo(
    () => Array.from({ length: currentYear - firstYear + 1 }, (_, index) => currentYear - index),
    [currentYear, firstYear],
  );

  const loadOther = useCallback(async targetYear => {
    setOther({ year: targetYear, status: 'loading' });
    try {
      const data = await loadReceiptsYear(targetYear, new Date());
      setOther({ year: targetYear, status: 'ok', data });
    } catch (error) {
      console.error('[Visão geral] Erro ao carregar recebimentos do ano:', error);
      setOther({ year: targetYear, status: 'error' });
    }
  }, []);

  useEffect(() => {
    if (year !== currentYear && other.year !== year) loadOther(year);
  }, [year, currentYear, other.year, loadOther]);

  function changeYear(next) {
    setYear(next);
    setMonth(next === currentYear ? today.slice(0, 7) : `${next}-12`);
  }

  // Estado do ano exibido: o ano corrente vem do bloco da página; os demais, sob demanda.
  let view;
  if (year === currentYear) view = block ? (block.status === 'ok' ? { status: 'ok', data: block.data } : { status: 'error' }) : { status: 'loading' };
  else if (other.year === year) view = other.status === 'ok' ? { status: 'ok', data: other.data } : { status: other.status };
  else view = { status: 'loading' };

  const retry = year === currentYear ? onRetry : () => loadOther(year);
  const receipts = view.status === 'ok' ? view.data.receipts : null;
  const selected = receipts?.months.find(item => item.ym === month) || receipts?.months[0];
  const hasValue = selected && (selected.state === RECEIPT_MONTH_STATE.REALIZED || selected.state === RECEIPT_MONTH_STATE.PARTIAL);
  const hasFuture = receipts?.months.some(item => item.state === RECEIPT_MONTH_STATE.FUTURE);
  const hasInsufficient = receipts?.months.some(item => item.state === RECEIPT_MONTH_STATE.INSUFFICIENT);

  const chartData = receipts?.months.map(item => ({
    ym: item.ym,
    label: MONTH_SHORT[item.monthIndex],
    received: item.received,
  }));

  const monthReceipts = view.status === 'ok' && selected ? selectMonthReceipts(view.data.movements, selected.ym) : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Recebimentos do ano</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Todas as áreas · dinheiro que entrou (planos, eventos, loja), líquido de taxa, pela data do recebimento.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-600" htmlFor="overview-receipts-year">Ano</label>
            <select
              id="overview-receipts-year"
              value={year}
              onChange={event => changeYear(Number(event.target.value))}
              className="h-8 rounded-md border bg-white px-2 text-sm"
            >
              {years.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <label className="text-xs text-slate-600" htmlFor="overview-receipts-month">Mês</label>
            <select
              id="overview-receipts-month"
              value={selected?.ym || month}
              onChange={event => setMonth(event.target.value)}
              disabled={!receipts}
              className="h-8 rounded-md border bg-white px-2 text-sm"
            >
              {(receipts?.months || []).map(item => (
                <option key={item.ym} value={item.ym}>{MONTH_LONG[item.monthIndex]} — {STATE_LABEL[item.state]}</option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.status === 'loading' && <div className="h-64 animate-pulse rounded bg-slate-100" role="status" aria-label="Recebimentos: carregando" />}
        {(view.status === 'error') && (
          <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">Não foi possível carregar os recebimentos de {year}.</p>
            <p className="text-xs text-amber-800">Nenhum valor é mostrado até a consulta funcionar; isto não significa que nada foi recebido.</p>
            <Button variant="outline" size="sm" onClick={retry}>Tentar novamente</Button>
          </div>
        )}
        {receipts && (
          <>
            {receipts.truncated && (
              <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                A consulta atingiu o limite de recebimentos e os valores deste ano podem estar incompletos.
              </p>
            )}
            <div
              className="h-64"
              role="img"
              aria-label={`Recebido líquido por mês em ${receipts.year}. Total recebido no ano até agora: ${formatCurrency(receipts.accumulated)}.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                  <XAxis dataKey="label" interval={0} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={compact} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="received" name="Recebido líquido" fill="#059669" radius={[4, 4, 0, 0]} onClick={entry => setMonth(entry.ym)} cursor="pointer">
                    {chartData.map(item => <Cell key={item.ym} fillOpacity={item.ym === selected?.ym ? 1 : 0.55} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-slate-500">
              {(hasFuture || hasInsufficient) && (
                <>
                  {hasFuture && hasInsufficient ? 'Mês futuro ou anterior ao primeiro recebimento registrado' : hasFuture ? 'Mês futuro' : 'Mês anterior ao primeiro recebimento registrado'}
                  {hasInsufficient && receipts.coverageFrom ? ` (${formatDate(receipts.coverageFrom)})` : ''} fica sem barra: ausência de barra não é zero.{' '}
                </>
              )}
              Total recebido em {receipts.year}{receipts.year === Number(receipts.today.slice(0, 4)) ? ' até agora' : ''}: <b>{formatCurrency(receipts.accumulated)}</b>.
            </p>

            {selected && (
              <section aria-label={`Detalhe de ${MONTH_LONG[selected.monthIndex]} de ${receipts.year}`} className="rounded-lg border bg-slate-50 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-gray-900">{MONTH_LONG[selected.monthIndex]} de {receipts.year} · {STATE_LABEL[selected.state]}</h3>
                  {hasValue && (
                    <Button variant="outline" size="sm" onClick={() => setShowReceipts(true)}>Ver recebimentos ({monthReceipts.length})</Button>
                  )}
                </div>
                {hasValue ? (
                  <>
                    <div className="flex items-center justify-between gap-4 py-1">
                      <span className="text-slate-700">Recebido líquido · {selected.receiptCount} {selected.receiptCount === 1 ? 'recebimento' : 'recebimentos'}</span>
                      <span className="font-semibold tabular-nums">{formatCurrency(selected.received)}</span>
                    </div>
                    {selected.state === RECEIPT_MONTH_STATE.PARTIAL && (
                      <p className="mt-1 text-xs text-slate-600">Parcial: recebido até {formatDate(receipts.today)}.</p>
                    )}
                    <p className="mt-1 text-xs text-slate-600">A taxa já está abatida. Estornos, repasses e despesas não entram aqui: o sistema ainda não analisa saídas.</p>
                  </>
                ) : selected.state === RECEIPT_MONTH_STATE.FUTURE ? (
                  <p className="text-slate-600">Mês que ainda não aconteceu: não há valor recebido.</p>
                ) : (
                  <p className="text-slate-600">
                    Sem histórico confiável neste mês{receipts.coverageFrom ? `: o primeiro recebimento registrado é de ${formatDate(receipts.coverageFrom)}` : ''}. Nenhum valor é mostrado em vez de um zero.
                  </p>
                )}
              </section>
            )}
            <div className="flex justify-end">
              <Button asChild variant="link" size="sm"><Link to="/financeiro/fluxo-caixa">Abrir fluxo de caixa</Link></Button>
            </div>
          </>
        )}
      </CardContent>

      <OverviewDetailDialog
        open={showReceipts}
        onClose={() => setShowReceipts(false)}
        title={selected ? `Recebimentos de ${MONTH_LONG[selected.monthIndex]} de ${receipts?.year}` : 'Recebimentos'}
        description="Recebimentos que compõem o valor do mês, já com a taxa abatida."
        summary={hasValue ? `${monthReceipts.length} recebimentos · ${formatCurrency(selected.received)}` : undefined}
        rows={monthReceipts}
        columns={[
          { key: 'date', label: 'Data', render: row => formatDate(financialMovementDate(row)) },
          { key: 'description', label: 'Descrição', render: row => row.description || '—' },
          { key: 'amount', label: 'Líquido', align: 'right', render: row => formatCurrency(Number(row.net_amount) || 0) },
        ]}
        destination={{ to: '/financeiro/fluxo-caixa', label: 'Abrir fluxo de caixa' }}
      />
    </Card>
  );
}
