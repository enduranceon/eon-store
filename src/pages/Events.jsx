import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Plus, Users } from 'lucide-react';
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

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function loadEvents() {
  const [events, registrations, centers] = await Promise.all([
    EventRecord.list('-event_date'),
    EventRegistration.list(),
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
  const [form, setForm] = useState({ name: '', event_date: '', location: '', description: '' });

  const createEvent = async () => {
    if (!form.name.trim()) return toast.error('Informe o nome do evento');
    if (!form.event_date) return toast.error('Informe a data do evento');
    setSaving(true);
    try {
      const eventsCenter = centers.find(c => c.type === 'eventos');
      const created = await EventRecord.create({
        name: form.name.trim(),
        slug: slugify(form.name),
        event_date: form.event_date,
        location: form.location.trim() || null,
        description: form.description.trim() || null,
        status: 'draft',
        revenue_center_id: eventsCenter?.id || null,
      });
      setCreateModal(false);
      setForm({ name: '', event_date: '', location: '', description: '' });
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
            return (
              <Card key={event.id} className="cursor-pointer transition-shadow hover:shadow-md" onClick={() => navigate(`/eventos/${event.id}`)}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold leading-snug">{event.name}</p>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="w-4 h-4" /> {formatDate(event.event_date)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="w-4 h-4" /> {total} inscrito{total === 1 ? '' : 's'}
                      {total > 0 && <span className="text-xs">({paid} pago{paid === 1 ? '' : 's'})</span>}
                    </span>
                  </div>
                  {event.location && <p className="text-xs text-muted-foreground">{event.location}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createModal} onOpenChange={open => !saving && setCreateModal(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Novo evento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome do evento</Label>
              <Input className="mt-1" value={form.name} placeholder="Ex.: Briefing Maratona de Floripa"
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label>Data</Label>
              <Input className="mt-1" type="date" value={form.event_date}
                onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))} />
            </div>
            <div>
              <Label>Local (opcional)</Label>
              <Input className="mt-1" value={form.location}
                onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
            </div>
            <div>
              <Label>Descrição (opcional)</Label>
              <Textarea className="mt-1" rows={2} value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
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
