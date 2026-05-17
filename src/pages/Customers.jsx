import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Search, Phone, Mail } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PreSaleCustomer, PreSaleOrder } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([PreSaleCustomer.list(), PreSaleOrder.list()]).then(([c, o]) => {
      setCustomers(c);
      setOrders(o);
    });
  }, []);

  const filtered = customers.filter(c => {
    const q = search.toLowerCase();
    return !q || [c.full_name, c.whatsapp, c.email, c.trainer].some(v => v?.toLowerCase().includes(q));
  });

  const getCustomerStats = (customerId) => {
    const co = orders.filter(o => o.customer_id === customerId && o.payment_status !== 'cancelled');
    return {
      total: co.length,
      totalValue: co.reduce((acc, o) => acc + (o.total_value || 0), 0),
      totalPaid: co.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0),
      lastOrder: co.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0],
    };
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Clientes</h2>
        <p className="text-sm text-muted-foreground">{customers.length} clientes cadastrados</p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Buscar por nome, WhatsApp, e-mail ou treinador..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Users className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum cliente encontrado</p>
            <p className="text-xs text-muted-foreground mt-1">Os clientes são criados automaticamente ao receber um pedido pelo checkout</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">WhatsApp</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Treinador</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Pedidos</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total comprado</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total pago</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Último pedido</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(c => {
                const stats = getCustomerStats(c.id);
                const pending = stats.totalValue - stats.totalPaid;
                return (
                  <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/clientes/${c.id}`)}>
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.full_name}</p>
                      <p className="text-xs text-muted-foreground">{c.email || ''}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.whatsapp || '-'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.trainer || '-'}</td>
                    <td className="px-4 py-3 text-center font-semibold">{stats.total}</td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(stats.totalValue)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-green-700">{formatCurrency(stats.totalPaid)}</span>
                      {pending > 0 && <span className="block text-xs text-yellow-600">Pendente: {formatCurrency(pending)}</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {stats.lastOrder ? (
                        <div>
                          <p className="font-mono text-xs text-blue-700">{stats.lastOrder.order_number}</p>
                          <p className="text-xs">{formatDate(stats.lastOrder.created_date)}</p>
                        </div>
                      ) : '-'}
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
