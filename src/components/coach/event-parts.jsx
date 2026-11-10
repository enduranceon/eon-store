// Peças dos eventos usadas na tela inicial e na lista de eventos do coach.
import { MessageCircle } from 'lucide-react';
import { Pill } from '@/components/coach/kit';
import { dayOfMonth, eventCountdown, monthShort } from '@/lib/coach-ui';
import { cn, formatDate } from '@/lib/utils';

export const EVENT_STATUS = {
  draft: { label: 'Em preparação', tone: 'neutral' },
  open: { label: 'Inscrições abertas', tone: 'success' },
  closed: { label: 'Inscrições encerradas', tone: 'info' },
  cancelled: { label: 'Cancelado', tone: 'danger' },
};

export function eventDateLabel(event) {
  if (!event.event_date) return 'Data a definir';
  if (event.end_date && event.end_date !== event.event_date) return `${formatDate(event.event_date)} a ${formatDate(event.end_date)}`;
  return formatDate(event.event_date);
}

export function eventTimeLabel(event) {
  const start = String(event.start_time || '').slice(0, 5);
  const end = String(event.end_time || '').slice(0, 5);
  if (start && end) return `${start} às ${end}`;
  return start || end || '';
}

export function EventDateTile({ event, past = false, className }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl',
        past ? 'bg-slate-100 text-slate-500' : 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm',
        className,
      )}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider opacity-90">{monthShort(event.event_date) || '--'}</span>
      <span className="text-xl font-bold leading-none">{dayOfMonth(event.event_date) || '?'}</span>
    </div>
  );
}

export function CountdownPill({ event, today }) {
  const countdown = eventCountdown(event, today);
  return <Pill tone={countdown.tone}>{countdown.label}</Pill>;
}

// "31 pagos de 42 inscritos · 6 faltam no grupo": o que o coach precisa saber de relance.
export function EventNumbers({ event }) {
  const missing = Number(event.group_missing) || 0;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-slate-600">
      <span><b className="font-semibold text-slate-900 tabular-nums">{event.paid}</b> {event.paid === 1 ? 'pago' : 'pagos'} de <b className="font-semibold text-slate-900 tabular-nums">{event.registered}</b> {event.registered === 1 ? 'inscrito' : 'inscritos'}</span>
      {event.not_paid > 0 && <span className="text-amber-700">{event.not_paid} sem pagar</span>}
      {event.whatsapp_group_enabled && (
        <span className={cn('inline-flex items-center gap-1 font-medium', missing > 0 ? 'text-amber-700' : 'text-emerald-700')}>
          <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {missing > 0 ? `${missing} ${missing === 1 ? 'falta' : 'faltam'} no grupo` : 'Grupo em dia'}
        </span>
      )}
    </p>
  );
}
