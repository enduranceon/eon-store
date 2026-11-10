import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import PanelState from '@/components/coach/PanelState';
import { formatDate } from '@/lib/utils';
import { useCoachPanel } from './useCoachPanel';

const SITUATION_TONE = { active: 'success', leave: 'warning', renewal: 'info' };

const normalize = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function Table({ head, children }) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border bg-white sm:block">
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="border-b bg-gray-50 text-left text-xs text-slate-600">
          <tr>{head.map(label => <th key={label} scope="col" className="px-3 py-2 font-semibold">{label}</th>)}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

function Students({ data }) {
  const [query, setQuery] = useState('');
  const needle = normalize(query);
  const students = useMemo(
    () => data.students.filter(student => !needle || normalize(student.name).includes(needle)),
    [data.students, needle],
  );
  const exits = useMemo(
    () => data.exits.filter(exit => !needle || normalize(exit.name).includes(needle)),
    [data.exits, needle],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Meus alunos</h1>
        <p className="text-sm text-muted-foreground">Quem está com você hoje e quem saiu nos últimos 12 meses.</p>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input aria-label="Buscar aluno por nome" placeholder="Buscar aluno por nome..." className="pl-9" value={query} onChange={event => setQuery(event.target.value)} />
      </div>

      <section className="space-y-2" aria-label="Ativos hoje">
        <h2 className="font-semibold text-gray-900">Ativos hoje ({students.length}{needle ? ` de ${data.students.length}` : ''})</h2>
        {students.length === 0 ? (
          <p className="rounded-lg border bg-white p-4 text-sm text-muted-foreground">{needle ? 'Nenhum aluno com esse nome.' : 'Nenhum aluno ativo hoje.'}</p>
        ) : (
          <Table head={['Aluno', 'Modalidade', 'Plano', 'Início', 'Fim do contrato', 'Situação']}>
            {students.map((student, index) => (
              <tr key={`${student.name}-${index}`}>
                <td className="px-3 py-2.5 font-medium text-gray-900">{student.name}</td>
                <td className="px-3 py-2.5 capitalize">{student.modality}</td>
                <td className="px-3 py-2.5 text-slate-600">{student.plan || '—'}</td>
                <td className="px-3 py-2.5 tabular-nums">{student.started_on ? formatDate(student.started_on) : '—'}</td>
                <td className="px-3 py-2.5 tabular-nums">{student.ends_on ? formatDate(student.ends_on) : '—'}</td>
                <td className="px-3 py-2.5"><Badge variant={SITUATION_TONE[student.situation.key] || 'secondary'}>{student.situation.label}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
        {students.length > 0 && (
          <ul className="divide-y rounded-lg border bg-white sm:hidden">
            {students.map((student, index) => (
              <li key={`${student.name}-${index}`} className="space-y-1 px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium text-gray-900">{student.name}</p>
                  <Badge variant={SITUATION_TONE[student.situation.key] || 'secondary'} className="shrink-0">{student.situation.label}</Badge>
                </div>
                <p className="text-xs capitalize text-slate-600">{student.modality}{student.plan ? <span className="normal-case"> · {student.plan}</span> : null}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  Início {student.started_on ? formatDate(student.started_on) : '—'} · Fim {student.ends_on ? formatDate(student.ends_on) : '—'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-label="Saíram nos últimos 12 meses">
        <h2 className="font-semibold text-gray-900">Saíram nos últimos 12 meses ({exits.length}{needle ? ` de ${data.exits.length}` : ''})</h2>
        {exits.length === 0 ? (
          <p className="rounded-lg border bg-white p-4 text-sm text-muted-foreground">{needle ? 'Ninguém com esse nome.' : 'Ninguém saiu nos últimos 12 meses.'}</p>
        ) : (
          <Table head={['Aluno', 'Saída', 'Modalidade', 'Plano', 'Motivo']}>
            {exits.map((exit, index) => (
              <tr key={`${exit.name}-${exit.date}-${index}`}>
                <td className="px-3 py-2.5 font-medium text-gray-900">{exit.name}</td>
                <td className="px-3 py-2.5 tabular-nums">{exit.date ? formatDate(exit.date) : '—'}</td>
                <td className="px-3 py-2.5 capitalize">{exit.modality}</td>
                <td className="px-3 py-2.5 text-slate-600">{exit.plan || '—'}</td>
                <td className="px-3 py-2.5 text-slate-600">{exit.reason || 'Sem motivo registrado'}</td>
              </tr>
            ))}
          </Table>
        )}
        {exits.length > 0 && (
          <ul className="divide-y rounded-lg border bg-white sm:hidden">
            {exits.map((exit, index) => (
              <li key={`${exit.name}-${exit.date}-${index}`} className="space-y-1 px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium text-gray-900">{exit.name}</p>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{exit.date ? formatDate(exit.date) : '—'}</span>
                </div>
                <p className="text-xs capitalize text-slate-600">{exit.modality}{exit.plan ? <span className="normal-case"> · {exit.plan}</span> : null}</p>
                <p className="text-xs text-slate-600">{exit.reason || 'Sem motivo registrado'}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function CoachStudents() {
  const panel = useCoachPanel();
  return <PanelState panel={panel}>{data => <Students data={data} />}</PanelState>;
}
