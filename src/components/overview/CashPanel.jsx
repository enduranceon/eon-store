import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatDate } from '@/lib/utils';
import { CASH_MONTH_STATE, selectMonthMovements } from '@/lib/overview-cash';
import { financialMovementDate } from '@/lib/financial-dashboard';
import { loadCashYear } from './overview-loader';
import OverviewDetailDialog from './OverviewDetailDialog';

const MONTH_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_LONG = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

const KIND_LABEL = {
  receipt: 'Recebimento',
  refund: 'Estorno',
  expense: 'Despesa',
  payout: 'Repasse',
  payout_adjustment: 'Ajuste de repasse',
};

const STATE_LABEL = {
  [CASH_MONTH_STATE.REALIZED]: 'Realizado',
  [CASH_MONTH_STATE.PARTIAL]: 'Parcial',
  [CASH_MONTH_STATE.FUTURE]: 'Futuro',
  [CASH_MONTH_STATE.INSUFFICIENT]: 'Sem histórico',
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

function Line({ label, value, sign, strong }) {
  return (
    <div className={`flex items-center justify-between gap-4 py-1 ${strong ? 'border-t font-semibold' : ''}`}>
      <span className="text-slate-700">{sign ? `${sign} ` : ''}{label}</span>
      <span className="tabular-nums">{formatCurrency(value)}</span>
    </div>
  );
}

// Caixa do ano: recebimentos e saídas realizados mês a mês. Escolher ano ou mês aqui
// não muda os cartões do topo (eles são sempre de hoje).
export default function CashPanel({ block, today, onRetry }) {
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [other, setOther] = useState({ year: null, status: 'idle' }); // ano diferente do corrente
  const [month, setMonth] = useState(today.slice(0, 7));
  const [showMovements, setShowMovements] = useState(false);

  const coverageFrom = block?.status === 'ok' ? block.data.coverageFrom : null;
  const firstYear = coverageFrom ? Math.min(Number(coverageFrom.slice(0, 4)), currentYear) : currentYear;
  const years = useMemo(
    () => Array.from({ length: currentYear - firstYear + 1 }, (_, index) => currentYear - index),
    [currentYear, firstYear],
  );

  const loadOther = useCallback(async targetYear => {
    setOther({ year: targetYear, status: 'loading' });
    try {
      const data = await loadCashYear(targetYear, new Date());
      setOther({ year: targetYear, status: 'ok', data });
    } catch (error) {
      console.error('[Visão geral] Erro ao carregar caixa do ano:', error);
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
  const cash = view.status === 'ok' ? view.data.cash : null;
  const selected = cash?.months.find(item => item.ym === month) || cash?.months[0];
  const hasValue = selected && (selected.state === CASH_MONTH_STATE.REALIZED || selected.state === CASH_MONTH_STATE.PARTIAL);

  const chartData = cash?.months.map(item => ({
    ym: item.ym,
    label: MONTH_SHORT[item.monthIndex],
    received: item.received,
    outflows: item.outflows,
  }));

  const monthMovements = view.status === 'ok' && selected ? selectMonthMovements(view.data.movements, selected.ym) : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Caixa do ano</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Todas as áreas · só dinheiro realizado (recebimentos líquidos e saídas), pela data do movimento.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-600" htmlFor="overview-cash-year">Ano</label>
            <select
              id="overview-cash-year"
              value={year}
              onChange={event => changeYear(Number(event.target.value))}
              className="h-8 rounded-md border bg-white px-2 text-sm"
            >
              {years.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <label className="text-xs text-slate-600" htmlFor="overview-cash-month">Mês</label>
            <select
              id="overview-cash-month"
              value={selected?.ym || month}
              onChange={event => setMonth(event.target.value)}
              disabled={!cash}
              className="h-8 rounded-md border bg-white px-2 text-sm"
            >
              {(cash?.months || []).map(item => (
                <option key={item.ym} value={item.ym}>{MONTH_LONG[item.monthIndex]} — {STATE_LABEL[item.state]}</option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.status === 'loading' && <div className="h-64 animate-pulse rounded bg-slate-100" role="status" aria-label="Caixa: carregando" />}
        {(view.status === 'error') && (
          <div role="alert" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">Não foi possível carregar o caixa de {year}.</p>
            <p className="text-xs text-amber-800">Nenhum valor é mostrado até a consulta funcionar; isto não significa caixa zerado.</p>
            <Button variant="outline" size="sm" onClick={retry}>Tentar novamente</Button>
          </div>
        )}
        {cash && (
          <>
            {cash.truncated && (
              <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                A consulta atingiu o limite de movimentos e os valores deste ano podem estar incompletos.
              </p>
            )}
            <div
              className="h-64"
              role="img"
              aria-label={`Recebido líquido e saídas por mês em ${cash.year}. Acumulado realizado: ${formatCurrency(cash.accumulated)}.`}
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
                  <Bar dataKey="outflows" name="Saídas" fill="#f97316" radius={[4, 4, 0, 0]} onClick={entry => setMonth(entry.ym)} cursor="pointer">
                    {chartData.map(item => <Cell key={item.ym} fillOpacity={item.ym === selected?.ym ? 1 : 0.55} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-slate-500">
              Meses futuros e anteriores ao primeiro movimento registrado{cash.coverageFrom ? ` (${formatDate(cash.coverageFrom)})` : ''} ficam sem barra: ausência de barra não é zero.
              Acumulado realizado em {cash.year}: <b>{formatCurrency(cash.accumulated)}</b>.
            </p>

            {selected && (
              <section aria-label={`Detalhe de ${MONTH_LONG[selected.monthIndex]} de ${cash.year}`} className="rounded-lg border bg-slate-50 p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-gray-900">{MONTH_LONG[selected.monthIndex]} de {cash.year} · {STATE_LABEL[selected.state]}</h3>
                  {hasValue && (
                    <Button variant="outline" size="sm" onClick={() => setShowMovements(true)}>Ver movimentações ({monthMovements.length})</Button>
                  )}
                </div>
                {hasValue ? (
                  <>
                    <Line label="Recebido líquido" value={selected.received} />
                    {selected.positiveAdjustments > 0 && <Line label="Ajustes positivos" value={selected.positiveAdjustments} sign="+" />}
                    <Line label="Saídas realizadas" value={selected.outflows} sign="−" />
                    <Line label="Resultado do mês" value={selected.result} sign="=" strong />
                    {!selected.reconciles && (
                      <p role="alert" className="mt-1 text-xs text-red-700">A composição não fecha com o resultado. Não use este mês como conferência.</p>
                    )}
                    {selected.state === CASH_MONTH_STATE.PARTIAL && (
                      <p className="mt-1 text-xs text-slate-600">Parcial: valores realizados até {formatDate(cash.today)}.</p>
                    )}
                    <p className="mt-1 text-xs text-slate-600">Diferença entre movimentos registrados; não é saldo bancário. A taxa já está abatida no recebido líquido.</p>
                  </>
                ) : selected.state === CASH_MONTH_STATE.FUTURE ? (
                  <p className="text-slate-600">Mês que ainda não aconteceu: não há valor realizado.</p>
                ) : (
                  <p className="text-slate-600">
                    Sem histórico confiável neste mês{cash.coverageFrom ? `: o primeiro movimento registrado é de ${formatDate(cash.coverageFrom)}` : ''}. Nenhum valor é mostrado em vez de um zero.
                  </p>
                )}
              </section>
            )}
            <div className="flex justify-end">
              <Button asChild variant="link" size="sm"><Link to="/financeiro/fluxo-caixa">Abrir fluxo de caixa completo</Link></Button>
            </div>
          </>
        )}
      </CardContent>

      <OverviewDetailDialog
        open={showMovements}
        onClose={() => setShowMovements(false)}
        title={selected ? `Movimentações de ${MONTH_LONG[selected.monthIndex]} de ${cash?.year}` : 'Movimentações'}
        description="Movimentos realizados que compõem o resultado do mês."
        summary={hasValue ? `${monthMovements.length} movimentos · resultado ${formatCurrency(selected.result)}` : undefined}
        rows={monthMovements}
        columns={[
          { key: 'date', label: 'Data', render: row => formatDate(financialMovementDate(row)) },
          { key: 'kind', label: 'Tipo', render: row => KIND_LABEL[row.movement_kind] || row.movement_kind },
          { key: 'description', label: 'Descrição', render: row => row.description || '—' },
          {
            key: 'amount',
            label: 'Valor líquido',
            align: 'right',
            render: row => formatCurrency(Number.isFinite(Number(row.signed_net_amount)) ? Number(row.signed_net_amount) : Number(row.net_amount) || 0),
          },
        ]}
        destination={{ to: '/financeiro/fluxo-caixa', label: 'Abrir fluxo de caixa' }}
      />
    </Card>
  );
}
