import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Package, Search, Edit, Trash2, Copy } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { PreSaleProduct } from '@/api/entities';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { toast } from 'sonner';

const STATUS_LABEL = { active: 'Ativo', inactive: 'Inativo', pre_sale_closed: 'Pré-venda encerrada' };
const STATUS_BADGE = { active: 'success', inactive: 'secondary', pre_sale_closed: 'warning' };

export default function Products() {
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const navigate = useNavigate();

  const load = () => PreSaleProduct.list().then(setProducts);
  useEffect(() => { load(); }, []);

  const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();

  const filtered = products.filter(p => {
    const matchSearch = p.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.supplier?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || p.status === statusFilter;
    const matchCategory = categoryFilter === 'all' || p.category === categoryFilter;
    return matchSearch && matchStatus && matchCategory;
  });

  const handleDelete = async (id, name) => {
    if (!confirm(`Excluir "${name}"?`)) return;
    await PreSaleProduct.delete(id);
    toast.success('Produto excluído');
    load();
  };

  const handleDuplicate = async (p) => {
    const { id, created_date, ...rest } = p;
    await PreSaleProduct.create({ ...rest, name: `${p.name} (cópia)`, status: 'inactive' });
    toast.success('Produto duplicado');
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Produtos</h2>
          <p className="text-sm text-muted-foreground">{products.length} produtos cadastrados</p>
        </div>
        <Button onClick={() => navigate('/produtos/novo')}>
          <Plus className="w-4 h-4" /> Novo Produto
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar produto ou fornecedor..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {categories.length > 0 && (
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Categoria" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as categorias</SelectItem>
              {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="active">Ativos</SelectItem>
            <SelectItem value="inactive">Inativos</SelectItem>
            <SelectItem value="pre_sale_closed">Encerrados</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Package className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum produto encontrado</p>
            <Button className="mt-4" onClick={() => navigate('/produtos/novo')}>
              <Plus className="w-4 h-4" /> Cadastrar produto
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Fornecedor</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Preço venda</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Custo total</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Lucro/un.</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Margem</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Variações</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(p => {
                const totalCost = (p.cost_price || 0) + (p.extra_cost || 0);
                const profit = (p.sale_price || 0) - totalCost;
                const margin = p.sale_price > 0 ? (profit / p.sale_price) * 100 : 0;
                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {(p.images?.[0] || p.image) ? (
                          <img src={p.images?.[0] || p.image} alt={p.name} className="w-10 h-10 rounded-lg object-cover border shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-gray-100 border flex items-center justify-center shrink-0">
                            <Package className="w-5 h-5 text-gray-300" />
                          </div>
                        )}
                        <span className="font-medium">{p.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.supplier || '-'}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatCurrency(p.sale_price)}</td>
                    <td className="px-4 py-3 text-right text-red-600">{formatCurrency(totalCost)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(profit)}</td>
                    <td className={`px-4 py-3 text-right font-medium ${margin >= 0 ? 'text-green-600' : 'text-red-600'}`}>{margin.toFixed(1)}%</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={STATUS_BADGE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">
                      {(p.variations || []).length > 0 ? `${p.variations.length} var.` : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <Button size="icon" variant="ghost" onClick={() => navigate(`/produtos/${p.id}`)}>
                          <Edit className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="text-gray-400 hover:text-gray-700" onClick={() => handleDuplicate(p)} title="Duplicar produto">
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="text-red-500 hover:text-red-700" onClick={() => handleDelete(p.id, p.name)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
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
