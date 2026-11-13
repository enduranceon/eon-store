import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Database, FileClock, Fingerprint, HeartHandshake, Layers3, Link2, LockKeyhole, Search, ShieldCheck, Sparkles, UsersRound, UserRoundPlus, X } from 'lucide-react';
import './styles.css';

const categoryLabels = { commercial: 'Aluno comercial', team: 'Equipe', partner: 'Parceiro', historical: 'Histórico', review: 'Revisar identidade' };
const statusLabels = { active: 'Em atividade', on_leave: 'Em pausa', cancelled: 'Encerrado' };
const roleLabels = { athlete: 'Atleta', coach: 'Coach', customer: 'Cliente' };
const commercialLabels = { current: 'Vigente', active: 'Ativo', overdue: 'Vencido', on_leave: 'Em licença', historical: 'Histórico', scheduled: 'Agendado', cancelled: 'Cancelado', not_applicable: 'Não se aplica' };
const modalityLabels = { run: 'Corrida', both: 'Corrida e triathlon', bike: 'Ciclismo', swim: 'Natação', trail_run: 'Trail running', running: 'Corrida', corrida: 'Corrida', triathlon: 'Triathlon', cycling: 'Ciclismo', ciclismo: 'Ciclismo', swimming: 'Natação', natacao: 'Natação' };
const formatNumber = (number) => Number.isFinite(number) ? new Intl.NumberFormat('pt-BR').format(number) : '—';
const formatDate = (date) => /^\d{4}-\d{2}-\d{2}/.test(date || '') ? date.slice(0, 10).split('-').reverse().join('/') : 'Data não informada';
const initials = (name = '') => name.split(' ').filter(Boolean).filter((word) => !['de', 'da', 'do', 'e', 'dos', 'das'].includes(word.toLowerCase())).slice(0, 2).map((word) => word[0]).join('');
const title = (value) => typeof value === 'string' ? value.replaceAll('_', ' ') : '';
const modality = (value) => Array.isArray(value) ? value.map(modality).join(' · ') : modalityLabels[value?.toLowerCase?.()] || value || 'Não informada';
const coachName = (value) => typeof value === 'string' ? value : value?.name || 'Não informado';

async function request(path, signal) {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Não foi possível consultar a base de teste.');
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

function Metric({ label, value, note, icon: Icon, tone, loading }) {
  return <article className={`metric ${tone}`}>
    <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={19} strokeWidth={1.7} /></span></div>
    <strong className={loading ? 'skeleton metric-number' : 'metric-number'}>{loading ? '\u00a0' : formatNumber(value)}</strong>
    <p>{note}</p>
  </article>;
}

function ErrorState({ retry, message = 'A base de teste está indisponível.' }) {
  return <div className="empty-state" role="alert"><span className="empty-icon"><Database size={26} /></span><h3>{message}</h3><p>Confira se o serviço local está em execução e tente novamente.</p><button className="button secondary" onClick={retry}>Tentar novamente</button></div>;
}

function Source({ source }) {
  return <li className="source-card">
    <div><span className={`source-mark ${source.system}`}>{source.system === 'store' ? 'S' : 'H'}</span><div><strong>EON {source.system === 'store' ? 'Store' : 'Hub'}</strong><p>{source.name || 'Nome preservado na origem'}</p></div><Badge>{source.relationship === 'alias' ? 'Histórico associado' : source.kind === 'customer' ? 'Cliente' : 'Atleta'}</Badge></div>
    <code>{source.id}</code>
  </li>;
}

function decisionText(decision) {
  if (typeof decision === 'string') return decision;
  const descriptions = {
    prepare_new_hub_athlete: 'Novo cadastro de atleta previsto, sem criação de login.',
    map_to_existing_active_athlete: 'Identidade vinculada ao cadastro ativo. O cadastro anterior é preservado.',
    map_identity_and_plan_birth_date_correction: 'Identidade confirmada e correção de nascimento registrada no plano.',
    map_coach_identity: 'Identidade de coach confirmada entre Store e Hub.',
    map_to_existing_athlete: 'Identidade confirmada entre os cadastros de Store e Hub.',
    plan_hub_sporting_status: 'Situação esportiva ajustada na projeção do piloto conforme a confirmação.',
    plan_coach_and_athlete_participation: 'Perfis de coach e atleta reunidos na mesma pessoa.',
    plan_departure_from_coach_and_athlete_roles: 'Saída da assessoria confirmada como coach e atleta; histórico preservado.',
    correct_existing_contract_dates: 'Correção anterior de vigência contratual reconhecida; não reaplicada pelo piloto.',
    plan_benefit_financial_and_metric_policy: 'Benefício sem cobrança, fora da contagem de alunos ativos.',
    plan_partner_athlete_and_benefit_policy: 'Vínculo de parceiro sem cobrança, com participação esportiva preservada.',
    plan_beneficiary_athlete_and_metric_policy: 'Benefício confirmado, sem cobrança e fora da contagem comercial.',
    plan_departure_from_athlete_participation: 'Saída como atleta confirmada; histórico preservado.',
  };
  return descriptions[decision.action] || decision.description || decision.reason || decision.note || decision.summary || title(decision.type) || 'Decisão preservada no mapa de reconciliação.';
}

function PersonDetails({ id, onClose }) {
  const dialogRef = useRef(null);
  const { data: person, loading, error, retry } = useResource(`/api/people/${encodeURIComponent(id)}`);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={dialogRef} className="person-dialog" aria-labelledby="person-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-shell">
      <div className="dialog-top"><span className="eyebrow"><Fingerprint size={15} /> Cadastro unificado</span><button autoFocus className="icon-button" aria-label="Fechar detalhes" onClick={onClose}><X size={21} /></button></div>
      {loading ? <div className="detail-loading" aria-live="polite"><div className="skeleton" /><div className="skeleton" /><p>Carregando cadastro…</p><h2 id="person-title" className="sr-only">Detalhes da pessoa</h2></div> : error ? <><h2 id="person-title" className="sr-only">Detalhes da pessoa</h2><ErrorState retry={retry} /></> : person && <>
        <header className="person-header"><span className={`avatar large ${person.category}`}>{initials(person.name)}</span><div><h2 id="person-title">{person.name}</h2><div className="badges"><Badge tone={person.category}>{categoryLabels[person.category] || 'Cadastro'} </Badge>{person.roles?.map((role) => <Badge key={role}>{roleLabels[role] || title(role)}</Badge>)}</div></div></header>
        <div className={`count-explanation ${person.inActiveStudents ? 'included' : ''}`}><span>{person.inActiveStudents ? <Check size={20} /> : <ArrowDownRight size={20} />}</span><div><strong>{person.inActiveStudents ? 'Entra na contagem de alunos ativos' : 'Fora da contagem de alunos ativos'}</strong><p>{person.category === 'team' || person.category === 'partner' ? 'Treina por benefício, sem cobrança. O vínculo esportivo é independente da contagem comercial.' : person.inActiveStudents ? 'Vínculo comercial vigente na data de referência, inclusive durante uma licença.' : 'Este cadastro não compõe a base comercial ativa na data de referência.'}</p></div></div>
        <section className="detail-section"><h3><Activity size={17} /> Participação esportiva</h3><dl className="detail-grid"><div><dt>Situação nos treinos</dt><dd>{person.needsAthleteProfile ? <Badge tone="review">Perfil a criar</Badge> : <Badge dot tone={person.sportsStatus || ''}>{statusLabels[person.sportsStatus] || 'Sem perfil esportivo'}</Badge>}</dd></div><div><dt>Modalidade</dt><dd>{modality(person.modality)}</dd></div><div><dt>Coach responsável</dt><dd>{coachName(person.coach)}</dd></div><div><dt>Vínculo</dt><dd>{categoryLabels[person.category] || 'Não definido'}</dd></div></dl>{person.needsAthleteProfile && <p className="detail-note"><UserRoundPlus size={16} /> Cadastro de atleta previsto no piloto; nenhum acesso foi criado.</p>}</section>
        {person.memberships?.some((membership) => membership.category === 'commercial') && <section className="detail-section"><h3><FileClock size={17} /> Vínculo comercial <Badge tone={person.metadata?.commercialStatus === 'current' ? 'active' : ''}>{commercialLabels[person.metadata?.commercialStatus] || 'Não informado'}</Badge></h3><ul className="contracts">{person.memberships.filter((membership) => membership.category === 'commercial').flatMap((membership) => membership.contracts || []).map((contract) => <li key={contract.id}><div><strong>{contract.number || 'Contrato de assessoria'}</strong><Badge>{commercialLabels[contract.status] || title(contract.status)}</Badge></div><span>{contract.start ? formatDate(contract.start) : 'Início não informado'} <ArrowRight size={12} /> {contract.end ? formatDate(contract.end) : 'Fim não informado'}</span></li>)}</ul><p className="quiet-note">Vigências do retrato importado. Cobranças e pagamentos não foram importados.</p></section>}
        {person.reviewReason && <section className="review-note"><CircleHelp size={19} /><div><strong>Identidade em revisão</strong><p>{person.reviewReason}</p></div></section>}
        <section className="detail-section"><h3><Link2 size={17} /> Registros de origem <span>{person.sources?.length || 0}</span></h3><ul className="sources">{person.sources?.map((source) => <Source key={`${source.system}:${source.kind}:${source.id}`} source={source} />)}</ul><p className="quiet-note">Os identificadores originais são preservados. Registros históricos associados não são apagados.</p></section>
        {person.decisions?.length > 0 && <section className="detail-section"><h3><FileClock size={17} /> Decisões da reconciliação</h3><ul className="decisions">{person.decisions.map((decision, index) => <li key={index}><span className="decision-dot" /><p>{decisionText(decision)}</p></li>)}</ul></section>}
        <footer className="detail-footer"><ShieldCheck size={18} /><p>Este piloto reúne cadastros e vínculos. Treinos, provas, pagamentos e permissões permanecem nos sistemas de origem.</p></footer>
      </>}
    </div>
  </dialog>;
}

function PeopleTable({ resource, openPerson, clearFilters, filtered }) {
  if (resource.error) return <ErrorState retry={resource.retry} />;
  if (!resource.loading && resource.data?.items?.length === 0) return <div className="empty-state"><span className="empty-icon"><Search size={26} /></span><h3>Nenhuma pessoa encontrada</h3><p>{filtered ? 'Tente outro nome ou ajuste os filtros.' : 'Importe um mapa reconciliado para visualizar os cadastros.'}</p>{filtered && <button className="button secondary" onClick={clearFilters}>Limpar filtros</button>}</div>;
  return <div className="table-scroll"><table aria-label="Pessoas do cadastro unificado" aria-busy={resource.loading}><thead><tr><th>Pessoa</th><th>Vínculo</th><th>Coach e modalidade</th><th>Esportivo</th><th>Alunos ativos</th><th><span className="sr-only">Abrir detalhes</span></th></tr></thead><tbody>{resource.loading ? Array.from({ length: 7 }, (_, index) => <tr className="loading-row" key={index}><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td><span className="skeleton" /></td><td /></tr>) : resource.data?.items?.map((person) => <tr key={person.id}>
    <td><button className="person-link" onClick={() => openPerson(person.id)}><span className={`avatar ${person.category}`}>{initials(person.name)}</span><span><strong>{person.name}</strong><small>{person.roles?.length ? person.roles.map((role) => roleLabels[role] || title(role)).join(' · ') : person.sources?.some((source) => source.system === 'hub') ? 'Perfil esportivo histórico' : 'Cliente da Store'}{person.sources?.some((source) => source.system === 'store') && person.sources?.some((source) => source.system === 'hub') && <span className="linked-label"><Link2 size={11} /> Bases vinculadas</span>}</small></span></button></td>
    <td><Badge tone={person.category}>{categoryLabels[person.category] || 'Cadastro'}</Badge>{['team', 'partner'].includes(person.category) && <span className="cell-note">Sem cobrança</span>}</td>
    <td><span className="coach-name">{coachName(person.coach)}</span><span className="cell-note">{modality(person.modality)}</span></td>
    <td>{person.needsAthleteProfile ? <Badge tone="review"><UserRoundPlus size={12} /> Perfil a criar</Badge> : <Badge dot={Boolean(person.sportsStatus)} tone={person.sportsStatus || ''}>{statusLabels[person.sportsStatus] || 'Sem perfil'}</Badge>}</td>
    <td><span className={`metric-inclusion ${person.inActiveStudents ? 'yes' : ''}`}>{person.inActiveStudents ? <Check size={14} /> : <span className="excluded-dash">—</span>}{person.inActiveStudents ? 'Incluído' : 'Não conta'}</span></td>
    <td><button className="row-arrow icon-button" aria-label={`Ver detalhes de ${person.name}`} onClick={() => openPerson(person.id)}><ArrowUpRight size={18} /></button></td>
  </tr>)}</tbody></table></div>;
}

function App() {
  const summary = useResource('/api/summary');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [sportsStatus, setSportsStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [lastFocused, setLastFocused] = useState(null);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  const params = new URLSearchParams({ q: query, category, sportsStatus, page: String(page), limit: '25' });
  const people = useResource(`/api/people?${params}`);
  const stats = summary.data || {};
  const total = people.data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / 25));
  const filtered = Boolean(search || category || sportsStatus);
  const clearFilters = () => { setSearch(''); setQuery(''); setCategory(''); setSportsStatus(''); setPage(1); };
  const openPerson = (id) => { setLastFocused(document.activeElement); setSelectedId(id); };
  const closePerson = () => { const target = lastFocused; setSelectedId(null); requestAnimationFrame(() => target?.focus()); };
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="/" aria-label="EON Hub início"><span className="brand-icon"><span /><span /><span /></span><span>EON<span className="brand-hub">HUB</span></span></a><div className="workspace-label">PLATAFORMA UNIFICADA</div><nav aria-label="Navegação do piloto"><a className="nav-item active" href="#pessoas" aria-current="page"><UsersRound size={19} /><span>Pessoas</span><span className="nav-dot" /></a></nav><div className="sidebar-bottom"><div className="pilot-symbol"><Layers3 size={23} /></div><strong>Um cadastro.<br />Toda a trajetória.</strong><p>Store e Hub conectados por uma identidade.</p><span className="sidebar-tag"><LockKeyhole size={12} /> Ambiente de teste</span><div className="sidebar-footer"><span className="small-eon">E</span><div><strong>Equipe EON</strong><small>Consulta do piloto</small></div></div></div></aside>
    <div className="main-shell"><header className="topbar"><span className="breadcrumb">EON Hub <ChevronRight size={14} /><strong>Pessoas</strong></span><div className="topbar-right"><span className="pilot-pill"><span /> Piloto</span><span className="read-only"><LockKeyhole size={13} /> Somente leitura</span><span className="team-avatar" aria-label="Equipe EON">E</span></div></header>
      <main id="pessoas"><div className="page-heading"><div><div className="eyebrow">BASE UNIFICADA</div><h1>Pessoas<span className="heading-dot">.</span></h1><p>Uma pessoa, seus vínculos e toda a sua história.</p></div><div className="snapshot"><Clock3 size={16} /><div><span>Retrato da base em</span><strong>{summary.loading ? 'Carregando…' : formatDate(stats.asOf)}</strong></div></div></div>
        <div className="pilot-banner"><span className="banner-icon"><Sparkles size={18} /></span><p><strong>O primeiro passo da nova EON.</strong> Cadastros reconciliados em uma base de teste, com os vínculos comerciais e esportivos separados.</p><span className="banner-seal"><ShieldCheck size={15} /> Produção preservada</span></div>
        {summary.error ? <div className="summary-error" role="alert"><p>Os indicadores não puderam ser carregados.</p><button className="text-button" onClick={summary.retry}>Tentar novamente <ArrowRight size={14} /></button></div> : <section className="metrics" aria-label="Indicadores da base"><Metric label="Alunos ativos" value={stats.activeStudents} note={`${formatNumber(stats.onLeave)} em pausa · vínculo comercial vigente`} icon={UsersRound} tone="primary" loading={summary.loading} /><Metric label="Benefícios" value={stats.benefits} note={`${formatNumber(stats.team)} equipe · ${formatNumber(stats.partners)} parceiros · fora da contagem`} icon={HeartHandshake} tone="benefit" loading={summary.loading} /><Metric label="Perfis a criar" value={stats.needsAthleteProfile} note="Clientes com cadastro esportivo previsto" icon={UserRoundPlus} tone="new" loading={summary.loading} /><Metric label="Históricos em revisão" value={stats.historicalReview} note="Identidades preservadas para conferência" icon={FileClock} tone="review" loading={summary.loading} /></section>}
        <section className="people-panel" aria-labelledby="people-list-title"><div className="panel-heading"><div><h2 id="people-list-title">Cadastros provisórios <span>{formatNumber(stats.people)}</span></h2><p>Identidades históricas em revisão permanecem separadas.</p></div><span className="panel-mode"><Database size={14} /> Base de teste</span></div><div className="filters"><div className="search-field"><Search size={18} /><label htmlFor="search" className="sr-only">Buscar pessoa pelo nome</label><input id="search" type="search" placeholder="Buscar pessoa pelo nome…" value={search} onChange={(event) => setSearch(event.target.value)} autoComplete="off" /></div><div className="filter-field"><label htmlFor="category">Vínculo</label><select id="category" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">Todos os vínculos</option>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="filter-field"><label htmlFor="sports-status">Esportivo</label><select id="sports-status" value={sportsStatus} onChange={(event) => { setSportsStatus(event.target.value); setPage(1); }}><option value="">Todas as situações</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>{filtered && <button className="clear-filters" onClick={clearFilters} aria-label="Limpar filtros"><X size={15} /> Limpar</button>}</div>
          <PeopleTable resource={people} openPerson={openPerson} clearFilters={clearFilters} filtered={filtered} />
          <div className="pagination"><p aria-live="polite">{people.loading ? 'Buscando cadastros…' : people.error ? 'Consulta indisponível' : total === 0 ? 'Nenhum cadastro' : <><strong>{formatNumber((page - 1) * 25 + 1)}–{formatNumber(Math.min(page * 25, total))}</strong> de <strong>{formatNumber(total)}</strong> cadastros{filtered ? ' encontrados' : ''}</>}</p><div><span>Página {page} de {totalPages}</span><button className="icon-button" aria-label="Página anterior" disabled={page === 1 || people.loading || Boolean(people.error)} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Próxima página" disabled={page >= totalPages || people.loading || Boolean(people.error)} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></div>
        </section><footer className="page-footer"><span><ShieldCheck size={15} /> Identidades preservadas. Histórico mantido na origem.</span><span>O piloto não altera contratos, acessos ou pagamentos.</span></footer>
      </main></div>{selectedId && <PersonDetails id={selectedId} onClose={closePerson} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
