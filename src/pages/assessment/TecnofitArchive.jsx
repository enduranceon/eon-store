import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, ChevronDown, ChevronRight, ExternalLink, Search, UserCheck, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { listTecnofitArchivePeople, listTecnofitArchiveReceipts } from '@/api/tecnofit-archive';
import { usePageData } from '@/hooks/usePageData';
import { studentProfilePath } from '@/lib/customer-profile';
import { loadPageCache } from '@/lib/page-cache';
import {
  ARCHIVE_VIEWS,
  RECEIPT_KINDS,
  archiveSituation,
  countByExitYear,
  filterArchive,
  hasRunningTecnofitPlan,
  sortArchive,
  summarizeArchive,
} from '@/lib/tecnofit-archive';
import { cn, formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';

const PAGE_SIZE = 100;
// O arquivo não muda depois da carga; guardar por mais tempo evita buscar de novo.
const ARCHIVE_MAX_AGE = 10 * 60_000;

const SITUATION_STYLE = {
  ex_students: { label: 'Ex-aluno', cls: 'bg-slate-100 text-slate-700' },
  in_eon: { label: 'Na EON Store', cls: 'bg-green-100 text-green-800' },
  customers_only: { label: 'Só compras e eventos', cls: 'bg-amber-100 text-amber-800' },
};

const KIND_STYLE = {
  plan: 'bg-blue-50 text-blue-700',
  fee: 'bg-slate-100 text-slate-700',
  event: 'bg-emerald-50 text-emerald-700',
  store: 'bg-amber-50 text-amber-700',
  service: 'bg-purple-50 text-purple-700',
};

function monthYear(date) {
  return date ? `${String(date).slice(5, 7)}/${String(date).slice(0, 4)}` : '—';
}

function plural(count, one, many) {
  return `${count.toLocaleString('pt-BR')} ${count === 1 ? one : many}`;
}

function ReceiptsPanel({ person }) {
  const [state, setState] = useState({ loading: true, rows: [], error: null });

  useEffect(() => {
    let active = true;
    loadPageCache(
      `tecnofit-archive:receipts:${person.tecnofit_code}`,
      () => listTecnofitArchiveReceipts(person.tecnofit_code),
      { maxAge: ARCHIVE_MAX_AGE, tags: ['tecnofit_archive'] },
    )
      .then(rows => { if (active) setState({ loading: false, rows, error: null }); })
      .catch(error => { if (active) setState({ loading: false, rows: [], error }); });
    return () => { active = false; };
  }, [person.tecnofit_code]);

  if (state.loading) return <p className="px-4 pb-4 text-sm text-muted-foreground">Carregando recibos…</p>;
  if (state.error) {
    return <p role="alert" className="px-4 pb-4 text-sm text-red-700">Não foi possível carregar os recibos: {state.error.message}</p>;
  }

  return (
    <div className="border-t bg-slate-50/60 px-4 py-3 space-y-3">
      {person.customer_id && (
        <Link to={studentProfilePath(person.customer_id)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-700 hover:underline">
          <ExternalLink className="h-4 w-4" /> Abrir o cadastro na EON Store
        </Link>
      )}
      <div className="space-y-2 md:hidden">
        {state.rows.map(receipt => (
          <div key={receipt.receipt_number} className="rounded-lg border bg-white p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', KIND_STYLE[receipt.kind])}>
                {RECEIPT_KINDS[receipt.kind] || receipt.kind}
              </span>
              <span className="font-semibold">{formatCurrency(receipt.amount)}</span>
            </div>
            <p className="mt-1.5 text-slate-800">{receipt.item_name}</p>
            {receipt.period_start && (
              <p className="mt-1 text-xs text-slate-600">{formatDate(receipt.period_start)} a {formatDate(receipt.period_end)}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {[formatDate(receipt.issued_at), receipt.payment_method, `recibo #${receipt.receipt_number}`].filter(Boolean).join(' · ')}
            </p>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border bg-white md:block">
        <table className="w-full text-sm">
          <thead className="border-b bg-gray-50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Data</th>
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="px-3 py-2 text-left font-medium">Período</th>
              <th className="px-3 py-2 text-right font-medium">Valor</th>
              <th className="px-3 py-2 text-left font-medium">Pagamento</th>
              <th className="px-3 py-2 text-left font-medium">Recibo</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {state.rows.map(receipt => (
              <tr key={receipt.receipt_number} className="align-top">
                <td className="whitespace-nowrap px-3 py-2">{formatDate(receipt.issued_at)}</td>
                <td className="px-3 py-2">
                  <span className={cn('mr-2 inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold', KIND_STYLE[receipt.kind])}>
                    {RECEIPT_KINDS[receipt.kind] || receipt.kind}
                  </span>
                  <span className="text-slate-800">{receipt.item_name}</span>
                  {(receipt.consultant || receipt.origin) && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {[receipt.origin, receipt.consultant && `consultor: ${receipt.consultant}`].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                  {receipt.period_start ? `${formatDate(receipt.period_start)} a ${formatDate(receipt.period_end)}` : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{formatCurrency(receipt.amount)}</td>
                <td className="px-3 py-2 text-slate-600">{receipt.payment_method || '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-500">#{receipt.receipt_number}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PersonRow({ person, today, open, onToggle }) {
  const situation = archiveSituation(person);
  const style = SITUATION_STYLE[situation];
  const runningPlan = hasRunningTecnofitPlan(person, today);

  return (
    <div className={cn('rounded-lg border bg-white', open && 'border-blue-200 shadow-sm')}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-start gap-3 p-4 text-left hover:bg-slate-50">
        {open
          ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
        <span className="grid min-w-0 flex-1 gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.7fr)_auto] md:items-center">
          <span className="min-w-0">
            <span className="block font-semibold text-slate-900">{person.full_name}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className={cn('rounded-full px-2 py-0.5 font-semibold', style.cls)}>{style.label}</span>
              <span className="text-muted-foreground">código {person.tecnofit_code} no Tecnofit</span>
            </span>
          </span>
          <span className="text-sm text-slate-700">
            {person.plans_count > 0
              ? `Aluno de ${monthYear(person.first_plan_start)} a ${monthYear(person.last_plan_end)}`
              : 'Sem plano no Tecnofit'}
            {runningPlan && (
              <span className="mt-0.5 block text-xs font-medium text-amber-700">
                Plano pago no Tecnofit até {formatDate(person.last_plan_end)}
              </span>
            )}
          </span>
          <span className="min-w-0 text-sm text-slate-600">
            {person.last_plan_name || '—'}
            {person.plans_count > 0 && <span className="block text-xs text-muted-foreground">{plural(person.plans_count, 'plano', 'planos')}</span>}
          </span>
          <span className="text-sm md:text-right">
            <span className="font-semibold text-slate-900">{formatCurrency(person.receipts_total)}</span>
            <span className="block text-xs text-muted-foreground">{plural(person.receipts_count, 'recibo', 'recibos')}</span>
          </span>
        </span>
      </button>
      {open && <ReceiptsPanel person={person} />}
    </div>
  );
}

export default function TecnofitArchive() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [openCode, setOpenCode] = useState(null);
  const { data: people, loading, error, refresh } = usePageData({
    key: 'tecnofit-archive:people:v1',
    loader: listTecnofitArchivePeople,
    initialData: [],
    maxAge: ARCHIVE_MAX_AGE,
    tags: ['tecnofit_archive'],
  });

  const today = todayLocalStr();
  const query = searchParams.get('busca') || '';
  const requestedView = searchParams.get('visao');
  const view = ARCHIVE_VIEWS.some(item => item.key === requestedView) ? requestedView : 'ex_students';
  const year = searchParams.get('ano') || 'all';
  const order = searchParams.get('ordem') === 'nome' ? 'name' : 'recent';

  const updateQuery = (field, value, fallback = 'all') => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === fallback) next.delete(field);
    else next.set(field, value);
    if (field === 'visao') next.delete('ano');
    setSearchParams(next, { replace: true });
    setVisible(PAGE_SIZE);
  };

  const summary = useMemo(() => summarizeArchive(people), [people]);
  const years = useMemo(() => countByExitYear(filterArchive(people, { view })), [people, view]);
  const filtered = useMemo(
    () => sortArchive(filterArchive(people, { view, year, query }), order),
    [people, view, year, query, order],
  );

  const reload = async () => {
    try { await refresh({ force: true }); }
    catch { /* O erro aparece no aviso abaixo. */ }
  };

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando o arquivo do Tecnofit…</div>;
  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        Não foi possível carregar o arquivo do Tecnofit. <Button variant="outline" className="ml-2" onClick={reload}>Tentar novamente</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900"><Archive className="h-6 w-6 text-slate-600" /> Ex-alunos do Tecnofit</h1>
        <p className="text-sm text-muted-foreground">
          Arquivo do sistema antigo, de 2020 a 2026. Só para consulta: não entra em indicadores, financeiro nem repasse.
        </p>
      </div>

      {people.length === 0 ? (
        <Card><CardContent className="py-14 text-center">
          <Archive className="mx-auto mb-3 h-9 w-9 text-gray-300" />
          <p className="font-medium">O arquivo ainda está vazio</p>
          <p className="mt-1 text-xs text-muted-foreground">Os recibos do Tecnofit aparecem aqui depois da carga.</p>
        </CardContent></Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card><CardContent className="flex items-center gap-3 p-4">
              <div className="rounded-xl bg-slate-100 p-2 text-slate-700"><UserX className="h-5 w-5" /></div>
              <div><p className="text-2xl font-bold">{summary.views.ex_students.toLocaleString('pt-BR')}</p><p className="text-xs text-muted-foreground">ex-alunos sem contrato na EON Store</p></div>
            </CardContent></Card>
            <Card><CardContent className="flex items-center gap-3 p-4">
              <div className="rounded-xl bg-green-100 p-2 text-green-700"><UserCheck className="h-5 w-5" /></div>
              <div><p className="text-2xl font-bold">{summary.views.in_eon.toLocaleString('pt-BR')}</p><p className="text-xs text-muted-foreground">já têm contrato na EON Store</p></div>
            </CardContent></Card>
            <Card><CardContent className="flex items-center gap-3 p-4">
              <div className="rounded-xl bg-blue-100 p-2 text-blue-700"><Archive className="h-5 w-5" /></div>
              <div><p className="text-2xl font-bold">{summary.receipts.toLocaleString('pt-BR')}</p><p className="text-xs text-muted-foreground">recibos guardados · {formatCurrency(summary.total)}</p></div>
            </CardContent></Card>
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            Antes de vender para alguém que diz ser novo, procure o nome aqui: se aparecer, a pessoa já foi aluna no Tecnofit.
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-auto sm:min-w-[220px] sm:max-w-sm sm:flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Buscar pelo nome ou código do Tecnofit" value={query}
                onChange={event => updateQuery('busca', event.target.value, '')} aria-label="Buscar no arquivo do Tecnofit" />
            </div>
            {ARCHIVE_VIEWS.map(item => (
              <button key={item.key} type="button" onClick={() => updateQuery('visao', item.key, 'ex_students')}
                aria-pressed={view === item.key}
                className={cn('rounded-lg border px-3 py-2 text-xs font-medium',
                  view === item.key ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                {item.label} <span className="font-bold">{summary.views[item.key].toLocaleString('pt-BR')}</span>
              </button>
            ))}
            <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              Ordem
              <select value={order === 'name' ? 'nome' : 'recente'} onChange={event => updateQuery('ordem', event.target.value, 'recente')}
                className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-slate-700">
                <option value="recente">Saída mais recente</option>
                <option value="nome">Nome</option>
              </select>
            </label>
          </div>

          {years.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="mr-1 text-muted-foreground">Último plano no Tecnofit em:</span>
              {[{ year: 'all', count: null }, ...years].map(item => (
                <button key={item.year} type="button" onClick={() => updateQuery('ano', String(item.year))}
                  aria-pressed={String(year) === String(item.year)}
                  className={cn('rounded-full border px-2.5 py-1',
                    String(year) === String(item.year) ? 'border-slate-700 bg-slate-800 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>
                  {item.year === 'all' ? 'Todos os anos' : `${item.year} · ${item.count}`}
                </button>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {filtered.length === 0
              ? 'Ninguém neste filtro.'
              : `Mostrando ${Math.min(visible, filtered.length).toLocaleString('pt-BR')} de ${plural(filtered.length, 'pessoa', 'pessoas')}. Clique no nome para ver os recibos.`}
          </p>

          <div className="space-y-2">
            {filtered.slice(0, visible).map(person => (
              <PersonRow key={person.tecnofit_code} person={person} today={today}
                open={openCode === person.tecnofit_code}
                onToggle={() => setOpenCode(current => current === person.tecnofit_code ? null : person.tecnofit_code)} />
            ))}
          </div>

          {filtered.length > visible && (
            <div className="text-center">
              <Button variant="outline" onClick={() => setVisible(count => count + PAGE_SIZE)}>
                Mostrar mais {Math.min(PAGE_SIZE, filtered.length - visible)}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
