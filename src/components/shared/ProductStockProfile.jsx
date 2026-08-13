import { Product, StockProduct } from '@/api/entities';
import { usePageData } from '@/hooks/usePageData';
import { StockOperations, StockSetupForm } from '@/components/shared/ProductStockPanel';
import { toast } from 'sonner';

async function loadProductStockProfile(productId) {
  const [catalogProduct, stockProducts] = await Promise.all([
    Product.get(productId),
    StockProduct.list(),
  ]);
  const stockProduct = stockProducts.find(item => item.product_id === productId) || null;
  const movements = stockProduct
    ? await StockProduct.movements({ stock_product_id: stockProduct.id, limit: 8 })
    : [];
  return { catalogProduct, stockProduct, movements };
}

export default function ProductStockProfile({ productId }) {
  const { data, loading, refresh } = usePageData({
    key: `product-profile-stock:${productId}`,
    loader: () => loadProductStockProfile(productId),
    initialData: { catalogProduct: null, stockProduct: null, movements: [] },
    tags: ['products', 'stock_products', 'stock_movements'],
    forceOnMount: true,
    onError: () => toast.error('Não foi possível carregar o estoque deste produto'),
  });

  if (loading || !data.catalogProduct) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Carregando estoque...</p>;
  }

  if (!data.stockProduct) {
    return <StockSetupForm catalogProduct={data.catalogProduct} onConfigured={() => refresh({ force: true })} />;
  }

  return <StockOperations stockProduct={data.stockProduct} movements={data.movements} onRefresh={() => refresh({ force: true })} />;
}
