import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, ClipboardList, RotateCcw, Search, ShoppingCart, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StockProduct } from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { toast } from 'sonner';

const MOVEMENT_TYPES = {
  opening_balance: { label: 'Saldo inicial', variant: 'secondary', icon: ClipboardList },
  stock_entry: { label: 'Entrada / ajuste', variant: 'success', icon: ArrowUp },
  stock_withdrawal: { label: 'Retirada de estoque', variant: 'destructive', icon: ArrowDown },
  inventory_adjustment: { label: 'Ajuste de estoque', variant: 'warning', icon: SlidersHorizontal },
  order_reserved: { label: 'Reserva para pedido', variant: 'info', icon: ShoppingCart },
  order_cancelled: { label: 'Cancelamento de pedido', variant: 'purple', icon: RotateCcw },
  order_refunded: { label: 'Estorno de pedido', variant: 'purple', icon: RotateCcw },
  order_item_cancelled: { label: 'Cancelamento de item', variant: 'purple', icon: RotateCcw },
  order_returned: { label: 'Retorno físico', variant: 'purple', icon: RotateCcw },
};

function formatDateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

async function loadStockMovements() {
  const [movements, products] = await Promise.all([
    StockProduct.movements({ limit: 500 }),
    StockProduct.list(),
  ]);
  return { movements, products };
}

export default function StockMovements() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialProductId = searchParams.get('produto') || 'all';
  const { data } = usePageData({
    key: 'stock-movements:list',
    loader: loadStockMovements,
    initialData: { movements: [], products: [] },
    tags: ['stock_movements', 'stock_products'],
    onError: () => toast.error('Erro ao carregar movimentações de estoque'),
  });
  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState(initialProductId);
  const [variationFilter, setVariationFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  const productById = useMemo(
    () => new Map(data.products.map(product => [product.id, product])),
    [data.products]
  );
  const variations = useMemo(() => [...new Set(
    data.movements.map(movement => movement.variation).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'pt-BR')), [data.movements]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return data.movements.filter(movement => {
      const product = productById.get(movement.stock_product_id);
      const productName = product?.name || 'Produto removido';
      const matchesSearch = !term || [
        productName,
        movement.variation,
        movement.reason,
        movement.metadata?.order_number,
      ].some(value => String(value || '').toLowerCase().includes(term));
      return matchesSearch
        && (productFilter === 'all' || movement.stock_product_id === productFilter)
        && (variationFilter === 'all' || movement.variation === variationFilter)
        && (typeFilter === 'all' || movement.movement_type === typeFilter);
    });
  }, [data.movements, productById, productFilter, search, typeFilter, variationFilter]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Button size="icon" variant="outline" title="Voltar ao estoque" onClick={() => navigate('/estoque')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-xl font-bold text-gray-900">Movimentações de estoque</h2>
            <p className="text-sm text-muted-foreground">Entradas, ajustes, reservas e retornos registrados por produto e tamanho.</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{filtered.length} de {data.movements.length} movimentações</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={event => setSearch(event.target.value)} className="pl-9" placeholder="Produto, tamanho, motivo ou pedido..." />
        </div>
        <Select value={productFilter} onValueChange={setProductFilter}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Produto" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os produtos</SelectItem>
            {data.products.map(product => <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={variationFilter} onValueChange={setVariationFilter}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Tamanho" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos tamanhos</SelectItem>
            {variations.map(variation => <SelectItem key={variation} value={variation}>{variation}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Tipo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tipos</SelectItem>
            {Object.entries(MOVEMENT_TYPES).map(([value, type]) => <SelectItem key={value} value={value}>{type.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16 text-center">
            <ClipboardList className="mb-3 w-10 h-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Nenhuma movimentação encontrada</p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Data</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Produto</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tamanho</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Movimentação</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Alteração</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Saldo</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Referência</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(movement => {
                const type = MOVEMENT_TYPES[movement.movement_type] || MOVEMENT_TYPES.inventory_adjustment;
                const TypeIcon = type.icon;
                const product = productById.get(movement.stock_product_id);
                const changeClass = movement.quantity_delta > 0 ? 'text-green-700' : 'text-red-700';
                const orderNumber = movement.metadata?.order_number;
                return (
                  <tr key={movement.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDateTime(movement.created_at)}</td>
                    <td className="px-4 py-3 font-medium">{product?.name || 'Produto removido'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{movement.variation || 'Sem tamanho'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={type.variant} className="w-fit gap-1.5"><TypeIcon className="w-3 h-3" />{type.label}</Badge>
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${changeClass}`}>
                      {movement.quantity_delta > 0 ? '+' : ''}{movement.quantity_delta}
                    </td>
                    <td className="px-4 py-3 text-right">{movement.quantity_before} <span className="text-muted-foreground">→</span> {movement.quantity_after}</td>
                    <td className="px-4 py-3">
                      {movement.order_id ? (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => navigate(`/estoque/pedidos/${movement.order_id}`)}>
                          {orderNumber || 'Ver pedido'}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">{movement.reason || '—'}</span>
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
