import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, CheckCircle2, CircleDollarSign, FileWarning,
  ListChecks, RefreshCw, Search, UserMinus, UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AssessmentCoach,
  AssessmentContract,
  AssessmentModality,
  AssessmentPlan,
  PreSaleCustomer,
} from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { cn, formatCurrency, formatDate } from '@/lib/utils';
import {
  AUDIT_TONE_CLASS,
  AUDIT_TYPES,
  buildContractAuditRows,
  currentAuditMonthStart,
  summarizeContractAudit,
} from '@/lib/assessment-contract-audit';

async function loadContractAuditPage() {
  const [contracts, students, coaches, plans, modalities] = await Promise.all([
    AssessmentContract.list('-created_at').catch(() => []),
    PreSaleCustomer.list().catch(() => []),
    AssessmentCoach.list().catch(() => []),
    AssessmentPlan.list().catch(() => []),
    AssessmentModality.list().catch(() => []),
  ]);

  return { contracts, students, coaches, plans, modalities };
}

function mapById(items = []) {
  return Object.fromEntries(items.filter(Boolean).map(item => [item.id, item]));
}

function MetricCard({ icon: Icon, label, value, sub, tone = 'slate' }) {
  const tones = {
    green: 'text-green-700 bg-green-50 border-green-200',
    blue: 'text-blue-700 bg-blue-50 border-blue-200',
    amber: 'text-amber-700 bg-amber-50 border-amber-200',
    red: 'text-red-700 bg-red-50 border-red-200',
    violet: 'text-violet-700 bg-violet-50 border-violet-200',
    slate: 'text-slate-700 bg-slate-50 border-slate-200',
  };

  return (
    <Card className="border-gray-200">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={cn('p-2 rounded-lg border', tones[tone])}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditPill({ type }) {
  const meta = AUDIT_TYPES[type] || AUDIT_TYPES.needs_review;
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold', AUDIT_TONE_CLASS[meta.tone])}>
      {meta.label}
    </span>
  );
}

function SeverityPill({ severity }) {
  const map = {
    ok:     'bg-green-50 text-green-700 border-green-200',
    low:    'bg-slate-50 text-slate-600 border-slate-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    high:   'bg-red-50 text-red-700 border-red-200',
  };
  const label = {
    ok: 'OK',
    low: 'Baixo',
    medium: 'Médio',
    high: 'Alto',
  }[severity] || 'Médio';
  return <span className={cn('text-[10px] font-bold uppercase border rounded-full px-1.5 py-0.5', map[severity] || map.medium)}>{label}</span>;
}

function dateInMonth(dateStr, monthStart) {
  return !!dateStr && dateStr >= monthStart;
}

export default function ContractAudit() {
  const monthStart = currentAuditMonthStart();
  const { data, loading, refreshing, refresh } = usePageData({
    key: 'assessment-contract-audit:v1',
    loader: loadContractAuditPage,
    initialData: { contracts: [], students: [], coaches: [], plans: [], modalities: [] },
    tags: ['assessment_contracts', 'presale_customers', 'assessment_coaches', 'assessment_plans', 'assessment_modalities'],
    onError: error => {
      console.error('Erro na auditoria de contratos:', error);
      toast.error('Erro ao carregar auditoria');
    },
  });

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('problem');
  const [coachFilter, setCoachFilter] = useState('all');

  const rows = useMemo(() => {
    const plansById = mapById(data.plans);
    const studentsById = mapById(data.students);
    const coachesById = mapById(data.coaches);
    const modalitiesById = mapById(data.modalities);
    return buildContractAuditRows(data.contracts, {
      monthStart,
      plansById,
      studentsById,
      coachesById,
      modalitiesById,
    });
  }, [data, monthStart]);

  const summary = useMemo(() => summarizeContractAudit(rows, monthStart), [rows, monthStart]);

  const filtered = rows.filter(row => {
    if (coachFilter !== 'all' && row.coach_id !== coachFilter) return false;
    if (typeFilter === 'problem' && ['active', 'finished', 'renewal', 'voided_sale'].includes(row.audit.type)) return false;
    if (typeFilter === 'month' && !dateInMonth(row.audit.createdLocal, monthStart) && !dateInMonth(row.audit.cancelDate, monthStart)) return false;
    if (typeFilter !== 'all' && typeFilter !== 'problem' && typeFilter !== 'month' && row.audit.type !== typeFilter) return false;

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const haystack = [
        row.contract_number,
        row.student?.full_name,
        row.coach?.name,
        row.plan?.name,
        row.modality?.name,
        row.status,
        row.payment_status,
        row.cancellation_reason,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const visibleSorted = [...filtered].sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2, ok: 3 };
    const sev = (severityOrder[a.audit.severity] ?? 2) - (severityOrder[b.audit.severity] ?? 2);
    if (sev !== 0) return sev;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  const handleRefresh = async () => {
    await refresh({ force: true });
    toast.success('Auditoria atualizada');
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-blue-600" />
            Auditoria de contratos
          </h2>
          <p className="text-sm text-muted-foreground">
            Classificação somente-leitura para separar contrato, venda, cobrança e estorno.
          </p>
        </div>
        <Button variant="outline" onClick={handleRefresh} disabled={refreshing || loading}>
          <RefreshCw className={cn('w-4 h-4 mr-2', (refreshing || loading) && 'animate-spin')} />
          Atualizar
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard icon={CheckCircle2} label="Ativos" value={summary.active} sub={formatCurrency(summary.mrr)} tone="green" />
        <MetricCard icon={UserPlus} label="Entradas reais" value={`+${summary.entries}`} sub={`${summary.renewals} renovações`} tone="blue" />
        <MetricCard icon={UserMinus} label="Saídas possíveis" value={summary.realExits} sub={`${summary.possibleWrongExits} suspeitas`} tone={summary.possibleWrongExits ? 'red' : 'slate'} />
        <MetricCard icon={CircleDollarSign} label="Pendências financeiras" value={summary.activePaymentPending} sub={`${summary.financialAdjustments} ajustes/estornos`} tone="amber" />
        <MetricCard icon={FileWarning} label="Revisar" value={summary.needsReview} sub={`${summary.possibleWrongEntries} entradas suspeitas`} tone={summary.needsReview ? 'red' : 'slate'} />
      </div>

      {(summary.possibleWrongExits > 0 || summary.possibleWrongEntries > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-900">Métricas com risco de interpretação</p>
            <p className="text-xs text-amber-800 mt-0.5">
              {summary.possibleWrongExits} contrato{summary.possibleWrongExits !== 1 ? 's' : ''} cancelado{summary.possibleWrongExits !== 1 ? 's' : ''} pode{summary.possibleWrongExits === 1 ? '' : 'm'} não ser saída real.
              {' '}{summary.possibleWrongEntries} contrato{summary.possibleWrongEntries !== 1 ? 's' : ''} criado{summary.possibleWrongEntries !== 1 ? 's' : ''} neste mês pode{summary.possibleWrongEntries === 1 ? '' : 'm'} não ser entrada real.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="text-base">Contratos auditados</CardTitle>
            <div className="flex flex-wrap gap-2">
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Buscar aluno, contrato, coach..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="problem">Somente atenção</SelectItem>
                  <SelectItem value="month">Movimentos do mês</SelectItem>
                  <SelectItem value="all">Todos</SelectItem>
                  {Object.entries(AUDIT_TYPES).map(([key, meta]) => (
                    <SelectItem key={key} value={key}>{meta.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={coachFilter} onValueChange={setCoachFilter}>
                <SelectTrigger className="w-48"><SelectValue placeholder="Coach" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos coaches</SelectItem>
                  {data.coaches.map(coach => (
                    <SelectItem key={coach.id} value={coach.id}>{coach.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {loading ? (
            <div className="py-16 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : visibleSorted.length === 0 ? (
            <div className="py-14 text-center text-sm text-muted-foreground">
              Nenhum contrato encontrado para o filtro atual.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contrato</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Aluno</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Coach</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Classificação</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Leitura</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Valor</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Datas</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="divide-y bg-white">
                  {visibleSorted.map(row => {
                    const meta = AUDIT_TYPES[row.audit.type] || AUDIT_TYPES.needs_review;
                    const primaryReason = row.audit.warnings[0] || row.audit.reasons[0] || 'Sem observação.';
                    const action = row.audit.actions[0] || meta.metric;
                    return (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 align-top">
                          <p className="font-mono text-xs font-semibold text-blue-700">{row.contract_number || '—'}</p>
                          <div className="flex items-center gap-1.5 mt-1">
                            <SeverityPill severity={row.audit.severity} />
                            <span className="text-[10px] text-muted-foreground">{row.status || 'sem status'} / {row.payment_status || 'sem pagamento'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <p className="font-medium text-gray-900">{row.student?.full_name || '—'}</p>
                          <p className="text-xs text-muted-foreground">{row.modality?.name || row.plan?.name || '—'}</p>
                        </td>
                        <td className="px-4 py-3 align-top text-muted-foreground">{row.coach?.name || '—'}</td>
                        <td className="px-4 py-3 align-top">
                          <AuditPill type={row.audit.type} />
                          <p className="text-[11px] text-muted-foreground mt-1">{meta.metric}</p>
                        </td>
                        <td className="px-4 py-3 align-top min-w-[280px] max-w-[460px]">
                          <p className="text-xs text-gray-700">{primaryReason}</p>
                          <p className="text-[11px] text-muted-foreground mt-1">{action}</p>
                          {row.cancellation_reason && (
                            <p className="text-[11px] text-muted-foreground mt-1 truncate">
                              Motivo: {row.cancellation_reason}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-right">
                          <p className="font-semibold">{formatCurrency(row.value)}</p>
                          <p className="text-[11px] text-muted-foreground">{formatCurrency(row.monthly)}/mês</p>
                        </td>
                        <td className="px-4 py-3 align-top text-right text-xs text-muted-foreground">
                          <p>Criado {formatDate(row.audit.createdLocal)}</p>
                          {row.audit.cancelDate && <p>Cancel. {formatDate(row.audit.cancelDate)}</p>}
                          {row.end_date && <p>Fim {formatDate(row.end_date)}</p>}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <Button variant="ghost" size="sm" asChild>
                            <Link to={`/assessoria/contratos/${row.id}`}>
                              <ArrowRight className="w-4 h-4" />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
