import { useEffect, useMemo, useState } from 'react';
import { CheckCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { checkAsaasPayments, listPaymentMethods } from '@/api/client';
import { asaasCheckCandidates, hasAsaasInvoiceLink, summarizeAsaasCheck } from '@/lib/asaas-payment-check';
import { todayLocalStr } from '@/lib/utils';

// Antes de cobrar de novo, consulta no Asaas (só leitura) se a fatura já foi
// paga. Se foi, o pagamento é registrado pela conferência, com confirmação.
// `order` usa o formato da tela de Cobranças ({ type, id, total_value,
// external_payment_link, ... }); a consulta só se repete quando esses dados mudam.
export default function AsaasPaidNotice({ order, onRegister }) {
  const {
    type, id, order_number: number, customer, total_value: total, payment_status: status,
    asaas_charge_id: chargeId, external_payment_link: link, is_prospect: isProspect,
  } = order || {};
  const snapshot = useMemo(() => ({
    type, id, order_number: number, customer, total_value: total, payment_status: status,
    asaas_charge_id: chargeId, external_payment_link: link, is_prospect: isProspect,
  }), [type, id, number, customer, total, status, chargeId, link, isProspect]);
  const canCheck = asaasCheckCandidates([snapshot]).length > 0;
  const [state, setState] = useState({ order: null, phase: 'none' });

  useEffect(() => {
    if (!canCheck) return undefined;
    let active = true;
    Promise.all([checkAsaasPayments([snapshot]), listPaymentMethods()])
      .then(([check, methods]) => {
        if (!active) return;
        const groups = summarizeAsaasCheck([snapshot], check?.results, methods, todayLocalStr());
        const paid = groups.ready[0] || groups.review[0];
        if (paid) setState({ order: snapshot, phase: 'paid', reason: groups.ready[0] ? '' : paid.reason });
        else if (groups.open[0]) setState({ order: snapshot, phase: 'open', label: groups.open[0].label });
        else setState({ order: snapshot, phase: 'none' });
      })
      .catch(() => { if (active) setState({ order: snapshot, phase: 'error' }); });
    return () => { active = false; };
  }, [canCheck, snapshot]);

  if (!link) return null;
  if (!hasAsaasInvoiceLink(snapshot)) {
    return (
      <p className="text-xs text-muted-foreground">
        Este link não é uma fatura do Asaas. Confira se a pessoa já pagou antes de enviar.
      </p>
    );
  }
  if (canCheck && state.order !== snapshot) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Conferindo no Asaas se já foi pago...
      </p>
    );
  }
  if (state.phase === 'paid') {
    return (
      <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-950">
        <p className="font-semibold">Já pagou no Asaas</p>
        <p className="mt-0.5 text-xs">
          {state.reason || 'Registre o pagamento em vez de mandar a mensagem.'}
        </p>
        <Button size="sm" className="mt-2 bg-green-600 hover:bg-green-700" onClick={() => onRegister(snapshot)}>
          <CheckCheck className="mr-1 h-3.5 w-3.5" /> Registrar pagamento
        </Button>
      </div>
    );
  }
  if (state.phase === 'open') {
    return <p className="text-xs text-muted-foreground">Conferido no Asaas agora: {state.label}.</p>;
  }
  if (state.phase === 'error') {
    return (
      <p role="alert" className="text-xs text-amber-800">
        Não deu para conferir no Asaas agora. Confira lá se a pessoa já pagou antes de enviar.
      </p>
    );
  }
  return null;
}
