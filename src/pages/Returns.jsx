import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, CheckCircle2, Clock, Undo2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/api/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const TABS = [
  { key: 'pending_return', label: 'Aguardando devolução', icon: Clock },
  { key: 'received',       label: 'Recebidos',            icon: Package },
  { key: 'completed',      label: 'Concluídos',           icon: CheckCircle2 },
];

export default function Returns() {
  const [returns, setReturns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending_return');
  const [actionId, setActionId] = useState(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('order_returns')
      .select('*')
      .order('created_at', { ascending: false });
    setReturns(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const markReceived = async (ret) => {
    setActionId(ret.id);
    try {
      await supabase.from('order_returns').update({
        status: 'received',
        received_at: new Date().toISOString(),
      }).eq('id', ret.id);
      toast.success('Marcado como recebido!');
      load();
    } catch {
      toast.error('Erro ao atualizar');
    } finally {
      setActionId(null);
    }
  };

  const restock = async (ret) => {
    setActionId(ret.id);
    try {
      if (ret.product_id) {
        const { data: prod } = await supabase
          .from('stock_products').select('quantity').eq('id', ret.product_id).single();
        if (prod) {
          await supabase.from('stock_products')
            .update({ quantity: (prod.quantity || 0) + ret.quantity })
            .eq('id', ret.product_id);
        }
      }
      await supabase.from('order_returns').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', ret.id);
      toast.success(ret.product_id ? 'Estoque reposto!' : 'Devolução concluída!');
      load();
    } catch {
      toast.error('Erro ao repor estoque');
    } finally {
      setActionId(null);
    }
  };

  const counts = {
    pending_return: returns.filter(r => r.status === 'pending_return').length,
    received:       returns.filter(r => r.status === 'received').length,
    completed:      returns.filter(r => r.status === 'completed').length,
  };

  const filtered = returns.filter(r => r.status === filter);

  const emptyMsg = {
    pending_return: 'Nenhuma devolução pendente',
    received:       'Nenhum item recebido aguardando reposição',
    completed:      'Nenhuma devolução concluída',
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Central de Devoluções</h2>
        <p className="text-sm text-muted-foreground">Gerencie devoluções físicas de peças canceladas</p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const active = filter === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                active ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              {counts[tab.key] > 0 && (
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center ${
                  active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600'
                }`}>{counts[tab.key]}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Conteúdo */}
      {loading ? (
        <p className="text-center text-muted-foreground py-8">Carregando...</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Undo2 className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">{emptyMsg[filter]}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Pedido</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Qtd</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Valor est.</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Data cancel.</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(ret => {
                const link = ret.order_type === 'stock'
                  ? `/estoque/pedidos/${ret.order_id}`
                  : `/pedidos/${ret.order_id}`;
                return (
                  <tr key={ret.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link to={link} className="font-mono font-semibold text-blue-700 hover:underline flex items-center gap-1.5">
                        {ret.order_number}
                        {ret.order_type === 'stock' && (
                          <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Loja</span>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{ret.customer_name}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{ret.product_name}</p>
                      {ret.variation && <p className="text-xs text-muted-foreground">{ret.variation}</p>}
                      {ret.notes && <p className="text-xs text-muted-foreground italic mt-0.5">"{ret.notes}"</p>}
                    </td>
                    <td className="px-4 py-3 text-center">{ret.quantity}</td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(ret.refund_value)}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{formatDate(ret.created_at?.split('T')[0])}</td>
                    <td className="px-4 py-3 text-right">
                      {ret.status === 'pending_return' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => markReceived(ret)}
                          disabled={actionId === ret.id}
                        >
                          {actionId === ret.id ? '...' : 'Marcar recebido'}
                        </Button>
                      )}
                      {ret.status === 'received' && (
                        <Button
                          size="sm"
                          className="bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => restock(ret)}
                          disabled={actionId === ret.id}
                        >
                          {actionId === ret.id ? 'Repondo...' : ret.product_id ? 'Repor estoque' : 'Concluir'}
                        </Button>
                      )}
                      {ret.status === 'completed' && (
                        <span className="text-xs text-green-600 font-medium flex items-center justify-end gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Concluído
                        </span>
                      )}
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
