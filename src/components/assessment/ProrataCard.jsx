import { useState } from 'react';
import { CalendarRange } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmDialog from '@/components/ConfirmDialog';
import { applyAssessmentContractProrata } from '@/api/client';
import {
  PRORATA_CYCLE_DAYS,
  canChangeProrata,
  contractProrata,
  prorataFullPrice,
  prorataPreview,
} from '@/lib/assessment-prorata';
import { formatCurrency, formatDate } from '@/lib/utils';

function dayBefore(dateStr) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// Pro rata do plano mensal: o primeiro período vai até o dia do ciclo (o da
// assinatura no Asaas) e custa o mensal ÷ 30 × dias; a renovação já nasce
// cheia, do dia do ciclo ao dia do ciclo. As regras ficam no banco.
export default function ProrataCard({ contract, monthly, hasRenewal, onChanged, onNeedsCharge }) {
  const current = contractProrata(contract);
  const editable = canChangeProrata(contract, { monthly, hasRenewal });
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [cycleDay, setCycleDay] = useState('');
  const [saving, setSaving] = useState(false);

  if (!monthly || (!current && !editable)) return null;

  const preview = cycleDay ? prorataPreview(contract, Number(cycleDay)) : null;
  const full = prorataFullPrice(contract);
  const startDay = Number(String(contract.start_date || '').slice(8, 10));

  const save = async (day) => {
    setSaving(true);
    try {
      const result = await applyAssessmentContractProrata(contract.id, day, contract.updated_at);
      toast.success(day ? 'Pro rata aplicado.' : 'Pro rata desfeito.');
      setOpen(false);
      setRemoving(false);
      await onChanged?.();
      if (result?.had_charge) {
        toast.warning('O link de cobrança já enviado é do valor anterior. Registre o link novo.');
        onNeedsCharge?.();
      }
    } catch (error) {
      toast.error(error.message || 'Não foi possível salvar o pro rata');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarRange className="w-4 h-4 text-blue-600" /> Pro rata
        </CardTitle>
        {editable && (
          <div className="flex gap-2">
            {current && (
              <Button size="sm" variant="outline" onClick={() => setRemoving(true)}>Desfazer</Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setCycleDay(current ? String(current.cycle_day) : ''); setOpen(true); }}
            >
              {current ? 'Mudar dia' : 'Aplicar'}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        {current ? (
          <>
            <p>
              Primeiro período de <b>{formatDate(contract.start_date)}</b> a{' '}
              <b>{formatDate(dayBefore(contract.end_date))}</b> ({current.days} dias):{' '}
              <b>{formatCurrency(contract.plan_snapshot?.price_total)}</b>.
            </p>
            <p className="text-muted-foreground">
              Mensal de {formatCurrency(current.full_price_total)} ÷ 30 × {current.days} dias. A partir de{' '}
              {formatDate(contract.end_date)}, mensal cheio sempre do dia {current.cycle_day} ao dia {current.cycle_day}.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            Para alinhar o plano ao dia da assinatura, cobre só os dias até o dia do ciclo. A renovação já nasce
            cheia, do dia do ciclo ao dia do ciclo.
          </p>
        )}
      </CardContent>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Pro rata"
        icon={CalendarRange}
        iconClassName="text-blue-600"
        confirmLabel="Aplicar pro rata"
        busy={saving}
        onConfirm={() => {
          if (!preview) return toast.error('Escolha o dia do ciclo');
          return save(Number(cycleDay));
        }}
      >
        <div>
          <Label className="text-xs">Dia do ciclo (dia da assinatura no Asaas)</Label>
          <Select value={cycleDay} onValueChange={setCycleDay}>
            <SelectTrigger className="mt-1"><SelectValue placeholder="Escolha o dia" /></SelectTrigger>
            <SelectContent>
              {PRORATA_CYCLE_DAYS.filter(day => day !== startDay).map(day => (
                <SelectItem key={day} value={String(day)}>Dia {day}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {preview ? (
          <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 space-y-1">
            <p>
              <b>{formatDate(preview.start)}</b> a <b>{formatDate(dayBefore(preview.end))}</b>: {preview.days} dias
            </p>
            <p>
              {formatCurrency(preview.full)} ÷ 30 × {preview.days} = <b>{formatCurrency(preview.value)}</b>
            </p>
            <p className="text-blue-800">
              A partir de {formatDate(preview.end)}: {formatCurrency(full)} por mês, do dia {cycleDay} ao dia {cycleDay}.
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">Os dias até lá custam o mensal ÷ 30 por dia.</p>
        )}
        {contract.external_payment_link && (
          <p className="text-amber-700 text-xs">
            Já existe um link de cobrança. Depois de aplicar, registre o link novo com o valor do pro rata.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Desfazer pro rata"
        icon={CalendarRange}
        iconClassName="text-blue-600"
        confirmLabel="Desfazer"
        busy={saving}
        onConfirm={() => save(null)}
      >
        <p>
          O contrato volta a ser um mês cheio a partir de {formatDate(contract.start_date)}, por{' '}
          {formatCurrency(full)}.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
