import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { transitionAssessmentRenewalStage } from '@/api/client';
import { todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { RENEWAL_RESPONSE_LABELS } from '@/lib/assessment-renewal-pipeline';

const OPTIONS = [
  { code: 'will_renew', hint: 'Vai para "Enviar cobrança".' },
  { code: 'thinking', hint: 'Fica em "Aguardando decisão"; marque quando voltar a falar.' },
  { code: 'change_plan_or_coach', hint: 'Fica aguardando até resolver a mudança. Não conta como saída.' },
  { code: 'needs_agent', hint: 'Fica aguardando, com atendimento pendente.' },
  { code: 'not_renewing', hint: 'Abre o encerramento seguro da renovação.' },
];

function plusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

// Registra a resposta do atleta à mensagem de intenção. "Não vou renovar" não
// é gravado aqui: vai para a janela segura, que cuida de cobrança e repasse.
export default function RenewalResponseDialog({ card, onClose, onDone, onNotRenewing, onConflict }) {
  const [code, setCode] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const contract = card?.contract;
  const asksFollowUp = ['thinking', 'change_plan_or_coach', 'needs_agent'].includes(code);

  const choose = (next) => {
    setCode(next);
    if (next === 'thinking' && !followUpAt) setFollowUpAt(plusDays(3));
    if (!['thinking', 'change_plan_or_coach', 'needs_agent'].includes(next)) setFollowUpAt('');
  };

  const save = async () => {
    if (!contract || !code) return toast.error('Escolha a resposta do atleta');
    if (code === 'not_renewing') {
      onNotRenewing(card);
      return;
    }
    if (followUpAt && followUpAt < todayLocalStr()) return toast.error('O follow-up precisa ser de hoje em diante');
    setSaving(true);
    try {
      await transitionAssessmentRenewalStage(contract.id, {
        action: 'register_response',
        expectedUpdatedAt: contract.updated_at,
        responseCode: code,
        followUpAt: asksFollowUp ? followUpAt || null : null,
        notes: notes.trim() || null,
      });
      toast.success(code === 'will_renew'
        ? 'Resposta registrada. A renovação foi para "Enviar cobrança".'
        : 'Resposta registrada. A renovação continua aguardando a decisão.');
      onDone();
    } catch (error) {
      if (error?.status === 409) {
        toast.error(error.message || 'A renovação mudou. Atualizando a tela.');
        onConflict();
      } else {
        toast.error(error.message || 'Não foi possível registrar a resposta');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!card} onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-blue-600" /> Registrar resposta
          </DialogTitle>
        </DialogHeader>
        {card && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {card.customer?.full_name || 'Atleta'} · {contract.contract_number}
            </p>
            <fieldset className="space-y-2" disabled={saving}>
              <legend className="sr-only">Resposta do atleta</legend>
              {OPTIONS.map((option, index) => (
                <label
                  key={option.code}
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    code === option.code ? 'border-blue-400 bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="renewal-response"
                    className="mt-1 accent-blue-600"
                    checked={code === option.code}
                    onChange={() => choose(option.code)}
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">
                      {index + 1}. {RENEWAL_RESPONSE_LABELS[option.code]}
                    </span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {asksFollowUp && (
              <div>
                <Label className="text-xs">Próximo contato (opcional)</Label>
                <Input
                  type="date"
                  className="mt-1"
                  min={todayLocalStr()}
                  value={followUpAt}
                  disabled={saving}
                  onChange={e => setFollowUpAt(e.target.value)}
                />
              </div>
            )}

            {code && code !== 'not_renewing' && (
              <div>
                <Label className="text-xs">Observação (opcional)</Label>
                <Textarea
                  rows={2}
                  maxLength={500}
                  className="mt-1 text-sm"
                  placeholder={code === 'change_plan_or_coach' ? 'Ex.: quer passar para Triathlon com a Thais' : ''}
                  value={notes}
                  disabled={saving}
                  onChange={e => setNotes(e.target.value)}
                />
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" disabled={saving} onClick={onClose}>Voltar</Button>
              <Button className="flex-1" disabled={saving || !code} onClick={save}>
                {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                {code === 'not_renewing' ? 'Seguir para o encerramento' : 'Registrar'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
