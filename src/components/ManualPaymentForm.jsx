import { useEffect, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatCurrency, todayLocalStr } from '@/lib/utils';
import { projectInstallments } from '@/lib/manual-payment';
import { Calendar, ChevronRight, Banknote, RotateCcw, AlertTriangle } from 'lucide-react';

const CENT = 0.01;

// Componente compartilhado entre OrderDetail, StockOrderDetail, ContractDetail e EventDetail.
// Props:
//   form         = { method_id, date, value, installments?, installmentsCustom? }
//   setForm      = setter
//   methodGroups = [[groupName, [method, ...]], ...] de loadActivePaymentMethods()
//   saving       = bool
//   onSave, onCancel
//
// `installments` fica no próprio `form` (parcela: { number, total, date, value }) para
// que o `onSave` do componente pai (que lê o form direto) já mande a projeção editada
// pro backend. Por padrão é recalculada automaticamente a cada troca de método/data/valor;
// assim que o usuário edita uma parcela na mão, para de recalcular sozinho até ele clicar
// em "Recalcular automaticamente".
export default function ManualPaymentForm({ form, setForm, methodGroups, saving, onSave, onCancel }) {
  const allMethods = useMemo(() => methodGroups.flatMap(([, list]) => list), [methodGroups]);
  const selected   = useMemo(() => allMethods.find(m => m.id === form.method_id) || null, [allMethods, form.method_id]);

  const valor = Number(form.value) || 0;
  const installments = form.installments || [];

  // Recalcula a projeção padrão sempre que método/data/valor mudam — a não ser
  // que o usuário já tenha editado alguma parcela na mão (installmentsCustom).
  useEffect(() => {
    if (!selected || !form.date) return;
    setForm(f => {
      if (f.installmentsCustom) return f;
      return { ...f, installments: projectInstallments(selected, f.date, Number(f.value) || 0) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, form.date, form.value]);

  const updateInstallment = (index, patch) => {
    setForm(f => ({
      ...f,
      installmentsCustom: true,
      installments: (f.installments || []).map((row, i) => i === index ? { ...row, ...patch } : row),
    }));
  };

  const resetInstallments = () => {
    if (!selected || !form.date) return;
    setForm(f => ({
      ...f,
      installmentsCustom: false,
      installments: projectInstallments(selected, f.date, Number(f.value) || 0),
    }));
  };

  const installmentsSum = installments.reduce((acc, row) => acc + (Number(row.value) || 0), 0);
  const sumMismatch = installments.length > 0 && Math.abs(installmentsSum - valor) > CENT;
  const canSave = !sumMismatch && installments.every(row => row.date && Number(row.value) > 0);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground bg-green-50 border border-green-200 rounded-lg px-3 py-2">
        Registra que o pagamento foi recebido. Se for parcelado, o sistema projeta cada parcela no fluxo de caixa — e você pode ajustar valor e data de cada uma antes de confirmar.
      </p>

      <div>
        <Label>Forma de pagamento *</Label>
        <select
          className="w-full mt-1 h-10 border rounded-lg px-3 text-sm bg-white"
          value={form.method_id}
          onChange={e => setForm(f => ({ ...f, method_id: e.target.value, installmentsCustom: false }))}
        >
          <option value="">Selecione...</option>
          {methodGroups.map(([groupName, list]) => (
            <optgroup key={groupName} label={groupName}>
              {list.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {Number(m.installments) > 1 ? ` — ${m.installments}x` : ''}
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
            onChange={e => setForm(f => ({ ...f, date: e.target.value, installmentsCustom: false }))}
            max={todayLocalStr()} />
        </div>
      </div>

      {/* Parcelas — editáveis */}
      {installments.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-blue-50 border-b border-blue-200 px-3 py-2 text-xs font-semibold text-blue-900 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              {installments.length === 1 ? 'Data de crédito' : 'Parcelas projetadas no fluxo de caixa'}
            </span>
            {form.installmentsCustom && (
              <button type="button" onClick={resetInstallments}
                className="flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium">
                <RotateCcw className="w-3 h-3" /> Recalcular automaticamente
              </button>
            )}
          </div>
          <div className="divide-y max-h-64 overflow-y-auto">
            {installments.map((row, index) => (
              <div key={row.number} className="flex items-center gap-2 px-3 py-2">
                <span className="text-xs font-bold text-muted-foreground w-8 shrink-0">
                  {installments.length === 1 ? '1x' : `${row.number}/${row.total}`}
                </span>
                <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <Input type="date" value={row.date}
                  onChange={e => updateInstallment(index, { date: e.target.value })}
                  className="h-8 text-xs flex-1" />
                <Input type="number" step="0.01" value={row.value}
                  onChange={e => updateInstallment(index, { value: e.target.value })}
                  className="h-8 text-xs w-28" />
              </div>
            ))}
          </div>
          <div className={`px-3 py-2 text-xs flex items-center justify-between border-t ${sumMismatch ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-muted-foreground'}`}>
            <span className="flex items-center gap-1">
              {sumMismatch && <AlertTriangle className="w-3.5 h-3.5" />}
              Soma das parcelas
            </span>
            <span className="font-semibold">{formatCurrency(installmentsSum)}{sumMismatch && ` (esperado ${formatCurrency(valor)})`}</span>
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="outline" className="flex-1" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={onSave} disabled={saving || !canSave}>
          <Banknote className="w-4 h-4 mr-1.5" />
          {saving ? 'Salvando...' : 'Confirmar recebimento'}
        </Button>
      </div>
    </div>
  );
}
