import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ShoppingCart, MessageCircle, Clock, Package,
  Undo2, ChevronRight, Sparkles, RotateCcw, CalendarX, UserCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/api/db';
import { formatCurrency, todayLocalStr, toLocalDateStr } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
const DELIVERY_LABEL = {
  awaiting_supplier: 'Aguardando fornecedor',
  supplier_ordered:  'Pedido ao fornecedor',
  received:          'Produto recebido',
  separated:         'Separado p/ entrega',
  awaiting_delivery: 'Aguardando entrega',
};

function daysSince(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - today) / 86400000);
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
  if (type === 'contract') return <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">🏃 Assessoria</span>;
  return null;
}

function ItemRow({ item, badge, badgeColor }) {
  const link = item.type === 'stock'    ? `/estoque/pedidos/${item.id}`
             : item.type === 'contract' ? `/assessoria/contratos/${item.id}`
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
    <Link to="/devolucoes" className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors group">
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

// ─────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────────────────────
export default function Today() {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders]   = useState([]);    // store orders (presale + stock)
  const [contracts, setContracts] = useState([]); // assessment contracts
  const [returns, setReturns] = useState([]);
  const [pendingRefunds, setPendingRefunds] = useState([]);

  useEffect(() => {
    const load = async () => {
      try {
        const todayStr = todayLocalStr();

        const [presaleRes, stockRes, contractRes, plansRes, customersRes, returnsRes, refundsRes] = await Promise.all([
          supabase.from('presale_orders')
            .select('id, order_number, checkout_name, total_value, payment_status, delivery_status, asaas_charge_id, due_date, created_date, status_changed_at')
            .neq('payment_status', 'cancelled')
            .neq('payment_status', 'refunded'),
          supabase.from('stock_orders')
            .select('id, order_number, customer_name, total_value, payment_status, delivery_status, asaas_charge_id, due_date, created_date, status_changed_at')
            .neq('payment_status', 'cancelled')
            .neq('payment_status', 'refunded'),
          supabase.from('assessment_contracts')
            .select('id, contract_number, customer_id, plan_id, payment_status, payment_method, due_date, end_date, status, asaas_charge_id, enrollment_fee, manual_discount, refund_status, refund_amount')
            .not('status', 'in', '("cancelled","finished","draft")')
            .neq('payment_status', 'refunded'),
          supabase.from('assessment_plans').select('id, price_total'),
          supabase.from('presale_customers').select('id, full_name'),
          supabase.from('order_returns').select('*').in('status', ['pending_return', 'received']),
          supabase.from('assessment_contracts')
            .select('id, contract_number, customer_id, refund_amount, refund_status, payment_method, updated_at')
            .eq('refund_status', 'pending'),
        ]);

        const presale = (presaleRes.data || []).map(o => ({ ...o, type: 'presale', customer: o.checkout_name }));
        const stock   = (stockRes.data   || []).map(o => ({ ...o, type: 'stock',   customer: o.customer_name  }));
        setOrders([...presale, ...stock]);
        setReturns(returnsRes.data || []);

        // Mapeia contratos
        const plansMap     = Object.fromEntries((plansRes.data     || []).map(p => [p.id, p]));
        const customersMap = Object.fromEntries((customersRes.data || []).map(c => [c.id, c]));

        const mapped = (contractRes.data || []).map(c => {
          const plan  = plansMap[c.plan_id];
          const base  = Number(plan?.price_total) || 0;
          const total = Math.max(0, base + (Number(c.enrollment_fee) || 0) - (Number(c.manual_discount) || 0));
          return {
            id:             c.id,
            order_number:   c.contract_number,
            customer:       customersMap[c.customer_id]?.full_name || '—',
            total_value:    total,
            payment_status: c.payment_status,
            payment_method: c.payment_method,
            due_date:       c.due_date,
            end_date:       c.end_date,
            status:         c.status,
            asaas_charge_id: c.asaas_charge_id,
            type:           'contract',
          };
        });
        setContracts(mapped);

        // Estornos pendentes
        if (refundsRes.data?.length) {
          const rfIds = [...new Set(refundsRes.data.map(r => r.customer_id).filter(Boolean))];
          const { data: rfCust } = await supabase.from('presale_customers').select('id, full_name').in('id', rfIds);
          const rfMap = Object.fromEntries((rfCust || []).map(c => [c.id, c]));
          setPendingRefunds(refundsRes.data.map(r => ({
            ...r,
            customer_name: rfMap[r.customer_id]?.full_name || '—',
          })));
        } else {
          setPendingRefunds([]);
        }
      } catch (e) {
        console.error('Erro ao carregar Hoje:', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center space-y-2">
        <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-sm text-muted-foreground">Carregando...</p>
      </div>
    </div>
  );

  const todayStr = todayLocalStr();
  const allItems = [...orders, ...contracts];

  // ── Buckets ─────────────────────────────────────────────────────

  // 1. Em atraso — store + assessoria
  const overdue = allItems
    .filter(o => o.due_date && o.due_date < todayStr && o.payment_status !== 'paid')
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  // 2. Para cobrar — store (awaiting_charge) + contratos sem cobrança
  const toCharge = allItems
    .filter(o => o.payment_status === 'awaiting_charge')
    .sort((a, b) => (b.created_date || '').localeCompare(a.created_date || ''));

  // 3. Mensagem enviada — aguardando resposta (store)
  const messagesSent = orders
    .filter(o => o.payment_status === 'message_sent' && daysSince(o.status_changed_at || o.created_date) >= 1)
    .sort((a, b) => daysSince(b.status_changed_at) - daysSince(a.status_changed_at));

  // 4. Cobrança enviada sem pagamento (store + assessoria)
  const chargedNoPay = allItems
    .filter(o => o.payment_status === 'charge_sent' && daysSince(o.status_changed_at || o.created_date) >= 2)
    .sort((a, b) => daysSince(b.status_changed_at) - daysSince(a.status_changed_at));

  // 5. Contratos vencendo em até 14 dias (renovação)
  const in14Days = (() => {
    const d14 = new Date(); d14.setDate(d14.getDate() + 14);
    return toLocalDateStr(d14);
  })();
  const expiringContracts = contracts
    .filter(c => c.status === 'active' && c.end_date && c.end_date <= in14Days && c.end_date >= todayStr)
    .sort((a, b) => a.end_date.localeCompare(b.end_date));

  // 6. Pagos aguardando entrega (store only)
  const awaitingDelivery = orders
    .filter(o => o.payment_status === 'paid' && o.delivery_status && !['delivered', 'cancelled'].includes(o.delivery_status))
    .sort((a, b) => (a.payment_date || '').localeCompare(b.payment_date || ''));

  // 7. Devoluções
  const pendingReturns  = returns.filter(r => r.status === 'pending_return');
  const receivedReturns = returns.filter(r => r.status === 'received');

  const sum       = arr => arr.reduce((s, x) => s + (x.total_value   || 0), 0);
  const sumRefund = arr => arr.reduce((s, x) => s + (x.refund_value  || 0), 0);
  const sumAmount = arr => arr.reduce((s, x) => s + (x.refund_amount || 0), 0);

  const totalActions =
    overdue.length + toCharge.length + messagesSent.length +
    chargedNoPay.length + expiringContracts.length +
    awaitingDelivery.length + pendingReturns.length +
    receivedReturns.length + pendingRefunds.length;

  return (
    <div className="space-y-5 max-w-4xl mx-auto">

      {/* Cabeçalho */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900">{greeting()}! 👋</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {totalActions === 0
            ? 'Tudo em dia. Nenhuma ação pendente.'
            : `Você tem ${totalActions} ${totalActions === 1 ? 'item' : 'itens'} para revisar hoje`}
        </p>
      </div>

      {totalActions === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Sparkles className="w-12 h-12 text-green-400 mb-3" />
            <p className="text-lg font-semibold text-gray-700">Caixa de entrada vazia!</p>
            <p className="text-sm text-muted-foreground mt-1">Você está em dia com tudo — store e assessoria. ✨</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── 1. Em atraso — store + assessoria ──────────────────── */}
          <Section
            title="Cobranças em atraso"
            subtitle="Vencimento passou e ainda não foi pago"
            icon={AlertTriangle} iconColor="text-red-600"
            count={overdue.length} total={sum(overdue)}
            borderColor="border-red-200"
          >
            {overdue.map(o => {
              const d = Math.abs(daysUntil(o.due_date));
              return (
                <ItemRow key={o.id + o.type} item={o}
                  badge={`${d}d em atraso`} badgeColor="bg-red-100 text-red-700" />
              );
            })}
          </Section>

          {/* ── 2. Estornos pendentes ───────────────────────────────── */}
          {pendingRefunds.length > 0 && (
            <Card className="border-orange-200">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2 text-orange-700">
                      <RotateCcw className="w-4 h-4" />
                      Estornos pendentes
                      <span className="text-sm font-normal text-muted-foreground">({pendingRefunds.length})</span>
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">Contratos cancelados aguardando devolução ao aluno</p>
                  </div>
                  <span className="text-sm font-bold text-orange-700">{formatCurrency(sumAmount(pendingRefunds))}</span>
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
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── 3. Para cobrar ─────────────────────────────────────── */}
          <Section
            title="Pedidos / contratos para cobrar"
            subtitle="Aguardando você gerar cobrança"
            icon={ShoppingCart} iconColor="text-blue-600"
            count={toCharge.length} total={sum(toCharge)}
          >
            {toCharge.map(o => {
              const d = daysSince(o.created_date || o.created_at);
              return (
                <ItemRow key={o.id + o.type} item={o}
                  badge={d === 0 ? 'Hoje' : `Há ${d}d`}
                  badgeColor={d > 1 ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'} />
              );
            })}
          </Section>

          {/* ── 4. Contratos vencendo em breve ─────────────────────── */}
          <Section
            title="Contratos vencendo em breve"
            subtitle="Assessoria — renovar ou encerrar nos próximos 14 dias"
            icon={CalendarX} iconColor="text-violet-600"
            count={expiringContracts.length} total={0}
            borderColor="border-violet-100"
          >
            {expiringContracts.map(c => {
              const d = daysUntil(c.end_date);
              return (
                <ItemRow key={c.id + 'contract'} item={c}
                  badge={d === 0 ? 'Vence hoje' : d === 1 ? 'Vence amanhã' : `Vence em ${d}d`}
                  badgeColor={d <= 3 ? 'bg-red-100 text-red-700' : d <= 7 ? 'bg-orange-100 text-orange-700' : 'bg-violet-100 text-violet-700'} />
              );
            })}
          </Section>

          {/* ── 5. Mensagem enviada sem resposta ───────────────────── */}
          <Section
            title="Mensagens — aguardando resposta"
            subtitle="Cliente recebeu mas ainda não confirmou forma de pagamento"
            icon={MessageCircle} iconColor="text-orange-600"
            count={messagesSent.length} total={sum(messagesSent)}
          >
            {messagesSent.map(o => {
              const d = daysSince(o.status_changed_at || o.created_date);
              return (
                <ItemRow key={o.id + o.type} item={o}
                  badge={`Há ${d}d`} badgeColor="bg-orange-100 text-orange-700" />
              );
            })}
          </Section>

          {/* ── 6. Cobrança enviada há 2+ dias sem pagamento ───────── */}
          <Section
            title="Cobranças enviadas — lembrar cliente"
            subtitle="PIX/boleto enviado há 2+ dias sem confirmação"
            icon={Clock} iconColor="text-amber-600"
            count={chargedNoPay.length} total={sum(chargedNoPay)}
          >
            {chargedNoPay.map(o => {
              const d = daysSince(o.status_changed_at || o.created_date);
              return (
                <ItemRow key={o.id + o.type} item={o}
                  badge={`${d}d sem pagar`} badgeColor="bg-amber-100 text-amber-700" />
              );
            })}
          </Section>

          {/* ── 7. Pagos aguardando entrega (store) ────────────────── */}
          <Section
            title="Pagos — pendentes de entrega"
            subtitle="Pedidos da loja pagos que precisam ser processados"
            icon={Package} iconColor="text-purple-600"
            count={awaitingDelivery.length} total={sum(awaitingDelivery)}
          >
            {awaitingDelivery.map(o => (
              <ItemRow key={o.id + o.type} item={o}
                badge={DELIVERY_LABEL[o.delivery_status] || o.delivery_status}
                badgeColor="bg-purple-100 text-purple-700" />
            ))}
          </Section>

          {/* ── 8. Devoluções ──────────────────────────────────────── */}
          <Section
            title="Devoluções aguardando recebimento"
            subtitle="Cliente vai devolver — marque quando chegar"
            icon={Undo2} iconColor="text-slate-600"
            count={pendingReturns.length} total={sumRefund(pendingReturns)}
          >
            {pendingReturns.map(r => <ReturnItem key={r.id} ret={r} />)}
          </Section>

          <Section
            title="Devoluções recebidas — repor estoque"
            subtitle="Itens chegaram, precisam voltar ao estoque"
            icon={Undo2} iconColor="text-green-700"
            count={receivedReturns.length} total={sumRefund(receivedReturns)}
            borderColor="border-green-200"
          >
            {receivedReturns.map(r => <ReturnItem key={r.id} ret={r} />)}
          </Section>
        </>
      )}
    </div>
  );
}
