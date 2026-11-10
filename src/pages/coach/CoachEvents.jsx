import { Link } from 'react-router-dom';
import { CalendarDays, ChevronRight, Clock, MapPin, MessageCircle, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { listCoachEvents } from '@/api/client';
import { usePageData } from '@/hooks/usePageData';
import { splitEvents } from '@/lib/coach-events';
import { formatDate, todayLocalStr } from '@/lib/utils';

const EVENT_STATUS = {
  draft: { label: 'Em preparação', variant: 'secondary' },
  open: { label: 'Inscrições abertas', variant: 'success' },
  closed: { label: 'Inscrições encerradas', variant: 'info' },
  cancelled: { label: 'Cancelado', variant: 'destructive' },
};

function dateLabel(event) {
  if (!event.event_date) return 'Data a definir';
  if (event.end_date && event.end_date !== event.event_date) return `${formatDate(event.event_date)} a ${formatDate(event.end_date)}`;
  return formatDate(event.event_date);
}

function timeLabel(event) {
  const start = String(event.start_time || '').slice(0, 5);
  const end = String(event.end_time || '').slice(0, 5);
  if (start && end) return `${start} às ${end}`;
  return start || end || '';
}

function EventCard({ event }) {
  const status = EVENT_STATUS[event.status] || EVENT_STATUS.draft;
  const time = timeLabel(event);
  return (
    <Link to={`/coach/eventos/${event.id}`} className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 rounded-xl">
      <Card className="transition-shadow hover:shadow-md">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold leading-snug text-gray-900">{event.name}</p>
            <Badge variant={status.variant} className="shrink-0">{status.label}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" aria-hidden="true" /> {dateLabel(event)}</span>
            {time && <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4" aria-hidden="true" /> {time}</span>}
            {event.location && <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4" aria-hidden="true" /> {event.location}</span>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> {event.registered} {event.registered === 1 ? 'inscrito' : 'inscritos'}</span>
              <span className="text-green-700">{event.paid} {event.paid === 1 ? 'pago' : 'pagos'}</span>
              {event.not_paid > 0 && <span className="text-amber-700">{event.not_paid} sem pagar</span>}
            </span>
            {event.whatsapp_group_enabled && (
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${event.group_missing > 0 ? 'text-amber-700' : 'text-green-700'}`}>
                <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                {event.group_missing > 0 ? `${event.group_missing} ${event.group_missing === 1 ? 'falta' : 'faltam'} no grupo` : 'Grupo em dia'}
              </span>
            )}
            <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function Section({ title, events }) {
  if (!events.length) return null;
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
      <div className="space-y-3">{events.map(event => <EventCard key={event.id} event={event} />)}</div>
    </section>
  );
}

export default function CoachEvents() {
  const { data: events, loading, error, refresh } = usePageData({
    key: 'coach:events',
    loader: listCoachEvents,
    initialData: null,
    maxAge: 30_000,
    forceOnMount: true,
  });
  const retry = () => refresh({ force: true }).catch(() => {});

  if (loading && !events) {
    return <div className="space-y-3" role="status" aria-label="Carregando eventos">
      {[0, 1].map(item => <div key={item} className="h-32 animate-pulse rounded-xl bg-slate-200" />)}
    </div>;
  }
  if (!events) {
    return (
      <Card className="border-amber-200"><CardContent className="space-y-2 p-4" role="alert">
        <p className="text-sm font-semibold text-amber-900">Não foi possível carregar seus eventos.</p>
        <p className="text-xs text-amber-800">{error?.message || 'Tente novamente em instantes.'}</p>
        <Button variant="outline" size="sm" onClick={retry}>Tentar novamente</Button>
      </CardContent></Card>
    );
  }

  const { upcoming, past } = splitEvents(events, todayLocalStr());
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Seus eventos</h1>
        <p className="text-sm text-muted-foreground">Eventos em que você é responsável.</p>
      </div>
      {events.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">
          Você ainda não é responsável por nenhum evento. A equipe define os responsáveis em cada evento.
        </CardContent></Card>
      ) : (
        <>
          <Section title="Próximos" events={upcoming} />
          <Section title="Anteriores" events={past} />
        </>
      )}
    </div>
  );
}
