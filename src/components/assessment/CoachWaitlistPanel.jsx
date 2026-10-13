import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Clock, Hourglass, Loader2, MessageCircle, Plus, RefreshCw, Trash2, UserPlus, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { AssessmentCoach, AssessmentCoachWaitlist, AssessmentModality } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ConfirmDialog from '@/components/ConfirmDialog';
import { PhoneInput } from '@/components/PhoneInput';
import { CreateProspectModal } from '@/pages/assessment/Prospects';
import { usePageData } from '@/hooks/usePageData';
import { formatPhoneInput, phoneDigitsForWhatsApp } from '@/lib/phone';
import {
  WAITLIST_CLOSE_REASONS,
  WAITLIST_REGIONS,
  WAITLIST_SOURCES,
  WAITLIST_STATUSES,
  emptyWaitlistForm,
  isOpenWaitlistEntry,
  prepareWaitlistEntry,
  sortWaitlist,
  summarizeWaitlist,
  waitingDays,
  waitlistPositions,
  waitlistStatus,
} from '@/lib/coach-waitlist';
import { cn, formatDate, todayLocalStr, utcToLocalDateStr } from '@/lib/utils';

const INITIAL_DATA = { entries: [], coaches: [], modalities: [] };

async function loadWaitlistData() {
  const [entries, coaches, modalities] = await Promise.all([
    AssessmentCoachWaitlist.list('created_at'),
    AssessmentCoach.list('name'),
    AssessmentModality.list('name'),
  ]);
  return { entries, coaches, modalities };
}

const REGION_LABELS = Object.fromEntries(WAITLIST_REGIONS.map(region => [region.value, region.label]));

// Lista de espera de todos os coaches ou de um só (perfil do coach).
export default function CoachWaitlistPanel({ coachId = null }) {
  const today = todayLocalStr();
  const [coachFilter, setCoachFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('open');
  const [adding, setAdding] = useState(false);
  const [converting, setConverting] = useState(null);
  const [closing, setClosing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const { data, loading, refreshing, refresh } = usePageData({
    key: 'assessment-coach-waitlist:v1',
    loader: loadWaitlistData,
    initialData: INITIAL_DATA,
    tags: ['assessment_coach_waitlist', 'assessment_coaches', 'assessment_modalities'],
    onError: error => {
      console.error('Erro ao carregar a lista de espera:', error);
      toast.error('Erro ao carregar a lista de espera');
    },
  });

  const coachById = useMemo(() => new Map(data.coaches.map(coach => [coach.id, coach])), [data.coaches]);
  const modalityById = useMemo(() => new Map(data.modalities.map(modality => [modality.id, modality])), [data.modalities]);
  const scopedCoach = coachId || (coachFilter === 'all' ? null : coachFilter);
  const positions = useMemo(() => waitlistPositions(data.entries), [data.entries]);
  const summary = useMemo(() => summarizeWaitlist(data.entries, today), [data.entries, today]);
  const visible = useMemo(() => sortWaitlist(data.entries.filter(entry => {
    if (scopedCoach && entry.coach_id !== scopedCoach) return false;
    if (statusFilter === 'open') return isOpenWaitlistEntry(entry);
    if (statusFilter === 'all') return true;
    return entry.status === statusFilter;
  })), [data.entries, scopedCoach, statusFilter]);

  // Coaches com fila aberta ou que não recebem novos alunos.
  const coachRows = useMemo(() => data.coaches
    .filter(coach => (!coachId || coach.id === coachId)
      && (coach.accepting_new_students === false || summary.has(coach.id)))
    .map(coach => ({ coach, ...(summary.get(coach.id) || { open: 0, waiting: 0, oldestDays: 0 }) })),
  [data.coaches, summary, coachId]);

  const updateEntry = async (entry, changes, message) => {
    setBusyId(entry.id);
    try {
      await AssessmentCoachWaitlist.update(entry.id, changes);
      if (message) toast.success(message);
      await refresh({ force: true });
    } catch (error) {
      toast.error(error.message || 'Não foi possível atualizar a lista de espera');
    } finally {
      setBusyId(null);
    }
  };

  const prospectCreated = async contract => {
    const entry = converting;
    setConverting(null);
    if (!entry) return;
    try {
      await AssessmentCoachWaitlist.update(entry.id, {
        status: 'converted',
        prospect_contract_id: contract?.id || null,
      });
    } catch {
      toast.error('O prospect foi criado, mas a lista de espera não foi marcada. Marque como "Virou prospect".');
    }
    await refresh({ force: true });
  };

  const removeEntry = async () => {
    const entry = deleting;
    setBusyId(entry.id);
    try {
      await AssessmentCoachWaitlist.delete(entry.id);
      toast.success('Pessoa removida da lista de espera');
      setDeleting(null);
      await refresh({ force: true });
    } catch (error) {
      toast.error(error.message || 'Não foi possível remover');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[30vh] flex items-center justify-center text-muted-foreground">
        <RefreshCw className="w-5 h-5 text-blue-600 animate-spin mr-2" /> Carregando lista de espera...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {coachRows.length > 0 && (
        <section aria-label="Fila por coach" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {coachRows.map(({ coach, open, oldestDays }) => (
            <div key={coach.id} className="rounded-xl border bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                {coachId ? <p className="font-semibold text-gray-900">{coach.name}</p> : (
                  <Link to={`/assessoria/coaches/${coach.id}`} className="font-semibold text-gray-900 hover:text-blue-700 hover:underline">
                    {coach.name}
                  </Link>
                )}
                <AvailabilityBadge coach={coach} />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {open === 0 ? 'Ninguém na fila' : `${open} ${open === 1 ? 'pessoa' : 'pessoas'} na fila`}
                {open > 0 && ` · a primeira espera ${sinceLabel(oldestDays)}`}
              </p>
            </div>
          ))}
        </section>
      )}

      <section aria-label="Filtros" className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-3">
        {!coachId && (
          <div className="min-w-[12rem] flex-1 sm:flex-none">
            <Label className="mb-1 block text-xs text-muted-foreground">Coach</Label>
            <Select value={coachFilter} onValueChange={setCoachFilter}>
              <SelectTrigger aria-label="Coach"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os coaches</SelectItem>
                {data.coaches.filter(coach => coach.active).map(coach => (
                  <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="min-w-[12rem] flex-1 sm:flex-none">
          <Label className="mb-1 block text-xs text-muted-foreground">Situação</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger aria-label="Situação"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Na fila (em aberto)</SelectItem>
              {WAITLIST_STATUSES.map(status => <SelectItem key={status.value} value={status.value}>{status.label}</SelectItem>)}
              <SelectItem value="all">Todas</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="icon" onClick={() => refresh({ force: true })} disabled={refreshing}
            title="Atualizar" aria-label="Atualizar">
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
          </Button>
          <Button onClick={() => setAdding(true)}>
            <Plus className="w-4 h-4 mr-1.5" /> Adicionar pessoa
          </Button>
        </div>
      </section>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-white p-8 text-center text-sm text-muted-foreground">
          <Hourglass className="mx-auto mb-2 h-6 w-6 text-slate-400" />
          {statusFilter === 'open' ? 'Ninguém esperando agora.' : 'Nada nesta situação.'}
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Pessoas na lista de espera">
          {visible.map(entry => (
            <WaitlistRow key={entry.id} entry={entry} today={today}
              coach={coachById.get(entry.coach_id)} modality={modalityById.get(entry.modality_id)}
              position={positions.get(entry.id)} showCoach={!coachId} busy={busyId === entry.id}
              onStatus={status => updateEntry(entry, { status }, 'Situação atualizada')}
              onReopen={() => updateEntry(entry, { status: 'waiting' }, 'Pessoa de volta na fila')}
              onConvert={() => setConverting(entry)} onClose={() => setClosing(entry)}
              onDelete={() => setDeleting(entry)} />
          ))}
        </ul>
      )}

      <Dialog open={adding} onOpenChange={open => { if (!open) setAdding(false); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {adding && (
            <AddEntryForm coaches={data.coaches.filter(coach => coach.active)} modalities={data.modalities}
              defaultCoachId={scopedCoach || ''} onClose={() => setAdding(false)}
              onDone={async () => { setAdding(false); await refresh({ force: true }); }} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(converting)} onOpenChange={open => { if (!open) setConverting(null); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto overscroll-contain">
          {converting && (
            <CreateProspectModal onClose={() => setConverting(null)} onDone={prospectCreated}
              initial={{
                full_name: converting.full_name,
                whatsapp: converting.whatsapp,
                email: converting.email,
                coach_id: converting.coach_id,
                notes: prospectNotes(converting, coachById.get(converting.coach_id)),
              }} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(closing)} onOpenChange={open => { if (!open) setClosing(null); }}>
        <DialogContent className="max-w-md">
          {closing && (
            <CloseEntryForm entry={closing} busy={busyId === closing.id} onCancel={() => setClosing(null)}
              onConfirm={async reason => {
                await updateEntry(closing, { status: 'closed', closed_reason: reason }, 'Lista de espera encerrada para esta pessoa');
                setClosing(null);
              }} />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null); }}
        title="Remover da lista de espera" icon={Trash2} iconClassName="text-red-600"
        confirmLabel="Remover" confirmClassName="bg-red-600 hover:bg-red-700"
        busy={Boolean(deleting) && busyId === deleting.id} busyLabel="Removendo..." onConfirm={removeEntry}>
        <p>
          Os dados de <b>{deleting?.full_name}</b> saem do sistema. Use quando a pessoa pedir para ser removida
          ou o cadastro estiver errado. Para quem só desistiu, prefira <b>Encerrar</b>, que guarda o histórico.
        </p>
      </ConfirmDialog>
    </div>
  );
}

export function AvailabilityBadge({ coach }) {
  const open = coach?.accepting_new_students !== false;
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
      open ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
      {open ? 'Recebe novos alunos' : 'Lista de espera'}
    </span>
  );
}

function sinceLabel(days) {
  if (days === 0) return 'desde hoje';
  return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

function prospectNotes(entry, coach) {
  const since = formatDate(utcToLocalDateStr(entry.created_at));
  return [
    `Veio da lista de espera${coach ? ` de ${coach.name}` : ''} (desde ${since}).`,
    entry.notes,
  ].filter(Boolean).join('\n');
}

function WaitlistRow({ entry, coach, modality, position, today, showCoach, busy, onStatus, onReopen, onConvert, onClose, onDelete }) {
  const status = waitlistStatus(entry.status);
  const open = isOpenWaitlistEntry(entry);
  const days = waitingDays(entry, today);
  const digits = phoneDigitsForWhatsApp(entry.whatsapp);
  return (
    <li className={cn('rounded-xl border bg-white p-3 sm:p-4', !open && 'bg-slate-50/60')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {open && position && (
              <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-900 px-1.5 text-xs font-bold text-white"
                title="Posição na fila deste coach">{position}º</span>
            )}
            <p className="font-semibold text-gray-900">{entry.full_name}</p>
            <span className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', status.tone)}>{status.label}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              showCoach && coach?.name,
              modality?.name,
              REGION_LABELS[entry.region],
              WAITLIST_SOURCES[entry.source],
            ].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />
              Entrou em {formatDate(utcToLocalDateStr(entry.created_at))}{open && ` · ${days === 0 ? 'hoje' : sinceLabel(days)}`}
            </span>
            <span>{formatPhoneInput(entry.whatsapp)}</span>
            {entry.email && <span>{entry.email}</span>}
          </p>
          {entry.notes && <p className="mt-2 whitespace-pre-line text-sm text-gray-700">{entry.notes}</p>}
          {entry.status === 'closed' && entry.closed_reason && (
            <p className="mt-2 text-sm text-gray-700">Motivo: {entry.closed_reason}</p>
          )}
          {entry.status === 'converted' && entry.prospect_contract_id && (
            <Link to={`/assessoria/contratos/${entry.prospect_contract_id}`} className="mt-2 inline-block text-sm text-blue-700 hover:underline">
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
              <Select value={entry.status} onValueChange={onStatus} disabled={busy}>
                <SelectTrigger className="h-9 w-[12.5rem]" aria-label={`Situação de ${entry.full_name}`}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <SelectValue />}
                </SelectTrigger>
                <SelectContent>
                  {WAITLIST_STATUSES.filter(item => item.open).map(item => (
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
            <Button size="sm" variant="outline" onClick={onReopen} disabled={busy}>Voltar para a fila</Button>
          )}
          <Button size="icon" variant="ghost" className="h-9 w-9 text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={onDelete} disabled={busy} title="Remover" aria-label={`Remover ${entry.full_name}`}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function AddEntryForm({ coaches, modalities, defaultCoachId, onClose, onDone }) {
  const [form, setForm] = useState(() => emptyWaitlistForm(defaultCoachId));
  const [saving, setSaving] = useState(false);
  const coach = coaches.find(item => item.id === form.coach_id);
  const coachModalities = modalities.filter(modality => (coach?.modality_ids || []).includes(modality.id));

  const save = async () => {
    const { error, payload } = prepareWaitlistEntry(form, coach);
    if (error) return toast.error(error);
    setSaving(true);
    try {
      await AssessmentCoachWaitlist.create(payload);
      toast.success('Pessoa adicionada à lista de espera');
      await onDone();
    } catch (error) {
      toast.error(error.message || 'Não foi possível adicionar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Hourglass className="w-5 h-5 text-amber-600" /> Adicionar à lista de espera</DialogTitle>
      </DialogHeader>
      <fieldset className="mt-2 min-w-0 space-y-4" disabled={saving}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="waitlist-coach">Coach *</Label>
            <Select value={form.coach_id} onValueChange={value => setForm(f => ({ ...f, coach_id: value, modality_id: '' }))}>
              <SelectTrigger id="waitlist-coach" className="mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
              <SelectContent>
                {coaches.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="waitlist-modality">Modalidade</Label>
            <Select value={form.modality_id || 'none'} onValueChange={value => setForm(f => ({ ...f, modality_id: value === 'none' ? '' : value }))}>
              <SelectTrigger id="waitlist-modality" className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Não informada</SelectItem>
                {coachModalities.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="waitlist-name">Nome *</Label>
          <Input id="waitlist-name" className="mt-1" maxLength={160} value={form.full_name}
            onChange={event => setForm(f => ({ ...f, full_name: event.target.value }))} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="waitlist-phone">WhatsApp *</Label>
            <PhoneInput id="waitlist-phone" className="mt-1" value={form.whatsapp}
              onChange={value => setForm(f => ({ ...f, whatsapp: value }))} />
          </div>
          <div>
            <Label htmlFor="waitlist-email">E-mail</Label>
            <Input id="waitlist-email" className="mt-1" type="email" maxLength={180} value={form.email}
              onChange={event => setForm(f => ({ ...f, email: event.target.value }))} />
          </div>
        </div>
        <div>
          <Label htmlFor="waitlist-region">Onde treina</Label>
          <Select value={form.region || 'none'} onValueChange={value => setForm(f => ({ ...f, region: value === 'none' ? '' : value }))}>
            <SelectTrigger id="waitlist-region" className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Não informado</SelectItem>
              {WAITLIST_REGIONS.map(region => <SelectItem key={region.value} value={region.value}>{region.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="waitlist-notes">Observações</Label>
          <Textarea id="waitlist-notes" className="mt-1" rows={3} maxLength={1000} value={form.notes}
            onChange={event => setForm(f => ({ ...f, notes: event.target.value }))}
            placeholder="Ex.: quer começar em janeiro, prefere treinos de manhã..." />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancelar</Button>
          <Button className="flex-1" onClick={save}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
            Adicionar
          </Button>
        </div>
      </fieldset>
    </>
  );
}

function CloseEntryForm({ entry, busy, onCancel, onConfirm }) {
  const [choice, setChoice] = useState(WAITLIST_CLOSE_REASONS[0]);
  const [other, setOther] = useState('');
  const reason = choice === 'other' ? other.trim() : choice;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><XCircle className="w-5 h-5 text-slate-600" /> Encerrar a espera</DialogTitle>
      </DialogHeader>
      <div className="mt-2 space-y-4 text-sm">
        <p><b>{entry.full_name}</b> sai da fila e fica no histórico. Dá para voltar para a fila depois.</p>
        <div>
          <Label htmlFor="waitlist-close-reason">Motivo</Label>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger id="waitlist-close-reason" className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              {WAITLIST_CLOSE_REASONS.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}
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
