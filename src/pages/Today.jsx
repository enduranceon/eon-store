import { Link } from 'react-router-dom';
import {
  MessageCircle, RefreshCw, Package, Wallet,
  Undo2, ChevronRight, Sparkles, RotateCcw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/api/db';
import { formatCurrency } from '@/lib/utils';
import { listCommunicationCases } from '@/api/client';
import { Button } from '@/components/ui/button';
import { usePageData } from '@/hooks/usePageData';
import { fulfillmentStatus } from '@/lib/order-fulfillment';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function daysSince(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

// ─────────────────────────────────────────────────────────────────
// SUB-COMPONENTES
// ─────────────────────────────────────────────────────────────────
function TypeBadge({ type }) {
  if (type === 'stock')    return <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Loja</span>;
  if (type === 'contract') return <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Assessoria</span>;
  if (type === 'event')    return <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">Eventos</span>;
  return null;
}

function ItemRow({ item, badge, badgeColor }) {
  const link = item.type === 'stock'    ? `/estoque/pedidos/${item.id}`
             : item.type === 'contract' ? `/assessoria/contratos/${item.id}`
             : item.type === 'event'    ? `/eventos/${item.event_id}`
             : `/pedidos/${item.id}`;
  return (
    <Link to={link} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-blue-700">{item.order_number}</span>
          <TypeBadge type={item.type} />
        </div>
        <p className="text-xs text-muted-foreground truncate">{item.customer}</p>
      </div>
      {badge && (
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${badgeColor}`}>
          {badge}
        </span>
      )}
      <span className="font-semibold text-sm">{formatCurrency(item.total_value)}</span>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

function ReturnItem({ ret }) {
  return (
    <Link to={`/devolucoes?status=${ret.status}`} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-blue-700">{ret.order_number}</span>
          {ret.order_type === 'stock' && <TypeBadge type="stock" />}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {ret.product_name}{ret.variation ? ` — ${ret.variation}` : ''} · {ret.customer_name}
        </p>
      </div>
      <span className="font-semibold text-sm">{formatCurrency(ret.refund_value)}</span>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

function Section({ title, subtitle, icon: Icon, iconColor, count, total, borderColor, children }) {
  if (count === 0) return null;
  return (
    <Card className={borderColor || ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className={`text-base flex items-center gap-2 ${iconColor || 'text-gray-800'}`}>
              <Icon className="w-4 h-4 shrink-0" />
              <span>{title}</span>
              <span className="text-sm font-normal text-muted-foreground">({count})</span>
            </CardTitle>
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {total > 0 && (
            <span className="text-sm font-bold text-gray-700 whitespace-nowrap">{formatCurrency(total)}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="divide-y">{children}</div>
      </CardContent>
    </Card>
  );
}

async function loadTodayPage() {
  const [presaleRes, stockRes, pendingReturnsRes, receivedReturnsRes, refundsRes, renewalChargesRes, contacts] = await Promise.all([
    supabase.from('presale_orders')
      .select('id, order_number, checkout_name, total_value, payment_status, delivery_status, payment_date, created_date', { count: 'exact' })
      .eq('payment_status', 'paid')
      .not('delivery_status', 'in', '("delivered","cancelled")')
      .order('created_date', { ascending: true }).range(0, 19),
    supabase.from('stock_orders')
      .select('id, order_number, customer_name, total_value, payment_status, delivery_status, payment_date, created_date', { count: 'exact' })
      .eq('payment_status', 'paid')
      .not('delivery_status', 'in', '("delivered","cancelled")')
      .order('created_date', { ascending: true }).range(0, 19),
    supabase.from('order_returns')
      .select('id, order_id, order_type, order_number, customer_name, product_name, variation, refund_value, status, created_at', { count: 'exact' })
      .eq('status', 'pending_return').order('created_at', { ascending: true }).range(0, 19),
    supabase.from('order_returns')
      .select('id, order_id, order_type, order_number, customer_name, product_name, variation, refund_value, status, created_at', { count: 'exact' })
      .eq('status', 'received').order('created_at', { ascending: true }).range(0, 19),
    supabase.from('assessment_contracts')
      .select('id, contract_number, customer_id, refund_amount, refund_status, updated_at', { count: 'exact' })
      .eq('refund_status', 'pending').order('updated_at', { ascending: true }).range(0, 19),
    supabase.from('assessment_contracts')
      .select('id, contract_number, renewal_stage_updated_at', { count: 'exact' })
      .not('parent_contract_id', 'is', null)
      .eq('renewal_stage', 'charge_pending')
      .order('renewal_stage_updated_at', { ascending: true }).range(0, 19),
    listCommunicationCases({ state: 'to_do', limit: 20 }),
  ]);

  for (const result of [presaleRes, stockRes, pendingReturnsRes, receivedReturnsRes, refundsRes, renewalChargesRes]) {
    if (result.error || result.count == null) throw new Error('Não foi possível conferir todas as pendências. Tente atualizar a tela.');
  }
  if (!contacts || (contacts.rollout?.enabled !== false &&
      (!Array.isArray(contacts.items) || !contacts.counts))) {
    throw new Error('Não foi possível conferir os acompanhamentos. Tente atualizar a tela.');
  }

  const deliveries = [
    ...(presaleRes.data || []).map(order => ({ ...order, type: 'presale', customer: order.checkout_name })),
    ...(stockRes.data || []).map(order => ({ ...order, type: 'stock', customer: order.customer_name })),
  ].sort((a, b) => (a.created_date || '').localeCompare(b.created_date || '')).slice(0, 20);

  let pendingRefunds = [];
  if (refundsRes.data?.length) {
    const customerIds = [...new Set(refundsRes.data.map(r => r.customer_id).filter(Boolean))];
    const { data: refundCustomers, error: refundError } = await supabase
      .from('presale_customers')
      .select('id, full_name')
      .in('id', customerIds);
    if (refundError) throw new Error('Não foi possível conferir as pessoas dos estornos.');
    const refundCustomerMap = Object.fromEntries((refundCustomers || []).map(c => [c.id, c]));
    pendingRefunds = refundsRes.data.map(r => ({
      ...r,
      customer_name: refundCustomerMap[r.customer_id]?.full_name || '—',
    }));
  }

  return {
    contacts,
    deliveries,
    pendingReturns: pendingReturnsRes.data || [],
    receivedReturns: receivedReturnsRes.data || [],
    pendingRefunds,
    renewalCharges: renewalChargesRes.data || [],
    counts: {
      deliveries: presaleRes.count + stockRes.count,
      pendingReturns: pendingReturnsRes.count,
      receivedReturns: receivedReturnsRes.count,
      pendingRefunds: refundsRes.count,
      renewalCharges: renewalChargesRes.count,
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────────────────────
export default function Today() {
  const {
    data: { deliveries, pendingReturns, receivedReturns, pendingRefunds, renewalCharges, contacts, counts },
    loading, refreshing, refresh, error,
  } = usePageData({
    key: 'today:operational-v3',
    forceOnMount: true,
    loader: loadTodayPage,
    initialData: {
      deliveries: [], pendingReturns: [], receivedReturns: [], pendingRefunds: [], renewalCharges: [],
      contacts: { items: [], counts: {} },
      counts: { deliveries: 0, pendingReturns: 0, receivedReturns: 0, pendingRefunds: 0, renewalCharges: 0 },
    },
    tags: [
      'communication_cases',
      'communication_case_events',
      'presale_orders',
      'stock_orders',
      'assessment_contracts',
      'presale_customers',
      'order_returns',
    ],
    onError: error => console.error('Erro ao carregar Hoje:', error),
  });

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center space-y-2">
        <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-sm text-muted-foreground">Carregando...</p>
      </div>
    </div>
  );

  if (error) return (
    <div role="alert" className="mx-auto max-w-5xl rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-900">
      <h1 className="text-lg font-semibold">Não foi possível conferir as pendências</h1>
      <p className="my-3 text-sm">{error.message} As contagens ficam ocultas até a consulta ser concluída.</p>
      <Button variant="outline" disabled={refreshing} onClick={() => refresh({ force: true }).catch(() => {})}>Tentar novamente</Button>
    </div>
  );
  const contactItems = contacts.items || [];
  const contactsPreparing = contacts.rollout?.enabled === false;
  const contactCount = Number(contacts.counts?.to_do ?? contactItems.length);
  const sum       = arr => arr.reduce((s, x) => s + Number(x.total_value || 0), 0);
  const sumRefund = arr => arr.reduce((s, x) => s + Number(x.refund_value || 0), 0);
  const sumAmount = arr => arr.reduce((s, x) => s + Number(x.refund_amount || 0), 0);

  const totalActions =
    (contactsPreparing ? 0 : contactCount) +
    counts.deliveries + counts.pendingReturns +
    counts.receivedReturns + counts.pendingRefunds + counts.renewalCharges;

  return (
    <div className="space-y-5 max-w-5xl mx-auto">

      {/* Cabeçalho */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold text-gray-900">Hoje · {greeting()}</h1><Button variant="outline" disabled={refreshing} onClick={() => refresh({ force: true }).catch(() => {})}><RefreshCw aria-hidden="true" className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Atualizar</Button></div>
        <p className="text-sm text-muted-foreground mt-1">
          {contactsPreparing
            ? `${totalActions} pendência${totalActions !== 1 ? 's' : ''} de cobranças de renovação, entregas, devoluções e estornos. Os acompanhamentos estão em preparação.`
            : totalActions === 0
            ? 'Nenhuma ação prevista para agora.'
            : `Você tem ${totalActions} ${totalActions === 1 ? 'ação' : 'ações'} para revisar hoje`}
        </p>
      </div>

      {contactsPreparing && (
        <div role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
          <p className="font-semibold">Acompanhamentos em preparação</p>
          <p className="mt-1">A fila de contatos ainda está sendo organizada. Cobranças de renovação, entregas, devoluções e estornos seguem abaixo.</p>
        </div>
      )}

      {totalActions === 0 && !contactsPreparing ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Sparkles className="w-12 h-12 text-green-400 mb-3" />
            <p className="text-lg font-semibold text-gray-700">Caixa de entrada vazia!</p>
            <p className="text-sm text-muted-foreground mt-1">Retornos futuros e contatos agendados continuam na Comunicação.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {!contactsPreparing && <Section title="Contatos e pendências de atendimento" subtitle="A mesma fila da Comunicação, incluindo casos que precisam de revisão antes do contato." icon={MessageCircle} iconColor="text-blue-700" count={contactCount} total={0}>
            {contactItems.map(item => (
              <Link key={item.id || item.case_id} to={`/comunicacao?state=to_do&case=${encodeURIComponent(item.id || item.case_id)}`} className="flex min-h-16 items-center gap-3 rounded-lg px-3 py-3 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{item.person_name || item.customer_name || 'Pessoa não identificada'}</p>
                  <p className="text-xs text-slate-600">{item.reference || item.source_reference || 'Atendimento'}</p>
                  {item.blocked_reason && <p className="mt-1 text-xs font-medium text-amber-800">Revisar pendência antes de enviar</p>}
                </div>
                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
              </Link>
            ))}
            <Link to="/comunicacao?state=to_do" className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-blue-700">{contactCount > contactItems.length ? `Ver todas as ${contactCount} ações` : 'Abrir fila de contatos'}</Link>
          </Section>}

          <Section title="Enviar cobrança de renovação" subtitle="Renovações aprovadas que aguardam o registro da cobrança no quadro." icon={Wallet} iconColor="text-amber-800" count={counts.renewalCharges} total={0}>
            {renewalCharges.map(contract => (
              <Link key={contract.id} to={`/assessoria/contratos/${contract.id}`} className="flex min-h-16 items-center gap-3 rounded-lg px-3 py-3 hover:bg-amber-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{contract.contract_number || 'Renovação'}</p>
                  <p className="text-xs text-slate-600">Abrir contrato e registrar a cobrança</p>
                </div>
                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
              </Link>
            ))}
            <Link to="/assessoria/renovacoes" className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-blue-700">{counts.renewalCharges > renewalCharges.length ? `Ver todas as ${counts.renewalCharges} renovações no quadro` : 'Abrir quadro de renovações'}</Link>
          </Section>

          {/* ── 2. Estornos pendentes ───────────────────────────────── */}
          {counts.pendingRefunds > 0 && (
            <Card className="border-orange-200">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2 text-orange-700">
                      <RotateCcw className="w-4 h-4" />
                      Estornos pendentes
                      <span className="text-sm font-normal text-muted-foreground">({counts.pendingRefunds})</span>
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">Contratos cancelados aguardando devolução ao aluno</p>
                  </div>
                  {counts.pendingRefunds === pendingRefunds.length && <span className="text-sm font-bold text-orange-700">{formatCurrency(sumAmount(pendingRefunds))}</span>}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="divide-y">
                  {pendingRefunds.map(r => {
                    const dias = daysSince(r.updated_at);
                    return (
                      <Link key={r.id} to={`/assessoria/contratos/${r.id}`}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-orange-50 transition-colors group">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-semibold text-blue-700">{r.contract_number}</span>
                            <TypeBadge type="contract" />
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{r.customer_name}</p>
                        </div>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${dias > 7 ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>
                          há {dias}d
                        </span>
                        <span className="font-semibold text-sm">{formatCurrency(r.refund_amount)}</span>
                        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </Link>
                    );
                  })}
                  {counts.pendingRefunds > pendingRefunds.length && (
                    <Link to="/estornos" className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-blue-700">Ver todos os {counts.pendingRefunds} estornos</Link>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── 7. Pagos aguardando entrega (store) ────────────────── */}
          <Section
            title="Pagos — pendentes de entrega"
            subtitle="Pedidos da loja pagos que precisam ser processados"
            icon={Package} iconColor="text-purple-600"
            count={counts.deliveries} total={counts.deliveries === deliveries.length ? sum(deliveries) : 0}
          >
            {deliveries.map(o => (
              <ItemRow key={o.id + o.type} item={o}
                badge={fulfillmentStatus(o.type, o.delivery_status).label}
                badgeColor="bg-purple-100 text-purple-700" />
            ))}
            {counts.deliveries > deliveries.length && <Link to="/pedidos" className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-blue-700">Ver todos os {counts.deliveries} pedidos pendentes de entrega</Link>}
          </Section>

          {/* ── 8. Devoluções ──────────────────────────────────────── */}
          <Section
            title="Devoluções aguardando recebimento"
            subtitle="Cliente vai devolver — marque quando chegar"
            icon={Undo2} iconColor="text-slate-600"
            count={counts.pendingReturns} total={counts.pendingReturns === pendingReturns.length ? sumRefund(pendingReturns) : 0}
          >
            {pendingReturns.map(r => <ReturnItem key={r.id} ret={r} />)}
            {counts.pendingReturns > pendingReturns.length && <Link to="/devolucoes?status=pending_return" className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-blue-700">Ver todas as {counts.pendingReturns} devoluções pendentes</Link>}
          </Section>

          <Section
            title="Devoluções recebidas — repor estoque"
            subtitle="Itens chegaram, precisam voltar ao estoque"
            icon={Undo2} iconColor="text-green-700"
            count={counts.receivedReturns} total={counts.receivedReturns === receivedReturns.length ? sumRefund(receivedReturns) : 0}
            borderColor="border-green-200"
          >
            {receivedReturns.map(r => <ReturnItem key={r.id} ret={r} />)}
            {counts.receivedReturns > receivedReturns.length && <Link to="/devolucoes?status=received" className="inline-flex min-h-11 items-center px-3 text-sm font-medium text-blue-700">Ver todas as {counts.receivedReturns} devoluções recebidas</Link>}
          </Section>
        </>
      )}
      <footer className="flex flex-wrap gap-4 border-t pt-3 text-sm">
        <Link className="inline-flex min-h-11 items-center text-blue-700 hover:underline" to="/comunicacao">Retornos e agendamentos</Link>
        <Link className="inline-flex min-h-11 items-center text-blue-700 hover:underline" to="/assessoria/renovacoes">Quadro de renovações</Link>
        <Link className="inline-flex min-h-11 items-center text-blue-700 hover:underline" to="/assessoria/indicadores">Indicadores da assessoria</Link>
      </footer>
    </div>
  );
}
