import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  ImageOff,
  Link2,
  Link2Off,
  Megaphone,
  Package,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Product, PreSaleProduct, StockProduct } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { formatProductNumber } from '@/lib/sku';
import { getProductCampaignIds } from '@/lib/campaignLinks';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const LOW_STOCK_LIMIT = 3;

async function loadProductLibraryPage() {
  const [library, presaleProducts, stockProducts] = await Promise.all([
    Product.list(),
    PreSaleProduct.list(),
    StockProduct.list().catch(() => []),
  ]);
  return { library, presaleProducts, stockProducts };
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

function buildRow({ key, product, stockRows = [], presaleRows = [], source }) {
  const firstStock = stockRows[0];
  const firstPresale = presaleRows[0];
  const image = getFirstImage(product, firstStock, firstPresale);
  const campaignIds = new Set(presaleRows.flatMap(getProductCampaignIds));
  const stockQty = stockRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const statuses = [product?.status, ...stockRows.map(row => row.status), ...presaleRows.map(row => row.status)].filter(Boolean);
  const active = statuses.includes('active');
  const category = getFirstValue('category', product, firstStock, firstPresale);
  const supplier = getFirstValue('supplier', product, firstStock, firstPresale);
  const subcategory = getFirstValue('subcategory', product, firstStock, firstPresale);
  const productNumber = getFirstValue('product_number', product, firstStock, firstPresale);
  const missingLibrary = source === 'missing-library';
  const standalone = source === 'stock' || source === 'presale';

  return {
    key,
    product,
    stockRows,
    presaleRows,
    source,
    name: getFirstValue('name', product, firstStock, firstPresale) || 'Produto sem nome',
    image,
    category,
    subcategory,
    supplier,
    productNumber,
    salePrice: getFirstValue('sale_price', product, firstStock, firstPresale) || 0,
    costPrice: getFirstValue('cost_price', product, firstStock, firstPresale) || 0,
    stockQty,
    campaignCount: campaignIds.size,
    variationCount: Math.max(
      product?.variations?.length || 0,
      firstStock?.variations?.length || 0,
      firstPresale?.variations?.length || 0
    ),
    status: active ? 'active' : (statuses[0] || 'inactive'),
    hasStock: stockRows.length > 0,
    hasPresale: presaleRows.length > 0,
    hasIssue: !image || !category || standalone || missingLibrary,
    missingLibrary,
    standalone,
  };
}

function qtyClass(qty, hasStock) {
  if (!hasStock) return 'bg-gray-100 text-gray-500';
  if (qty <= 0) return 'bg-red-100 text-red-700';
  if (qty <= LOW_STOCK_LIMIT) return 'bg-amber-100 text-amber-700';
  return 'bg-green-100 text-green-700';
}

export default function ProductLibrary() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialScope = searchParams.get('visao') || (location.pathname === '/estoque' ? 'stock' : 'all');
  const { data } = usePageData({
    key: 'product-library:list',
    loader: loadProductLibraryPage,
    initialData: { library: [], presaleProducts: [], stockProducts: [] },
    tags: ['products', 'presale_products', 'stock_products'],
    onError: error => toast.error('Erro ao carregar produtos: ' + error.message),
  });
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState(initialScope);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const rows = useMemo(() => {
    const libraryById = new Map(data.library.map(product => [product.id, product]));
    const stockByProductId = groupByProductId(data.stockProducts, libraryById);
    const presaleByProductId = groupByProductId(data.presaleProducts, libraryById);
    const missingIds = new Set([
      ...data.stockProducts.filter(row => row.product_id && !libraryById.has(row.product_id)).map(row => row.product_id),
      ...data.presaleProducts.filter(row => row.product_id && !libraryById.has(row.product_id)).map(row => row.product_id),
    ]);

    const libraryRows = data.library.map(product => buildRow({
      key: `product:${product.id}`,
      product,
      stockRows: stockByProductId[product.id] || [],
      presaleRows: presaleByProductId[product.id] || [],
      source: 'library',
    }));

    const missingLibraryRows = [...missingIds].map(productId => buildRow({
      key: `missing:${productId}`,
      stockRows: data.stockProducts.filter(row => row.product_id === productId),
      presaleRows: data.presaleProducts.filter(row => row.product_id === productId),
      source: 'missing-library',
    }));

    const standaloneStockRows = data.stockProducts
      .filter(row => !row.product_id)
      .map(row => buildRow({ key: `stock:${row.id}`, stockRows: [row], source: 'stock' }));

    const standalonePresaleRows = data.presaleProducts
      .filter(row => !row.product_id)
      .map(row => buildRow({ key: `presale:${row.id}`, presaleRows: [row], source: 'presale' }));

    return [...libraryRows, ...missingLibraryRows, ...standaloneStockRows, ...standalonePresaleRows]
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [data]);

  const categories = [...new Set(rows.map(row => row.category).filter(Boolean))].sort();
  const libraryCount = data.library.length;
  const stockCount = data.stockProducts.length;
  const presaleCount = data.presaleProducts.length;
  const issueCount = rows.filter(row => row.hasIssue).length;

  const filtered = rows.filter(row => {
    const q = search.toLowerCase();
    const matchesSearch = !q ||
      row.name.toLowerCase().includes(q) ||
      row.category?.toLowerCase().includes(q) ||
      row.subcategory?.toLowerCase().includes(q) ||
      row.supplier?.toLowerCase().includes(q) ||
      String(row.productNumber || '').includes(q);
    const matchesCategory = categoryFilter === 'all' || row.category === categoryFilter;
    const matchesStatus = statusFilter === 'all' || row.status === statusFilter;
    const matchesScope =
      scope === 'all' ||
      (scope === 'stock' && row.hasStock) ||
      (scope === 'available' && row.hasStock && row.stockQty > 0) ||
      (scope === 'presale' && row.hasPresale) ||
      (scope === 'attention' && row.hasIssue);
    return matchesSearch && matchesCategory && matchesStatus && matchesScope;
  });

  const handleScopeChange = value => {
    setScope(value);
    if (location.pathname === '/produtos') {
      setSearchParams(value === 'all' ? {} : { visao: value });
    }
  };

  const editStock = row => {
    const stockId = row.stockRows[0]?.id;
    if (stockId) navigate(`/estoque/${stockId}`);
  };

  const editPresale = row => {
    const presaleId = row.presaleRows[0]?.id;
    if (presaleId) navigate(`/produtos/pre-venda/${presaleId}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Produtos</h2>
          <p className="text-sm text-muted-foreground">
            {libraryCount} cadastros base · {stockCount} itens em estoque · {presaleCount} itens de pré-venda · {issueCount} para revisar
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate('/produtos/pre-venda/novo')}>
            <Megaphone className="w-4 h-4" /> Nova pré-venda
          </Button>
          <Button onClick={() => navigate('/estoque/novo')}>
            <Plus className="w-4 h-4" /> Novo estoque
          </Button>
        </div>
      </div>

      <Tabs value={scope} onValueChange={handleScopeChange}>
        <TabsList className="h-auto flex flex-wrap justify-start">
          <TabsTrigger value="all">Todos</TabsTrigger>
          <TabsTrigger value="stock">Com estoque</TabsTrigger>
          <TabsTrigger value="available">Disponíveis</TabsTrigger>
          <TabsTrigger value="presale">Pré-venda</TabsTrigger>
          <TabsTrigger value="attention">Atenção</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-52">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar produto, código, categoria ou fornecedor..."
            className="pl-9"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        {categories.length > 0 && (
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Categoria" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as categorias</SelectItem>
              {categories.map(category => <SelectItem key={category} value={category}>{category}</SelectItem>)}
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Classificação</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Uso</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Estoque</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Preço</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Custo</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(row => (
                <tr key={row.key} className="hover:bg-gray-50">
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
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          <span className="text-[11px] text-muted-foreground font-mono">
                            {row.productNumber ? formatProductNumber(row.productNumber) : 'sem codigo'}
                          </span>
                          {row.standalone && (
                            <span className="text-[11px] text-amber-700 inline-flex items-center gap-1">
                              <Link2Off className="w-3 h-3" /> avulso
                            </span>
                          )}
                          {row.missingLibrary && (
                            <span className="text-[11px] text-red-700 inline-flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3" /> vínculo sem cadastro base
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.category ? (
                      <div>
                        <span>{row.category}</span>
                        {(row.subcategory || row.supplier) && (
                          <p className="text-[11px] text-muted-foreground">
                            {[row.subcategory, row.supplier].filter(Boolean).join(' · ')}
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
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={row.product ? 'info' : 'outline'} className="gap-1">
                        <Package className="w-3 h-3" /> Base
                      </Badge>
                      {row.hasStock && (
                        <Badge variant="outline" className="gap-1">
                          <Archive className="w-3 h-3" /> {row.stockRows.length} estoque
                        </Badge>
                      )}
                      {row.hasPresale && (
                        <Badge variant="outline" className="gap-1">
                          <Megaphone className="w-3 h-3" /> {row.presaleRows.length} pré-venda
                        </Badge>
                      )}
                      {row.campaignCount > 0 && (
                        <Badge variant="outline" className="gap-1 text-green-700 border-green-200 bg-green-50">
                          <Link2 className="w-3 h-3" /> {row.campaignCount} coleção
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn('text-xs font-bold px-2.5 py-1 rounded-full', qtyClass(row.stockQty, row.hasStock))}>
                      {row.hasStock ? `${row.stockQty} un.` : '-'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(row.salePrice)}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{formatCurrency(row.costPrice)}</td>
                  <td className="px-4 py-3 text-center">
                    <Badge variant={row.status === 'active' ? 'success' : 'secondary'}>
                      {row.status === 'active' ? 'Ativo' : 'Inativo'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {row.hasStock && (
                        <Button size="icon" variant="ghost" onClick={() => editStock(row)} title="Editar estoque">
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {row.hasPresale && (
                        <Button size="sm" variant="ghost" onClick={() => editPresale(row)}>
                          Pré-venda
                        </Button>
                      )}
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
