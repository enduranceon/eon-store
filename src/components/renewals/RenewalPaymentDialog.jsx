import { useEffect, useState } from 'react';
import { CheckCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ManualPaymentForm from '@/components/ManualPaymentForm';
import { createManualInstallments, findPreferredPaymentMethod, loadActivePaymentMethods } from '@/lib/manual-payment';
import { formatCurrency, todayLocalStr } from '@/lib/utils';
import { renewalSaleTotal } from '@/lib/assessment-renewal-pipeline';

// Registro de pagamento pelo mesmo fluxo do Financeiro. Ao confirmar, o banco
// move a renovação para "Renovou"; nada aqui muda a etapa direto.
export default function RenewalPaymentDialog({ card, onClose, onDone }) {
  const contract = card?.contract;
  const total = contract ? renewalSaleTotal(contract) : 0;
  const [methodGroups, setMethodGroups] = useState([]);
  const [form, setForm] = useState({ method_id: '', date: todayLocalStr(), value: total.toFixed(2) });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const preferredMethod = contract?.payment_method;

  useEffect(() => {
    let active = true;
    loadActivePaymentMethods()
      .then(groups => {
        if (!active) return;
        setMethodGroups(groups);
        const defaultMethod = findPreferredPaymentMethod(groups, preferredMethod);
        setForm(current => ({ ...current, method_id: defaultMethod?.id || current.method_id }));
      })
      .catch(error => toast.error(error.message || 'Erro ao carregar formas de pagamento'))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [preferredMethod]);

  const save = async () => {
    const method = methodGroups.flatMap(([, methods]) => methods).find(item => item.id === form.method_id);
    if (!method) return toast.error('Selecione a forma de pagamento');
    if (Math.abs(Number(form.value) - total) > 0.009) {
      return toast.error(`O valor recebido deve ser ${formatCurrency(total)}.`);
    }
    setSaving(true);
    try {
      await createManualInstallments(method, form.date, {
        order_id: contract.id,
        order_type: 'contract',
        external_reference: contract.contract_number,
      }, total, form.installments);
      toast.success('Pagamento registrado. A renovação foi para "Renovou".');
      onDone();
    } catch (error) {
      toast.error(error.message || 'Não foi possível registrar o pagamento');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!card} onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCheck className="w-5 h-5 text-green-600" /> Registrar pagamento da renovação
          </DialogTitle>
        </DialogHeader>
        {card && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {card.customer?.full_name || 'Atleta'} · {contract.contract_number} · {formatCurrency(total)}
            </p>
            {loading ? (
              <div className="py-12 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : (
              <ManualPaymentForm
                form={form}
                setForm={setForm}
                methodGroups={methodGroups}
                saving={saving}
                onSave={save}
                onCancel={onClose}
                lockedValue
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
