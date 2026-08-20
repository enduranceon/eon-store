import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Clock, MapPin, Plus, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { EventRecord, EventRegistration, RevenueCenter } from '@/api/entities';
import { formatDate } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const EVENT_STATUS = {
  draft:     { label: 'Rascunho',   variant: 'secondary' },
  open:      { label: 'Inscrições abertas', variant: 'success' },
  closed:    { label: 'Encerrado',  variant: 'info' },
  cancelled: { label: 'Cancelado',  variant: 'destructive' },
};

const EMPTY_EVENT_FORM = {
  name: '',
  slug: '',
  event_date: '',
  end_date: '',
  start_time: '',
  end_time: '',
  location: '',
  address: '',
  online_url: '',
  description: '',
  public_notes: '',
  internal_notes: '',
};

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function eventPayload(form, centers) {
  const slug = form.slug.trim() || slugify(form.name);
  const eventsCenter = centers.find(c => c.type === 'eventos');
  return {
    name: form.name.trim(),
    slug,
    event_date: form.event_date || null,
    end_date: form.end_date || null,
    start_time: form.start_time || null,
    end_time: form.end_time || null,
    location: form.location.trim() || null,
    address: form.address.trim() || null,
    online_url: normalizeUrl(form.online_url) || null,
    description: form.description.trim() || null,
    public_notes: form.public_notes.trim() || null,
    internal_notes: form.internal_notes.trim() || null,
    status: 'draft',
    revenue_center_id: eventsCenter?.id || null,
  };
}

function timeSummary(event) {
  const start = String(event.start_time || '').slice(0, 5);
  const end = String(event.end_time || '').slice(0, 5);
  if (start && end) return `${start} - ${end}`;
  return start || end || '';
}

function dateSummary(event) {
  if (!event.event_date) return 'Data a definir';
  if (event.end_date && event.end_date !== event.event_date) {
    return `${formatDate(event.event_date)} - ${formatDate(event.end_date)}`;
  }
  return formatDate(event.event_date);
}

async function loadEvents() {
  const [events, registrations, centers] = await Promise.all([
    EventRecord.list('-event_date'),
    EventRegistration.list('-created_at'),
    RevenueCenter.list().catch(() => []),
  ]);
  const countByEvent = {};
  const paidByEvent = {};
  for (const reg of registrations) {
    if (reg.payment_status === 'cancelled') continue;
    countByEvent[reg.event_id] = (countByEvent[reg.event_id] || 0) + 1;
    if (reg.payment_status === 'paid') paidByEvent[reg.event_id] = (paidByEvent[reg.event_id] || 0) + 1;
  }
  return { events, countByEvent, paidByEvent, centers };
}

export default function Events() {
  const navigate = useNavigate();
  const {
    data: { events, countByEvent, paidByEvent, centers },
    refresh,
  } = usePageData({
    key: 'events:list',
    loader: loadEvents,
    initialData: { events: [], countByEvent: {}, paidByEvent: {}, centers: [] },
    tags: ['events', 'event_registrations'],
    onError: () => toast.error('Erro ao carregar eventos'),
  });

  const [createModal, setCreateModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_EVENT_FORM);

  const createEvent = async () => {
    if (!form.name.trim()) return toast.error('Informe o nome do evento');
    if ((form.slug.trim() || slugify(form.name)).length < 3) return toast.error('Informe um link válido para o evento');
    if (!form.event_date && form.end_date) return toast.error('Informe a data inicial antes da data final');
    if (form.event_date && form.end_date && form.end_date < form.event_date) return toast.error('Data final anterior à data inicial');
    if (form.start_time && form.end_time && form.end_time < form.start_time) return toast.error('Horário final anterior ao horário inicial');
    setSaving(true);
    try {
      const created = await EventRecord.create(eventPayload(form, centers));
      setCreateModal(false);
      setForm(EMPTY_EVENT_FORM);
      toast.success('Evento criado como rascunho');
      refresh({ force: true });
      navigate(`/eventos/${created.id}`);
    } catch (e) {
      toast.error(e.message || 'Erro ao criar evento');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Eventos</h2>
          <p className="text-sm text-muted-foreground">{events.length} evento{events.length === 1 ? '' : 's'}</p>
        </div>
        <Button onClick={() => setCreateModal(true)}>
          <Plus className="w-4 h-4 mr-1.5" /> Novo evento
        </Button>
      </div>

      {events.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
          Nenhum evento ainda. Crie o primeiro para começar a receber inscrições.
        </CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {events.map(event => {
            const status = EVENT_STATUS[event.status] || EVENT_STATUS.draft;
            const total = countByEvent[event.id] || 0;
            const paid = paidByEvent[event.id] || 0;
            const time = timeSummary(event);
            return (
              <Card key={event.id} className="cursor-pointer transition-shadow hover:shadow-md" onClick={() => navigate(`/eventos/${event.id}`)}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold leading-snug">{event.name}</p>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="w-4 h-4" /> {dateSummary(event)}
                    </span>
                    {time && (
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="w-4 h-4" /> {time}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="w-4 h-4" /> {total} inscrito{total === 1 ? '' : 's'}
                      {total > 0 && <span className="text-xs">({paid} pago{paid === 1 ? '' : 's'})</span>}
                    </span>
                  </div>
                  {event.location && (
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5" /> {event.location}
                    </p>
                  )}
                  {event.description && <p className="text-xs text-muted-foreground line-clamp-2">{event.description}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createModal} onOpenChange={open => !saving && setCreateModal(open)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Novo evento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome do evento</Label>
              <Input className="mt-1" value={form.name} placeholder="Ex.: Briefing Maratona de Floripa"
                onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: f.slug ? f.slug : slugify(e.target.value) }))} />
            </div>
            <div>
              <Label>Link público</Label>
              <Input className="mt-1 font-mono text-sm" value={form.slug}
                placeholder="briefing-maratona-de-floripa"
                onChange={e => setForm(f => ({ ...f, slug: slugify(e.target.value) }))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Data inicial</Label>
                <Input className="mt-1" type="date" value={form.event_date}
                  onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))} />
              </div>
              <div>
                <Label>Data final</Label>
                <Input className="mt-1" type="date" value={form.end_date}
                  onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
              </div>
              <div>
                <Label>Horário inicial</Label>
                <Input className="mt-1" type="time" value={form.start_time}
                  onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} />
              </div>
              <div>
                <Label>Horário final</Label>
                <Input className="mt-1" type="time" value={form.end_time}
                  onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Local</Label>
                <Input className="mt-1" value={form.location} placeholder="Ex.: Sede Endurance ON"
                  onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
              </div>
              <div>
                <Label>Link online</Label>
                <Input className="mt-1" value={form.online_url} placeholder="meet.google.com/..."
                  onChange={e => setForm(f => ({ ...f, online_url: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>Endereço</Label>
              <Input className="mt-1" value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
            </div>
            <div>
              <Label>Descrição pública</Label>
              <Textarea className="mt-1" rows={2} value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div>
              <Label>Informações para inscritos</Label>
              <Textarea className="mt-1" rows={3} value={form.public_notes}
                placeholder="Ex.: chegue 15 minutos antes, leve documento, estacionamento..."
                onChange={e => setForm(f => ({ ...f, public_notes: e.target.value }))} />
            </div>
            <div>
              <Label>Notas internas</Label>
              <Textarea className="mt-1" rows={2} value={form.internal_notes}
                onChange={e => setForm(f => ({ ...f, internal_notes: e.target.value }))} />
            </div>
            <p className="text-xs text-muted-foreground">
              O evento nasce como rascunho. Depois de criar, você adiciona os tipos de inscrição e o formulário de cada um.
            </p>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setCreateModal(false)} disabled={saving}>Cancelar</Button>
              <Button className="flex-1" onClick={createEvent} disabled={saving}>
                {saving ? 'Criando...' : 'Criar evento'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
