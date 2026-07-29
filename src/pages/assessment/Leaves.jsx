import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, CheckCircle2, Clock3, Pause, RotateCcw, Search, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AssessmentCoach,
  AssessmentContract,
  AssessmentLeave,
  AssessmentModality,
  AssessmentPlan,
  PreSaleCustomer,
} from '@/api/entities';
import { finishAssessmentContractLeave } from '@/api/client';
import { usePageData } from '@/hooks/usePageData';
import { cn, formatDate, todayLocalStr } from '@/lib/utils';

async function loadLeavesPage() {
  const [leaves, contracts, students, coaches, plans, modalities] = await Promise.all([
    AssessmentLeave.list('-created_at'),
    AssessmentContract.list('-created_at'),
    PreSaleCustomer.list(),
    AssessmentCoach.list(),
    AssessmentPlan.list(),
    AssessmentModality.list(),
  ]);
  return { leaves, contracts, students, coaches, plans, modalities };
}

function elapsedDays(startDate) {
  if (!startDate) return 0;
  const start = new Date(`${startDate}T12:00:00`);
  const today = new Date(`${todayLocalStr()}T12:00:00`);
  return Math.max(1, Math.floor((today - start) / 86_400_000) + 1);
}

function periodText(leave) {
  if (!leave.end_date) return `${formatDate(leave.start_date)} → sem data definida`;
  return `${formatDate(leave.start_date)} → ${formatDate(leave.end_date)}`;
}

export default function Leaves() {
  const [statusFilter, setStatusFilter] = useState('active');
  const [coachFilter, setCoachFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [finishingId, setFinishingId] = useState(null);
  const { data, loading, refresh } = usePageData({
    key: 'assessment-leaves:center:v1',
    loader: loadLeavesPage,
    initialData: { leaves: [], contracts: [], students: [], coaches: [], plans: [], modalities: [] },
    maxAge: 30_000,
    tags: [
      'assessment_leaves', 'assessment_contracts', 'presale_customers',
      'assessment_coaches', 'assessment_plans', 'assessment_modalities',
    ],
    onError: error => toast.error(`Erro ao carregar licenças: ${error.message}`),
  });

  const rows = useMemo(() => data.leaves.map(leave => {
    const contract = data.contracts.find(item => item.id === leave.contract_id);
    const plan = data.plans.find(item => item.id === contract?.plan_id);
    return {
      ...leave,
      contract,
      student: data.students.find(item => item.id === contract?.customer_id),
      coach: data.coaches.find(item => item.id === contract?.coach_id),
      plan,
      modality: data.modalities.find(item => item.id === plan?.modality_id),
    };
  }), [data]);

  const active = rows.filter(row => row.status === 'active');
  const openEnded = active.filter(row => !row.end_date);
  const filtered = rows.filter(row => {
    if (statusFilter !== 'all' && row.status !== statusFilter) return false;
    if (coachFilter !== 'all' && row.coach?.id !== coachFilter) return false;
    if (!search) return true;
    const query = search.toLowerCase();
    return row.student?.full_name?.toLowerCase().includes(query)
      || row.contract?.contract_number?.toLowerCase().includes(query)
      || row.coach?.name?.toLowerCase().includes(query);
  });

  const finishLeave = async row => {
    const indefinite = !row.end_date;
    const message = indefinite
      ? `Encerrar hoje a licença sem data definida de ${row.student?.full_name || 'este aluno'}? O contrato será prorrogado pelo período efetivo.`
      : `Encerrar a licença de ${row.student?.full_name || 'este aluno'}?`;
    if (!confirm(message)) return;
    setFinishingId(row.id);
    try {
      const result = await finishAssessmentContractLeave(row.contract_id, row.id, row.contract.updated_at);
      toast.success(`Licença encerrada após ${result.leave.days} dia${result.leave.days !== 1 ? 's' : ''}.`);
      await refresh({ force: true });
    } catch (error) {
      toast.error(error.message || 'Não foi possível encerrar a licença');
    } finally {
      setFinishingId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2"><Pause className="w-6 h-6 text-amber-600" /> Licenças</h1>
        <p className="text-sm text-muted-foreground">Controle de contratos pausados e histórico de retornos</p>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-xl bg-amber-100 text-amber-700"><Pause className="w-5 h-5" /></div><div><p className="text-2xl font-bold">{active.length}</p><p className="text-xs text-muted-foreground">licenças ativas</p></div></CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-xl bg-blue-100 text-blue-700"><Clock3 className="w-5 h-5" /></div><div><p className="text-2xl font-bold">{openEnded.length}</p><p className="text-xs text-muted-foreground">sem data definida</p></div></CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-xl bg-green-100 text-green-700"><CheckCircle2 className="w-5 h-5" /></div><div><p className="text-2xl font-bold">{rows.filter(row => row.status === 'finished').length}</p><p className="text-xs text-muted-foreground">licenças encerradas</p></div></CardContent></Card>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Buscar aluno, contrato ou coach..." value={search} onChange={event => setSearch(event.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="active">Licenças ativas</SelectItem><SelectItem value="finished">Histórico encerrado</SelectItem><SelectItem value="all">Todas</SelectItem></SelectContent>
        </Select>
        <Select value={coachFilter} onValueChange={setCoachFilter}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Todos os coaches</SelectItem>{data.coaches.map(coach => <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {loading ? (
        <Card><CardContent className="py-14 text-center text-sm text-muted-foreground">Carregando licenças…</CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-14 text-center"><Pause className="w-9 h-9 text-gray-300 mx-auto mb-3" /><p className="font-medium">Nenhuma licença neste filtro</p><p className="text-xs text-muted-foreground mt-1">Novas licenças são registradas dentro do contrato do aluno.</p></CardContent></Card>
      ) : (
        <div className="grid lg:grid-cols-2 gap-3">
          {filtered.map(row => (
            <Card key={row.id} className={cn(row.status === 'active' && 'border-amber-200')}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div><Link to={`/assessoria/contratos/${row.contract_id}`} className="font-semibold text-blue-700 hover:underline">{row.student?.full_name || 'Aluno não encontrado'}</Link><p className="text-xs text-muted-foreground mt-0.5">{row.contract?.contract_number || '—'} · <span className="capitalize">{row.modality?.name || '—'}</span></p></div>
                  <span className={cn('text-xs font-semibold px-2 py-1 rounded-full', row.status === 'active' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600')}>{row.status === 'active' ? 'Ativa' : 'Encerrada'}</span>
                </div>
                <div className="grid sm:grid-cols-2 gap-2 text-xs">
                  <div className="flex items-center gap-2 text-gray-700"><CalendarDays className="w-4 h-4 text-gray-400" /><span>{periodText(row)}</span></div>
                  <div className="flex items-center gap-2 text-gray-700"><UserCheck className="w-4 h-4 text-gray-400" /><span>{row.coach?.name || 'Sem coach'}</span></div>
                </div>
                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <div><p className="text-xs font-medium">{row.end_date ? `${row.days} dia${row.days !== 1 ? 's' : ''}` : `${elapsedDays(row.start_date)} dia(s) decorridos`}</p>{row.reason && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{row.reason}</p>}</div>
                  {row.status === 'active' && row.contract && <Button size="sm" variant="outline" disabled={finishingId === row.id} onClick={() => finishLeave(row)}><RotateCcw className="w-4 h-4 mr-1.5" />{finishingId === row.id ? 'Encerrando…' : 'Encerrar licença'}</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
