import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Users, Search, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PreSaleCustomer, PreSaleOrder, AssessmentContract, AssessmentPlan } from '@/api/entities';
import { formatCurrency, formatDate, todayLocalStr } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';
import { buildContractLifecycleRows, isContractPaymentOverdue } from '@/lib/assessment-contract-lifecycle';

async function loadCustomersPage() {
  const [customers, orders, contracts, plans] = await Promise.all([
    PreSaleCustomer.list('full_name'),
    PreSaleOrder.list().catch(() => []),
    AssessmentContract.list('-created_at').catch(() => []),
    AssessmentPlan.list().catch(() => []),
  ]);
  return { customers, orders, contracts, plans };
}

export default function Customers() {
  const [searchParams] = useSearchParams();
  const {
    data: { customers, orders, contracts, plans },
    loading,
  } = usePageData({
    key: 'customers:list',
    loader: loadCustomersPage,
    initialData: { customers: [], orders: [], contracts: [], plans: [] },
    tags: ['presale_customers', 'presale_orders', 'assessment_contracts', 'assessment_plans'],
    onError: error => console.error('Erro ao carregar clientes:', error),
  });
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // all | assessment | store-only
  const [cpfFilter,  setCpfFilter]  = useState(() => searchParams.get('filtro') === 'sem-cpf' ? 'no-cpf' : 'all');
  const [sortBy,     setSortBy]     = useState('ltv'); // ltv | name | last-activity
  const navigate  = useNavigate();

  // ── LTV e stats por cliente ───────────────────────────────────────────────
  const plansById = useMemo(() => Object.fromEntries(plans.map(p => [p.id, p])), [plans]);
  const lifecycleRows = useMemo(
    () => buildContractLifecycleRows(contracts, { plansById }),
    [contracts, plansById]
  );
  const today = todayLocalStr();

  // Deriva o status do aluno a partir dos contratos.
  // Inadimplente é cobrança vencida; contrato vencido sem cobrança atrasada segue como ativo operacional.
  const getAssessmentStatus = (clientContracts) => {
    if (clientContracts.length === 0) return 'none';
    const activeContracts = clientContracts.filter(c => c.lifecycle?.counts?.active);
    if (activeContracts.some(c => isContractPaymentOverdue(c, today))) return 'overdue';
    const statuses = activeContracts.map(c => c.status);
    if (statuses.includes('on_leave'))  return 'on_leave';  // Em licença
    if (activeContracts.length > 0)     return 'active';    // Ativo operacional
    return 'inactive';                                      // Todos encerrados
  };

  const getClientData = (customerId) => {
    // Pedidos da loja
    const clientOrders = orders.filter(o =>
      o.customer_id === customerId && o.payment_status !== 'cancelled'
    );
    const storeTotal  = clientOrders.reduce((s, o) => s + (o.total_value || 0), 0);
    const storePaid   = clientOrders.filter(o => o.payment_status === 'paid')
                                    .reduce((s, o) => s + (o.total_value || 0), 0);
    const lastOrder   = [...clientOrders].sort((a, b) =>
      new Date(b.created_date) - new Date(a.created_date)
    )[0];

    // Contratos de assessoria
    const clientContracts = lifecycleRows.filter(c =>
      c.customer_id === customerId &&
      !['pending_sale', 'voided_sale'].includes(c.lifecycle?.type)
    );
    const activeContracts = clientContracts.filter(c => c.lifecycle?.counts?.active);
    // Só conta contratos pagos (LTV real)
    const assessTotal = clientContracts
      .filter(c => c.payment_status === 'paid')
      .reduce((s, c) => s + (Number(c.value) || 0), 0);
    const monthlyRecurring = activeContracts.reduce((s, c) => s + (Number(c.monthly) || 0), 0);

    // Última atividade
    const lastContractDate = clientContracts.length > 0
      ? [...clientContracts].sort((a, b) => b.created_at?.localeCompare(a.created_at))[0]?.created_at?.split('T')[0]
      : null;
    const lastActivity = [lastOrder?.created_date, lastContractDate]
      .filter(Boolean).sort().reverse()[0] || null;

    return {
      storeOrders:      clientOrders.length,
      storeTotal,
      storePaid,
      lastOrder,
      contractsTotal:   clientContracts.length,
      contractsActive:  activeContracts.length,
      assessTotal,
      monthlyRecurring,
      ltv:              storeTotal + assessTotal,
      lastActivity,
      hasAssessment:    clientContracts.length > 0,
      assessmentStatus: getAssessmentStatus(clientContracts),
    };
  };

  // ── Filtros e ordenação ───────────────────────────────────────────────────

  const enriched = customers.map(c => ({ ...c, _data: getClientData(c.id) }));

  const filtered = enriched.filter(c => {
    const q = search.toLowerCase();
    const matchSearch = !q || [c.full_name, c.whatsapp, c.email, c.trainer]
      .some(v => v?.toLowerCase().includes(q));
    const matchCpf  = cpfFilter === 'all' || (cpfFilter === 'no-cpf' && !c.cpf);
    const matchType =
      typeFilter === 'all'          ||
      (typeFilter === 'active'      && c._data.assessmentStatus === 'active')    ||
      (typeFilter === 'overdue'     && c._data.assessmentStatus === 'overdue')   ||
      (typeFilter === 'on_leave'    && c._data.assessmentStatus === 'on_leave')  ||
      (typeFilter === 'assessment'  && c._data.hasAssessment)                    ||
      (typeFilter === 'store-only'  && !c._data.hasAssessment);
    return matchSearch && matchCpf && matchType;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'ltv')           return b._data.ltv - a._data.ltv;
    if (sortBy === 'name')          return a.full_name.localeCompare(b.full_name);
    if (sortBy === 'last-activity') return (b._data.lastActivity || '').localeCompare(a._data.lastActivity || '');
    return 0;
  });

  const noCpfCount       = customers.filter(c => !c.cpf).length;
  const withAssessment   = customers.filter(c =>
    lifecycleRows.some(ct =>
      ct.customer_id === c.id &&
      !['pending_sale', 'voided_sale'].includes(ct.lifecycle?.type)
    )
  ).length;
  const inadimplentes    = enriched.filter(c => c._data.assessmentStatus === 'overdue').length;
  const totalLTV         = enriched.reduce((s, c) => s + c._data.ltv, 0);
  const monthlyRecurring = enriched.reduce((s, c) => s + c._data.monthlyRecurring, 0);

  if (loading) return (
    <div className="p-8 text-center text-muted-foreground">Carregando clientes...</div>
  );

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Clientes</h2>
          <p className="text-sm text-muted-foreground">
            {customers.length} pessoas · {withAssessment} com assessoria
            {inadimplentes > 0 && (
              <button onClick={() => setTypeFilter('overdue')}
                className="ml-2 text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full hover:bg-red-100 transition-colors">
                ⚠️ {inadimplentes} inadimplente{inadimplentes !== 1 ? 's' : ''}
              </button>
            )}
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <div className="bg-white border rounded-xl px-4 py-2 text-center">
            <p className="text-xs text-muted-foreground">LTV total da base</p>
            <p className="text-lg font-bold text-gray-900">{formatCurrency(totalLTV)}</p>
          </div>
          {monthlyRecurring > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-2 text-center">
              <p className="text-xs text-green-700">Recorrência mensal</p>
              <p className="text-lg font-bold text-green-700">{formatCurrency(monthlyRecurring)}</p>
            </div>
          )}
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[220px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, WhatsApp, e-mail..."
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Tipo / Status */}
        <div className="flex flex-wrap gap-1.5">
          {[
            { value: 'all',        label: 'Todos',         cls: 'bg-gray-800 text-white' },
            { value: 'active',     label: '✅ Ativos',      cls: 'bg-green-600 text-white' },
            { value: 'overdue',    label: '⚠️ Inadimplente', cls: 'bg-red-600 text-white' },
            { value: 'on_leave',   label: '🏖️ Em licença',  cls: 'bg-amber-500 text-white' },
            { value: 'assessment', label: '🏃 Assessoria',  cls: 'bg-blue-600 text-white' },
            { value: 'store-only', label: 'Só loja',        cls: 'bg-gray-600 text-white' },
          ].map(opt => (
            <button key={opt.value} onClick={() => setTypeFilter(opt.value)}
              className={cn('px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                typeFilter === opt.value ? opt.cls : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              )}
            >{opt.label}</button>
          ))}
        </div>

        {/* Ordenação */}
        <div className="flex rounded-lg border bg-white overflow-hidden text-sm">
          {[
            { value: 'ltv',           label: '↓ Maior LTV' },
            { value: 'last-activity', label: 'Mais recentes' },
            { value: 'name',          label: 'A→Z' },
          ].map(opt => (
            <button key={opt.value} onClick={() => setSortBy(opt.value)}
              className={cn('px-3 py-1.5 font-medium transition-colors',
                sortBy === opt.value ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'
              )}
            >{opt.label}</button>
          ))}
        </div>

        {/* CPF */}
        {noCpfCount > 0 && (
          <button onClick={() => setCpfFilter(f => f === 'no-cpf' ? 'all' : 'no-cpf')}
            className={cn('flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border transition-all',
              cpfFilter === 'no-cpf' ? 'bg-red-500 text-white border-red-500' : 'text-red-600 border-red-200 hover:bg-red-50'
            )}
          >
            <AlertTriangle className="w-3.5 h-3.5" /> {noCpfCount} sem CPF
          </button>
        )}
      </div>

      {/* Tabela */}
      {sorted.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center py-16 text-center">
          <Users className="w-10 h-10 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">Nenhum cliente encontrado</p>
        </CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contato</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">CPF</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">LTV total</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Loja</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Assessoria</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Última ativ.</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.map(c => {
                const d = c._data;
                return (
                  <tr key={c.id} className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/clientes/${c.id}`)}>

                    <td className="px-4 py-3">
                      <p className="font-semibold">{c.full_name}</p>
                      {c.trainer && <p className="text-xs text-muted-foreground">{c.trainer}</p>}
                    </td>

                    <td className="px-4 py-3 text-xs text-muted-foreground space-y-0.5">
                      {c.whatsapp && <p>{c.whatsapp}</p>}
                      {c.email    && <p className="truncate max-w-[140px]">{c.email}</p>}
                    </td>

                    <td className="px-4 py-3 text-center">
                      {c.cpf
                        ? <span className="text-xs font-mono text-gray-600">{c.cpf}</span>
                        : <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 bg-red-50 px-2 py-0.5 rounded-full">
                            <AlertTriangle className="w-3 h-3" /> ausente
                          </span>
                      }
                    </td>

                    {/* LTV destacado */}
                    <td className="px-4 py-3 text-right">
                      <p className={cn('font-bold', d.ltv > 0 ? 'text-gray-900' : 'text-gray-300')}>
                        {d.ltv > 0 ? formatCurrency(d.ltv) : '—'}
                      </p>
                      {d.monthlyRecurring > 0 && (
                        <p className="text-xs text-green-600">{formatCurrency(d.monthlyRecurring)}/mês</p>
                      )}
                    </td>

                    {/* Loja */}
                    <td className="px-4 py-3 text-right text-xs">
                      {d.storeOrders > 0
                        ? <>
                            <p className="font-medium">{formatCurrency(d.storeTotal)}</p>
                            <p className="text-muted-foreground">{d.storeOrders} pedido{d.storeOrders !== 1 ? 's' : ''}</p>
                          </>
                        : <span className="text-gray-300">—</span>
                      }
                    </td>

                    {/* Assessoria */}
                    <td className="px-4 py-3 text-right text-xs">
                      {d.contractsTotal > 0
                        ? <>
                            <p className="font-medium">{formatCurrency(d.assessTotal)}</p>
                            <p className={cn(d.contractsActive > 0 ? 'text-blue-600 font-semibold' : 'text-muted-foreground')}>
                              {d.contractsActive > 0
                                ? `${d.contractsActive} ativo${d.contractsActive !== 1 ? 's' : ''}`
                                : `${d.contractsTotal} encerrado${d.contractsTotal !== 1 ? 's' : ''}`
                              }
                            </p>
                          </>
                        : <span className="text-gray-300">—</span>
                      }
                    </td>

                    {/* Status do aluno */}
                    <td className="px-4 py-3 text-center">
                      {d.assessmentStatus === 'active'   && <span className="text-xs font-semibold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">✅ Ativo</span>}
                      {d.assessmentStatus === 'overdue'  && <span className="text-xs font-semibold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">⚠️ Inadimplente</span>}
                      {d.assessmentStatus === 'on_leave' && <span className="text-xs font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">🏖️ Em licença</span>}
                      {d.assessmentStatus === 'inactive' && <span className="text-xs font-semibold bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Inativo</span>}
                      {d.assessmentStatus === 'none' && d.storeOrders > 0 && <span className="text-xs bg-gray-50 text-gray-400 px-2 py-0.5 rounded-full border">Só loja</span>}
                      {d.assessmentStatus === 'none' && d.storeOrders === 0 && <span className="text-xs text-gray-300">—</span>}
                    </td>

                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {d.lastActivity ? formatDate(d.lastActivity) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
