import { useState } from 'react';
import { Check, Copy, Loader2, MessageCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { transitionAssessmentRenewalStage } from '@/api/client';
import { phoneDigitsForWhatsApp } from '@/lib/phone';
import { buildRenewalMessageTask, buildTaskMessage } from '@/lib/communication-tasks';

// Despedida de quem decidiu não renovar: agradece e pede um feedback. A
// renovação já está encerrada; o envio só fica no histórico do contrato.
export default function RenewalFarewellDialog({ target, rules, onClose, onDone }) {
  const { contract, parent, customer, coaches = [], modalities = [] } = target;
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const message = buildTaskMessage(buildRenewalMessageTask(contract, {
    customers: customer ? [customer] : [],
    coaches,
    modalities,
  }, { rules, step: 'farewell', parentEndDate: parent?.end_date }));

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Mensagem copiada!');
    window.setTimeout(() => setCopied(false), 2000);
  };

  const openWhatsApp = () => {
    const phone = phoneDigitsForWhatsApp(customer?.whatsapp);
    if (!phone || phone === '55') return toast.error('WhatsApp do atleta não cadastrado');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    return null;
  };

  const register = async () => {
    setSaving(true);
    try {
      await transitionAssessmentRenewalStage(contract.id, {
        action: 'farewell_sent',
        expectedUpdatedAt: contract.updated_at,
        message,
      });
      toast.success('Despedida registrada no histórico do contrato.');
      onDone();
    } catch (error) {
      toast.error(error.message || 'Não foi possível registrar a despedida');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-green-600" /> Despedida
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {customer?.full_name || 'Atleta'} · {contract.contract_number}. A renovação já está como “Não renovou”.
          </p>
          <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm whitespace-pre-wrap text-gray-800 max-h-72 overflow-y-auto">
            {message}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={copyMessage}>
              {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
              {copied ? 'Copiado!' : 'Copiar'}
            </Button>
            <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={openWhatsApp} disabled={!customer?.whatsapp}>
              <MessageCircle className="w-4 h-4 mr-1.5" /> Abrir WhatsApp
            </Button>
          </div>
          <div className="flex items-center justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Agora não</Button>
            <Button className="bg-violet-600 hover:bg-violet-700" onClick={register} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Send className="w-4 h-4 mr-1.5" />}
              Registrar que enviei
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
