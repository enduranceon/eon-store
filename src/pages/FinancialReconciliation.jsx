import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronUp,
  ListChecks, RefreshCw, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { listFinancialDataQuality } from '@/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePageData } from '@/hooks/usePageData';
import {
  filterFinancialQualityIssues,
  financialQualityTypeMeta,
  financialQualityUnitLabel,
  summarizeFinancialQuality,
} from '@/lib/financial-quality';
import { financialQualityPath, financialQualitySeverityLabel } from '@/lib/financial-ledger';
import { cn, formatCurrency, formatDate } from '@/lib/utils';

const QUALITY_CACHE_KEY = 'financial:reconciliation:v1';
const QUALITY_CACHE_TAGS = [
  'financial_data_quality',
  'financial_movements',
  'asaas_payments',
  'assessment_contracts',
  'event_registrations',
  'presale_orders',
  'stock_orders',
];

const SEVERITY_CLASS = {
  high: 'border-rose-200 bg-rose-50 text-rose-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-blue-200 bg-blue-50 text-blue-700',
};

const METRIC_TONE = {
  red: 'border-rose-200 bg-rose-50 text-rose-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-700',
  blue: 'border-blue-200 bg-blue-50 text-blue-700',
  green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
};

async function loadFinancialReconciliation() {
  return listFinancialDataQuality({ sort: '-occurred_on' });
}

function MetricCard({ icon: Icon, label, value, sub, tone = 'blue' }) {
  return (
    <Card className="border-gray-200">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 truncate text-2xl font-bold text-gray-900">{value}</p>
            {sub && <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>}
          </div>
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border', METRIC_TONE[tone])}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SeverityPill({ severity }) {
  return (
    <span className={cn(
      'inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase',
      SEVERITY_CLASS[severity] || 'border-gray-200 bg-gray-50 text-gray-600',
    )}>
      {financialQualitySeverityLabel(severity)}
    </span>
  );
}

function ReconciliationGroup({ group, expanded, onToggle }) {
  const meta = financialQualityTypeMeta(group.issueType);
  const recordLabel = `${group.count} registro${group.count !== 1 ? 's' : ''}`;

  return (
    <Card className={cn('overflow-hidden border-gray-200', group.severity === 'high' && 'border-rose-200')}>
      <CardContent className="p-0">
        <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityPill severity={group.severity} />
              <span className="text-xs font-medium text-muted-foreground">{financialQualityUnitLabel(group.businessUnit)}</span>
              <span className="text-xs text-muted-foreground">{recordLabel}</span>
            </div>
            <p className="mt-2 truncate text-sm font-semibold text-gray-900">{meta.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{meta.description}</p>
          </div>

          <div className="flex items-center justify-between gap-4 lg:justify-end">
            <div className="min-w-0 text-right">
              <p className="text-[11px] text-muted-foreground">Valor sob revisão</p>
              <p className="mt-0.5 truncate text-sm font-bold text-gray-900">{formatCurrency(group.totalAmount)}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => onToggle(group.key)}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {expanded ? 'Ocultar' : 'Ver registros'}
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="border-t bg-gray-50/70">
            {group.issues.map(issue => (
              <div key={issue.issue_id} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-800">{issue.reference || 'Registro financeiro'}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{issue.message || 'Sem observação adicional.'}</p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>{issue.occurred_on ? `Identificado em ${formatDate(issue.occurred_on)}` : 'Data não informada'}</span>
                    <span>{formatCurrency(issue.amount)}</span>
                  </div>
                </div>
                <Button asChild variant="ghost" size="icon" className="shrink-0" title={meta.actionLabel}>
                  <Link to={financialQualityPath(issue)} aria-label={`${meta.actionLabel}: ${issue.reference || 'registro financeiro'}`}>
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function FinancialReconciliation() {
  const { data: issues, loading, refreshing, refresh } = usePageData({
    key: QUALITY_CACHE_KEY,
    loader: loadFinancialReconciliation,
    initialData: [],
    maxAge: 60_000,
    tags: QUALITY_CACHE_TAGS,
    onError: error => {
      console.error('Erro ao carregar a conciliação financeira:', error);
      toast.error('Não foi possível carregar a conciliação financeira');
    },
  });
  const [filters, setFilters] = useState({
    severity: 'all',
    businessUnit: 'all',
    issueType: 'all',
  });
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  const issueTypes = useMemo(() => (
    [...new Set(issues.map(issue => issue.issue_type).filter(Boolean))]
      .sort((left, right) => financialQualityTypeMeta(left).label.localeCompare(financialQualityTypeMeta(right).label))
  ), [issues]);
  const filteredIssues = useMemo(() => filterFinancialQualityIssues(issues, filters), [issues, filters]);
  const summary = useMemo(() => summarizeFinancialQuality(filteredIssues), [filteredIssues]);
  const filtersActive = Object.values(filters).some(value => value !== 'all');

  const updateFilter = (key, value) => {
    setFilters(current => ({ ...current, [key]: value }));
  };

  const toggleGroup = key => {
    setExpandedGroups(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleRefresh = async () => {
    try {
      await refresh({ force: true });
      toast.success('Conciliação atualizada');
    } catch {
      // The page-level error callback gives the user the actionable feedback.
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <ListChecks className="h-5 w-5 text-blue-600" />
            Conciliação financeira
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Pendências que exigem conferência antes do fechamento financeiro.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/financeiro"><ArrowLeft className="h-4 w-4" /> Financeiro</Link>
          </Button>
          <Button variant="outline" size="icon" title="Atualizar conciliação" onClick={handleRefresh} disabled={loading || refreshing}>
            <RefreshCw className={cn('h-4 w-4', (loading || refreshing) && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={AlertTriangle}
          label="Prioridade alta"
          value={summary.highCount}
          sub={summary.highCount ? 'Exige revisão imediata' : 'Nenhuma pendência crítica'}
          tone={summary.highCount ? 'red' : 'green'}
        />
        <MetricCard
          icon={ListChecks}
          label="Registros na fila"
          value={summary.totalCount}
          sub={`${summary.groupCount} grupo${summary.groupCount !== 1 ? 's' : ''} de trabalho`}
          tone="amber"
        />
        <MetricCard
          icon={Wallet}
          label="Valor sob revisão"
          value={formatCurrency(summary.totalAmount)}
          sub="Soma dos registros filtrados"
          tone="blue"
        />
        <MetricCard
          icon={CheckCircle2}
          label="Sem prioridade alta"
          value={Math.max(0, summary.totalCount - summary.highCount)}
          sub="Registros de prioridade média ou baixa"
          tone="green"
        />
      </div>

      <div className="border-y py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Prioridade
              <Select value={filters.severity} onValueChange={value => updateFilter('severity', value)}>
                <SelectTrigger className="w-full bg-white sm:w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="high">Alta</SelectItem>
                  <SelectItem value="medium">Média</SelectItem>
                  <SelectItem value="low">Baixa</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Área
              <Select value={filters.businessUnit} onValueChange={value => updateFilter('businessUnit', value)}>
                <SelectTrigger className="w-full bg-white sm:w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="assessoria">Assessoria</SelectItem>
                  <SelectItem value="loja">Loja</SelectItem>
                  <SelectItem value="pre_venda">Pré-venda</SelectItem>
                  <SelectItem value="eventos">Eventos</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Tipo de pendência
              <Select value={filters.issueType} onValueChange={value => updateFilter('issueType', value)}>
                <SelectTrigger className="w-full bg-white sm:w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os tipos</SelectItem>
                  {issueTypes.map(issueType => (
                    <SelectItem key={issueType} value={issueType}>{financialQualityTypeMeta(issueType).label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={() => setFilters({ severity: 'all', businessUnit: 'all', issueType: 'all' })}>
              Limpar filtros
            </Button>
          )}
        </div>
      </div>

      <section className="space-y-3" aria-label="Fila de conciliação">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Fila de revisão</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Agrupada por prioridade, área e tipo de ajuste.</p>
          </div>
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{summary.groupCount} grupo{summary.groupCount !== 1 ? 's' : ''}</span>
        </div>

        {loading ? (
          <div className="flex min-h-56 items-center justify-center rounded-lg border border-dashed bg-gray-50">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          </div>
        ) : summary.groups.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed bg-emerald-50 px-6 text-center">
            <CheckCircle2 className="h-6 w-6 text-emerald-600" />
            <p className="mt-2 text-sm font-semibold text-emerald-800">Nenhuma pendência para este filtro.</p>
            <p className="mt-1 text-xs text-emerald-700">A fila de conciliação está em dia.</p>
          </div>
        ) : (
          summary.groups.map(group => (
            <ReconciliationGroup
              key={group.key}
              group={group}
              expanded={expandedGroups.has(group.key)}
              onToggle={toggleGroup}
            />
          ))
        )}
      </section>
    </div>
  );
}
