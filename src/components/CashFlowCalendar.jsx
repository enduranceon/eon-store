import { useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Zap, Banknote, CreditCard, Wallet,
  CalendarDays, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function billingIcon(type) {
  const up = String(type || '').toUpperCase();
  if (up === 'PIX')        return <Zap className="w-3.5 h-3.5" />;
  if (up === 'BOLETO')     return <Banknote className="w-3.5 h-3.5" />;
  if (up.includes('CARD') || up.includes('CREDIT')) return <CreditCard className="w-3.5 h-3.5" />;
  return <Wallet className="w-3.5 h-3.5" />;
}

function amountOf(p) {
  return Number(p.value) || 0;
}

// Calendário de recebimentos: bolinha verde nos dias com recebimento,
// clique em um dia (ou arraste de um dia a outro) para ver o total e as parcelas.
export default function CashFlowCalendar({ payments }) {
  const todayStr = todayLocalStr();
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date(); d.setDate(1); return d;
  });
  // Seleção de intervalo: start sempre <= end. end null = ainda escolhendo / dia único.
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);

  // Mapa dateStr -> { count, amount, items }
  const byDate = useMemo(() => {
    const map = {};
    for (const p of payments) {
      const d = p.credit_date;
      if (!d) continue;
      if (!map[d]) map[d] = { count: 0, amount: 0, items: [] };
      map[d].count++;
      map[d].amount += amountOf(p);
      map[d].items.push(p);
    }
    return map;
  }, [payments]);

  // Intensidade da bolinha por faixa de valor (relativo ao maior dia do mês exibido)
  const monthMaxAmount = useMemo(() => {
    const ym = toLocalDateStr(viewMonth).slice(0, 7);
    let max = 0;
    for (const [d, info] of Object.entries(byDate)) {
      if (d.slice(0, 7) === ym) max = Math.max(max, info.amount);
    }
    return max;
  }, [byDate, viewMonth]);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const monthTitle = viewMonth.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

  // Células do grid (com blanks iniciais para alinhar o dia da semana)
  const cells = useMemo(() => {
    const startWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const arr = [];
    for (let i = 0; i < startWeekday; i++) arr.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      arr.push(toLocalDateStr(new Date(year, month, day)));
    }
    return arr;
  }, [year, month]);

  const goPrev = () => setViewMonth(new Date(year, month - 1, 1));
  const goNext = () => setViewMonth(new Date(year, month + 1, 1));
  const goToday = () => { const d = new Date(); d.setDate(1); setViewMonth(d); };

  function handleDayClick(dateStr) {
    if (!byDate[dateStr]) return; // só dias com recebimento são clicáveis
    if (!rangeStart || (rangeStart && rangeEnd)) {
      // começa nova seleção
      setRangeStart(dateStr);
      setRangeEnd(null);
    } else {
      // fecha o intervalo
      if (dateStr === rangeStart) {
        setRangeEnd(dateStr); // dia único
      } else if (dateStr < rangeStart) {
        setRangeEnd(rangeStart);
        setRangeStart(dateStr);
      } else {
        setRangeEnd(dateStr);
      }
    }
  }

  const clearSelection = () => { setRangeStart(null); setRangeEnd(null); };

  function inSelectedRange(dateStr) {
    if (!rangeStart) return false;
    const end = rangeEnd || rangeStart;
    return dateStr >= rangeStart && dateStr <= end;
  }

  // Parcelas e totais do que está selecionado
  const selection = useMemo(() => {
    if (!rangeStart) return null;
    const end = rangeEnd || rangeStart;
    const items = [];
    for (const [d, info] of Object.entries(byDate)) {
      if (d >= rangeStart && d <= end) items.push(...info.items);
    }
    items.sort((a, b) => (a.credit_date || '').localeCompare(b.credit_date || ''));
    const amount = items.reduce((s, p) => s + amountOf(p), 0);
    return {
      start: rangeStart, end, isSingle: rangeStart === end,
      items, amount, count: items.length,
    };
  }, [rangeStart, rangeEnd, byDate]);

  const dotColor = (amount) => {
    if (monthMaxAmount <= 0) return 'bg-emerald-400';
    const ratio = amount / monthMaxAmount;
    if (ratio >= 0.66) return 'bg-emerald-600';
    if (ratio >= 0.33) return 'bg-emerald-500';
    return 'bg-emerald-400';
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-emerald-600" />
          Calendário de recebimentos
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Dias com bolinha verde têm recebimentos. Clique em um dia para ver o detalhe, ou clique em dois dias para somar um período.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* ── Calendário ─────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <button onClick={goPrev} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2">
                <span className="font-semibold capitalize text-sm">{monthTitle}</span>
                <button onClick={goToday} className="text-[10px] uppercase font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-1.5 py-0.5 rounded">
                  Hoje
                </button>
              </div>
              <button onClick={goNext} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 mb-1">
              {WEEKDAYS.map(w => (
                <div key={w} className="text-center text-[10px] font-medium text-muted-foreground uppercase py-1">{w}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {cells.map((dateStr, i) => {
                if (!dateStr) return <div key={`b${i}`} />;
                const info = byDate[dateStr];
                const has = !!info;
                const day = Number(dateStr.slice(8, 10));
                const isToday = dateStr === todayStr;
                const selected = inSelectedRange(dateStr);
                const isEdge = dateStr === rangeStart || dateStr === rangeEnd;
                return (
                  <button
                    key={dateStr}
                    onClick={() => handleDayClick(dateStr)}
                    disabled={!has}
                    className={[
                      'relative aspect-square rounded-lg flex flex-col items-center justify-center text-xs transition',
                      has ? 'cursor-pointer hover:ring-2 hover:ring-emerald-300' : 'cursor-default text-gray-300',
                      selected ? 'bg-emerald-100' : has ? 'bg-emerald-50/40' : '',
                      isEdge ? 'ring-2 ring-emerald-500' : '',
                      isToday && !isEdge ? 'ring-1 ring-blue-400' : '',
                    ].join(' ')}
                  >
                    <span className={`font-medium ${has ? 'text-gray-900' : ''} ${isToday ? 'text-blue-600 font-bold' : ''}`}>
                      {day}
                    </span>
                    {has && (
                      <>
                        <span className={`w-1.5 h-1.5 rounded-full mt-0.5 ${dotColor(info.amount)}`} />
                        <span className="hidden sm:block text-[8px] text-emerald-700 font-semibold leading-none mt-0.5">
                          {info.amount >= 1000 ? `${(info.amount / 1000).toFixed(1)}k` : Math.round(info.amount)}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Detalhe da seleção ─────────────────────────── */}
          <div className="lg:border-l lg:pl-5">
            {!selection ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-10 text-muted-foreground">
                <CalendarDays className="w-8 h-8 mb-2 opacity-40" />
                <p className="text-sm">Selecione um dia no calendário</p>
                <p className="text-xs mt-1">ou clique em dois dias para somar um período</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm capitalize">
                      {selection.isSingle
                        ? formatDate(selection.start)
                        : `${formatDate(selection.start)} → ${formatDate(selection.end)}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {selection.count} parcela{selection.count !== 1 ? 's' : ''}
                      {!selection.isSingle && ' no período'}
                    </p>
                  </div>
                  <button onClick={clearSelection} className="p-1 rounded-md hover:bg-gray-100 text-gray-400">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-2 text-center">
                  <div className="rounded-lg bg-emerald-50 p-2">
                    <p className="text-[10px] text-emerald-700 uppercase">Recebimento</p>
                    <p className="font-bold text-sm text-emerald-700">{formatCurrency(selection.amount)}</p>
                  </div>
                </div>

                <div className="divide-y border rounded-xl max-h-72 overflow-y-auto">
                  {selection.items.map(item => (
                    <div key={item.id} className="flex items-center gap-3 p-2.5 text-sm hover:bg-gray-50">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0 w-20">
                        {billingIcon(item.billing_type)}
                        <span>{formatDate(item.credit_date)}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate text-xs">
                          {item._customer
                            || item.description
                            || item.external_reference
                            || `Parcela #${item.installment_number || '?'}`}
                        </p>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {item._orderNumber ? `#${item._orderNumber} · ` : ''}
                          {item.source === 'manual' ? '✋ Manual' : '⚡ Asaas'}
                          {item.installment_number && item.total_installments > 1 &&
                            ` · ${item.installment_number}/${item.total_installments}`}
                          {item._customer && item.description ? ` · ${item.description}` : ''}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-semibold text-sm">{formatCurrency(amountOf(item))}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        </div>
      </CardContent>
    </Card>
  );
}
