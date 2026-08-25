import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, ChevronRight, Eye, EyeOff, ImageOff, Package, Plus, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Product, StockProduct } from '@/api/entities';
import { formatCurrency, cn } from '@/lib/utils';
import { formatProductNumber } from '@/lib/sku';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const LOW_STOCK_LIMIT = 3;

async function loadProductLibraryPage() {
  const [library, stockProducts] = await Promise.all([
    Product.list(),
    StockProduct.list().catch(() => []),
  ]);
  return { library, stockProducts };
}

function groupByProductId(rows, libraryById) {
  return rows.reduce((acc, row) => {
    if (!row.product_id || !libraryById.has(row.product_id)) return acc;
    if (!acc[row.product_id]) acc[row.product_id] = [];
    acc[row.product_id].push(row);
    return acc;
  }, {});
}

function getFirstImage(...rows) {
  for (const row of rows.filter(Boolean)) {
    const image = row.images?.[0] || row.image_url || row.image;
    if (image) return image;
  }
  return '';
}

function getFirstValue(field, ...rows) {
  for (const row of rows.filter(Boolean)) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') return row[field];
  }
  return null;
}

function getStoreState(hasStock, stockQty, stockPublished) {
  if (!hasStock) return 'not_configured';
  if (!stockPublished) return 'hidden';
  if (stockQty <= 0) return 'out_of_stock';
  return 'live';
}

function buildRow({ key, product, stockRows = [], source = 'library' }) {
  const firstStock = stockRows[0];
  const stockQty = stockRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const hasStock = stockRows.length > 0;
  const stockPublished = stockRows.some(row => row.status === 'active' && row.show_in_store === true);

  return {
    key,
    product,
    stockRows,
    source,
    name: getFirstValue('name', product, firstStock) || 'Produto sem nome',
    image: getFirstImage(product, firstStock),
    productNumber: getFirstValue('product_number', product, firstStock),
    salePrice: getFirstValue('sale_price', product, firstStock) || 0,
    stockQty,
    hasStock,
    stockPublished,
    storeState: getStoreState(hasStock, stockQty, stockPublished),
    status: product?.status || firstStock?.status || 'inactive',
    standalone: source === 'stock',
  };
}

function qtyClass(qty, hasStock) {
  if (!hasStock) return 'bg-gray-100 text-gray-500';
  if (qty <= 0) return 'bg-red-100 text-red-700';
  if (qty <= LOW_STOCK_LIMIT) return 'bg-amber-100 text-amber-700';
  return 'bg-green-100 text-green-700';
}

function needsRestock(row) {
  return row.storeState === 'not_configured'
    || row.storeState === 'out_of_stock'
    || (row.hasStock && row.stockQty > 0 && row.stockQty <= LOW_STOCK_LIMIT);
}

function StoreState({ state }) {
  const styles = {
    live: 'border-green-200 bg-green-50 text-green-700',
    hidden: 'border-gray-200 bg-gray-50 text-gray-600',
    out_of_stock: 'border-red-200 bg-red-50 text-red-700',
    not_configured: 'border-amber-200 bg-amber-50 text-amber-700',
  };
  const labels = {
    live: 'No ar',
    hidden: 'Oculto',
    out_of_stock: 'Sem saldo',
    not_configured: 'Estoque não configurado',
  };
  const Icon = state === 'live' ? Eye : state === 'hidden' ? EyeOff : Archive;

  return (
    <Badge variant="outline" className={cn('gap-1 whitespace-nowrap', styles[state])}>
      <Icon className="w-3 h-3" /> {labels[state]}
    </Badge>
  );
}

export default function ProductLibrary() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialScope = searchParams.get('visao') || 'all';
  const { data } = usePageData({
    key: 'product-library:list',
    loader: loadProductLibraryPage,
    initialData: { library: [], stockProducts: [] },
    tags: ['products', 'stock_products'],
    onError: error => toast.error('Erro ao carregar produtos: ' + error.message),
  });
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState(initialScope);
  const [statusFilter, setStatusFilter] = useState('all');

  const rows = useMemo(() => {
    const libraryById = new Map(data.library.map(product => [product.id, product]));
    const stockByProductId = groupByProductId(data.stockProducts, libraryById);
    const missingIds = new Set(
      data.stockProducts
        .filter(row => row.product_id && !libraryById.has(row.product_id))
        .map(row => row.product_id)
    );

    const libraryRows = data.library.map(product => buildRow({
      key: `product:${product.id}`,
      product,
      stockRows: stockByProductId[product.id] || [],
    }));

    const missingLibraryRows = [...missingIds].map(productId => buildRow({
      key: `missing:${productId}`,
      stockRows: data.stockProducts.filter(row => row.product_id === productId),
      source: 'missing-library',
    }));

    const standaloneStockRows = data.stockProducts
      .filter(row => !row.product_id)
      .map(row => buildRow({ key: `stock:${row.id}`, stockRows: [row], source: 'stock' }));

    return [...libraryRows, ...missingLibraryRows, ...standaloneStockRows]
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [data]);

  const storeLiveCount = rows.filter(row => row.storeState === 'live').length;
  const needsStockCount = rows.filter(needsRestock).length;
  const hiddenCount = rows.filter(row => row.storeState === 'hidden').length;

  const filtered = rows.filter(row => {
    const query = search.toLowerCase();
    const matchesSearch = !query ||
      row.name.toLowerCase().includes(query) ||
      String(row.productNumber || '').includes(query);
    const matchesStatus = statusFilter === 'all' || row.status === statusFilter;
    const matchesScope =
      scope === 'all' ||
      (scope === 'live' && row.storeState === 'live') ||
      (scope === 'needs_stock' && needsRestock(row)) ||
      (scope === 'hidden' && row.storeState === 'hidden');
    return matchesSearch && matchesStatus && matchesScope;
  });

  const handleScopeChange = value => {
    setScope(value);
    setSearchParams(value === 'all' ? {} : { visao: value });
  };

  const openRow = row => {
    if (row.product?.id) navigate(`/produtos/${row.product.id}`);
    else if (row.stockRows[0]?.id) navigate(`/produtos/estoque/${row.stockRows[0].id}`);
  };

  const handleRowKeyDown = (event, row) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openRow(row);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Produtos</h2>
          <p className="text-sm text-muted-foreground">
            {rows.length} produtos · {storeLiveCount} no ar · {needsStockCount} para abastecer · {hiddenCount} ocultos
          </p>
        </div>
        <Button onClick={() => navigate('/produtos/novo')}>
          <Plus className="w-4 h-4" /> Novo produto
        </Button>
      </div>

      <Tabs value={scope} onValueChange={handleScopeChange}>
        <TabsList className="h-auto flex flex-wrap justify-start">
          <TabsTrigger value="all">Todos</TabsTrigger>
          <TabsTrigger value="live">No ar</TabsTrigger>
          <TabsTrigger value="needs_stock">Para abastecer</TabsTrigger>
          <TabsTrigger value="hidden">Ocultos</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-52">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por produto ou código..."
            className="pl-9"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            <SelectItem value="active">Ativos</SelectItem>
            <SelectItem value="inactive">Inativos</SelectItem>
          </SelectContent>
        </Select>
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Loja</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Saldo</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Preço</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(row => (
                <tr
                  key={row.key}
                  className="cursor-pointer hover:bg-gray-50 focus-visible:bg-blue-50 focus-visible:outline-none"
                  tabIndex={0}
                  onClick={() => openRow(row)}
                  onKeyDown={event => handleRowKeyDown(event, row)}
                  aria-label={`Abrir produto ${row.name}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {row.image ? (
                        <img src={row.image} alt={row.name} className="w-10 h-10 rounded-lg object-cover border border-gray-100 shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                          <ImageOff className="w-4 h-4 text-gray-300" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium truncate">{row.name}</p>
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {row.productNumber ? formatProductNumber(row.productNumber) : 'sem código'}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><StoreState state={row.storeState} /></td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn('text-xs font-bold px-2.5 py-1 rounded-full', qtyClass(row.stockQty, row.hasStock))}>
                      {row.hasStock ? `${row.stockQty} un.` : '-'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(row.salePrice)}</td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant={row.status === 'active' ? 'success' : 'secondary'}>
                      {row.status === 'active' ? 'Ativo' : 'Inativo'}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-right text-muted-foreground"><ChevronRight className="w-4 h-4" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
