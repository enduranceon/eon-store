import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, Check, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { checkAsaasSubscriptions, enableAutoRenewalFromSubscription } from '@/api/client';
import {
  billingTypeLabel,
  groupSubscriptionCheck,
  subscriptionCheckNote,
  subscriptionValueDiffers,
} from '@/lib/asaas-subscription-check';
import { formatCurrency, formatDate } from '@/lib/utils';

// Planos mensais com a renovação automática desligada: quem já tem assinatura
// mensal ativa no Asaas (só consulta) e o botão para ligar a automática.
export default function SubscriptionCheckDialog({ open, onClose, onChanged }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [enabledIds, setEnabledIds] = useState(() => new Set());

  const run = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await checkAsaasSubscriptions());
    } catch (e) {
      setData(null);
      setError(e.message || 'Não foi possível consultar o Asaas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setEnabledIds(new Set());
    run();
  }, [open, run]);

  const enable = async (result) => {
    setBusyId(result.contract_id);
    try {
      await enableAutoRenewalFromSubscription(result.contract_id, result.subscription.id);
      setEnabledIds(prev => new Set(prev).add(result.contract_id));
      toast.success(`Renovação automática ligada para ${result.customer_name || result.contract_number}.`);
      onChanged?.();
    } catch (e) {
      toast.error(e.message || 'Não foi possível ligar a renovação automática');
    } finally {
      setBusyId(null);
    }
  };

  const groups = groupSubscriptionCheck(data?.results || []);

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busyId) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeCheck className="w-5 h-5 text-blue-600" /> Conferir assinaturas no Asaas
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Planos mensais com a renovação automática desligada. O sistema procura no Asaas, só consultando,
            assinaturas mensais ativas pelo CPF/CNPJ de cada pessoa. Ligar a automática não muda nada no Asaas:
            a próxima renovação já nasce automática e busca a fatura nessa assinatura.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Consultando o Asaas...
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {!loading && data && (
            <>
              <p className="text-sm">
                <b>{data.checked}</b> plano{data.checked === 1 ? '' : 's'} mensa{data.checked === 1 ? 'l' : 'is'} conferido{data.checked === 1 ? '' : 's'}
                {' · '}<b className="text-green-700">{data.found}</b> com assinatura no Asaas
              </p>
              {data.checked === 0 && (
                <p className="text-sm text-muted-foreground">Todos os planos mensais já estão com a renovação automática ligada.</p>
              )}
              <div className="max-h-[60vh] overflow-y-auto space-y-4 pr-1">
                {groups.map(group => (
                  <section key={group.key} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.title} ({group.items.length})
                    </h3>
                    <ul className="space-y-2">
                      {group.items.map(result => (
                        <SubscriptionCheckRow
                          key={result.contract_id}
                          result={result}
                          enabled={enabledIds.has(result.contract_id)}
                          busy={busyId === result.contract_id}
                          disabled={!!busyId}
                          onEnable={() => enable(result)}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" disabled={!!busyId} onClick={onClose}>Fechar</Button>
            <Button variant="outline" className="flex-1" disabled={loading || !!busyId} onClick={run}>
              <RotateCcw className="w-4 h-4 mr-1.5" /> Consultar de novo
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SubscriptionCheckRow({ result, enabled, busy, disabled, onEnable }) {
  const subscription = result.subscription;
  const note = subscriptionCheckNote(result);
  const valueDiffers = subscription && subscriptionValueDiffers(result);
  return (
    <li className="rounded-lg border p-3 text-sm flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-gray-900 truncate">{result.customer_name || 'Pessoa sem nome'}</p>
        <p className="text-xs text-muted-foreground">
          <Link to={`/assessoria/contratos/${result.contract_id}`} className="font-mono text-blue-700 hover:underline">
            {result.contract_number}
          </Link>
          {result.plan_name && <> · {result.plan_name}</>}
          {result.end_date && <> · fim {formatDate(result.end_date)}</>}
        </p>
        {subscription && (
          <p className="text-xs text-gray-700">
            Assinatura de {formatCurrency(subscription.value)}
            {billingTypeLabel(subscription.billing_type) && <> · {billingTypeLabel(subscription.billing_type)}</>}
            {subscription.next_due_date && <> · próxima fatura {formatDate(subscription.next_due_date)}</>}
          </p>
        )}
        {valueDiffers && (
          <p className="text-xs text-amber-700">
            Valor diferente: no contrato {formatCurrency(result.expected_value)}.
          </p>
        )}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {subscription && (
        enabled ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700">
            <Check className="w-4 h-4" /> Automática ligada
          </span>
        ) : (
          <Button size="sm" disabled={disabled} onClick={onEnable}>
            {busy && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            Ligar automática
          </Button>
        )
      )}
    </li>
  );
}
