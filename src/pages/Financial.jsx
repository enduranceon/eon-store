import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, Calendar, CheckCircle2, Clock, AlertTriangle, TrendingDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getMonthStartStr() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().split('T')[0];
}

function daysDiff(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

function DueChip({ dateStr }) {
  const diff = daysDiff(dateStr);
  let label, cls;
  if (diff < 0) {
    label = `${Math.abs(diff)}d em atraso`;
    cls = 'bg-red-100 text-red-700';
  } else if (diff === 0) {
    label = 'Vence hoje';
    cls = 'bg-orange-100 text-orange-700';
  } else if (diff === 1) {
    label = 'Amanhã';
    cls = 'bg-orange-50 text-orange-600';
  } else if (diff <= 7) {
    label = `Em ${diff} dias`;
    cls = 'bg-amber-50 text-amber-700';
  } else {
    label = formatDate(dateStr);
    cls = 'bg-blue-50 text-blue-700';
  }
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

function OrderRow({ o }) {
  const link = o.type === 'stock' ? `/estoque/pedidos/${o.id}` : `/pedidos/${o.id}`;
  return (
    <Link
      to={link}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-blue-700">{o.order_number}</span>
          {o.type === 'stock' && (
            <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Loja</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{o.customer}</p>
      </div>
      {o.due_date && <DueChip dateStr={o.due_date} />}
      {o.payment_date && !o.due_date && (
        <span className="text-xs text-muted-foreground">{formatDate(o.payment_date)}</span>
      )}
      <span className="font-semibold text-sm">{formatCurrency(o.total_value)}</span>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

function Section({ title, icon: Icon, iconCls, orders, emptyMsg, border }) {
  if (orders.length === 0) return null;
  return (
    <Card className={border || ''}>
      <CardHeader className="pb-2">
        <CardTitle className={`text-base flex items-center gap-2 ${iconCls || 'text-gray-800'}`}>
          <Icon className="w-4 h-4" /> {title} <span className="font-normal text-sm text-muted-foreground">({orders.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {orders.length === 0
          ? <p className="text-sm text-muted-foreground py-4 text-center">{emptyMsg}</p>
          : <div className="divide-y">{orders.map(o => <OrderRow key={o.id + o.type} o={o} />)}</div>
        }
      </CardContent>
    </Card>
  );
}

export default function Financial() {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [presaleRes, stockRes] = await Promise.all([
        supabase.from('presale_orders')
          .select('id, order_number, checkout_name, total_value, payment_status, payment_date, due_date, asaas_charge_id')
          .neq('payment_status', 'cancelled')
          .neq('payment_status', 'refunded'),
        supabase.from('stock_orders')
          .select('id, order_number, customer_name, total_value, payment_status, payment_date, due_date, asaas_charge_id')
          .neq('payment_status', 'cancelled')
          .neq('payment_status', 'refunded'),
      ]);

      const presale = (presaleRes.data || []).map(o => ({ ...o, type: 'presale', customer: o.checkout_name }));
      const stock = (stockRes.data || []).map(o => ({ ...o, type: 'stock', customer: o.customer_name }));
      setOrders([...presale, ...stock]);
      setLoading(false);
    };
    load();
  }, []);

  const todayStr = getTodayStr();
  const monthStart = getMonthStartStr();

  const activeOrders = orders.filter(o => o.payment_status !== 'paid');

  // Categorias
  const paidThisMonth = orders
    .filter(o => o.payment_status === 'paid' && o.payment_date && o.payment_date >= monthStart)
    .sort((a, b) => b.payment_date.localeCompare(a.payment_date));

  const overdue = activeOrders
    .filter(o => o.due_date && o.due_date < todayStr)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  const upcoming = activeOrders
    .filter(o => o.due_date && o.due_date >= todayStr)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  const chargedNoDate = activeOrders
    .filter(o => !o.due_date && o.asaas_charge_id);

  const noCharge = activeOrders
    .filter(o => ['awaiting_charge', 'message_sent'].includes(o.payment_status));

  // KPIs
  const receivedMonth = paidThisMonth.reduce((s, o) => s + (o.total_value || 0), 0);
  const toReceive = orders
    .filter(o => ['charge_sent', 'partially_paid'].includes(o.payment_status))
    .reduce((s, o) => s + (o.total_value || 0), 0);
  const overdueTotal = overdue.reduce((s, o) => s + (o.total_value || 0), 0);
  const noChargeTotal = noCharge.reduce((s, o) => s + (o.total_value || 0), 0);

  const upcomingTotal = upcoming.reduce((s, o) => s + (o.total_value || 0), 0);

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Fluxo de Caixa</h2>
        <p className="text-sm text-muted-foreground">Previsibilidade de pagamentos — pré-venda + loja</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground">Recebido esse mês</p>
                <p className="text-2xl font-bold text-green-600 mt-1">{formatCurrency(receivedMonth)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{paidThisMonth.length} pagamentos</p>
              </div>
              <div className="p-2.5 rounded-full bg-green-50 shrink-0">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground">A receber</p>
                <p className="text-2xl font-bold text-blue-600 mt-1">{formatCurrency(toReceive)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">cobranças enviadas</p>
              </div>
              <div className="p-2.5 rounded-full bg-blue-50 shrink-0">
                <DollarSign className="w-5 h-5 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={overdueTotal > 0 ? 'border-red-200' : ''}>
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground">Em atraso</p>
                <p className={`text-2xl font-bold mt-1 ${overdueTotal > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                  {formatCurrency(overdueTotal)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{overdue.length} cobranças</p>
              </div>
              <div className={`p-2.5 rounded-full shrink-0 ${overdueTotal > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                <AlertTriangle className={`w-5 h-5 ${overdueTotal > 0 ? 'text-red-600' : 'text-gray-400'}`} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground">Prev. próx. 30 dias</p>
                <p className="text-2xl font-bold text-amber-600 mt-1">{formatCurrency(upcomingTotal)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{upcoming.length} vencimentos</p>
              </div>
              <div className="p-2.5 rounded-full bg-amber-50 shrink-0">
                <Calendar className="w-5 h-5 text-amber-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Em atraso */}
      <Section
        title="Em atraso"
        icon={AlertTriangle}
        iconCls="text-red-600"
        orders={overdue}
        border="border-red-200"
      />

      {/* Próximos vencimentos */}
      <Section
        title="Próximos vencimentos"
        icon={Calendar}
        iconCls="text-blue-600"
        orders={upcoming}
      />

      {/* Cobrança sem data */}
      <Section
        title="Cobrança enviada — sem data definida"
        icon={Clock}
        iconCls="text-gray-500"
        orders={chargedNoDate}
      />

      {/* Sem cobrança */}
      <Section
        title="Sem cobrança ainda"
        icon={TrendingDown}
        iconCls="text-gray-500"
        orders={noCharge}
        emptyMsg="Todos os pedidos já têm cobrança gerada."
      />

      {/* Recebidos este mês */}
      <Section
        title="Recebidos esse mês"
        icon={CheckCircle2}
        iconCls="text-green-700"
        orders={paidThisMonth}
      />

      {orders.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <DollarSign className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum pedido encontrado</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
