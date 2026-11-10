import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Search, SearchX, UserMinus, Users, X } from 'lucide-react';
import { Avatar, EmptyState, FilterChip, ModalityChip, PageHeader, Pill, ProgressBar, Segmented } from '@/components/coach/kit';
import PanelState from '@/components/coach/PanelState';
import {
  STUDENT_FILTERS, STUDENT_SORTS, agoLabel, contractProgress, daysBetween, daysLeftLabel, filterCounts, filterStudents,
  modalitiesOf, planLabel, sortStudents, studentAttention,
} from '@/lib/coach-ui';
import { cn, formatDate } from '@/lib/utils';
import { useCoachPanel } from './useCoachPanel';

const BAR_TONE = { danger: 'bg-red-500', warning: 'bg-amber-500', info: 'bg-blue-500', neutral: 'bg-slate-400' };
const selectClass = 'h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600';

// Aba, busca e filtros ficam no estado da tela (respondem na hora, sem depender do endereço).
// O endereço só serve para abrir a tela já filtrada, como no link "Vencendo" da tela inicial
// (?aba=, ?q=, ?filtro=, ?modalidade=, ?ordem=).
function useListState() {
  const [params] = useSearchParams();
  const [state, setState] = useState(() => ({
    tab: params.get('aba') === 'saidas' ? 'saidas' : 'ativos',
    query: params.get('q') || '',
    filter: STUDENT_FILTERS.some(item => item.key === params.get('filtro')) ? params.get('filtro') : 'todos',
    modality: params.get('modalidade') || '',
    sort: STUDENT_SORTS.some(item => item.key === params.get('ordem')) ? params.get('ordem') : 'nome',
  }));
  const set = useCallback(patch => setState(current => ({ ...current, ...patch })), []);
  return { ...state, set };
}

function StudentRow({ student, today }) {
  const attention = studentAttention(student, today);
  const progress = contractProgress(student, today);
  const plan = planLabel(student);
  const status = attention
    ? <Pill tone={attention.tone}>{attention.label}</Pill>
    : <Pill tone="success">Ativo</Pill>;
  const barTone = BAR_TONE[attention?.tone] || 'bg-emerald-500';
  return (
    <li className="px-3 py-3.5 sm:px-4">
      <div className="flex items-start gap-3">
        <Avatar name={student.name} />
        <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1fr)_16rem_10.5rem] sm:items-center sm:gap-6">
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-semibold text-slate-900">{student.name}</p>
              <span className="shrink-0 sm:hidden">{status}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <ModalityChip modality={student.modality} />
              {plan && <span className="text-xs text-slate-500">{plan}</span>}
            </div>
          </div>
          <div className="mt-2.5 sm:mt-0">
            {progress ? (
              <>
                <ProgressBar
                  label={`Contrato ${progress.percent}% percorrido`}
                  segments={[{ value: progress.percent, className: barTone }]}
                />
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-slate-500">
                  <span>{formatDate(student.started_on)}</span>
                  <span className={cn('font-medium', attention?.key === 'expired' ? 'text-red-600' : 'text-slate-600')}>{attention?.key === 'leave' ? '' : daysLeftLabel(progress.daysLeft)}</span>
                  <span>{formatDate(student.ends_on)}</span>
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-400">Datas do contrato não informadas</p>
            )}
          </div>
          <div className="hidden justify-end sm:flex">{status}</div>
        </div>
      </div>
    </li>
  );
}

function ExitRow({ exit, today }) {
  const plan = planLabel(exit);
  const days = daysBetween(today, exit.date);
  return (
    <li className="px-3 py-3.5 sm:px-4">
      <div className="flex items-start gap-3">
        <Avatar name={exit.name} className="opacity-70" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-semibold text-slate-900">{exit.name}</p>
            <p className="shrink-0 text-right text-xs text-slate-500">
              <span className="tabular-nums">{exit.date ? formatDate(exit.date) : '—'}</span>
              {days !== null && <span className="block text-[11px] text-slate-400">{agoLabel(days)}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ModalityChip modality={exit.modality} />
            {plan && <span className="text-xs text-slate-500">{plan}</span>}
          </div>
          <p className={cn('text-[13px]', exit.reason ? 'text-slate-700' : 'italic text-slate-400')}>
            {exit.reason || 'Sem motivo registrado'}
          </p>
        </div>
      </div>
    </li>
  );
}

function Students({ data }) {
  const { tab, query, filter, modality, sort, set } = useListState();
  const { today } = data;
  const counts = useMemo(() => filterCounts(data.students, today), [data.students, today]);
  const modalities = useMemo(() => modalitiesOf(data.students), [data.students]);
  const students = useMemo(
    () => sortStudents(filterStudents(data.students, { query, filter, modality }, today), sort),
    [data.students, query, filter, modality, sort, today],
  );
  const exits = useMemo(() => {
    const needle = query.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    return data.exits
      .filter(exit => !needle || exit.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(needle))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
  }, [data.exits, query]);

  const filtering = tab === 'ativos' ? Boolean(query || modality || filter !== 'todos') : Boolean(query);
  const clear = () => set({ query: '', filter: 'todos', modality: '' });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Meus alunos"
        subtitle={`${data.students.length} ${data.students.length === 1 ? 'ativo' : 'ativos'} hoje · ${data.exits.length} ${data.exits.length === 1 ? 'saiu' : 'saíram'} nos últimos 12 meses`}
        actions={<Segmented label="Lista" value={tab} onChange={value => set({ tab: value })} options={[
          { value: 'ativos', label: 'Ativos', count: data.students.length },
          { value: 'saidas', label: 'Saíram', count: data.exits.length },
        ]} />}
      />

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              aria-label="Buscar aluno por nome"
              placeholder="Buscar aluno por nome"
              value={query}
              onChange={event => set({ query: event.target.value })}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-10 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button type="button" onClick={() => set({ query: '' })} aria-label="Limpar busca" className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          {tab === 'ativos' && (
            <div className="flex gap-2">
              {modalities.length > 1 && (
                <select aria-label="Filtrar por modalidade" value={modality} onChange={event => set({ modality: event.target.value })} className={cn(selectClass, 'flex-1 sm:flex-none')}>
                  <option value="">Modalidades</option>
                  {modalities.map(item => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}
                </select>
              )}
              <select aria-label="Ordenar alunos" value={sort} onChange={event => set({ sort: event.target.value })} className={cn(selectClass, 'flex-1 sm:flex-none')}>
                {STUDENT_SORTS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </div>
          )}
        </div>

        {tab === 'ativos' && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Filtrar por situação">
            {STUDENT_FILTERS.filter(item => item.key === 'todos' || counts[item.key] > 0 || filter === item.key).map(item => (
              <FilterChip key={item.key} active={filter === item.key} count={counts[item.key]} onClick={() => set({ filter: item.key })}>
                {item.label}
              </FilterChip>
            ))}
          </div>
        )}
      </div>

      {tab === 'ativos' ? (
        data.students.length === 0 ? (
          <EmptyState icon={Users} title="Você ainda não tem alunos ativos.">Quando um aluno entrar na sua lista, ele aparece aqui.</EmptyState>
        ) : students.length === 0 ? (
          <EmptyState icon={SearchX} title="Nenhum aluno encontrado.">
            Tente outro nome ou tire algum filtro.
            <button type="button" onClick={clear} className="mt-3 block w-full text-sm font-medium text-blue-700 hover:underline">Limpar busca e filtros</button>
          </EmptyState>
        ) : (
          <section aria-label="Alunos ativos">
            {filtering && <p className="mb-2 text-xs text-slate-500" aria-live="polite">Mostrando {students.length} de {data.students.length} alunos · <button type="button" onClick={clear} className="font-medium text-blue-700 hover:underline">limpar</button></p>}
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
              {students.map((student, index) => <StudentRow key={`${student.name}-${student.started_on}-${index}`} student={student} today={today} />)}
            </ul>
          </section>
        )
      ) : (
        data.exits.length === 0 ? (
          <EmptyState icon={UserMinus} title="Ninguém saiu nos últimos 12 meses.">Que ótimo. Quando alguém sair, o motivo registrado aparece aqui.</EmptyState>
        ) : exits.length === 0 ? (
          <EmptyState icon={SearchX} title="Ninguém com esse nome.">
            <button type="button" onClick={() => set({ query: '' })} className="mt-1 text-sm font-medium text-blue-700 hover:underline">Limpar busca</button>
          </EmptyState>
        ) : (
          <section aria-label="Saíram nos últimos 12 meses">
            <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
              {exits.map((exit, index) => <ExitRow key={`${exit.name}-${exit.date}-${index}`} exit={exit} today={today} />)}
            </ul>
          </section>
        )
      )}

      <p className="text-xs text-slate-500">
        Quem está em renovação ou licença não aparece como "vencendo": a conversa com o aluno já começou.
        {' '}<Link to="/coach/movimento" className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline">Ver evolução mês a mês <ArrowRight className="h-3 w-3" aria-hidden="true" /></Link>
      </p>
    </div>
  );
}

export default function CoachStudents() {
  const panel = useCoachPanel();
  return <PanelState panel={panel}>{data => <Students data={data} />}</PanelState>;
}
