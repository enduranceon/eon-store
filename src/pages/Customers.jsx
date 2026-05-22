import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Users, Search, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PreSaleCustomer, PreSaleOrder } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [cpfFilter, setCpfFilter] = useState('all'); // 'all' | 'no-cpf'
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    Promise.all([PreSaleCustomer.list(), PreSaleOrder.list()]).then(([c, o]) => {
      setCustomers(c);
      setOrders(o);
    });
    // Lê filtro da URL (ex: /clientes?filtro=sem-cpf)
    if (searchParams.get('filtro') === 'sem-cpf') setCpfFilter('no-cpf');
  }, []);

  const filtered = customers.filter(c => {
    const q = search.toLowerCase();
    const matchSearch = !q || [c.full_name, c.whatsapp, c.email, c.trainer].some(v => v?.toLowerCase().includes(q));
    const matchCpf = cpfFilter === 'all' || (cpfFilter === 'no-cpf' && !c.cpf);
    return matchSearch && matchCpf;
  });

  const noCpfCount = customers.filter(c => !c.cpf).length;

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
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Clientes</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} de {customers.length} clientes</p>
        </div>
        {noCpfCount > 0 && (
          <button
            onClick={() => setCpfFilter(f => f === 'no-cpf' ? 'all' : 'no-cpf')}
            className={cn(
              'flex items-center gap-2 text-sm font-semibold px-3 py-1.5 rounded-full border transition-all',
              cpfFilter === 'no-cpf'
                ? 'bg-red-500 text-white border-red-500'
                : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
            )}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            {noCpfCount} sem CPF
          </button>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por nome, WhatsApp, e-mail ou treinador..."
          className="pl-9"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {cpfFilter === 'no-cpf' && (
        <div className="flex items-start gap-2 text-sm bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-red-700">Clientes sem CPF não podem receber cobrança Asaas.</p>
            <p className="text-red-600 text-xs mt-0.5">Entre em contato com cada um e cadastre o CPF no perfil antes de gerar a cobrança.</p>
          </div>
        </div>
      )}

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
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">CPF</th>
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
                  <tr
                    key={c.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/clientes/${c.id}`)}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.full_name}</p>
                      <p className="text-xs text-muted-foreground">{c.email || ''}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.whatsapp || '-'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.trainer || '-'}</td>
                    <td className="px-4 py-3 text-center">
                      {c.cpf ? (
                        <span className="text-xs font-mono text-gray-600">{c.cpf}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 bg-red-50 px-2 py-0.5 rounded-full">
                          <AlertTriangle className="w-3 h-3" /> ausente
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center font-semibold">{stats.total}</td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(stats.totalValue)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-green-700">{formatCurrency(stats.totalPaid)}</span>
                      {pending > 0 && (
                        <span className="block text-xs text-yellow-600">Pendente: {formatCurrency(pending)}</span>
                      )}
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
