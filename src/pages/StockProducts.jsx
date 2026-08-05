import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Pencil, Trash2, Archive, Link2, Link2Off, ImageOff, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { StockProduct } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { formatProductNumber } from '@/lib/sku';
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
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [linkFilter, setLinkFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState('all');
  const navigate = useNavigate();

  const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
  const unlinkedCount = products.filter(p => !p.product_id).length;
  const withoutCategoryCount = products.filter(p => !p.category).length;
  const withoutImageCount = products.filter(p => !(p.images?.[0])).length;

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
    const matchSearch = !q ||
      p.name?.toLowerCase().includes(q) ||
      p.category?.toLowerCase().includes(q) ||
      p.subcategory?.toLowerCase().includes(q) ||
      p.supplier?.toLowerCase().includes(q) ||
      String(p.product_number || '').includes(q);
    const matchStatus = statusFilter === 'all' || p.status === statusFilter;
    const matchCategory = categoryFilter === 'all' || p.category === categoryFilter;
    const matchLink =
      linkFilter === 'all' ||
      (linkFilter === 'linked' && p.product_id) ||
      (linkFilter === 'unlinked' && !p.product_id);
    const matchStock =
      stockFilter === 'all' ||
      (stockFilter === 'low' && Number(p.quantity || 0) > 0 && Number(p.quantity || 0) <= 3) ||
      (stockFilter === 'out' && Number(p.quantity || 0) <= 0);
    return matchSearch && matchStatus && matchCategory && matchLink && matchStock;
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
          <h2 className="text-xl font-bold text-gray-900">Produtos em estoque</h2>
          <p className="text-sm text-muted-foreground">
            {products.length} cadastrados · {unlinkedCount} sem vínculo · {withoutCategoryCount} sem categoria · {withoutImageCount} sem foto
          </p>
        </div>
        <Button onClick={() => navigate('/estoque/novo')}>
          <Plus className="w-4 h-4 mr-2" /> Novo produto em estoque
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-52">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar produto, código, categoria ou fornecedor..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
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
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            <SelectItem value="active">Ativos</SelectItem>
            <SelectItem value="inactive">Inativos</SelectItem>
          </SelectContent>
        </Select>
        <Select value={linkFilter} onValueChange={setLinkFilter}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos vínculos</SelectItem>
            <SelectItem value="linked">Com biblioteca</SelectItem>
            <SelectItem value="unlinked">Sem biblioteca</SelectItem>
          </SelectContent>
        </Select>
        <Select value={stockFilter} onValueChange={setStockFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todo estoque</SelectItem>
            <SelectItem value="low">Baixo estoque</SelectItem>
            <SelectItem value="out">Sem estoque</SelectItem>
          </SelectContent>
        </Select>
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Biblioteca</th>
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
                      <div className="min-w-0">
                        <span className="font-medium">{p.name}</span>
                        {p.product_number && (
                          <p className="text-[11px] text-muted-foreground font-mono">{formatProductNumber(p.product_number)}</p>
                        )}
                        {!(p.images?.[0]) && (
                          <p className="text-[11px] text-amber-700 flex items-center gap-1 mt-0.5">
                            <ImageOff className="w-3 h-3" /> Sem foto
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {p.category ? (
                      <div>
                        <span>{p.category}</span>
                        {(p.subcategory || p.supplier) && (
                          <p className="text-[11px] text-muted-foreground">
                            {[p.subcategory, p.supplier].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-700">
                        <AlertTriangle className="w-3 h-3" /> Sem categoria
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {p.product_id ? (
                      <Badge variant="outline" className="gap-1 text-green-700 border-green-200 bg-green-50">
                        <Link2 className="w-3 h-3" /> Vinculado
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 text-amber-700 border-amber-200 bg-amber-50">
                        <Link2Off className="w-3 h-3" /> Avulso
                      </Badge>
                    )}
                  </td>
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
