import { useState } from 'react';
import { Archive, ImageOff, Link2, Megaphone, Package, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Product, PreSaleProduct, StockProduct } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { formatProductNumber } from '@/lib/sku';
import { getProductCampaignIds } from '@/lib/campaignLinks';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

async function loadProductLibraryPage() {
  const [library, presaleProducts, stockProducts] = await Promise.all([
    Product.list(),
    PreSaleProduct.list(),
    StockProduct.list().catch(() => []),
  ]);
  return { library, presaleProducts, stockProducts };
}

function countByProductId(rows) {
  return rows.reduce((acc, row) => {
    if (!row.product_id) return acc;
    acc[row.product_id] = (acc[row.product_id] || 0) + 1;
    return acc;
  }, {});
}

export default function ProductLibrary() {
  const { data } = usePageData({
    key: 'product-library:list',
    loader: loadProductLibraryPage,
    initialData: { library: [], presaleProducts: [], stockProducts: [] },
    tags: ['products', 'presale_products', 'stock_products'],
    onError: error => toast.error('Erro ao carregar biblioteca: ' + error.message),
  });
  const [search, setSearch] = useState('');

  const presaleCount = countByProductId(data.presaleProducts);
  const stockCount = countByProductId(data.stockProducts);
  const linkedLibraryCount = data.library.filter(product => presaleCount[product.id] || stockCount[product.id]).length;
  const withoutImageCount = data.library.filter(product => !(product.images?.[0])).length;

  const filtered = data.library.filter(product => {
    const q = search.toLowerCase();
    return !q ||
      product.name?.toLowerCase().includes(q) ||
      product.category?.toLowerCase().includes(q) ||
      product.subcategory?.toLowerCase().includes(q) ||
      product.supplier?.toLowerCase().includes(q) ||
      String(product.product_number || '').includes(q);
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Biblioteca de produtos</h2>
          <p className="text-sm text-muted-foreground">
            {data.library.length} produtos-mãe · {linkedLibraryCount} usados em fluxos · {withoutImageCount} sem foto
          </p>
        </div>
      </div>

      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar produto, código, categoria ou fornecedor..."
          className="pl-9"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <Package className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum produto encontrado</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto-mãe</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Categoria</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Uso</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Preço</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Custo</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Variações</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(product => {
                const relatedPresale = data.presaleProducts.filter(row => row.product_id === product.id);
                const relatedCampaigns = new Set(relatedPresale.flatMap(getProductCampaignIds));
                const variationCount = Array.isArray(product.variations) ? product.variations.length : 0;
                return (
                  <tr key={product.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {product.images?.[0] ? (
                          <img src={product.images[0]} alt={product.name} className="w-10 h-10 rounded-lg object-cover border border-gray-100" />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                            <ImageOff className="w-4 h-4 text-gray-300" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="font-medium truncate">{product.name}</p>
                          <p className="text-[11px] text-muted-foreground font-mono">
                            {product.product_number ? formatProductNumber(product.product_number) : 'sem codigo'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <div>
                        <span>{product.category || '-'}</span>
                        {(product.subcategory || product.supplier) && (
                          <p className="text-[11px] text-muted-foreground">
                            {[product.subcategory, product.supplier].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline" className="gap-1">
                          <Megaphone className="w-3 h-3" /> {relatedPresale.length} pré-venda
                        </Badge>
                        <Badge variant="outline" className="gap-1">
                          <Archive className="w-3 h-3" /> {stockCount[product.id] || 0} estoque
                        </Badge>
                        {relatedCampaigns.size > 0 && (
                          <Badge variant="outline" className="gap-1 text-green-700 border-green-200 bg-green-50">
                            <Link2 className="w-3 h-3" /> {relatedCampaigns.size} coleção
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCurrency(product.sale_price)}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{formatCurrency(product.cost_price)}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{variationCount || '-'}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={product.status === 'active' ? 'success' : 'secondary'}>
                        {product.status === 'active' ? 'Ativo' : 'Inativo'}
                      </Badge>
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
