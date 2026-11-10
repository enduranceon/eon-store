import { Link } from 'react-router-dom';
import { CalendarDays, ChevronRight, Clock, MapPin } from 'lucide-react';
import { listCoachEvents } from '@/api/client';
import {
  CountdownPill, EVENT_STATUS, EventDateTile, EventNumbers, eventDateLabel, eventTimeLabel,
} from '@/components/coach/event-parts';
import { EmptyState, ErrorCard, PageHeader, Pill, ProgressBar, Skeleton } from '@/components/coach/kit';
import { usePageData } from '@/hooks/usePageData';
import { splitEvents } from '@/lib/coach-events';
import { registrationShares } from '@/lib/coach-ui';
import { cn, todayLocalStr } from '@/lib/utils';

function EventCard({ event, today, past = false }) {
  const status = EVENT_STATUS[event.status] || EVENT_STATUS.draft;
  const time = eventTimeLabel(event);
  const shares = registrationShares({ paid: event.paid, not_paid: event.not_paid, cancelled: Math.max(0, event.registered - event.paid - event.not_paid) });
  return (
    <Link
      to={`/coach/eventos/${event.id}`}
      className={cn(
        'group block rounded-2xl border bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 sm:p-5',
        past ? 'border-slate-200/80' : 'border-slate-200',
      )}
    >
      <div className="flex items-start gap-3.5">
        <EventDateTile event={event} past={past} className="h-16 w-16" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold leading-snug text-slate-900">{event.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-slate-500">
                <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> {eventDateLabel(event)}</span>
                {time && <span className="inline-flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" aria-hidden="true" /> {time}</span>}
                {event.location && <span className="inline-flex min-w-0 items-center gap-1.5"><MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> <span className="truncate">{event.location}</span></span>}
              </div>
            </div>
            <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CountdownPill event={event} today={today} />
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          {shares.total > 0 && (
            <div className="space-y-1.5">
              <ProgressBar
                label={`${event.paid} pagos de ${event.registered} inscritos`}
                segments={[
                  { value: shares.paid, className: 'bg-emerald-500' },
                  { value: shares.notPaid, className: 'bg-amber-400' },
                ]}
              />
              <EventNumbers event={event} />
            </div>
          )}
          {shares.total === 0 && <p className="text-[13px] text-slate-500">Nenhuma inscrição ainda.</p>}
        </div>
      </div>
    </Link>
  );
}

function Section({ title, count, events, today, past }) {
  if (!events.length) return null;
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">{title}<span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600">{count}</span></h2>
      <div className="grid gap-3 lg:grid-cols-2">{events.map(event => <EventCard key={event.id} event={event} today={today} past={past} />)}</div>
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

  if (loading && !events) {
    return (
      <div className="space-y-4" role="status" aria-label="Carregando eventos">
        <Skeleton className="h-8 w-48" />
        {[0, 1].map(item => <Skeleton key={item} className="h-36" />)}
      </div>
    );
  }
  if (!events) {
    return (
      <ErrorCard
        title="Não foi possível carregar seus eventos."
        message={error?.message || 'Tente novamente em instantes.'}
        onRetry={() => refresh({ force: true }).catch(() => {})}
      />
    );
  }

  const today = todayLocalStr();
  const { upcoming, past } = splitEvents(events, today);
  return (
    <div className="space-y-6">
      <PageHeader title="Seus eventos" subtitle="Eventos em que você é responsável." />
      {events.length === 0 ? (
        <EmptyState icon={CalendarDays} title="Você ainda não é responsável por nenhum evento.">
          A equipe define os responsáveis em cada evento. Quando você for incluído, ele aparece aqui.
        </EmptyState>
      ) : (
        <>
          <Section title="Próximos" count={upcoming.length} events={upcoming} today={today} />
          <Section title="Anteriores" count={past.length} events={past} today={today} past />
        </>
      )}
    </div>
  );
}
