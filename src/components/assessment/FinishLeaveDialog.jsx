import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { leaveFinishPreview, leaveLastDayProblem } from '@/lib/leave-finish';
import { formatDate, todayLocalStr } from '@/lib/utils';

// Encerrar uma licença sem data de volta escolhendo o último dia dela. O dia
// conta como dia de licença; os dias somados ao fim do contrato vão do início
// até esse dia. `onConfirm(ultimoDia)` recebe AAAA-MM-DD.
export default function FinishLeaveDialog({ open, leave, contractEnd, busy = false, onConfirm, onClose }) {
  const today = todayLocalStr();
  const [lastDay, setLastDay] = useState(today);

  useEffect(() => {
    if (open) setLastDay(todayLocalStr());
  }, [open, leave?.id]);

  const leaveStart = leave?.start_date || '';
  const problem = leaveLastDayProblem({ leaveStart, lastDay, today });
  const preview = leaveFinishPreview({ leaveStart, contractEnd, lastDay, today });
  const isPast = !problem && lastDay < today;

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Encerrar licença</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Licença sem data de volta, desde {formatDate(leaveStart)}.
          </p>
          <div>
            <Label htmlFor="finish-leave-last-day">Último dia da licença</Label>
            <Input
              id="finish-leave-last-day"
              type="date"
              value={lastDay}
              min={leaveStart || undefined}
              max={today}
              disabled={busy}
              onChange={event => setLastDay(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              O dia escolhido conta como dia de licença. Se o aluno voltou a treinar numa data, escolha o dia anterior a ela.
            </p>
          </div>
          {problem ? (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{problem}</p>
          ) : preview && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <p><strong>{preview.days} dia{preview.days !== 1 ? 's' : ''}</strong> parado{preview.days !== 1 ? 's' : ''}.</p>
              <p>O vencimento vai de {formatDate(contractEnd)} para <strong>{formatDate(preview.newEnd)}</strong>.</p>
            </div>
          )}
          {isPast && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Data no passado: se o fechamento do repasse daquele mês estiver em revisão, ele precisa ser gerado de novo. Mês já aprovado ou pago não aceita.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busy} onClick={onClose}>Cancelar</Button>
            <Button className="flex-1" disabled={busy || Boolean(problem)} onClick={() => onConfirm(lastDay)}>
              {busy ? 'Encerrando…' : 'Encerrar licença'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
