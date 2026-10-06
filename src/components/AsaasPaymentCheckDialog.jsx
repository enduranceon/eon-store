import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { checkAsaasPayments, listPaymentMethods } from '@/api/client';
import { createManualInstallments } from '@/lib/manual-payment';
import {
  asaasCheckCandidates,
  reconfirmAsaasItems,
  registerAsaasPayments,
  summarizeAsaasCheck,
} from '@/lib/asaas-payment-check';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';

const TYPE_LABELS = { contract: 'Assessoria', presale: 'Pré-venda', stock: 'Loja', event: 'Evento' };

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function scheduleLabel(schedule) {
  if (!schedule?.length) return 'Valores e datas das parcelas calculados pelo sistema.';
  if (schedule.length === 1) return `Entra em ${formatDate(schedule[0].date)}, como no Asaas.`;
  const values = schedule.map(row => row.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const amounts = min === max
    ? `${schedule.length}x de ${formatCurrency(min)}`
    : `${schedule.length} parcelas de ${formatCurrency(min)} a ${formatCurrency(max)}`;
  return `${amounts}, como no Asaas: a 1ª entra em ${formatDate(schedule[0].date)} e a última em ${formatDate(schedule[schedule.length - 1].date)}.`;
}

function SaleLine({ order }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-mono text-sm font-semibold text-blue-700">{order.order_number}</span>
      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
        {order.is_prospect ? 'Prospect' : TYPE_LABELS[order.type] || 'Venda'}
      </span>
      <span className="min-w-0 truncate text-sm text-gray-800">{order.customer}</span>
    </span>
  );
}

function Section({ icon: Icon, tone, title, count, children }) {
  if (!count) return null;
  return (
    <section className="space-y-2">
      <h3 className={`flex items-center gap-2 text-sm font-semibold ${tone}`}>
        <Icon className="h-4 w-4" aria-hidden="true" /> {title} ({count})
      </h3>
      {children}
    </section>
  );
}

const EMPTY_GROUPS = { ready: [], review: [], open: [], skip: [] };

// Consulta no Asaas as cobranças abertas com fatura do Asaas e registra as
// pagas pelo mesmo pagamento manual do "Receber". Nada muda no Asaas.
// Antes de gravar, confere de novo no Asaas as escolhidas e mostra o resumo
// (forma, data e cada parcela) para confirmar.
// Montado só enquanto aberto, com a lista do momento em que foi aberto;
// ao fechar, avisa se registrou algo para a tela recarregar.
export default function AsaasPaymentCheckDialog({ orders, onClose }) {
  const candidates = useMemo(() => asaasCheckCandidates(orders), [orders]);
  const [phase, setPhase] = useState(() => (candidates.length ? 'loading' : 'ready'));
  const [error, setError] = useState('');
  const [groups, setGroups] = useState(() => (candidates.length ? null : EMPTY_GROUPS));
  const [selected, setSelected] = useState(() => new Set());
  const [saved, setSaved] = useState({});
  const [review, setReview] = useState(null);

  useEffect(() => {
    if (!candidates.length) return undefined;
    let active = true;
    Promise.all([checkAsaasPayments(candidates), listPaymentMethods()])
      .then(([check, methods]) => {
        if (!active) return;
        const next = summarizeAsaasCheck(candidates, check?.results, methods, todayLocalStr());
        setGroups(next);
        setSelected(new Set(next.ready.map(item => item.key)));
        setPhase('ready');
      })
      .catch(cause => {
        if (!active) return;
        setError(cause.message || 'Não foi possível conferir no Asaas');
        setPhase('error');
      });
    return () => { active = false; };
  }, [candidates]);

  const saving = phase === 'saving';
  const busy = saving || phase === 'reconfirming';
  const confirming = Boolean(review) && (phase === 'confirm' || saving);
  const registered = Object.values(saved).some(result => result.ok);
  const close = () => onClose({ registered });
  const ready = groups?.ready || [];
  const pendingReady = ready.filter(item => !saved[item.key]?.ok);
  const selectedItems = pendingReady.filter(item => selected.has(item.key));
  const allSelected = pendingReady.length > 0 && selectedItems.length === pendingReady.length;

  const toggle = (key) => setSelected(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pendingReady.map(item => item.key)));

  // Segunda conferência: consulta de novo só as escolhidas e mostra o resumo.
  const startConfirm = async () => {
    if (!selectedItems.length) return;
    setPhase('reconfirming');
    try {
      const chosen = selectedItems.map(item => item.order);
      const [check, methods] = await Promise.all([checkAsaasPayments(chosen), listPaymentMethods()]);
      const fresh = summarizeAsaasCheck(chosen, check?.results, methods, todayLocalStr());
      setReview(reconfirmAsaasItems(selectedItems, fresh));
      setPhase('confirm');
    } catch (cause) {
      toast.error(cause.message || 'Não foi possível conferir de novo no Asaas');
      setPhase('ready');
    }
  };

  const backToList = () => {
    setReview(null);
    setPhase('ready');
  };

  const register = async () => {
    const items = review?.confirmed || [];
    if (!items.length) return;
    setPhase('saving');
    const results = await registerAsaasPayments(items, item => createManualInstallments(
      item.method,
      item.paymentDate,
      { order_id: item.order.id, order_type: item.order.type, external_reference: item.order.order_number },
      item.total,
      item.schedule || undefined,
    ));
    setSaved(current => ({ ...current, ...Object.fromEntries(results.map(result => [result.key, result])) }));
    setReview(null);
    setPhase('ready');
    const okCount = results.filter(result => result.ok).length;
    const failed = results.length - okCount;
    if (okCount) toast.success(`${plural(okCount, 'pagamento registrado', 'pagamentos registrados')}.`);
    if (failed) toast.error(`${plural(failed, 'pagamento não foi registrado', 'pagamentos não foram registrados')}. Veja o motivo na lista.`);
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Conferir pagamentos no Asaas</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Consulta as cobranças abertas que têm fatura do Asaas. Nada muda no Asaas: as pagas são registradas aqui
          como no &quot;Receber&quot;, com a forma, a data e as parcelas (valor e data de crédito) que estão no Asaas.
        </p>

        {phase === 'loading' && (
          <p role="status" className="flex items-center gap-2 rounded-lg border bg-slate-50 p-4 text-sm text-slate-700">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Consultando {plural(candidates.length, 'cobrança', 'cobranças')} no Asaas...
          </p>
        )}

        {phase === 'error' && (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error}</p>
        )}

        {phase === 'reconfirming' && (
          <p role="status" className="flex items-center gap-2 rounded-lg border bg-slate-50 p-4 text-sm text-slate-700">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Conferindo de novo no Asaas as escolhidas...
          </p>
        )}

        {confirming && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              Conferi de novo no Asaas agora. Veja cada uma antes de registrar:
            </p>
            {review.confirmed.length > 0 && (
              <ul className="space-y-2">
                {review.confirmed.map(item => (
                  <li key={item.key} className="space-y-1 rounded-lg border border-emerald-200 p-3">
                    <SaleLine order={item.order} />
                    <span className="block text-xs text-slate-600">
                      {item.method.name} · pago em {formatDate(item.paymentDate)} · total {formatCurrency(item.total)}
                    </span>
                    {item.schedule ? (
                      <ol className="grid gap-x-4 gap-y-0.5 text-xs text-slate-600 sm:grid-cols-2">
                        {item.schedule.map(row => (
                          <li key={row.number}>
                            {row.number}ª parcela · entra em {formatDate(row.date)} · {formatCurrency(row.value)}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <span className="block text-xs text-slate-500">Valores e datas das parcelas calculados pelo sistema.</span>
                    )}
                    {item.order.is_prospect && (
                      <span className="block text-xs text-violet-700">Ao registrar, o prospect vira aluno.</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {review.changed.length > 0 && (
              <div role="alert" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-medium">Não vão ser registradas:</p>
                <ul className="space-y-0.5 text-xs">
                  {review.changed.map(({ item, reason }) => (
                    <li key={item.key}>{item.order.order_number} · {item.order.customer}: {reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {!review.confirmed.length && (
              <p className="text-sm text-slate-700">Nenhuma das escolhidas continua igual no Asaas. Volte e confira de novo.</p>
            )}
          </div>
        )}

        {groups && !confirming && (
          <div className="space-y-5">
            {!candidates.length && (
              <p className="rounded-lg border bg-slate-50 p-4 text-sm text-slate-700">
                Nenhuma cobrança aberta tem fatura do Asaas salva.
              </p>
            )}

            <Section icon={CheckCircle2} tone="text-emerald-700" title="Pagas no Asaas" count={ready.length}>
              {pendingReady.length > 1 && (
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={allSelected} disabled={busy} onChange={toggleAll} />
                  Selecionar todas
                </label>
              )}
              <ul className="space-y-2">
                {ready.map(item => {
                  const result = saved[item.key];
                  return (
                    <li key={item.key}>
                      <label className={`flex items-start gap-3 rounded-lg border p-3 ${result?.ok ? 'border-emerald-200 bg-emerald-50' : 'cursor-pointer hover:bg-gray-50'}`}>
                        {result?.ok ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Registrado" />
                        ) : (
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
                            checked={selected.has(item.key)}
                            disabled={busy}
                            onChange={() => toggle(item.key)}
                            aria-label={`Registrar ${item.order.order_number}`}
                          />
                        )}
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <SaleLine order={item.order} />
                          <span className="block text-xs text-slate-600">
                            {item.method.name} · pago em {formatDate(item.paymentDate)} · {formatCurrency(item.total)}
                          </span>
                          <span className="block text-xs text-slate-500">{scheduleLabel(item.schedule)}</span>
                          {item.order.is_prospect && !result?.ok && (
                            <span className="block text-xs text-violet-700">Ao registrar, o prospect vira aluno.</span>
                          )}
                          {result?.ok && <span className="block text-xs font-medium text-emerald-700">Registrado.</span>}
                          {result && !result.ok && <span className="block text-xs font-medium text-red-700">{result.message}</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </Section>

            <Section icon={AlertTriangle} tone="text-amber-700" title="Precisam de conferência" count={groups.review.length}>
              <ul className="space-y-2">
                {groups.review.map(item => (
                  <li key={item.key} className="space-y-0.5 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                    <SaleLine order={item.order} />
                    <span className="block text-xs text-amber-900">{item.reason}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section icon={Clock} tone="text-slate-700" title="Ainda em aberto no Asaas" count={groups.open.length}>
              <ul className="divide-y rounded-lg border">
                {groups.open.map(item => (
                  <li key={item.key} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <SaleLine order={item.order} />
                    <span className="text-xs text-slate-600">{item.label} · {formatCurrency(item.order.total_value)}</span>
                  </li>
                ))}
              </ul>
            </Section>

            {groups.skip.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {plural(groups.skip.length, 'cobrança já estava paga ou encerrada', 'cobranças já estavam pagas ou encerradas')} no sistema.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          {confirming ? (
            <>
              <Button variant="outline" className="min-h-11" disabled={saving} onClick={backToList}>Voltar</Button>
              <Button
                className="min-h-11 bg-emerald-600 hover:bg-emerald-700"
                disabled={saving || !review.confirmed.length}
                onClick={register}
              >
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
                {saving ? 'Registrando...' : `Confirmar e registrar ${plural(review.confirmed.length, 'pagamento', 'pagamentos')}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" className="min-h-11" disabled={busy} onClick={close}>Fechar</Button>
              {pendingReady.length > 0 && (
                <Button
                  className="min-h-11 bg-emerald-600 hover:bg-emerald-700"
                  disabled={busy || !selectedItems.length}
                  onClick={startConfirm}
                >
                  {phase === 'reconfirming' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
                  {`Revisar e registrar ${plural(selectedItems.length, 'pagamento', 'pagamentos')}`}
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
