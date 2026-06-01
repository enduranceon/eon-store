import { useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { calcFee, projectInstallments } from '@/lib/manual-payment';
import { Calendar, ChevronRight, Banknote } from 'lucide-react';

// Componente compartilhado entre OrderDetail, StockOrderDetail e ContractDetail.
// Props:
//   form         = { method_id, date, value }
//   setForm      = setter
//   methodGroups = [[groupName, [method, ...]], ...] de loadActivePaymentMethods()
//   saving       = bool
//   onSave, onCancel
export default function ManualPaymentForm({ form, setForm, methodGroups, saving, onSave, onCancel }) {
  const allMethods = useMemo(() => methodGroups.flatMap(([, list]) => list), [methodGroups]);
  const selected   = useMemo(() => allMethods.find(m => m.id === form.method_id) || null, [allMethods, form.method_id]);

  const valor   = Number(form.value) || 0;
  const fee     = selected ? calcFee(selected, valor) : 0;
  const liquido = Math.max(0, valor - fee);
  const installments = selected?.installments || 1;
  const parcels = selected && form.date ? projectInstallments(selected, form.date) : [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground bg-green-50 border border-green-200 rounded-lg px-3 py-2">
        Registra que o pagamento foi recebido. Se for parcelado, o sistema projeta cada parcela no fluxo de caixa.
      </p>

      <div>
        <Label>Forma de pagamento *</Label>
        <select
          className="w-full mt-1 h-10 border rounded-lg px-3 text-sm bg-white"
          value={form.method_id}
          onChange={e => setForm(f => ({ ...f, method_id: e.target.value }))}
        >
          <option value="">Selecione...</option>
          {methodGroups.map(([groupName, list]) => (
            <optgroup key={groupName} label={groupName}>
              {list.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {Number(m.fee_percent) > 0 || Number(m.fee_fixed) > 0
                    ? ` — taxa ${Number(m.fee_percent).toFixed(2)}%${m.fee_fixed > 0 ? ` + R$ ${Number(m.fee_fixed).toFixed(2)}` : ''}`
                    : ' — sem taxa'}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Valor recebido (R$) *</Label>
          <Input type="number" step="0.01" className="mt-1"
            value={form.value}
            onChange={e => setForm(f => ({ ...f, value: e.target.value }))} />
        </div>
        <div>
          <Label>Data do pagamento *</Label>
          <Input type="date" className="mt-1"
            value={form.date}
            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            max={todayLocalStr()} />
        </div>
      </div>

      {/* Resumo */}
      {selected && valor > 0 && (
        <div className="bg-gray-50 border rounded-lg p-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Bruto</span>
            <span className="font-medium">{formatCurrency(valor)}</span>
          </div>
          {fee > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">− Taxa ({Number(selected.fee_percent).toFixed(2)}%{selected.fee_fixed > 0 ? ` + R$ ${Number(selected.fee_fixed).toFixed(2)}` : ''})</span>
              <span className="text-red-600">−{formatCurrency(fee)}</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-1 mt-1">
            <span className="font-semibold">Líquido total</span>
            <span className="font-bold text-green-700">{formatCurrency(liquido)}</span>
          </div>
          {installments > 1 && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Parcelamento</span>
              <span>{installments}x de {formatCurrency(liquido / installments)}</span>
            </div>
          )}
        </div>
      )}

      {/* Preview das datas de crédito */}
      {parcels.length > 0 && form.date && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 text-xs font-semibold text-blue-900 flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" />
            Datas de crédito projetadas no fluxo de caixa
          </div>
          <div className="divide-y max-h-48 overflow-y-auto">
            {parcels.map(p => (
              <div key={p.number} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="text-xs font-bold text-muted-foreground w-10 shrink-0">
                  {parcels.length === 1 ? '1x' : `${p.number}/${p.total}`}
                </span>
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs text-gray-700 flex-1">{formatDate(p.credit_date)}</span>
                <span className="font-semibold text-sm">
                  {formatCurrency(liquido / parcels.length)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={onSave} disabled={saving}>
          <Banknote className="w-4 h-4 mr-1.5" />
          {saving ? 'Salvando...' : 'Confirmar recebimento'}
        </Button>
      </div>
    </div>
  );
}
