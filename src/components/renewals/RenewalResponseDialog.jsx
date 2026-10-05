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
import { RENEWAL_CHANGE_TARGETS, RENEWAL_RESPONSE_LABELS } from '@/lib/assessment-renewal-pipeline';

const OPTIONS = [
  { code: 'will_renew', hint: 'Vai para "Enviar cobrança".' },
  { code: 'thinking', hint: 'Fica em "Aguardando decisão"; marque quando voltar a falar.' },
  { code: 'change_plan_or_coach', hint: 'Já abre a troca no contrato; depois segue para a cobrança. Não conta como saída.' },
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
// "Mudar plano/treinador" grava a resposta e já abre a troca escolhida.
export default function RenewalResponseDialog({ card, onClose, onDone, onNotRenewing, onChangeRequested, onConflict }) {
  const [code, setCode] = useState('');
  const [changeTarget, setChangeTarget] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const contract = card?.contract;
  const asksChange = code === 'change_plan_or_coach';
  const asksFollowUp = ['thinking', 'needs_agent'].includes(code);

  const choose = (next) => {
    setCode(next);
    if (next === 'thinking' && !followUpAt) setFollowUpAt(plusDays(3));
    if (!['thinking', 'needs_agent'].includes(next)) setFollowUpAt('');
  };

  const save = async () => {
    if (!contract || !code) return toast.error('Escolha a resposta do atleta');
    if (code === 'not_renewing') {
      onNotRenewing(card);
      return;
    }
    if (asksChange && !RENEWAL_CHANGE_TARGETS[changeTarget]) return toast.error('Escolha o que o atleta quer mudar');
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
      if (asksChange) {
        toast.success(`Resposta registrada. Abrindo a troca de ${changeTarget === 'plan' ? 'plano' : 'coach'}.`);
        onChangeRequested(card, changeTarget);
        return;
      }
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

            {asksChange && (
              <fieldset className="space-y-2" disabled={saving}>
                <legend className="text-xs font-medium text-gray-700 mb-1">O que o atleta quer mudar?</legend>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(RENEWAL_CHANGE_TARGETS).map(([target, option]) => (
                    <label
                      key={target}
                      className={`flex items-start gap-2 rounded-lg border p-3 cursor-pointer transition-colors ${
                        changeTarget === target ? 'border-violet-400 bg-violet-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="renewal-change-target"
                        className="mt-1 accent-violet-600"
                        checked={changeTarget === target}
                        onChange={() => setChangeTarget(target)}
                      />
                      <span>
                        <span className="block text-sm font-medium text-gray-900">{option.label}</span>
                        <span className="block text-xs text-muted-foreground">{option.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Se for mudar os dois, troque um e depois o outro no próprio contrato.
                </p>
              </fieldset>
            )}

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
              <Button className="flex-1" disabled={saving || !code || (asksChange && !changeTarget)} onClick={save}>
                {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                {code === 'not_renewing'
                  ? 'Seguir para o encerramento'
                  : asksChange && changeTarget
                    ? `Registrar e trocar o ${changeTarget === 'plan' ? 'plano' : 'coach'}`
                    : 'Registrar'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
