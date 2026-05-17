import { useEffect, useState } from 'react';
import { BarChart3, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { PreSaleOrder, PreSaleProduct, PreSaleCampaign, PreSaleCustomer } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';

export default function Reports() {
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [campaignFilter, setCampaignFilter] = useState('all');

  useEffect(() => {
    Promise.all([
      PreSaleOrder.list(),
      PreSaleProduct.list(),
      PreSaleCampaign.list(),
      PreSaleCustomer.list(),
    ]).then(([o, p, c, cu]) => { setOrders(o); setProducts(p); setCampaigns(c); setCustomers(cu); });
  }, []);

  const filteredOrders = campaignFilter === 'all'
    ? orders
    : orders.filter(o => o.campaign_id === campaignFilter);

  const active = filteredOrders.filter(o => o.payment_status !== 'cancelled');
  const totalSold = active.reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPaid = active.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPending = active.filter(o => ['awaiting_charge','charge_sent','partially_paid'].includes(o.payment_status)).reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalCancelled = filteredOrders.filter(o => o.payment_status === 'cancelled').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalCost = active.reduce((acc, o) => acc + (o.total_cost || 0), 0);
  const grossProfit = totalSold - totalCost;
  const margin = totalSold > 0 ? (grossProfit / totalSold) * 100 : 0;

  // Por campanha
  const byCampaign = campaigns.map(c => {
    const co = orders.filter(o => o.campaign_id === c.id && o.payment_status !== 'cancelled');
    const sold = co.reduce((acc, o) => acc + (o.total_value || 0), 0);
    const paid = co.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
    const cost = co.reduce((acc, o) => acc + (o.total_cost || 0), 0);
    const profit = sold - cost;
    const uniqueCustomers = new Set(co.map(o => o.customer_id || o.checkout_whatsapp)).size;
    return { name: c.name, orders: co.length, sold, paid, cost, profit, uniqueCustomers, margin: sold > 0 ? (profit / sold) * 100 : 0 };
  });

  // Por fornecedor
  const bySupplier = {};
  products.forEach(p => {
    if (!p.supplier) return;
    if (!bySupplier[p.supplier]) bySupplier[p.supplier] = { supplier: p.supplier, totalSold: 0, totalCost: 0, profit: 0, qty: 0 };
    active.forEach(o => {
      (o.items || []).forEach(item => {
        if (item.product_name === p.name) {
          bySupplier[p.supplier].totalSold += item.sale_price * item.quantity;
          bySupplier[p.supplier].totalCost += item.cost_price * item.quantity;
          bySupplier[p.supplier].qty += item.quantity;
        }
      });
    });
    bySupplier[p.supplier].profit = bySupplier[p.supplier].totalSold - bySupplier[p.supplier].totalCost;
  });

  // Pedidos para entrega (pago, não entregue)
  const deliveryReport = orders.filter(o => o.payment_status === 'paid' && o.delivery_status !== 'delivered' && o.delivery_status !== 'cancelled');
  const deliveredOrders = orders.filter(o => o.delivery_status === 'delivered');

  // Relatório fornecedor: quantidade por produto/variação
  const supplierReport = {};
  active.forEach(o => {
    (o.items || []).forEach(item => {
      const key = `${item.product_name}||${item.variation || ''}`;
      if (!supplierReport[key]) {
        supplierReport[key] = { product: item.product_name, variation: item.variation || '-', totalQty: 0, paidQty: 0, pendingQty: 0 };
      }
      supplierReport[key].totalQty += item.quantity || 1;
      if (o.payment_status === 'paid') supplierReport[key].paidQty += item.quantity || 1;
      else supplierReport[key].pendingQty += item.quantity || 1;
    });
  });

  const chartData = byCampaign.filter(c => c.sold > 0).map(c => ({ name: c.name.length > 20 ? c.name.slice(0, 20) + '...' : c.name, Vendido: c.sold, Pago: c.paid, Lucro: c.profit }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Relatórios</h2>
          <p className="text-sm text-muted-foreground">Visão financeira completa</p>
        </div>
        <Select value={campaignFilter} onValueChange={setCampaignFilter}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Filtrar por campanha" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as campanhas</SelectItem>
            {campaigns.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="financeiro">
        <TabsList className="mb-4">
          <TabsTrigger value="financeiro">Financeiro Geral</TabsTrigger>
          <TabsTrigger value="campanhas">Por Campanha</TabsTrigger>
          <TabsTrigger value="fornecedor">Para Fornecedor</TabsTrigger>
          <TabsTrigger value="entrega">Entregas</TabsTrigger>
        </TabsList>

        {/* FINANCEIRO GERAL */}
        <TabsContent value="financeiro" className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total vendido', value: formatCurrency(totalSold), color: 'text-gray-900' },
              { label: 'Total pago', value: formatCurrency(totalPaid), color: 'text-green-700' },
              { label: 'Total pendente', value: formatCurrency(totalPending), color: 'text-yellow-700' },
              { label: 'Total cancelado', value: formatCurrency(totalCancelled), color: 'text-red-700' },
              { label: 'Custo total produtos', value: formatCurrency(totalCost), color: 'text-red-700' },
              { label: 'Lucro bruto estimado', value: formatCurrency(grossProfit), color: grossProfit >= 0 ? 'text-green-700' : 'text-red-700' },
              { label: 'Margem estimada', value: `${margin.toFixed(1)}%`, color: margin >= 0 ? 'text-green-700' : 'text-red-700' },
              { label: 'Total de pedidos ativos', value: active.length, color: 'text-gray-900' },
            ].map(k => (
              <Card key={k.label}>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">{k.label}</p>
                  <p className={`text-xl font-bold mt-1 ${k.color}`}>{k.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {chartData.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Vendas por Campanha</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={chartData} margin={{ left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={v => `R$${(v/1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={v => formatCurrency(v)} />
                    <Bar dataKey="Vendido" fill="#3b82f6" />
                    <Bar dataKey="Pago" fill="#22c55e" />
                    <Bar dataKey="Lucro" fill="#a855f7" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* POR CAMPANHA */}
        <TabsContent value="campanhas">
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Campanha</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground">Pedidos</th>
                  <th className="text-center px-4 py-3 font-medium text-muted-foreground">Clientes</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total vendido</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total pago</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Custo</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Lucro</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Margem</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byCampaign.map(c => (
                  <tr key={c.name} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 text-center">{c.orders}</td>
                    <td className="px-4 py-3 text-center">{c.uniqueCustomers}</td>
                    <td className="px-4 py-3 text-right">{formatCurrency(c.sold)}</td>
                    <td className="px-4 py-3 text-right text-green-700">{formatCurrency(c.paid)}</td>
                    <td className="px-4 py-3 text-right text-red-600">{formatCurrency(c.cost)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${c.profit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{formatCurrency(c.profit)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${c.margin >= 0 ? 'text-green-700' : 'text-red-700'}`}>{c.margin.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* PARA FORNECEDOR */}
        <TabsContent value="fornecedor">
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Variação</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Qtd total</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Qtd paga</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Qtd pendente</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.values(supplierReport).sort((a, b) => b.totalQty - a.totalQty).map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{r.product}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.variation}</td>
                    <td className="px-4 py-3 text-right font-semibold">{r.totalQty}</td>
                    <td className="px-4 py-3 text-right text-green-700">{r.paidQty}</td>
                    <td className="px-4 py-3 text-right text-yellow-700">{r.pendingQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* ENTREGAS */}
        <TabsContent value="entrega" className="space-y-6">
          <div>
            <h3 className="font-semibold text-base mb-3 text-yellow-700">Pagos e aguardando entrega ({deliveryReport.length})</h3>
            <div className="overflow-x-auto rounded-lg border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nº Pedido</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">WhatsApp</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto(s)</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {deliveryReport.map(o => (
                    <tr key={o.id}>
                      <td className="px-4 py-3 font-mono font-semibold text-blue-700">{o.order_number}</td>
                      <td className="px-4 py-3 font-medium">{o.checkout_name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{o.checkout_whatsapp}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{(o.items || []).map(i => `${i.product_name}${i.variation ? ' ' + i.variation : ''} x${i.quantity}`).join(', ')}</td>
                      <td className="px-4 py-3 text-right font-semibold">{formatCurrency(o.total_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="font-semibold text-base mb-3 text-green-700">Entregues ({deliveredOrders.length})</h3>
            <div className="overflow-x-auto rounded-lg border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Nº Pedido</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">WhatsApp</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto(s)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {deliveredOrders.map(o => (
                    <tr key={o.id}>
                      <td className="px-4 py-3 font-mono font-semibold text-blue-700">{o.order_number}</td>
                      <td className="px-4 py-3 font-medium">{o.checkout_name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{o.checkout_whatsapp}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{(o.items || []).map(i => `${i.product_name}${i.variation ? ' ' + i.variation : ''} x${i.quantity}`).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
