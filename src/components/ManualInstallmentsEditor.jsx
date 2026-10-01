import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { editManualPaymentInstallments } from '@/api/client';

const money = value => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const cents = value => Math.round(Number(value) * 100);

export default function ManualInstallmentsEditor({ orderType, order, installments, onSaved }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [original, setOriginal] = useState([]);
  const [saving, setSaving] = useState(false);
  const eligible = order.manual_payment && order.payment_status === 'paid' && installments.length > 0
    && installments.every(p => p.source === 'manual' && ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(p.status));
  if (!eligible) return null;

  const total = original.reduce((sum, p) => sum + cents(p.value), 0);
  const sum = rows.reduce((acc, p) => acc + cents(p.value), 0);
  const valid = rows.length > 0 && sum === total && rows.every(p => p.credit_date && Number(p.value) > 0);
  const start = () => {
    const snapshot = installments.map(p => ({ id: p.id, value: Number(p.value), due_date: p.due_date, credit_date: p.credit_date }));
    setOriginal(snapshot);
    setRows(snapshot.map(p => ({ ...p, credit_date: p.credit_date || p.due_date || '' })));
    setOpen(true);
  };
  const change = (index, patch) => setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await editManualPaymentInstallments(orderType, order.id, rows.map(p => ({ ...p, value: Number(p.value) })), original);
      setOpen(false);
      toast.success('Parcelas atualizadas');
      await onSaved();
    } catch (error) {
      toast.error(error.message || 'Não foi possível atualizar as parcelas');
    } finally {
      setSaving(false);
    }
  };
  return <>
    <Button type="button" variant="outline" size="sm" onClick={start} className="m-2 text-xs">
      <Pencil className="w-3 h-3 mr-1" /> Editar parcelas
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!saving) setOpen(value); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar parcelas do pagamento</DialogTitle>
          <DialogDescription>Ajuste a data de crédito e o valor de cada parcela. A quantidade e o total de {money(total / 100)} devem permanecer iguais.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {rows.map((row, index) => <div key={row.id} className="grid grid-cols-[2rem_1fr_1fr] gap-2 items-end">
            <span className="text-xs pb-3">{index + 1}/{rows.length}</span>
            <label className="text-xs min-w-0">Data de crédito
              <Input aria-label={`Data da parcela ${index + 1}`} type="date" value={row.credit_date} disabled={saving} onChange={e => change(index, { credit_date: e.target.value, due_date: e.target.value })} />
            </label>
            <label className="text-xs min-w-0">Valor (R$)
              <Input aria-label={`Valor da parcela ${index + 1}`} type="number" step="0.01" min="0.01" value={row.value} disabled={saving} onChange={e => change(index, { value: e.target.value })} />
            </label>
          </div>)}
          <p className={sum === total ? 'text-sm' : 'text-sm text-red-600'} role="status">Soma: {money(sum / 100)} de {money(total / 100)}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancelar</Button>
          <Button disabled={!valid || saving} onClick={save}>{saving ? 'Salvando…' : 'Salvar parcelas'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
