import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, CalendarClock, Clock3, History, Loader2, MessageCircle,
  RefreshCw, Search, Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import CommunicationSendDialog from '@/components/CommunicationSendDialog';
import { listCommunicationCases, listCommunicationHistory } from '@/api/client';
import { communicationBlockReasonLabel } from '@/lib/communication-case';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils';

const STATES = [
  { value: 'to_do', label: 'A fazer' },
  { value: 'following_up', label: 'Em acompanhamento' },
  { value: 'scheduled', label: 'Agendadas' },
  { value: 'resolved', label: 'Histórico' },
];

const PURPOSES = [
  { value: '', label: 'Todas as finalidades' },
  { value: 'billing', label: 'Cobranças' },
  { value: 'renewal', label: 'Renovações' },
  { value: 'onboarding', label: 'Boas-vindas' },
];

const PURPOSE_LABEL = {
  billing: 'Cobrança',
  renewal: 'Renovação',
  onboarding: 'Boas-vindas',
};

const EMPTY_COUNTS = {
  to_do: 0,
  following_up: 0,
  scheduled: 0,
  resolved: 0,
  open: 0,
};

function readableDate(value) {
  if (!value) return 'Não definida';
  return String(value).includes('T') ? formatDateTime(value) : formatDate(value);
}

function caseActionLabel(item) {
  if (item.blocked_reason) return 'Revisar bloqueio';
  if (item.workflow_stage === 'resolved') return 'Ver histórico';
  if (item.workflow_stage === 'scheduled') return 'Ver combinado';
  if (item.workflow_stage === 'following_up') return 'Ver acompanhamento';
  if (item.purpose === 'renewal') return 'Retomar conversa';
  if (item.purpose === 'billing') return 'Preparar mensagem';
  return 'Abrir acompanhamento';
}

function CaseRow({ item, onOpen }) {
  const sourceHref = item.source_href;
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={item.purpose === 'billing' ? 'info' : item.purpose === 'renewal' ? 'purple' : 'success'}>
              {PURPOSE_LABEL[item.purpose] || item.purpose || 'Contato'}
            </Badge>
            {item.blocked_reason && <Badge variant="warning">Bloqueio</Badge>}
          </div>
          {sourceHref ? (
            <Link to={sourceHref} className="mt-1 block break-words font-semibold text-blue-700 hover:underline">
              {item.person_name || 'Pessoa sem nome'}
            </Link>
          ) : (
            <p className="mt-1 break-words font-semibold text-gray-900">{item.person_name || 'Pessoa sem nome'}</p>
          )}
          <p className="text-xs text-muted-foreground">{item.reference || 'Referência indisponível'}</p>
        </div>
        <div className="min-w-0 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Situação</p>
          <p className="mt-1 break-words text-gray-900">
            {communicationBlockReasonLabel(item.blocked_reason) || item.action_label || item.status_label || (item.purpose === 'billing' ? 'Cobrança em acompanhamento' : 'Contato em acompanhamento')}
          </p>
          {item.purpose === 'billing' && item.balance != null && (
            <p className="mt-1 font-semibold text-gray-900">Saldo pendente: {formatCurrency(Number(item.balance) || 0)}</p>
          )}
        </div>
        <div className="text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Último contato</p>
          <p className="mt-1 text-gray-900">{readableDate(item.last_contact_at)}</p>
        </div>
        <div className="text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Próxima ação</p>
          <p className="mt-1 font-medium text-gray-900">{readableDate(item.next_action_at)}</p>
        </div>
        <Button
          type="button"
          variant={item.blocked_reason || item.workflow_stage === 'resolved' ? 'outline' : 'default'}
          className="min-h-11 w-full md:w-auto"
          onClick={() => onOpen(item)}
          aria-label={`${caseActionLabel(item)}: ${item.person_name || item.reference || 'contato'}`}
        >
          {caseActionLabel(item)}
        </Button>
      </div>
    </article>
  );
}

const HISTORY_EVENT_LABEL = {
  message_sent: 'Mensagem registrada',
  response_recorded: 'Resposta registrada',
  return_scheduled: 'Retorno agendado',
  review_requested: 'Revisão solicitada',
  review_completed: 'Conferência concluída',
  resolve_case: 'Acompanhamento resolvido',
  task_completed: 'Tarefa concluída',
  legacy_message_sent: 'Mensagem registrada anteriormente',
};

function HistoryRow({ item, onOpen }) {
  const caseId = item.case_id;
  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={item.origin === 'case' ? 'info' : 'secondary'}>{item.origin === 'case' ? 'Acompanhamento' : 'Registro anterior'}</Badge>
            <span className="text-xs text-muted-foreground">{item.created_at ? formatDateTime(item.created_at) : 'Data indisponível'}</span>
          </div>
          <p className="mt-2 font-semibold text-gray-900">{item.person_name || 'Pessoa sem nome'} · {HISTORY_EVENT_LABEL[item.event_type] || item.event_type || 'Contato registrado'}</p>
          {item.reference && <p className="text-xs text-muted-foreground">{item.reference}</p>}
        </div>
        {caseId ? (
          <Button type="button" variant="outline" onClick={() => onOpen({ id: caseId })} className="min-h-11 w-full sm:w-auto">Abrir acompanhamento</Button>
        ) : item.source_href ? (
          <Button variant="outline" asChild className="min-h-11 w-full sm:w-auto"><Link to={item.source_href}>Ver origem</Link></Button>
        ) : null}
      </div>
      {(item.message_text || item.notes) && (
        <p className="mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-gray-50 p-3 text-sm text-gray-700">{item.message_text || item.notes}</p>
      )}
    </article>
  );
}

export default function CommunicationCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const stateParam = searchParams.get('state');
  const state = STATES.some(tab => tab.value === stateParam) ? stateParam : 'to_do';
  const purposeParam = searchParams.get('purpose');
  const purpose = PURPOSES.some(filter => filter.value === purposeParam) ? purposeParam : '';
  const search = searchParams.get('q') || '';
  const caseId = searchParams.get('case');
  const sourceType = searchParams.get('source_type') || '';
  const sourceId = searchParams.get('source_id') || '';
  const customerId = searchParams.get('customer_id') || '';
  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [rollout, setRollout] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [selectedCase, setSelectedCase] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);
  const restoredPages = useRef(Math.min(10, Math.max(1, Number(searchParams.get('pages')) || 1)));

  const updateQuery = useCallback((key, value, { replace = false } = {}) => {
    if (['state', 'purpose', 'q', 'from', 'to'].includes(key)) restoredPages.current = 1;
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, value);
      if (['state', 'purpose', 'q', 'from', 'to'].includes(key)) next.delete('pages');
      return next;
    }, { replace });
  }, [setSearchParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async ({ cursor = null, append = false } = {}) => {
    const requestId = ++requestVersion.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      if (state === 'resolved') {
        const overview = await listCommunicationCases({
          state: 'to_do', purpose: purpose || undefined,
          source_type: sourceType || undefined, source_id: sourceId || undefined,
          customer_id: customerId || undefined, limit: 1,
        });
        if (requestId !== requestVersion.current) return false;
        setCounts({ ...EMPTY_COUNTS, ...(overview.counts || {}) });
        setRollout(overview.rollout || null);
        if (overview.rollout?.enabled === false) {
          setItems([]);
          setNextCursor(null);
          return true;
        }
        const pagesToLoad = append ? 1 : restoredPages.current;
        let next = cursor;
        let collected = [];
        for (let index = 0; index < pagesToLoad; index += 1) {
          const page = await listCommunicationHistory({
            customer_id: customerId || undefined,
            source_type: sourceType || undefined,
            source_id: sourceId || undefined,
            q: debouncedSearch || undefined,
            from: from || undefined,
            to: to || undefined,
            cursor: next || undefined,
            limit: 30,
          });
          if (requestId !== requestVersion.current) return false;
          collected = [...collected, ...(page.items || [])];
          next = page.next_cursor || null;
          if (!next) break;
        }
        setItems(current => append ? [...current, ...collected] : collected);
        setNextCursor(next);
        if (append) {
          restoredPages.current += 1;
          updateQuery('pages', String(restoredPages.current), { replace: true });
        }
        return true;
      }
      const pagesToLoad = append ? 1 : restoredPages.current;
      let next = cursor;
      let collected = [];
      let lastPage = null;
      for (let index = 0; index < pagesToLoad; index += 1) {
        const page = await listCommunicationCases({
          state,
          purpose: purpose || undefined,
          source_type: sourceType || undefined,
          source_id: sourceId || undefined,
          customer_id: customerId || undefined,
          q: debouncedSearch || undefined,
          cursor: next || undefined,
          limit: 30,
        });
        if (requestId !== requestVersion.current) return false;
        collected = [...collected, ...(page.items || [])];
        lastPage = page;
        next = page.next_cursor || null;
        if (!next) break;
      }
      setItems(current => append ? [...current, ...collected] : collected);
      setCounts({ ...EMPTY_COUNTS, ...(lastPage?.counts || {}) });
      setRollout(lastPage?.rollout || null);
      setNextCursor(next);
      if (append) {
        restoredPages.current += 1;
        updateQuery('pages', String(restoredPages.current), { replace: true });
      }
      return true;
    } catch (cause) {
      if (requestId !== requestVersion.current) return;
      setError(cause?.message || 'Não foi possível carregar os acompanhamentos.');
      if (!append) {
        setItems([]);
        setNextCursor(null);
      }
      return false;
    } finally {
      if (requestId === requestVersion.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [state, purpose, sourceType, sourceId, customerId, debouncedSearch, from, to, updateQuery]);

  useEffect(() => {
    load();
    return () => { requestVersion.current += 1; };
  }, [load]);

  const openCount = useMemo(
    () => Number(counts.open),
    [counts],
  );
  const queueReady = rollout?.enabled === true;

  const handleChanged = useCallback(() => {
    load();
  }, [load]);

  const openCase = useCallback((item) => {
    setSelectedCase(item);
    updateQuery('case', item.id);
  }, [updateQuery]);

  const closeCase = useCallback(() => {
    setSelectedCase(null);
    updateQuery('case', null, { replace: true });
  }, [updateQuery]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <MessageCircle className="h-5 w-5 text-blue-600" aria-hidden="true" />
            Comunicação
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cada pendência tem um próximo passo. Abrir o WhatsApp não registra o envio.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild className="min-h-11 gap-2">
            <Link to="/comunicacao/configuracoes">
              <Settings className="h-4 w-4" aria-hidden="true" />
              Modelos e regras
            </Link>
          </Button>
          <Button variant="outline" onClick={() => load()} disabled={loading} className="min-h-11 gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            Atualizar
          </Button>
        </div>
      </header>

      {loading && !rollout && (
        <div role="status" className="rounded-lg border bg-white p-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" aria-hidden="true" />
          Carregando acompanhamentos...
        </div>
      )}

      {error && !queueReady && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
          <Button variant="outline" onClick={() => load()} className="mt-2 min-h-11">Tentar novamente</Button>
        </div>
      )}

      {!loading && rollout?.enabled === false && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-950">
          <p className="font-semibold">Acompanhamentos em preparação</p>
          <p className="mt-1 text-sm">
            A equipe está conferindo os vínculos e o histórico antes de liberar esta fila.
            Nenhuma ação de contato está disponível aqui por enquanto. Atualize a página mais tarde.
          </p>
        </div>
      )}

      {queueReady && <section aria-label="Resumo dos acompanhamentos" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border bg-white p-3">
          <p className="text-xs text-muted-foreground">Acompanhamentos abertos</p>
          <p className="mt-1 text-2xl font-bold">{openCount}</p>
        </div>
        <div className="rounded-lg border bg-white p-3">
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> A fazer</p>
          <p className="mt-1 text-2xl font-bold">{counts.to_do}</p>
        </div>
        <div className="rounded-lg border bg-white p-3">
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" /> Em acompanhamento</p>
          <p className="mt-1 text-2xl font-bold">{counts.following_up}</p>
        </div>
        <div className="rounded-lg border bg-white p-3">
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" /> Agendadas</p>
          <p className="mt-1 text-2xl font-bold">{counts.scheduled}</p>
        </div>
      </section>}

      {queueReady && <div className="space-y-3 rounded-lg border bg-white p-3 shadow-sm">
        <div role="tablist" aria-label="Estado do acompanhamento" className="flex gap-1 overflow-x-auto border-b pb-2">
          {STATES.map(tab => (
            <button
              key={tab.value}
              id={`communication-tab-${tab.value}`}
              type="button"
              role="tab"
              aria-selected={state === tab.value}
              aria-controls="communication-list"
              onClick={() => updateQuery('state', tab.value)}
              className={`min-h-11 shrink-0 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${state === tab.value ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {tab.label}{tab.value !== 'resolved' && <span className="ml-1 text-xs">({counts[tab.value] || 0})</span>}
            </button>
          ))}
        </div>
        {state !== 'resolved' && <div className="flex flex-wrap gap-2">
          {PURPOSES.map(filter => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={purpose === filter.value}
              onClick={() => updateQuery('purpose', filter.value)}
              className={`min-h-11 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${purpose === filter.value ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}
            >
              {filter.label}
            </button>
          ))}
        </div>}
        <label className="relative block">
          <span className="sr-only">{state === 'resolved' ? 'Buscar pessoa, referência ou texto' : 'Buscar pessoa ou referência'}</span>
          <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            className="min-h-11 pl-9"
            placeholder={state === 'resolved' ? 'Buscar pessoa, referência ou texto' : 'Buscar pessoa ou referência'}
            value={search}
            onChange={event => updateQuery('q', event.target.value, { replace: true })}
          />
        </label>
        {state === 'resolved' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-gray-700">
              De
              <Input type="date" value={from} max={to || undefined} onChange={event => updateQuery('from', event.target.value)} className="mt-1 min-h-11" />
            </label>
            <label className="text-sm font-medium text-gray-700">
              Até
              <Input type="date" value={to} min={from || undefined} onChange={event => updateQuery('to', event.target.value)} className="mt-1 min-h-11" />
            </label>
          </div>
        )}
      </div>}

      {queueReady && <div id="communication-list" role="tabpanel" aria-labelledby={`communication-tab-${state}`} className="space-y-2">
        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <span>{error}</span>
            <Button variant="outline" onClick={() => load()} className="min-h-11">Tentar novamente</Button>
          </div>
        )}
        {loading ? (
          <div className="rounded-lg border bg-white p-8 text-center text-sm text-muted-foreground" role="status">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" aria-hidden="true" />
            {state === 'resolved' ? 'Carregando histórico...' : 'Carregando acompanhamentos...'}
          </div>
        ) : !error && items.length === 0 ? (
          <div className="rounded-lg border bg-white p-8 text-center text-sm text-muted-foreground">
            {state === 'to_do' && !purpose && !debouncedSearch
              ? 'Nenhuma ação agora. Verifique Em acompanhamento e Agendadas para os próximos retornos.'
              : state === 'resolved'
                ? 'Nenhum evento corresponde à busca ou ao período selecionado.'
                : 'Nenhum acompanhamento corresponde aos filtros.'}
          </div>
        ) : items.map(item => state === 'resolved'
          ? <HistoryRow key={item.id || item.event_identifier} item={item} onOpen={openCase} />
          : <CaseRow key={item.id} item={item} onOpen={openCase} />)}
        {nextCursor && !loading && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" disabled={loadingMore} onClick={() => load({ cursor: nextCursor, append: true })} className="min-h-11">
              {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <History className="mr-2 h-4 w-4" aria-hidden="true" />}
              Carregar mais
            </Button>
          </div>
        )}
      </div>}

      <CommunicationSendDialog
        caseId={queueReady ? caseId : null}
        communicationCase={selectedCase?.id === caseId ? selectedCase : null}
        onClose={closeCase}
        onChanged={handleChanged}
      />
    </div>
  );
}
