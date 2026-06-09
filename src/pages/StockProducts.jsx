import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Pencil, Trash2, Archive } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StockProduct } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { usePageData } from '@/hooks/usePageData';

async function loadStockProductsPage() {
  return StockProduct.list();
}

export default function StockProducts() {
  const { data: products, refresh } = usePageData({
    key: 'stock-products:list',
    loader: loadStockProductsPage,
    initialData: [],
    tags: ['stock_products'],
    onError: () => toast.error('Erro ao carregar estoque'),
  });
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  const handleDelete = async (id, name) => {
    if (!confirm(`Excluir "${name}"?`)) return;
    try {
      await StockProduct.delete(id);
      toast.success('Produto excluído');
      await refresh({ force: true });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const filtered = products.filter(p => {
    const q = search.toLowerCase();
    return !q || p.name?.toLowerCase().includes(q) || p.category?.toLowerCase().includes(q);
  });

  const qtyColor = (qty) => {
    if (qty <= 0) return 'bg-red-100 text-red-700';
    if (qty <= 3) return 'bg-amber-100 text-amber-700';
    return 'bg-green-100 text-green-700';
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Estoque</h2>
          <p className="text-sm text-muted-foreground">{filtered.length} produto{filtered.length !== 1 ? 's' : ''}</p>
        </div>
        <Button onClick={() => navigate('/estoque/novo')}>
          <Plus className="w-4 h-4 mr-2" /> Novo produto
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Buscar produto..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Archive className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum produto em estoque</p>
            <Button className="mt-4" onClick={() => navigate('/estoque/novo')}>Adicionar produto</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Categoria</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Preço</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Estoque</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(p => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {(p.images?.[0]) ? (
                        <img src={p.images[0]} alt={p.name} className="w-10 h-10 rounded-lg object-cover border border-gray-100" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                          <Archive className="w-4 h-4 text-gray-300" />
                        </div>
                      )}
                      <span className="font-medium">{p.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{p.category || '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(p.sale_price)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn('text-xs font-bold px-2.5 py-1 rounded-full', qtyColor(p.quantity))}>
                      {p.quantity} un.
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full',
                      p.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    )}>
                      {p.status === 'active' ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/estoque/${p.id}`)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => handleDelete(p.id, p.name)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
