import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StockProduct } from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { StockOperations } from '@/components/shared/ProductStockPanel';
import { toast } from 'sonner';

export default function ProductStockManager() {
  const { stockId, id } = useParams();
  const resolvedStockId = stockId || id;
  const navigate = useNavigate();
  const { data, loading, refresh } = usePageData({
    key: `legacy-product-stock:${resolvedStockId}`,
    loader: async () => {
      const [stockProduct, movements] = await Promise.all([
        StockProduct.get(resolvedStockId),
        StockProduct.movements({ stock_product_id: resolvedStockId, limit: 8 }),
      ]);
      return { stockProduct, movements };
    },
    initialData: { stockProduct: null, movements: [] },
    tags: ['stock_products', 'stock_movements'],
    onError: () => toast.error('Não foi possível carregar este estoque'),
  });

  if (loading || !data.stockProduct) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Carregando estoque...</p>;
  }

  const product = data.stockProduct;
  if (product.product_id) {
    return <Navigate to={`/produtos/${product.product_id}?aba=estoque`} replace />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Button size="icon" variant="outline" title="Voltar aos produtos" onClick={() => navigate('/produtos')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="text-xl font-bold text-gray-900">{product.name}</h2>
            <p className="text-sm text-muted-foreground">Estoque{product.category ? ` · ${product.category}` : ''}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate(`/estoque/movimentacoes?produto=${product.id}`)}>
            <History className="w-4 h-4" /> Histórico completo
          </Button>
        </div>
      </div>

      <StockOperations stockProduct={product} movements={data.movements} onRefresh={() => refresh({ force: true })} />
    </div>
  );
}
