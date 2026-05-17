import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, ShoppingCart, Users, TrendingUp, Package, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PreSaleOrder, PreSaleCustomer, PreSaleProduct, PreSaleCampaign } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';

function KPICard({ title, value, sub, icon: Icon, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    purple: 'bg-purple-50 text-purple-600',
    red: 'bg-red-50 text-red-600',
  };
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={`p-3 rounded-full ${colors[color]}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const PAYMENT_STATUS_LABEL = {
  awaiting_charge: 'Aguardando cobrança',
  charge_sent: 'Cobrança enviada',
  paid: 'Pago',
  partially_paid: 'Parcialmente pago',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
};

const PAYMENT_BADGE = {
  paid: 'success',
  partially_paid: 'warning',
  awaiting_charge: 'secondary',
  charge_sent: 'info',
  cancelled: 'destructive',
  refunded: 'outline',
};

export default function Dashboard() {
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);

  useEffect(() => {
    Promise.all([
      PreSaleOrder.list(),
      PreSaleCustomer.list(),
      PreSaleProduct.list(),
      PreSaleCampaign.list(),
    ]).then(([o, c, p, camp]) => {
      setOrders(o);
      setCustomers(c);
      setProducts(p);
      setCampaigns(camp);
    });
  }, []);

  const activeOrders = orders.filter(o => o.payment_status !== 'cancelled');
  const totalSold = activeOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPaid = activeOrders.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPending = activeOrders.filter(o => ['awaiting_charge', 'charge_sent', 'partially_paid'].includes(o.payment_status)).reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalCost = activeOrders.reduce((acc, o) => acc + (o.total_cost || 0), 0);
  const grossProfit = totalSold - totalCost;
  const margin = totalSold > 0 ? (grossProfit / totalSold) * 100 : 0;

  const recentOrders = [...orders].slice(0, 8);
  const activeCampaigns = campaigns.filter(c => c.status === 'active');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Painel Financeiro</h2>
        <p className="text-sm text-muted-foreground">Visão geral de vendas, pedidos e lucro</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard title="Total Vendido" value={formatCurrency(totalSold)} icon={DollarSign} color="blue" />
        <KPICard title="Total Pago" value={formatCurrency(totalPaid)} sub={`${orders.filter(o => o.payment_status === 'paid').length} pedidos`} icon={CheckCircle2} color="green" />
        <KPICard title="Total Pendente" value={formatCurrency(totalPending)} sub={`${orders.filter(o => ['awaiting_charge','charge_sent','partially_paid'].includes(o.payment_status)).length} pedidos`} icon={Clock} color="yellow" />
        <KPICard title="Lucro Bruto Est." value={formatCurrency(grossProfit)} sub={`Margem: ${margin.toFixed(1)}%`} icon={TrendingUp} color="purple" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard title="Total de Pedidos" value={orders.length} icon={ShoppingCart} color="blue" />
        <KPICard title="Clientes" value={customers.length} icon={Users} color="purple" />
        <KPICard title="Produtos Ativos" value={products.filter(p => p.status === 'active').length} icon={Package} color="green" />
        <KPICard title="Campanhas Ativas" value={activeCampaigns.length} icon={AlertCircle} color="yellow" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pedidos recentes */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Pedidos Recentes</CardTitle>
                <Link to="/pedidos" className="text-sm text-blue-600 hover:underline">Ver todos</Link>
              </div>
            </CardHeader>
            <CardContent>
              {recentOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Nenhum pedido ainda</p>
              ) : (
                <div className="space-y-2">
                  {recentOrders.map(order => (
                    <Link
                      key={order.id}
                      to={`/pedidos/${order.id}`}
                      className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-200"
                    >
                      <div>
                        <p className="text-sm font-medium text-blue-700">{order.order_number}</p>
                        <p className="text-xs text-muted-foreground">{order.checkout_name} · {formatDate(order.created_date)}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant={PAYMENT_BADGE[order.payment_status] || 'secondary'}>
                          {PAYMENT_STATUS_LABEL[order.payment_status] || order.payment_status}
                        </Badge>
                        <span className="text-sm font-semibold">{formatCurrency(order.total_value)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Campanhas ativas */}
        <div>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Campanhas Ativas</CardTitle>
                <Link to="/campanhas" className="text-sm text-blue-600 hover:underline">Ver todas</Link>
              </div>
            </CardHeader>
            <CardContent>
              {activeCampaigns.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">Nenhuma campanha ativa</p>
              ) : (
                <div className="space-y-3">
                  {activeCampaigns.map(c => {
                    const cOrders = orders.filter(o => o.campaign_id === c.id && o.payment_status !== 'cancelled');
                    const cTotal = cOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
                    return (
                      <Link
                        key={c.id}
                        to={`/campanhas/${c.id}`}
                        className="block p-3 rounded-lg border hover:border-blue-300 hover:bg-blue-50 transition-colors"
                      >
                        <p className="text-sm font-medium">{c.name}</p>
                        <p className="text-xs text-muted-foreground">{c.supplier} · {cOrders.length} pedidos</p>
                        <p className="text-sm font-semibold text-blue-700 mt-1">{formatCurrency(cTotal)}</p>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
