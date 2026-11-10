import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, CalendarDays, Check, Clock, ClipboardCopy, Copy, MapPin, MessageCircle, Navigation, Search, SearchX, Users, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { getCoachEvent, setCoachRegistrationWhatsappGroup } from '@/api/client';
import { CountdownPill, EVENT_STATUS, eventDateLabel, eventTimeLabel } from '@/components/coach/event-parts';
import { Avatar, EmptyState, ErrorCard, FilterChip, Panel, Pill, ProgressBar, Skeleton, StatTile } from '@/components/coach/kit';
import { usePageData } from '@/hooks/usePageData';
import {
  filterRegistrations, formatPhone, groupRegistrations, groupSummaryOf, paymentInfo, whatsappLink,
} from '@/lib/coach-events';
import { registrationShares } from '@/lib/coach-ui';
import { WHATSAPP_GROUP_OPTIONS, groupStatusOf, summaryText } from '@/lib/event-whatsapp-group';
import { cn, todayLocalStr } from '@/lib/utils';

const GROUP_STYLE = {
  pending: { short: 'Falta', on: 'bg-amber-500 text-white shadow-sm' },
  added: { short: 'No grupo', on: 'bg-emerald-600 text-white shadow-sm' },
  declined: { short: 'Não quer', on: 'bg-slate-600 text-white shadow-sm' },
};
const PAY_TONE = { success: 'success', warning: 'warning', secondary: 'neutral' };

// Três botões no lugar de uma lista: um toque marca a situação. Por baixo são botões de
// rádio de verdade, então o teclado e o leitor de tela funcionam.
function GroupToggle({ id, name, value, disabled, onChange }) {
  return (
    <div role="radiogroup" aria-label={`Grupo do WhatsApp de ${name}`} className="inline-flex gap-1 rounded-xl bg-slate-100 p-1">
      {WHATSAPP_GROUP_OPTIONS.map(option => {
        const selected = value === option.value;
        const style = GROUP_STYLE[option.value];
        return (
          <label key={option.value} title={option.label} className="relative">
            <input
              type="radio"
              name={`group-${id}`}
              value={option.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className={cn(
              'flex min-h-10 min-w-[4.75rem] cursor-pointer items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-blue-600 peer-disabled:cursor-wait peer-disabled:opacity-70',
              selected ? style.on : 'text-slate-600 hover:bg-white hover:text-slate-900',
            )}>
              {selected && option.value === 'added' && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
              {style.short}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function copyText(text, success) {
  const done = () => toast.success(success);
  const fail = () => toast.error('Não foi possível copiar');
  if (!navigator.clipboard?.writeText) return fail();
  return navigator.clipboard.writeText(text).then(done, fail);
}

function RegistrationRow({ item, groupEnabled, saving, groupValue, onChangeGroup }) {
  const pay = paymentInfo(item.payment);
  const link = whatsappLink(item.whatsapp);
  const showGroup = groupEnabled && item.payment === 'paid';
  return (
    <li className="px-3 py-3.5 sm:px-4">
      <div className="flex items-start gap-3">
        <Avatar name={item.person_name} />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{item.person_name}</p>
              <p className="truncate text-xs text-slate-500">{item.type_name}</p>
            </div>
            <Pill tone={PAY_TONE[pay.tone] || 'neutral'}>{pay.label}</Pill>
          </div>
          {showGroup && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <GroupToggle id={item.id} name={item.person_name} value={groupValue} disabled={saving} onChange={status => onChangeGroup(item, status)} />
              {item.whatsapp && (
                <div className="flex items-center gap-1">
                  <span className="mr-1 text-xs tabular-nums text-slate-500">{formatPhone(item.whatsapp)}</span>
                  <button type="button" onClick={() => copyText(item.whatsapp, 'Número copiado')} aria-label={`Copiar número de ${item.person_name}`} className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </button>
                  {link && (
                    <a href={link} target="_blank" rel="noreferrer" aria-label={`Abrir conversa com ${item.person_name} no WhatsApp`} className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                      <MessageCircle className="h-4 w-4" aria-hidden="true" /> Conversar
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function RegistrationGroup({ title, items, groupEnabled, savingId, chosen, onChangeGroup }) {
  if (!items.length) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">{title}<span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600">{items.length}</span></h3>
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        {items.map(item => (
          <RegistrationRow
            key={item.id}
            item={item}
            groupEnabled={groupEnabled}
            saving={savingId === item.id}
            groupValue={chosen[item.id] || groupStatusOf({ whatsapp_group_status: item.whatsapp_group_status })}
            onChangeGroup={onChangeGroup}
          />
        ))}
      </ul>
    </section>
  );
}

function BackLink() {
  return (
    <Link to="/coach/eventos" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg text-sm font-medium text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Seus eventos
    </Link>
  );
}

function Hero({ event, today, mapHref }) {
  const time = eventTimeLabel(event);
  const status = EVENT_STATUS[event.status] || EVENT_STATUS.draft;
  return (
    <section aria-label="Sobre o evento" className="overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-[#1e1b4b] to-blue-900 p-5 text-white shadow-lg sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <CountdownPill event={event} today={today} />
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      <h1 className="mt-3 text-2xl font-bold leading-tight tracking-tight sm:text-3xl">{event.name}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-blue-100">
        <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" aria-hidden="true" /> {eventDateLabel(event)}</span>
        {time && <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4" aria-hidden="true" /> {time}</span>}
        {event.location && <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4" aria-hidden="true" /> {event.location}</span>}
      </div>
      {event.address && <p className="mt-1 text-xs text-blue-200/80">{event.address}</p>}
      {mapHref && (
        <a href={mapHref} target="_blank" rel="noreferrer" className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm font-semibold text-white ring-1 ring-inset ring-white/25 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
          <Navigation className="h-4 w-4" aria-hidden="true" /> Abrir no mapa
        </a>
      )}
      {event.public_notes && <p className="mt-4 whitespace-pre-line rounded-xl bg-white/10 p-3 text-[13px] leading-relaxed text-blue-50">{event.public_notes}</p>}
    </section>
  );
}

function GroupPanel({ summary, missingNumbers, onlyMissing, onToggleMissing }) {
  const total = summary.paid || 0;
  const pct = value => (total ? (value / total) * 100 : 0);
  return (
    <Panel title="Grupo do WhatsApp" description="Só quem já pagou entra na conta.">
      <div className="space-y-3">
        <ProgressBar
          className="h-3"
          label={`${summary.added} de ${total} pagos já estão no grupo`}
          segments={[
            { value: pct(summary.added), className: 'bg-emerald-500' },
            { value: pct(summary.declined), className: 'bg-slate-400' },
            { value: pct(summary.pending), className: 'bg-amber-400' },
          ]}
        />
        <p className="text-sm text-slate-700">{summaryText(summary)}</p>
        <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
          <button
            type="button"
            onClick={onToggleMissing}
            aria-pressed={onlyMissing}
            disabled={summary.pending === 0 && !onlyMissing}
            className={cn(
              'inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:opacity-50',
              onlyMissing ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200 hover:bg-amber-100',
            )}
          >
            {onlyMissing ? <><X className="h-4 w-4" aria-hidden="true" /> Mostrar todos</> : `Mostrar só quem falta (${summary.pending})`}
          </button>
          {missingNumbers.length > 0 && (
            <button
              type="button"
              onClick={() => copyText(missingNumbers.join('\n'), `${missingNumbers.length} ${missingNumbers.length === 1 ? 'número copiado' : 'números copiados'}`)}
              className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              <ClipboardCopy className="h-4 w-4" aria-hidden="true" /> Copiar números de quem falta
            </button>
          )}
        </div>
      </div>
    </Panel>
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
  const [filter, setFilter] = useState('todos');
  const [savingId, setSavingId] = useState(null);
  // Mostra a escolha na hora; se o servidor recusar, volta ao que estava.
  const [chosen, setChosen] = useState({});

  const event = data?.event;
  const groupEnabled = Boolean(event?.whatsapp_group_enabled);
  const groupSummary = groupSummaryOf(data?.summary);
  const onlyMissing = filter === 'faltam';

  const registrations = useMemo(() => data?.registrations || [], [data]);
  const everyGroup = useMemo(() => groupRegistrations(registrations), [registrations]);
  const liveSummary = useMemo(() => {
    const summary = { paid: 0, added: 0, pending: 0, declined: 0 };
    for (const item of registrations) {
      if (item.payment !== 'paid') continue;
      summary.paid += 1;
      const status = chosen[item.id] || groupStatusOf({ whatsapp_group_status: item.whatsapp_group_status });
      if (status === 'added') summary.added += 1;
      else if (status === 'declined') summary.declined += 1;
      else summary.pending += 1;
    }
    return summary;
  }, [registrations, chosen]);
  const missing = useMemo(
    () => registrations.filter(item => item.payment === 'paid' && (chosen[item.id] || groupStatusOf({ whatsapp_group_status: item.whatsapp_group_status })) === 'pending'),
    [registrations, chosen],
  );
  const missingNumbers = useMemo(
    () => missing.filter(item => item.whatsapp).map(item => `${item.person_name} - ${formatPhone(item.whatsapp)}`),
    [missing],
  );
  const searched = useMemo(
    () => filterRegistrations(registrations, { query, onlyMissingGroup: false }),
    [registrations, query],
  );
  const visible = useMemo(() => {
    const groups = groupRegistrations(searched);
    if (filter === 'pagos') return { paid: groups.paid, notPaid: [], cancelled: [] };
    if (filter === 'sem_pagar') return { paid: [], notPaid: groups.notPaid, cancelled: [] };
    if (filter === 'faltam') return { paid: groups.paid.filter(item => missing.some(entry => entry.id === item.id)), notPaid: [], cancelled: [] };
    return groups;
  }, [searched, filter, missing]);
  const shown = visible.paid.length + visible.notPaid.length + visible.cancelled.length;

  async function changeGroup(item, status) {
    setSavingId(item.id);
    setChosen(current => ({ ...current, [item.id]: status }));
    try {
      await setCoachRegistrationWhatsappGroup(item.id, status);
      await refresh({ force: true });
    } catch (e) {
      toast.error(e.message || 'Não foi possível atualizar o grupo do WhatsApp');
    } finally {
      setChosen(current => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setSavingId(null);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-4" role="status" aria-label="Carregando evento">
        <BackLink />
        <Skeleton className="h-44" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (!data) {
    const notFound = error?.status === 404;
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorCard
          title={notFound ? 'Evento não encontrado.' : 'Não foi possível carregar o evento.'}
          message={notFound ? 'Ele não existe ou você não é responsável por ele.' : (error?.message || 'Tente novamente em instantes.')}
          onRetry={notFound ? undefined : () => refresh({ force: true }).catch(() => {})}
        />
      </div>
    );
  }

  const today = todayLocalStr();
  const mapHref = event.map_url || (event.address || event.location
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([event.address, event.location].filter(Boolean).join(' '))}`
    : '');
  const shares = registrationShares({ paid: data.summary.paid, not_paid: data.summary.not_paid, cancelled: everyGroup.cancelled.length });
  const filterOptions = [
    { key: 'todos', label: 'Todos', count: registrations.length },
    { key: 'pagos', label: 'Pagos', count: everyGroup.paid.length },
    { key: 'sem_pagar', label: 'Sem pagar', count: everyGroup.notPaid.length },
    ...(groupEnabled ? [{ key: 'faltam', label: 'Faltam no grupo', count: missing.length }] : []),
  ].filter(option => option.key === 'todos' || option.count > 0 || filter === option.key);

  return (
    <div className="space-y-5">
      <BackLink />
      <Hero event={event} today={today} mapHref={mapHref} />

      <div className="grid gap-6 lg:grid-cols-3">
        <aside className="min-w-0 space-y-4 lg:col-start-3 lg:row-start-1" aria-label="Resumo das inscrições">
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-1">
            <StatTile label="Inscritos" value={data.summary.registered} accent={{ bar: 'bg-blue-500' }} />
            <StatTile label="Pagos" value={data.summary.paid} accent={{ bar: 'bg-emerald-500' }} />
            <StatTile label="Sem pagar" value={data.summary.not_paid} accent={{ bar: data.summary.not_paid > 0 ? 'bg-amber-400' : 'bg-slate-300' }} />
          </div>
          {shares.total > 0 && (
            <ProgressBar
              label={`${data.summary.paid} pagos, ${data.summary.not_paid} sem pagar`}
              className="h-2.5"
              segments={[
                { value: shares.paid, className: 'bg-emerald-500' },
                { value: shares.notPaid, className: 'bg-amber-400' },
                { value: shares.cancelled, className: 'bg-slate-300' },
              ]}
            />
          )}
          {groupEnabled && groupSummary && (
            <GroupPanel
              summary={liveSummary}
              missingNumbers={missingNumbers}
              onlyMissing={onlyMissing}
              onToggleMissing={() => setFilter(current => (current === 'faltam' ? 'todos' : 'faltam'))}
            />
          )}
        </aside>

        <div className="min-w-0 space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              aria-label="Buscar inscrito por nome"
              placeholder="Buscar inscrito por nome"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-10 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Limpar busca" className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>

          {filterOptions.length > 1 && (
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Filtrar inscritos">
              {filterOptions.map(option => (
                <FilterChip key={option.key} active={filter === option.key} count={option.count} onClick={() => setFilter(option.key)}>{option.label}</FilterChip>
              ))}
            </div>
          )}

          {registrations.length === 0 ? (
            <EmptyState icon={Users} title="Nenhuma inscrição ainda.">Quando alguém se inscrever, aparece aqui com a situação do pagamento.</EmptyState>
          ) : shown === 0 ? (
            <EmptyState icon={SearchX} title={onlyMissing && !query ? 'Ninguém falta adicionar ao grupo.' : 'Nenhum inscrito encontrado.'}>
              {onlyMissing && !query ? 'Todos os pagos já foram tratados.' : 'Tente outro nome ou outro filtro.'}
              <button type="button" onClick={() => { setQuery(''); setFilter('todos'); }} className="mt-3 block w-full text-sm font-medium text-blue-700 hover:underline">Ver todos os inscritos</button>
            </EmptyState>
          ) : (
            <div className="space-y-5">
              {[
                ['Pagos', visible.paid],
                ['Ainda não pagaram', visible.notPaid],
                ['Canceladas', visible.cancelled],
              ].map(([title, items]) => (
                <RegistrationGroup
                  key={title}
                  title={title}
                  items={items}
                  groupEnabled={groupEnabled}
                  savingId={savingId}
                  chosen={chosen}
                  onChangeGroup={changeGroup}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
