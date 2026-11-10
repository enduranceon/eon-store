import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ChevronRight, RefreshCw, TrendingDown, TrendingUp, UserMinus, UserPlus } from 'lucide-react';
import { listCoachEvents } from '@/api/client';
import { BaseTrend, FlowChart, FlowLegend } from '@/components/coach/charts';
import { CountdownPill, EventDateTile, EventNumbers } from '@/components/coach/event-parts';
import { Avatar, ErrorCard, Panel, Pill, ProgressBar, Skeleton, StatTile } from '@/components/coach/kit';
import PanelState from '@/components/coach/PanelState';
import { useAuth } from '@/hooks/useAuth';
import { usePageData } from '@/hooks/usePageData';
import { firstNameOf } from '@/lib/coach-access';
import { splitEvents } from '@/lib/coach-events';
import {
  attentionItems, greetingFor, longDateLabel, modalityShares, modalityTone, planLabel, periodSummary,
} from '@/lib/coach-ui';
import { cn } from '@/lib/utils';
import { useCoachPanel } from './useCoachPanel';

const percent = value => `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;
const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`;
const ATTENTION_ROWS = 5;

function Hero({ data }) {
  const { kpis } = data;
  const net = kpis.net;
  const first = data.monthly[0]?.label;
  const last = data.monthly[data.monthly.length - 1]?.label;
  return (
    <section
      aria-label="Seus alunos ativos"
      className="overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-[#1e1b4b] to-blue-900 text-white shadow-lg"
    >
      <div className="grid gap-2 p-5 sm:p-6 md:grid-cols-5 md:items-center md:gap-6">
        <div className="md:col-span-2">
          <p className="text-sm font-medium text-blue-200">Você tem</p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-6xl font-bold tabular-nums leading-none tracking-tight">{kpis.active}</span>
            <span className="text-base font-medium text-blue-100">{kpis.active === 1 ? 'aluno ativo' : 'alunos ativos'}</span>
          </p>
          <p className={cn(
            'mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
            net >= 0 ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300',
          )}>
            {net >= 0 ? <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> : <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />}
            {net === 0 ? 'Mesmo número de 12 meses atrás' : `${signed(net)} ${Math.abs(net) === 1 ? 'aluno' : 'alunos'} em 12 meses`}
          </p>
        </div>
        <div className="md:col-span-3">
          <BaseTrend
            monthly={data.monthly}
            tone="dark"
            height={132}
            ariaLabel={`Alunos ativos no fim de cada mês, de ${first} a ${last}. Hoje: ${kpis.active}.`}
          />
          <div className="flex justify-between px-2 text-[11px] font-medium text-blue-200/80">
            <span>{first}</span>
            <span>{last}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function AttentionPanel({ items }) {
  const shown = items.slice(0, ATTENTION_ROWS);
  const rest = items.length - shown.length;
  return (
    <Panel
      title="Precisa da sua atenção"
      description="Contratos perto do fim, renovações em andamento e licenças."
      action={items.length > 0 ? <Pill tone="warning">{items.length}</Pill> : null}
      bodyClassName="px-2 pb-2 sm:px-3"
    >
      {items.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl bg-emerald-50 px-4 py-5 text-emerald-900">
          <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Tudo em dia por aqui.</p>
            <p className="text-sm text-emerald-800">Nenhum contrato vence nos próximos 30 dias e ninguém está em licença.</p>
          </div>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-slate-100">
            {shown.map(({ student, attention }) => (
              <li key={`${student.name}-${student.ends_on}`}>
                <Link
                  to={`/coach/alunos?q=${encodeURIComponent(student.name)}`}
                  className="flex min-h-14 items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                >
                  <Avatar name={student.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">{student.name}</span>
                    <span className="block truncate text-xs capitalize text-slate-500">{student.modality}<span className="normal-case">{planLabel(student) ? ` · ${planLabel(student)}` : ''}</span></span>
                  </span>
                  <Pill tone={attention.tone}>{attention.label}</Pill>
                  <ChevronRight className="hidden h-4 w-4 shrink-0 text-slate-300 sm:block" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/coach/alunos" className="mt-1 flex min-h-11 items-center justify-center gap-1.5 rounded-xl text-sm font-medium text-blue-700 hover:bg-blue-50">
            {rest > 0 ? `Mais ${rest} ${rest === 1 ? 'aluno' : 'alunos'} · ver todos` : 'Ver todos os alunos'} <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </>
      )}
    </Panel>
  );
}

function Tiles({ data }) {
  const { kpis } = data;
  const summary = periodSummary(data.monthly, 12);
  const gained = kpis.entries + kpis.returns;
  return (
    <section aria-label="Últimos 12 meses" className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-slate-900">Seus últimos 12 meses</h2>
        <Link to="/coach/movimento" className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">Ver mês a mês <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={UserPlus} label="Entraram" value={gained} sub={`${kpis.entries} novos · ${kpis.returns} ${kpis.returns === 1 ? 'voltou' : 'voltaram'}`} accent={{ bar: 'bg-emerald-500', icon: 'text-emerald-600' }} />
        <StatTile icon={RefreshCw} label="Renovaram" value={kpis.renewals} sub={kpis.renewals_in_progress ? `${kpis.renewals_in_progress} em andamento agora` : 'nenhuma em andamento'} accent={{ bar: 'bg-violet-500', icon: 'text-violet-600' }} />
        <StatTile icon={UserMinus} label="Saíram" value={kpis.exits} sub={`${percent(kpis.average_churn)} ao mês em média`} accent={{ bar: 'bg-rose-500', icon: 'text-rose-600' }} />
        <StatTile
          icon={kpis.net >= 0 ? TrendingUp : TrendingDown}
          label="Saldo"
          value={signed(kpis.net)}
          sub={summary.best ? `melhor mês: ${summary.best.label}` : 'entradas menos saídas'}
          accent={kpis.net >= 0 ? { bar: 'bg-blue-500', icon: 'text-blue-600' } : { bar: 'bg-rose-500', icon: 'text-rose-600' }}
        />
      </div>
    </section>
  );
}

function ModalityPanel({ groups }) {
  const shares = modalityShares(groups);
  return (
    <Panel title="Por modalidade" description="Onde estão seus alunos ativos.">
      {shares.length === 0 ? (
        <p className="text-sm text-slate-500">Sem alunos ativos.</p>
      ) : (
        <div className="space-y-4">
          <ProgressBar
            className="h-3"
            label={`Alunos por modalidade: ${shares.map(item => `${item.modality} ${item.percent}%`).join(', ')}`}
            segments={shares.map(item => ({ value: item.percent, color: modalityTone(item.modality).bar }))}
          />
          <ul className="space-y-2.5">
            {shares.map(item => (
              <li key={item.modality} className="flex items-center gap-3 text-sm">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', modalityTone(item.modality).dot)} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate capitalize text-slate-700">{item.modality}</span>
                <span className="tabular-nums text-xs text-slate-500">{item.percent}%</span>
                <b className="w-6 text-right tabular-nums text-slate-900">{item.students}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function EventsPanel({ state, today }) {
  const { data: events, loading, error, refresh } = state;
  if (loading && !events) return <Skeleton className="h-40" />;
  if (!events) {
    return <ErrorCard title="Não foi possível carregar seus eventos agora." message={error?.message} onRetry={() => refresh({ force: true }).catch(() => {})} />;
  }
  const { upcoming } = splitEvents(events, today);
  if (upcoming.length === 0) return null;
  const next = upcoming.slice(0, 2);
  return (
    <Panel
      title="Próximos eventos"
      action={<Link to="/coach/eventos" className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">Ver todos <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>}
      bodyClassName="px-2 pb-2 sm:px-3"
    >
      <ul className="divide-y divide-slate-100">
        {next.map(event => (
          <li key={event.id}>
            <Link to={`/coach/eventos/${event.id}`} className="flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
              <EventDateTile event={event} />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-slate-900">{event.name}</span>
                  <CountdownPill event={event} today={today} />
                </span>
                <EventNumbers event={event} />
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Overview({ data, name, events }) {
  const items = attentionItems(data.students, data.today);
  const summary = periodSummary(data.monthly, 12);
  const hour = new Date().getHours();
  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-slate-500 first-letter:uppercase">{longDateLabel(data.today)}</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{greetingFor(hour)}{name ? `, ${name}` : ''}</h1>
      </header>

      <Hero data={data} />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3"><AttentionPanel items={items} /></div>
        <div className="space-y-6 lg:col-span-2">
          <EventsPanel state={events} today={data.today} />
          {data.by_modality.length > 0 && <ModalityPanel groups={data.by_modality} />}
        </div>
      </div>

      <Tiles data={data} />

      <Panel title="Entradas e saídas por mês" description="Para cima, quem entrou ou voltou. Para baixo, quem saiu.">
        <FlowChart
          monthly={data.monthly}
          height={220}
          ariaLabel={`Entradas e saídas por mês nos últimos 12 meses: ${summary.entries + summary.returns} entradas e ${summary.exits} saídas.`}
        />
        <div className="mt-3"><FlowLegend /></div>
      </Panel>

      <p className="text-xs text-slate-500">Os números seguem as mesmas regras do painel da equipe.</p>
    </div>
  );
}

export default function CoachHome() {
  const { coach } = useAuth();
  const panel = useCoachPanel();
  const events = usePageData({
    key: 'coach:events',
    loader: listCoachEvents,
    initialData: null,
    maxAge: 30_000,
    forceOnMount: true,
  });
  return <PanelState panel={panel}>{data => <Overview data={data} name={firstNameOf(coach?.name)} events={events} />}</PanelState>;
}
