import { useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createCoachAccess, removeCoachAccess, resetCoachPassword } from '@/api/client';
import { accessBlocker, accessMessage } from '@/lib/coach-access';

// Acesso do coach ao sistema (login). A equipe cria a conta, passa a senha provisória
// (que aparece UMA vez) e o coach troca no primeiro acesso. O coach só vê os eventos em
// que é responsável, sem valores.
export default function CoachAccessDialog({ coach, open, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [credentials, setCredentials] = useState(null); // { email, password }
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (open) {
      setBusy(false);
      setCredentials(null);
      setConfirmRemove(false);
      setProblem('');
    }
  }, [open, coach?.id]);

  if (!coach) return null;
  const hasAccess = Boolean(coach.auth_user_id);
  const blocker = accessBlocker(coach);
  const link = `${window.location.origin}/login`;

  async function run(task, onSuccess) {
    setBusy(true);
    setProblem('');
    try {
      const result = await task();
      onSuccess?.(result);
      await onChanged?.();
    } catch (error) {
      setProblem(error.message || 'Não foi possível concluir.');
    } finally {
      setBusy(false);
    }
  }

  const create = () => run(() => createCoachAccess(coach.id), result => {
    setCredentials({ email: result.email, password: result.temporary_password });
    toast.success('Acesso criado');
  });
  const reset = () => run(() => resetCoachPassword(coach.id), result => {
    setCredentials({ email: result.email, password: result.temporary_password });
    toast.success('Nova senha provisória gerada');
  });
  const remove = () => run(() => removeCoachAccess(coach.id), result => {
    setConfirmRemove(false);
    toast.success(result.account_removed === false
      ? 'Acesso removido. A conta de login ficará sem uso.'
      : 'Acesso removido');
    onClose();
  });

  const message = credentials
    ? accessMessage({ name: coach.name, link, email: credentials.email, password: credentials.password })
    : '';
  const copy = (text, done) => {
    navigator.clipboard?.writeText(text).then(() => toast.success(done), () => toast.error('Não foi possível copiar'));
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Acesso ao sistema · {coach.name}</DialogTitle>
          <DialogDescription>
            O coach entra com o e-mail do cadastro e vê só os eventos em que é responsável, sem valores. Pode marcar quem já está no grupo do WhatsApp.
          </DialogDescription>
        </DialogHeader>

        {credentials ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">
              <p className="font-semibold">Pronto. Passe o acesso ao coach:</p>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between gap-2"><dt>Link</dt><dd className="break-all text-right">{link}</dd></div>
                <div className="flex justify-between gap-2"><dt>E-mail</dt><dd className="break-all text-right">{credentials.email}</dd></div>
                <div className="flex items-center justify-between gap-2"><dt>Senha provisória</dt><dd className="font-mono text-sm font-bold">{credentials.password}</dd></div>
              </dl>
            </div>
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              A senha aparece só agora. Copie e envie antes de fechar. Se perder, gere outra. O coach troca a senha no primeiro acesso.
            </p>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => copy(message, 'Mensagem copiada')}><Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Copiar mensagem</Button>
              <Button variant="outline" onClick={onClose}>Fechar</Button>
            </div>
          </div>
        ) : hasAccess ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm text-green-700"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Este coach já tem acesso.</p>
            <p className="text-xs text-muted-foreground">
              O e-mail de login é o que estava no cadastro quando o acesso foi criado. Se ele mudar, remova o acesso e crie de novo.
            </p>
            {problem && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{problem}</p>}
            {confirmRemove ? (
              <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-900">O coach perde o acesso na hora e a conta de login é apagada. Os eventos e as marcações do grupo continuam.</p>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancelar</Button>
                  <Button className="flex-1 bg-red-600 hover:bg-red-700" disabled={busy} onClick={remove}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Remover acesso'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy} onClick={reset}>
                  {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />} Gerar nova senha provisória
                </Button>
                <Button variant="ghost" className="text-red-600 hover:text-red-700" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Remover acesso
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">Este coach ainda não tem acesso. O login será o e-mail <strong className="break-all">{coach.email || '(sem e-mail)'}</strong>.</p>
            {blocker && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{blocker}</p>}
            {problem && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{problem}</p>}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={busy} onClick={onClose}>Cancelar</Button>
              <Button className="flex-1" disabled={busy || Boolean(blocker)} onClick={create}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Criar acesso'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
