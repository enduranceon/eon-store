import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Activity, RefreshCw, CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronRight, Database } from 'lucide-react';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

// ─── Definição dos checks ──────────────────────────────────────────────
// Cada check tem:
//   id        — identificador único
//   title     — nome legível
//   description — o que está verificando
//   severity  — 'critical' | 'high' | 'medium' | 'info'
//   query     — função async que retorna { count, rows, ok }
//                 ok = count === 0 (problema NÃO existe)
//                 rows = primeiras N linhas pra detalhar

const CHECKS = [
  // ─── Críticos ───────────────────────────────────────────────────────
  {
    id: 'orfas_asaas_payments',
    title: 'Parcelas órfãs em asaas_payments',
    description: 'Linhas sem order_id vinculado. Não aparecem no fluxo de caixa, mas indicam falha de sincronização.',
    severity: 'critical',
    query: async () => {
      const { data, error } = await supabase
        .from('asaas_payments')
        .select('asaas_payment_id, source, status, value, external_reference, created_at')
        .is('order_id', null)
        .limit(20);
      if (error) throw error;
      return { count: data.length, rows: data, ok: data.length === 0 };
    },
  },
  {
    id: 'fantasmas_em_cancelados',
    title: 'Parcelas ativas em pedidos cancelados',
    description: 'Linhas RECEIVED/CONFIRMED em pedidos/contratos cancelled/refunded — inflam o fluxo de caixa.',
    severity: 'critical',
    query: async () => {
      // Faz 3 queries em paralelo (uma por tipo) e agrega
      const types = [
        { table: 'presale_orders', type: 'presale' },
        { table: 'stock_orders', type: 'stock' },
        { table: 'assessment_contracts', type: 'contract' },
      ];
      let totalRows = [];
      for (const { table, type } of types) {
        const { data: cancelled } = await supabase
          .from(table)
          .select('id, order_number, contract_number')
          .in('payment_status', ['cancelled', 'refunded']);
        if (!cancelled?.length) continue;
        const ids = cancelled.map(c => c.id);
        const { data: ap } = await supabase
          .from('asaas_payments')
          .select('asaas_payment_id, order_id, status, value, credit_date')
          .in('order_id', ids)
          .eq('order_type', type)
          .in('status', ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])
          .limit(20);
        for (const row of (ap || [])) {
          const parent = cancelled.find(c => c.id === row.order_id);
          totalRows.push({
            ...row,
            order_number: parent?.order_number || parent?.contract_number,
            order_type: type,
          });
        }
      }
      return { count: totalRows.length, rows: totalRows, ok: totalRows.length === 0 };
    },
  },
  {
    id: 'contratos_cancelados_com_charge',
    title: 'Contratos cancelados com cobrança Asaas ativa',
    description: 'Contratos cancelled mas asaas_charge_id ainda preenchido. Cliente pode pagar e bagunçar.',
    severity: 'critical',
    query: async () => {
      const { data, error } = await supabase
        .from('assessment_contracts')
        .select('contract_number, status, payment_status, asaas_charge_id, cancellation_date')
        .or('status.eq.cancelled,payment_status.eq.cancelled')
        .not('asaas_charge_id', 'is', null)
        .limit(20);
      if (error) throw error;
      return { count: data.length, rows: data, ok: data.length === 0 };
    },
  },
  // ─── Altos ──────────────────────────────────────────────────────────
  {
    id: 'pagos_sem_cache',
    title: 'Pedidos pagos sem cache em asaas_payments',
    description: 'payment_status=paid mas sem entrada em asaas_payments. Fluxo de caixa subestimado.',
    severity: 'high',
    query: async () => {
      const types = [
        { table: 'presale_orders', type: 'presale', numberField: 'order_number' },
        { table: 'stock_orders', type: 'stock', numberField: 'order_number' },
        { table: 'assessment_contracts', type: 'contract', numberField: 'contract_number' },
      ];
      let totalRows = [];
      for (const { table, type, numberField } of types) {
        const { data: paid } = await supabase
          .from(table)
          .select(`id, ${numberField}, payment_method, payment_date, manual_payment, total_value`)
          .eq('payment_status', 'paid')
          .limit(200);
        if (!paid?.length) continue;
        const ids = paid.map(p => p.id);
        const { data: existing } = await supabase
          .from('asaas_payments')
          .select('order_id')
          .in('order_id', ids)
          .eq('order_type', type)
          .in('status', ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);
        const withCache = new Set((existing || []).map(e => e.order_id));
        for (const p of paid) {
          if (!withCache.has(p.id)) {
            totalRows.push({
              order_number: p[numberField],
              order_type: type,
              payment_method: p.payment_method,
              payment_date: p.payment_date,
              manual: p.manual_payment,
              total_value: p.total_value,
            });
          }
        }
      }
      return { count: totalRows.length, rows: totalRows.slice(0, 20), ok: totalRows.length === 0 };
    },
  },
  {
    id: 'pagos_sem_data',
    title: 'Pedidos pagos sem data de pagamento',
    description: 'payment_status=paid mas payment_date é NULL. Relatórios por data ficam furados.',
    severity: 'high',
    query: async () => {
      const types = [
        { table: 'presale_orders', type: 'presale', numberField: 'order_number' },
        { table: 'stock_orders', type: 'stock', numberField: 'order_number' },
        { table: 'assessment_contracts', type: 'contract', numberField: 'contract_number' },
      ];
      let totalRows = [];
      for (const { table, type, numberField } of types) {
        const { data } = await supabase
          .from(table)
          .select(`id, ${numberField}, payment_method, payment_status`)
          .eq('payment_status', 'paid')
          .is('payment_date', null)
          .limit(20);
        for (const row of (data || [])) {
          totalRows.push({ order_number: row[numberField], order_type: type, payment_method: row.payment_method });
        }
      }
      return { count: totalRows.length, rows: totalRows, ok: totalRows.length === 0 };
    },
  },
  {
    id: 'pagos_sem_metodo',
    title: 'Pedidos pagos sem forma de pagamento',
    description: 'payment_status=paid mas payment_method é NULL. Impossibilita reconciliação.',
    severity: 'high',
    query: async () => {
      const types = [
        { table: 'presale_orders', type: 'presale', numberField: 'order_number' },
        { table: 'stock_orders', type: 'stock', numberField: 'order_number' },
        { table: 'assessment_contracts', type: 'contract', numberField: 'contract_number' },
      ];
      let totalRows = [];
      for (const { table, type, numberField } of types) {
        const { data } = await supabase
          .from(table)
          .select(`id, ${numberField}, payment_date`)
          .eq('payment_status', 'paid')
          .is('payment_method', null)
          .limit(20);
        for (const row of (data || [])) {
          totalRows.push({ order_number: row[numberField], order_type: type, payment_date: row.payment_date });
        }
      }
      return { count: totalRows.length, rows: totalRows, ok: totalRows.length === 0 };
    },
  },
  // ─── Médios / informativos ───────────────────────────────────────────
  {
    id: 'pedidos_pendentes_overdue',
    title: 'Pedidos vencidos sem cobrança',
    description: 'Status overdue mas sem asaas_charge_id. Cobrança parou no meio do caminho.',
    severity: 'medium',
    query: async () => {
      const { data: pre } = await supabase
        .from('presale_orders').select('order_number, payment_status').eq('payment_status', 'overdue').is('asaas_charge_id', null).limit(20);
      const { data: stk } = await supabase
        .from('stock_orders').select('order_number, payment_status').eq('payment_status', 'overdue').is('asaas_charge_id', null).limit(20);
      const rows = [
        ...(pre || []).map(r => ({ ...r, order_type: 'presale' })),
        ...(stk || []).map(r => ({ ...r, order_type: 'stock' })),
      ];
      return { count: rows.length, rows, ok: rows.length === 0 };
    },
  },
  {
    id: 'metodo_pagamento_invalido',
    title: 'Pedidos com método de pagamento desconhecido',
    description: 'payment_method que não bate com nenhum internal_code de payment_methods nem com códigos legacy.',
    severity: 'medium',
    query: async () => {
      const LEGACY_CODES = new Set([
        'pix_boleto', 'pix', 'boleto', 'credit_card',
        'card_1x', 'card_2x', 'card_3x', 'card_4x', 'card_5x', 'card_6x',
        'card_7x', 'card_8x', 'card_9x', 'card_10x', 'card_11x', 'card_12x',
        'pix_manual', 'cash', 'card_machine', 'bank_transfer',
      ]);
      const { data: methods } = await supabase.from('payment_methods').select('internal_code');
      const validCodes = new Set([...(methods || []).map(m => m.internal_code), ...LEGACY_CODES]);

      const types = [
        { table: 'presale_orders', numberField: 'order_number', type: 'presale' },
        { table: 'stock_orders', numberField: 'order_number', type: 'stock' },
        { table: 'assessment_contracts', numberField: 'contract_number', type: 'contract' },
      ];
      let totalRows = [];
      for (const { table, numberField, type } of types) {
        const { data } = await supabase
          .from(table)
          .select(`${numberField}, payment_method`)
          .not('payment_method', 'is', null)
          .limit(500);
        for (const row of (data || [])) {
          if (!validCodes.has(row.payment_method)) {
            totalRows.push({ order_number: row[numberField], order_type: type, payment_method: row.payment_method });
          }
        }
      }
      return { count: totalRows.length, rows: totalRows.slice(0, 20), ok: totalRows.length === 0 };
    },
  },
  {
    id: 'closings_aprovados_sem_itens',
    title: 'Fechamentos aprovados sem itens',
    description: 'payout_monthly_closings com status=approved mas zero items. Possível corrupção.',
    severity: 'medium',
    query: async () => {
      const { data: closings } = await supabase
        .from('payout_monthly_closings')
        .select('id, competence, status')
        .in('status', ['approved', 'paid']);
      if (!closings?.length) return { count: 0, rows: [], ok: true };
      let totalRows = [];
      for (const c of closings) {
        const { count } = await supabase
          .from('payout_monthly_statement_items')
          .select('*', { count: 'exact', head: true })
          .eq('closing_id', c.id);
        if (count === 0) {
          totalRows.push({ competence: c.competence, status: c.status });
        }
      }
      return { count: totalRows.length, rows: totalRows, ok: totalRows.length === 0 };
    },
  },
];

const SEVERITY_CONFIG = {
  critical: { label: 'Crítico',   color: 'text-red-700',    bg: 'bg-red-50',    border: 'border-red-200',    icon: XCircle },
  high:     { label: 'Alto',      color: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-200', icon: AlertTriangle },
  medium:   { label: 'Médio',     color: 'text-amber-700',  bg: 'bg-amber-50',  border: 'border-amber-200',  icon: AlertTriangle },
  info:     { label: 'Informativo', color: 'text-blue-700', bg: 'bg-blue-50',   border: 'border-blue-200',   icon: Activity },
};

export default function HealthCheck() {
  const [results, setResults] = useState({}); // { [check.id]: { count, rows, ok, error, loading } }
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [lastRun, setLastRun] = useState(null);

  const runAllChecks = useCallback(async () => {
    setRunning(true);
    const initial = Object.fromEntries(CHECKS.map(c => [c.id, { loading: true }]));
    setResults(initial);
    for (const check of CHECKS) {
      try {
        const result = await check.query();
        setResults(prev => ({ ...prev, [check.id]: { ...result, loading: false } }));
      } catch (e) {
        setResults(prev => ({ ...prev, [check.id]: { error: e.message, loading: false, ok: false, count: -1, rows: [] } }));
      }
    }
    setLastRun(new Date());
    setRunning(false);
  }, []);

  useEffect(() => {
    runAllChecks();
  }, [runAllChecks]);

  const toggle = id => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  // Resumo
  const totalChecks = CHECKS.length;
  const ranChecks = Object.values(results).filter(r => !r.loading);
  const failedChecks = ranChecks.filter(r => !r.ok && !r.error);
  const errored = ranChecks.filter(r => r.error);
  const criticalIssues = CHECKS.filter(c => c.severity === 'critical' && results[c.id] && !results[c.id].ok).length;
  const highIssues = CHECKS.filter(c => c.severity === 'high' && results[c.id] && !results[c.id].ok).length;
  const mediumIssues = CHECKS.filter(c => c.severity === 'medium' && results[c.id] && !results[c.id].ok).length;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
            <Activity className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Saúde do sistema</h2>
            <p className="text-sm text-muted-foreground">
              Detecta inconsistências em dados, fluxos quebrados e dados órfãos
              {lastRun && ` · Última verificação: ${lastRun.toLocaleString('pt-BR')}`}
            </p>
          </div>
        </div>
        <Button onClick={runAllChecks} disabled={running}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${running ? 'animate-spin' : ''}`} />
          {running ? 'Verificando...' : 'Verificar agora'}
        </Button>
      </div>

      {/* Resumo geral */}
      {ranChecks.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white border rounded-xl p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Checks rodados</p>
            <p className="text-2xl font-bold mt-0.5">{ranChecks.length}/{totalChecks}</p>
          </div>
          <div className={`border rounded-xl p-3 ${criticalIssues > 0 ? 'bg-red-50 border-red-200' : 'bg-white'}`}>
            <p className={`text-xs uppercase tracking-wide ${criticalIssues > 0 ? 'text-red-700' : 'text-muted-foreground'}`}>Críticos</p>
            <p className={`text-2xl font-bold mt-0.5 ${criticalIssues > 0 ? 'text-red-700' : 'text-gray-400'}`}>{criticalIssues}</p>
          </div>
          <div className={`border rounded-xl p-3 ${highIssues > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white'}`}>
            <p className={`text-xs uppercase tracking-wide ${highIssues > 0 ? 'text-orange-700' : 'text-muted-foreground'}`}>Altos</p>
            <p className={`text-2xl font-bold mt-0.5 ${highIssues > 0 ? 'text-orange-700' : 'text-gray-400'}`}>{highIssues}</p>
          </div>
          <div className={`border rounded-xl p-3 ${mediumIssues > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white'}`}>
            <p className={`text-xs uppercase tracking-wide ${mediumIssues > 0 ? 'text-amber-700' : 'text-muted-foreground'}`}>Médios</p>
            <p className={`text-2xl font-bold mt-0.5 ${mediumIssues > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{mediumIssues}</p>
          </div>
        </div>
      )}

      {/* Banner verde se tudo OK */}
      {ranChecks.length === totalChecks && failedChecks.length === 0 && errored.length === 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
          <div>
            <p className="font-semibold text-emerald-900">Tudo certo! 🎉</p>
            <p className="text-sm text-emerald-700">Nenhuma inconsistência detectada.</p>
          </div>
        </div>
      )}

      {/* Lista de checks */}
      <div className="space-y-2">
        {CHECKS.map(check => {
          // Antes do useEffect rodar, results ainda está {} — trata como "carregando"
          // pra não acessar result.count de undefined (quebrava a tela inteira).
          const result = results[check.id] || { loading: true };
          const isOpen = expanded.has(check.id);
          const sev = SEVERITY_CONFIG[check.severity];
          const SevIcon = sev.icon;
          const loading = result?.loading;
          const errorState = result?.error;
          const ok = result?.ok;

          // Cor do card
          let cardClasses = 'border';
          if (loading) cardClasses += ' border-gray-200 bg-gray-50';
          else if (errorState) cardClasses += ' border-purple-200 bg-purple-50';
          else if (ok) cardClasses += ' border-emerald-200 bg-emerald-50/30';
          else cardClasses += ` ${sev.border} ${sev.bg}`;

          return (
            <div key={check.id} className={`rounded-xl overflow-hidden transition-colors ${cardClasses}`}>
              <button
                type="button"
                onClick={() => result?.count > 0 && toggle(check.id)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left"
                disabled={!result || result.count === 0}
              >
                {/* Status icon */}
                <div className="shrink-0">
                  {loading ? (
                    <RefreshCw className="w-5 h-5 text-gray-400 animate-spin" />
                  ) : errorState ? (
                    <XCircle className="w-5 h-5 text-purple-600" />
                  ) : ok ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <SevIcon className={`w-5 h-5 ${sev.color}`} />
                  )}
                </div>

                {/* Title + desc */}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm flex items-center gap-2">
                    {check.title}
                    <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${sev.bg} ${sev.color}`}>
                      {sev.label}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{check.description}</p>
                </div>

                {/* Contagem + chevron */}
                <div className="shrink-0 flex items-center gap-2">
                  {loading ? (
                    <span className="text-xs text-muted-foreground">verificando...</span>
                  ) : errorState ? (
                    <span className="text-xs text-purple-700 font-mono truncate max-w-[200px]">{errorState}</span>
                  ) : (
                    <>
                      <span className={`text-sm font-bold ${ok ? 'text-emerald-700' : sev.color}`}>
                        {result.count} {ok ? 'ok' : (result.count === 1 ? 'problema' : 'problemas')}
                      </span>
                      {result.count > 0 && (
                        isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      )}
                    </>
                  )}
                </div>
              </button>

              {/* Detalhes expandidos */}
              {isOpen && result?.rows?.length > 0 && (
                <div className="border-t bg-white px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    Mostrando {result.rows.length} de {result.count} {result.count === 1 ? 'linha' : 'linhas'}:
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          {Object.keys(result.rows[0]).map(k => (
                            <th key={k} className="px-2 py-1 font-medium uppercase tracking-wide text-[10px]">{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {result.rows.map((row, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            {Object.entries(row).map(([k, v]) => (
                              <td key={k} className="px-2 py-1 font-mono text-[11px]">
                                {v === null || v === undefined ? <span className="text-gray-300">—</span>
                                  : typeof v === 'boolean' ? (v ? 'sim' : 'não')
                                  : k.includes('value') || k.includes('total') ? formatCurrency(Number(v) || 0)
                                  : k.includes('date') && typeof v === 'string' && v.length >= 10 ? formatDate(v)
                                  : String(v)
                                }
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer info */}
      <Card className="bg-gray-50">
        <CardContent className="py-3 px-4 text-xs text-muted-foreground flex items-start gap-2">
          <Database className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p><strong>Como usar:</strong> Esta página roda {CHECKS.length} verificações no banco a cada carregamento ou clique em "Verificar agora".
            Clique numa linha vermelha/laranja pra ver os registros problemáticos.</p>
            <p className="mt-1">Se um check der erro (ícone roxo), provavelmente é falha de permissão ou conexão.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
