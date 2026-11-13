import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Clock3, FileClock, HeartHandshake, LockKeyhole, Search, UsersRound, X } from 'lucide-react';
import './styles.css';

const categoryLabels = { commercial: 'Aluno', team: 'Equipe', partner: 'Parceiro', historical: 'Cadastro antigo' };
const groupLabels = { commercial: 'Alunos', team: 'Equipe', partner: 'Parceiros', historical: 'Cadastros antigos' };
const contractLabels = { active: 'Ativo', on_leave: 'Em licença', overdue: 'Atrasado', scheduled: 'Agendado', finished: 'Concluído', cancelled: 'Cancelado', voided: 'Descartado', draft: 'Prospect' };
const modalityLabels = { run: 'Corrida', both: 'Corrida e triathlon', bike: 'Ciclismo', swim: 'Natação', trail_run: 'Trail running', running: 'Corrida', corrida: 'Corrida', triathlon: 'Triathlon', cycling: 'Ciclismo', ciclismo: 'Ciclismo', swimming: 'Natação', natacao: 'Natação' };
const formatNumber = (number) => Number.isFinite(number) ? new Intl.NumberFormat('pt-BR').format(number) : '—';
const formatDate = (date) => /^\d{4}-\d{2}-\d{2}/.test(date || '') ? date.slice(0, 10).split('-').reverse().join('/') : 'Data não informada';
const initials = (name = '') => name.split(' ').filter(Boolean).filter((word) => !['de', 'da', 'do', 'e', 'dos', 'das'].includes(word.toLowerCase())).slice(0, 2).map((word) => word[0]).join('');
const modality = (value) => Array.isArray(value) ? value.map(modality).join(' · ') : modalityLabels[value?.toLowerCase?.()] || value || 'Não informada';
const coachName = (value) => typeof value === 'string' ? value : value?.name || 'Não informado';

async function request(path, signal) {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Não foi possível carregar as informações.');
  return response.json();
}

function useResource(url) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, loading: true, error: null });
    request(url, controller.signal).then((data) => setState({ data, loading: false, error: null })).catch((error) => {
      if (error.name !== 'AbortError') setState({ data: null, loading: false, error });
    });
    return () => controller.abort();
  }, [url, revision]);
  return { ...state, retry: () => setRevision((value) => value + 1) };
}

function Badge({ children, tone = '', dot = false }) {
  return <span className={`badge ${tone}`}>{dot && <span className="status-dot" />}{children}</span>;
}

function CustomerStatus({ status }) {
  return <Badge dot={Boolean(status?.key) && status.key !== 'none'} tone={status?.key || ''}>{status?.key === 'none' ? '—' : status?.label || 'Não informado'}</Badge>;
}

function Metric({ label, value, note, icon: Icon, tone, loading }) {
  return <article className={`metric ${tone}`}>
    <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={19} strokeWidth={1.7} /></span></div>
    <strong className={loading ? 'skeleton metric-number' : 'metric-number'}>{loading ? '\u00a0' : formatNumber(value)}</strong>
    <p>{note}</p>
  </article>;
}

function ErrorState({ retry }) {
  return <div className="empty-state" role="alert"><span className="empty-icon"><UsersRound size={26} /></span><h3>Não foi possível carregar as informações</h3><p>Tente novamente em instantes.</p><button className="button secondary" onClick={retry}>Tentar novamente</button></div>;
}

function PersonDetails({ id, onClose }) {
  const dialogRef = useRef(null);
  const { data: person, loading, error, retry } = useResource(`/api/people/${encodeURIComponent(id)}?view=customers`);
  const contracts = person?.memberships?.filter((membership) => membership.category === 'commercial').flatMap((membership) => membership.contracts || []) || [];
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={dialogRef} className="person-dialog" aria-labelledby="person-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-shell">
      <div className="dialog-top"><span className="eyebrow">CADASTRO</span><button autoFocus className="icon-button" aria-label="Fechar detalhes" onClick={onClose}><X size={21} /></button></div>
      {loading ? <div className="detail-loading" aria-live="polite"><div className="skeleton" /><div className="skeleton" /><p>Carregando cadastro…</p><h2 id="person-title" className="sr-only">Detalhes da pessoa</h2></div> : error ? <><h2 id="person-title" className="sr-only">Detalhes da pessoa</h2><ErrorState retry={retry} /></> : person && <>
        <header className="person-header"><span className={`avatar large ${person.category}`}>{initials(person.name)}</span><div><h2 id="person-title">{person.name}</h2><div className="badges"><Badge tone={person.category}>{categoryLabels[person.category] || 'Cadastro'}</Badge>{person.roles?.includes('coach') && <Badge>Coach</Badge>}{['team', 'partner'].includes(person.category) && <span className="no-charge">Sem cobrança</span>}</div></div></header>
        <section className="detail-section"><h3>Assessoria</h3><dl className="detail-grid"><div><dt>Situação</dt><dd><CustomerStatus status={person.customerStatus} /></dd></div><div><dt>Modalidade</dt><dd>{modality(person.modality)}</dd></div><div><dt>Coach responsável</dt><dd>{coachName(person.coach)}</dd></div><div><dt>Participação</dt><dd>{categoryLabels[person.category] || 'Não informada'}</dd></div></dl></section>
        <section className="detail-section"><h3><FileClock size={17} /> Contratos</h3>{contracts.length ? <ul className="contracts">{contracts.map((contract, index) => <li key={`${contract.number || 'contract'}-${index}`}><div><strong>{contract.number || 'Contrato de assessoria'}</strong><Badge tone={contract.status}>{contractLabels[contract.status] || 'Não informado'}</Badge></div><span>{contract.start ? formatDate(contract.start) : 'Início não informado'} <ArrowRight size={12} /> {contract.end ? formatDate(contract.end) : 'Fim não informado'}</span></li>)}</ul> : <p className="contract-empty">Nenhum contrato vigente nesta consulta.</p>}</section>
      </>}
    </div>
  </dialog>;
}

function PeopleTable({ resource, openPerson, clearFilters, filtered }) {
  if (resource.error) return <ErrorState retry={resource.retry} />;
  if (!resource.loading && resource.data?.items?.length === 0) return <div className="empty-state"><span className="empty-icon"><Search size={26} /></span><h3>Nenhuma pessoa encontrada</h3><p>{filtered ? 'Tente outro nome ou ajuste o filtro.' : 'Nenhum cadastro disponível nesta consulta.'}</p>{filtered && <button className="button secondary" onClick={clearFilters}>Limpar filtros</button>}</div>;
  return <div className="table-scroll"><table aria-label="Pessoas" aria-busy={resource.loading}><thead><tr><th>Nome</th><th>Coach</th><th>Modalidade</th><th>Situação</th><th><span className="sr-only">Abrir detalhes</span></th></tr></thead><tbody>{resource.loading ? Array.from({ length: 7 }, (_, index) => <tr className="loading-row" key={index}><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td /></tr>) : resource.data?.items?.map((person) => <tr key={person.id}>
    <td><button className="person-link" onClick={() => openPerson(person.id)}><span className={`avatar ${person.category}`}>{initials(person.name)}</span><span><strong>{person.name}</strong>{['team', 'partner'].includes(person.category) && <small><Badge tone={person.category}>{categoryLabels[person.category]}</Badge><span>Sem cobrança</span></small>}</span></button></td>
    <td><span className="coach-name">{coachName(person.coach)}</span></td>
    <td><span className="modality-name">{modality(person.modality)}</span></td>
    <td><CustomerStatus status={person.customerStatus} /></td>
    <td><button className="row-arrow icon-button" aria-label={`Ver detalhes de ${person.name}`} onClick={() => openPerson(person.id)}><ArrowUpRight size={18} /></button></td>
  </tr>)}</tbody></table></div>;
}

function App() {
  const summary = useResource('/api/summary?view=customers');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('commercial');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [lastFocused, setLastFocused] = useState(null);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  const params = new URLSearchParams({ view: 'customers', q: query, category, page: String(page), limit: '25' });
  const people = useResource(`/api/people?${params}`);
  const stats = summary.data || {};
  const total = people.data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / 25));
  const filtered = Boolean(search || category);
  const clearFilters = () => { setSearch(''); setQuery(''); setCategory(''); setPage(1); };
  const openPerson = (id) => { setLastFocused(document.activeElement); setSelectedId(id); };
  const closePerson = () => { const target = lastFocused; setSelectedId(null); requestAnimationFrame(() => target?.focus()); };
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/" aria-label="EON Hub início"><span className="brand-icon"><span /><span /><span /></span><span>EON<span className="brand-hub">HUB</span></span></a><div className="workspace-label">ASSESSORIA</div><nav aria-label="Navegação"><a className="nav-item active" href="#pessoas" aria-current="page"><UsersRound size={19} /><span>Pessoas</span><span className="nav-dot" /></a></nav><div className="sidebar-bottom"><div className="sidebar-footer"><span className="small-eon">E</span><div><strong>Equipe EON</strong><small>EON Hub</small></div></div></div></aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">EON Hub <ChevronRight size={14} /><strong>Pessoas</strong></span><div className="test-environment"><LockKeyhole size={12} /><span>Ambiente de teste · Dados de {summary.loading ? '…' : formatDate(stats.asOf)} · Somente leitura</span></div></header>
      <main id="pessoas"><div className="page-heading"><div><h1>Pessoas<span className="heading-dot">.</span></h1><p>Alunos, equipe e parceiros em um só lugar.</p></div></div>
        {summary.error ? <div className="summary-error" role="alert"><p>Os indicadores não puderam ser carregados.</p><button className="text-button" onClick={summary.retry}>Tentar novamente <ArrowRight size={14} /></button></div> : <section className="metrics customer-metrics" aria-label="Indicadores"><Metric label="Alunos ativos" value={stats.activeStudents} note="Com contrato vigente" icon={UsersRound} tone="primary" loading={summary.loading} /><Metric label="Em licença" value={stats.onLeave} note="Alunos com contrato em licença" icon={Clock3} tone="new" loading={summary.loading} /><Metric label="Equipe e parceiros" value={stats.benefits} note={`${formatNumber(stats.team)} da equipe · ${formatNumber(stats.partners)} parceiros`} icon={HeartHandshake} tone="benefit" loading={summary.loading} /></section>}
        <section className="people-panel" aria-labelledby="people-list-title"><div className="panel-heading"><div><h2 id="people-list-title">{groupLabels[category] || 'Todas as pessoas'} <span>{people.loading ? '—' : formatNumber(total)}</span></h2><p>Encontre a pessoa e consulte seu cadastro.</p></div></div><div className="filters"><div className="search-field"><Search size={18} /><label htmlFor="search" className="sr-only">Buscar pessoa pelo nome</label><input id="search" type="search" placeholder="Buscar pessoa pelo nome…" value={search} onChange={(event) => setSearch(event.target.value)} autoComplete="off" /></div><div className="filter-field"><label htmlFor="category">Mostrar</label><select id="category" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">Todas as pessoas</option>{Object.entries(groupLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>{filtered && <button className="clear-filters" onClick={clearFilters} aria-label="Limpar filtros"><X size={15} /> Limpar</button>}</div>
          <PeopleTable resource={people} openPerson={openPerson} clearFilters={clearFilters} filtered={filtered} />
          <div className="pagination"><p aria-live="polite">{people.loading ? 'Buscando cadastros…' : people.error ? 'Consulta indisponível' : total === 0 ? 'Nenhum cadastro' : <><strong>{formatNumber((page - 1) * 25 + 1)}–{formatNumber(Math.min(page * 25, total))}</strong> de <strong>{formatNumber(total)}</strong> pessoas</>}</p><div><span>Página {page} de {totalPages}</span><button className="icon-button" aria-label="Página anterior" disabled={page === 1 || people.loading || Boolean(people.error)} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Próxima página" disabled={page >= totalPages || people.loading || Boolean(people.error)} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></div>
        </section>
      </main></div>{selectedId && <PersonDetails id={selectedId} onClose={closePerson} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
