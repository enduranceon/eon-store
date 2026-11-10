import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Clock, Copy, ExternalLink, MapPin, MessageCircle, Navigation, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getCoachEvent, setCoachRegistrationWhatsappGroup } from '@/api/client';
import { usePageData } from '@/hooks/usePageData';
import { filterRegistrations, formatPhone, groupRegistrations, groupSummaryOf, paymentInfo, whatsappLink } from '@/lib/coach-events';
import { WHATSAPP_GROUP_OPTIONS, groupStatusOf, summaryText } from '@/lib/event-whatsapp-group';
import { formatDate } from '@/lib/utils';

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

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg border bg-white p-3 text-center">
      <p className={`text-2xl font-bold ${tone || 'text-gray-900'}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function RegistrationRow({ item, groupEnabled, saving, onChangeGroup }) {
  const pay = paymentInfo(item.payment);
  const link = whatsappLink(item.whatsapp);
  const showGroup = groupEnabled && item.payment === 'paid';
  return (
    <li className="space-y-2 px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900">{item.person_name}</p>
          <p className="truncate text-xs text-muted-foreground">{item.type_name}</p>
        </div>
        <Badge variant={pay.tone} className="shrink-0">{pay.label}</Badge>
      </div>
      {showGroup && (
        <div className="flex flex-wrap items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 shrink-0 text-green-700" aria-hidden="true" />
          <label className="text-xs text-muted-foreground" htmlFor={`group-${item.id}`}>Grupo do WhatsApp</label>
          <select
            id={`group-${item.id}`}
            value={groupStatusOf({ whatsapp_group_status: item.whatsapp_group_status })}
            disabled={saving}
            onChange={event => onChangeGroup(item, event.target.value)}
            className="h-9 rounded-md border bg-white px-2 text-sm"
          >
            {WHATSAPP_GROUP_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      )}
      {showGroup && item.whatsapp && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="tabular-nums">{formatPhone(item.whatsapp)}</span>
          <Button
            type="button" variant="ghost" size="sm" className="h-7 px-2"
            onClick={() => { navigator.clipboard?.writeText(item.whatsapp).then(() => toast.success('Número copiado'), () => toast.error('Não foi possível copiar')); }}
          >
            <Copy className="mr-1 h-3 w-3" aria-hidden="true" /> Copiar
          </Button>
          {link && (
            <Button asChild variant="ghost" size="sm" className="h-7 px-2">
              <a href={link} target="_blank" rel="noreferrer"><ExternalLink className="mr-1 h-3 w-3" aria-hidden="true" /> Abrir conversa</a>
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function RegistrationGroup({ title, items, groupEnabled, savingId, onChangeGroup }) {
  if (!items.length) return null;
  return (
    <section aria-label={title} className="space-y-1.5">
      <h3 className="text-sm font-semibold text-gray-700">{title} ({items.length})</h3>
      <Card><CardContent className="p-0">
        <ul className="divide-y">
          {items.map(item => (
            <RegistrationRow key={item.id} item={item} groupEnabled={groupEnabled} saving={savingId === item.id} onChangeGroup={onChangeGroup} />
          ))}
        </ul>
      </CardContent></Card>
    </section>
  );
}

export default function CoachEventDetail() {
  const { id } = useParams();
  const { data, loading, error, refresh } = usePageData({
    key: `coach:event:${id}`,
    loader: () => getCoachEvent(id),
    initialData: null,
    maxAge: 15_000,
    forceOnMount: true,
  });
  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [savingId, setSavingId] = useState(null);

  const event = data?.event;
  const groupEnabled = Boolean(event?.whatsapp_group_enabled);
  const groupSummary = groupSummaryOf(data?.summary);
  const visible = useMemo(
    () => filterRegistrations(data?.registrations || [], { query, onlyMissingGroup: groupEnabled && onlyMissing }),
    [data, query, onlyMissing, groupEnabled],
  );
  const groups = useMemo(() => groupRegistrations(visible), [visible]);

  async function changeGroup(item, status) {
    setSavingId(item.id);
    try {
      await setCoachRegistrationWhatsappGroup(item.id, status);
      await refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Não foi possível atualizar o grupo do WhatsApp');
    } finally {
      setSavingId(null);
    }
  }

  const back = (
    <Link to="/coach/eventos" className="inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Seus eventos
    </Link>
  );

  if (loading && !data) {
    return <div className="space-y-3" role="status" aria-label="Carregando evento">
      {back}<div className="h-40 animate-pulse rounded-xl bg-slate-200" />
    </div>;
  }
  if (!data) {
    const notFound = error?.status === 404;
    return (
      <div className="space-y-3">
        {back}
        <Card className="border-amber-200"><CardContent className="space-y-2 p-4" role="alert">
          <p className="text-sm font-semibold text-amber-900">{notFound ? 'Evento não encontrado.' : 'Não foi possível carregar o evento.'}</p>
          <p className="text-xs text-amber-800">{notFound ? 'Ele não existe ou você não é responsável por ele.' : (error?.message || 'Tente novamente em instantes.')}</p>
          {!notFound && <Button variant="outline" size="sm" onClick={() => refresh({ force: true }).catch(() => {})}>Tentar novamente</Button>}
        </CardContent></Card>
      </div>
    );
  }

  const time = timeLabel(event);
  const mapHref = event.map_url || (event.address || event.location
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([event.address, event.location].filter(Boolean).join(' '))}`
    : '');

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {back}
      <div>
        <h1 className="text-xl font-bold text-gray-900">{event.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" aria-hidden="true" /> {dateLabel(event)}</span>
          {time && <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4" aria-hidden="true" /> {time}</span>}
          {event.location && <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4" aria-hidden="true" /> {event.location}</span>}
        </div>
        {event.address && <p className="mt-1 text-xs text-muted-foreground">{event.address}</p>}
        {mapHref && (
          <a className="mt-1 inline-flex items-center gap-1.5 text-sm text-blue-700 hover:underline" href={mapHref} target="_blank" rel="noreferrer">
            <Navigation className="h-4 w-4" aria-hidden="true" /> Abrir localização
          </a>
        )}
        {event.public_notes && <p className="mt-2 whitespace-pre-line rounded-lg bg-slate-100 p-3 text-xs text-slate-700">{event.public_notes}</p>}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Inscritos" value={data.summary.registered} />
        <Stat label="Pagos" value={data.summary.paid} tone="text-green-700" />
        <Stat label="Sem pagar" value={data.summary.not_paid} tone={data.summary.not_paid > 0 ? 'text-amber-700' : undefined} />
      </div>

      {groupEnabled && groupSummary && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
          <p className="inline-flex items-center gap-1.5 text-sm text-green-900">
            <MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" /> Grupo do WhatsApp: {summaryText(groupSummary)}
          </p>
          <Button size="sm" variant={onlyMissing ? 'default' : 'outline'} onClick={() => setOnlyMissing(value => !value)}>
            {onlyMissing ? 'Mostrar todos' : 'Mostrar só quem falta'}
          </Button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          aria-label="Buscar inscrito por nome"
          placeholder="Buscar inscrito por nome..."
          className="pl-9"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>

      {data.registrations.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma inscrição ainda.</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{onlyMissing ? 'Ninguém falta adicionar ao grupo.' : 'Nenhum inscrito com esse nome.'}</p>
      ) : (
        <div className="space-y-4">
          <RegistrationGroup title="Pagos" items={groups.paid} groupEnabled={groupEnabled} savingId={savingId} onChangeGroup={changeGroup} />
          <RegistrationGroup title="Ainda não pagaram" items={groups.notPaid} groupEnabled={groupEnabled} savingId={savingId} onChangeGroup={changeGroup} />
          <RegistrationGroup title="Canceladas" items={groups.cancelled} groupEnabled={groupEnabled} savingId={savingId} onChangeGroup={changeGroup} />
        </div>
      )}
    </div>
  );
}
