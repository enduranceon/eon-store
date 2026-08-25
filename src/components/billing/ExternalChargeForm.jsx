import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EXTERNAL_CHARGE_METHODS } from '@/lib/external-charge';

export function ExternalChargeFields({ form, setForm, saving, autoFocus = false }) {
  return (
    <>
      <div>
        <Label className="text-xs">Forma da cobrança *</Label>
        <Select
          value={form.payment_method}
          onValueChange={value => setForm(current => ({ ...current, payment_method: value }))}
          disabled={saving}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Selecione a forma" />
          </SelectTrigger>
          <SelectContent>
            {EXTERNAL_CHARGE_METHODS.map(method => (
              <SelectItem key={method.value} value={method.value}>
                {method.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-xs">Link de pagamento *</Label>
        <Input
          className="mt-1 font-mono text-xs"
          placeholder="https://..."
          value={form.link}
          onChange={event => setForm(current => ({ ...current, link: event.target.value }))}
          disabled={saving}
          autoFocus={autoFocus}
        />
      </div>

      <div>
        <Label className="text-xs">Número da fatura</Label>
        <Input
          className="mt-1 font-mono text-xs"
          placeholder="Opcional"
          value={form.invoice_number}
          onChange={event => setForm(current => ({ ...current, invoice_number: event.target.value }))}
          disabled={saving}
        />
      </div>

      <div>
        <Label className="text-xs">Data de vencimento *</Label>
        <Input
          className="mt-1"
          type="date"
          value={form.due_date}
          onChange={event => setForm(current => ({ ...current, due_date: event.target.value }))}
          disabled={saving}
        />
      </div>
    </>
  );
}

export default function ExternalChargeForm({
  form,
  setForm,
  saving,
  onSave,
  onCancel,
  submitLabel = 'Salvar cobrança',
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Use quando a cobrança foi criada fora da plataforma. Salvar a cobrança não registra envio nem pagamento.
      </p>

      <ExternalChargeFields form={form} setForm={setForm} saving={saving} autoFocus />

      <div className="flex gap-2 pt-2">
        <Button variant="outline" className="flex-1" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button className="flex-1" onClick={onSave} disabled={saving}>
          <Check className="w-4 h-4 mr-1.5" />
          {saving ? 'Salvando...' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
