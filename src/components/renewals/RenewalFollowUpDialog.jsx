import { useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { transitionAssessmentRenewalStage } from '@/api/client';
import { todayLocalStr } from '@/lib/utils';

// Data do próximo contato enquanto o atleta decide. É independente do fim do
// contrato: se passar, o card continua e fica mais urgente.
export default function RenewalFollowUpDialog({ card, onClose, onDone, onConflict }) {
  const contract = card?.contract;
  const [followUpAt, setFollowUpAt] = useState(contract?.renewal_follow_up_at || '');
  const [saving, setSaving] = useState(false);

  const save = async (value) => {
    if (value && value < todayLocalStr()) return toast.error('O follow-up precisa ser de hoje em diante');
    setSaving(true);
    try {
      await transitionAssessmentRenewalStage(contract.id, {
        action: 'set_follow_up',
        expectedUpdatedAt: contract.updated_at,
        followUpAt: value || null,
      });
      toast.success(value ? 'Follow-up marcado.' : 'Follow-up removido.');
      onDone();
    } catch (error) {
      if (error?.status === 409) {
        toast.error(error.message || 'A renovação mudou. Atualizando a tela.');
        onConflict();
      } else {
        toast.error(error.message || 'Não foi possível salvar o follow-up');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!card} onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-violet-600" /> Follow-up
          </DialogTitle>
        </DialogHeader>
        {card && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {card.customer?.full_name || 'Atleta'} · {contract.contract_number}
            </p>
            <div>
              <Label className="text-xs">Próximo contato</Label>
              <Input
                type="date"
                className="mt-1"
                min={todayLocalStr()}
                value={followUpAt}
                disabled={saving}
                onChange={e => setFollowUpAt(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              {contract.renewal_follow_up_at && (
                <Button variant="outline" className="flex-1" disabled={saving} onClick={() => save(null)}>
                  Remover
                </Button>
              )}
              <Button className="flex-1" disabled={saving || !followUpAt} onClick={() => save(followUpAt)}>
                {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                Salvar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
