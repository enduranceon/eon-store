import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Clock, Loader2, MessageCircle, MessageSquare, RefreshCw, Trash2, UserPlus, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { AssessmentContactRequest } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmDialog from '@/components/ConfirmDialog';
import { CreateProspectModal } from '@/pages/assessment/Prospects';
import { usePageData } from '@/hooks/usePageData';
import { formatPhoneInput, phoneDigitsForWhatsApp } from '@/lib/phone';
import { waitingDays } from '@/lib/coach-waitlist';
import {
  CONTACT_CLOSE_REASONS,
  CONTACT_STATUSES,
  contactProspectNotes,
  contactStatus,
  isOpenContactRequest,
  sortContactRequests,
  summarizeContactRequests,
} from '@/lib/contact-requests';
import { cn, formatDate, todayLocalStr, utcToLocalDateStr } from '@/lib/utils';

const INITIAL_DATA = { requests: [] };

async function loadContactRequests() {
  return { requests: await AssessmentContactRequest.list('created_at') };
}

function sinceLabel(days) {
  if (days === 0) return 'hoje';
  return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

export default function ContactRequests() {
  const today = todayLocalStr();
  const [statusFilter, setStatusFilter] = useState('open');
  const [converting, setConverting] = useState(null);
  const [closing, setClosing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const { data, loading, refreshing, refresh } = usePageData({
    key: 'assessment-contact-requests:v1',
    loader: loadContactRequests,
    initialData: INITIAL_DATA,
    tags: ['assessment_contact_requests'],
    onError: error => {
      console.error('Erro ao carregar os contatos do site:', error);
      toast.error('Erro ao carregar os contatos do site');
    },
  });

  const summary = useMemo(() => summarizeContactRequests(data.requests), [data.requests]);
  const visible = useMemo(() => sortContactRequests(data.requests.filter(request => {
    if (statusFilter === 'open') return isOpenContactRequest(request);
    if (statusFilter === 'all') return true;
    return request.status === statusFilter;
  })), [data.requests, statusFilter]);

  const updateRequest = async (request, changes, message) => {
    setBusyId(request.id);
    try {
      await AssessmentContactRequest.update(request.id, changes);
      if (message) toast.success(message);
      await refresh({ force: true });
    } catch (error) {
      toast.error(error.message || 'Não foi possível atualizar o contato');
    } finally {
      setBusyId(null);
    }
  };

  const prospectCreated = async contract => {
    const request = converting;
    setConverting(null);
    if (!request) return;
    try {
      await AssessmentContactRequest.update(request.id, {
        status: 'converted',
        prospect_contract_id: contract?.id || null,
      });
    } catch {
      toast.error('O prospect foi criado, mas o contato não foi marcado. Marque como "Virou prospect".');
    }
    await refresh({ force: true });
  };

  const removeRequest = async () => {
    const request = deleting;
    setBusyId(request.id);
    try {
      await AssessmentContactRequest.delete(request.id);
      toast.success('Contato removido');
      setDeleting(null);
      await refresh({ force: true });
    } catch (error) {
      toast.error(error.message || 'Não foi possível remover');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5 pb-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Contatos do site</h2>
        <p className="text-sm text-muted-foreground">
          Mensagens enviadas pelo formulário de contato do site. Responda pelo WhatsApp e, se a pessoa quiser
          treinar, crie o prospect a partir do contato. Quem já escolheu um plano faz a pré-matrícula direto
          em <Link to="/assessoria/prospects" className="text-blue-700 hover:underline">Prospects</Link>.
        </p>
      </div>

      {loading ? (
        <div className="min-h-[30vh] flex items-center justify-center text-muted-foreground">
          <RefreshCw className="w-5 h-5 text-blue-600 animate-spin mr-2" /> Carregando contatos...
        </div>
      ) : (
        <div className="space-y-4">
          <section aria-label="Filtros" className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-3">
            <div className="min-w-[12rem] flex-1 sm:flex-none">
              <Label className="mb-1 block text-xs text-muted-foreground">Situação</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger aria-label="Situação"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Esperando resposta</SelectItem>
                  {CONTACT_STATUSES.map(status => <SelectItem key={status.value} value={status.value}>{status.label}</SelectItem>)}
                  <SelectItem value="all">Todas</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">
              {summary.open === 0
                ? 'Nenhum contato esperando resposta.'
                : `${summary.open} ${summary.open === 1 ? 'contato espera' : 'contatos esperam'} resposta (${summary.new} ${summary.new === 1 ? 'novo' : 'novos'}).`}
            </p>
            <div className="ml-auto">
              <Button variant="outline" size="icon" onClick={() => refresh({ force: true })} disabled={refreshing}
                title="Atualizar" aria-label="Atualizar">
                <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
              </Button>
            </div>
          </section>

          {visible.length === 0 ? (
            <div className="rounded-xl border border-dashed bg-white p-8 text-center text-sm text-muted-foreground">
              <MessageSquare className="mx-auto mb-2 h-6 w-6 text-slate-400" />
              {statusFilter === 'open' ? 'Nenhum contato esperando resposta.' : 'Nada nesta situação.'}
            </div>
          ) : (
            <ul className="space-y-2" aria-label="Contatos do site">
              {visible.map(request => (
                <ContactRow key={request.id} request={request} today={today} busy={busyId === request.id}
                  onStatus={status => updateRequest(request, { status }, 'Situação atualizada')}
                  onReopen={() => updateRequest(request, { status: 'new' }, 'Contato reaberto')}
                  onConvert={() => setConverting(request)} onClose={() => setClosing(request)}
                  onDelete={() => setDeleting(request)} />
              ))}
            </ul>
          )}
        </div>
      )}

      <Dialog open={Boolean(converting)} onOpenChange={open => { if (!open) setConverting(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {converting && (
            <CreateProspectModal onClose={() => setConverting(null)} onDone={prospectCreated}
              initial={{
                full_name: converting.full_name,
                whatsapp: converting.whatsapp,
                email: converting.email,
                notes: contactProspectNotes(converting, formatDate(utcToLocalDateStr(converting.created_at))),
              }} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(closing)} onOpenChange={open => { if (!open) setClosing(null); }}>
        <DialogContent className="max-w-md">
          {closing && (
            <CloseRequestForm request={closing} busy={busyId === closing.id} onCancel={() => setClosing(null)}
              onConfirm={async reason => {
                await updateRequest(closing, { status: 'closed', closed_reason: reason }, 'Contato encerrado');
                setClosing(null);
              }} />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null); }}
        title="Remover contato" icon={Trash2} iconClassName="text-red-600"
        confirmLabel="Remover" confirmClassName="bg-red-600 hover:bg-red-700"
        busy={Boolean(deleting) && busyId === deleting.id} busyLabel="Removendo..." onConfirm={removeRequest}>
        <p>
          Os dados de <b>{deleting?.full_name}</b> saem do sistema. Use quando a pessoa pedir para ser removida
          ou o envio for spam. Para um contato já respondido, prefira <b>Encerrar</b>, que guarda o histórico.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function ContactRow({ request, today, busy, onStatus, onReopen, onConvert, onClose, onDelete }) {
  const status = contactStatus(request.status);
  const open = isOpenContactRequest(request);
  const days = waitingDays(request, today);
  const digits = phoneDigitsForWhatsApp(request.whatsapp);
  return (
    <li className={cn('rounded-xl border bg-white p-3 sm:p-4', !open && 'bg-slate-50/60')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-gray-900">{request.full_name}</p>
            <span className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', status.tone)}>{status.label}</span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />
              Enviado em {formatDate(utcToLocalDateStr(request.created_at))}{open && ` · ${sinceLabel(days)}`}
            </span>
            <span>{formatPhoneInput(request.whatsapp)}</span>
            {request.email && <span>{request.email}</span>}
            {request.utm?.utm_source && <span>Origem: {request.utm.utm_source}</span>}
          </p>
          <p className="mt-2 text-sm font-medium text-gray-900">{request.subject}</p>
          <p className="mt-1 whitespace-pre-line break-words text-sm text-gray-700">{request.message}</p>
          {request.status === 'closed' && request.closed_reason && (
            <p className="mt-2 text-sm text-gray-700">Motivo: {request.closed_reason}</p>
          )}
          {request.status === 'converted' && request.prospect_contract_id && (
            <Link to={`/assessoria/contratos/${request.prospect_contract_id}`} className="mt-2 inline-block text-sm text-blue-700 hover:underline">
              Ver o prospect
            </Link>
          )}
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
          {digits && (
            <Button asChild variant="outline" size="sm">
              <a href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-4 h-4 mr-1.5" /> WhatsApp
              </a>
            </Button>
          )}
          {open ? (
            <>
              <Select value={request.status} onValueChange={onStatus} disabled={busy}>
                <SelectTrigger className="h-9 w-[10.5rem]" aria-label={`Situação de ${request.full_name}`}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <SelectValue />}
                </SelectTrigger>
                <SelectContent>
                  {CONTACT_STATUSES.filter(item => item.open).map(item => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={onConvert} disabled={busy}>
                <UserPlus className="w-4 h-4 mr-1.5" /> Criar prospect
              </Button>
              <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>
                <XCircle className="w-4 h-4 mr-1.5" /> Encerrar
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={onReopen} disabled={busy}>Reabrir</Button>
          )}
          <Button size="icon" variant="ghost" className="h-9 w-9 text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={onDelete} disabled={busy} title="Remover" aria-label={`Remover ${request.full_name}`}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function CloseRequestForm({ request, busy, onCancel, onConfirm }) {
  const [choice, setChoice] = useState(CONTACT_CLOSE_REASONS[0]);
  const [other, setOther] = useState('');
  const reason = choice === 'other' ? other.trim() : choice;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><XCircle className="w-5 h-5 text-slate-600" /> Encerrar o contato</DialogTitle>
      </DialogHeader>
      <div className="mt-2 space-y-4 text-sm">
        <p><b>{request.full_name}</b> sai dos contatos em aberto e fica no histórico. Dá para reabrir depois.</p>
        <div>
          <Label htmlFor="contact-close-reason">Motivo</Label>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger id="contact-close-reason" className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CONTACT_CLOSE_REASONS.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              <SelectItem value="other">Outro</SelectItem>
            </SelectContent>
          </Select>
          {choice === 'other' && (
            <Input className="mt-2" maxLength={500} value={other} placeholder="Qual?"
              onChange={event => setOther(event.target.value)} aria-label="Outro motivo" />
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>Voltar</Button>
          <Button className="flex-1" onClick={() => onConfirm(reason || null)} disabled={busy || (choice === 'other' && !reason)}>
            {busy && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />} Encerrar
          </Button>
        </div>
      </div>
    </>
  );
}
