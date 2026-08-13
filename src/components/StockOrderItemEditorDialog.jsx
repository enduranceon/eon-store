import { useEffect, useMemo, useState } from 'react';
import { Minus, Package, Plus, Search, ShoppingCart } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StockProduct } from '@/api/entities';
import { replaceStockOrderItems } from '@/api/client';
import { formatCurrency } from '@/lib/utils';
import {
  findStockVariation,
  hasStockVariations,
  stockCartKey,
  stockItemQuantity,
  stockItemSalePrice,
  stockProductVariations,
  stockVariationLabel,
} from '@/lib/stock-variations';
import { toast } from 'sonner';

const activeOrderItems = order => (order?.items || []).filter(item => !item.cancelled);

export default function StockOrderItemEditorDialog({ open, onOpenChange, order, onSaved }) {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedVariations, setSelectedVariations] = useState({});
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [saving, setSaving] = useState(false);

  const originalItems = useMemo(() => activeOrderItems(order), [order]);
  const originalByKey = useMemo(() => new Map(
    originalItems.map(item => [stockCartKey(item.product_id, item.variation || null), item]),
  ), [originalItems]);

  useEffect(() => {
    if (!open || !order) return;

    const resetTimer = window.setTimeout(() => {
      setSearch('');
      setSelectedVariations({});
      setCart(originalItems.map(item => ({
        key: stockCartKey(item.product_id, item.variation || null),
        product_id: item.product_id,
        variation: item.variation || null,
        quantity: Number(item.quantity) || 1,
      })));
      setLoadingProducts(true);
      StockProduct.list()
        .then(rows => setProducts(rows || []))
        .catch(error => {
          setProducts([]);
          toast.error(error.message || 'Não foi possível carregar o estoque');
        })
        .finally(() => setLoadingProducts(false));
    }, 0);

    return () => window.clearTimeout(resetTimer);
  }, [open, order, originalItems]);

  const productsById = useMemo(
    () => new Map(products.map(product => [product.id, product])),
    [products],
  );
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter(product => {
      if (product.status !== 'active') return false;
      if (!query) return true;
      return [product.name, product.category, product.subcategory, product.supplier, product.product_number]
        .some(value => String(value || '').toLowerCase().includes(query));
    });
  }, [products, search]);

  const originalQuantity = (productId, variation) => Number(
    originalByKey.get(stockCartKey(productId, variation || null))?.quantity || 0,
  );
  const cartQuantity = key => Number(cart.find(item => item.key === key)?.quantity || 0);
  const quantityLimit = (product, variation) => (
    stockItemQuantity(product, variation) + originalQuantity(product.id, variation)
  );
  const setQuantity = (productId, variation, quantity) => {
    const key = stockCartKey(productId, variation || null);
    setCart(current => {
      if (quantity <= 0) return current.filter(item => item.key !== key);
      const existing = current.find(item => item.key === key);
      if (existing) return current.map(item => item.key === key ? { ...item, quantity } : item);
      return [...current, { key, product_id: productId, variation: variation || null, quantity }];
    });
  };
  const defaultVariation = product => stockProductVariations(product)
    .find(variation => stockItemQuantity(product, stockVariationLabel(variation)) > 0);
  const selectedVariationName = product => {
    if (!hasStockVariations(product)) return null;
    return selectedVariations[product.id] || stockVariationLabel(defaultVariation(product));
  };
  const addOne = product => {
    const variation = selectedVariationName(product);
    if (hasStockVariations(product) && !variation) {
      toast.error('Selecione o tamanho');
      return;
    }
    const key = stockCartKey(product.id, variation || null);
    const nextQuantity = cartQuantity(key) + 1;
    if (nextQuantity > quantityLimit(product, variation)) {
      toast.error('Estoque insuficiente nessa opção');
      return;
    }
    setQuantity(product.id, variation, nextQuantity);
  };

  const cartLines = cart.map(line => {
    const product = productsById.get(line.product_id);
    const original = originalByKey.get(line.key);
    const variationData = product && line.variation ? findStockVariation(product, line.variation) : null;
    return {
      ...line,
      product,
      productName: product?.name || original?.product_name || 'Produto indisponível',
      unitPrice: original
        ? Number(original.sale_price) || 0
        : stockItemSalePrice(product, variationData),
      limit: product ? quantityLimit(product, line.variation) : line.quantity,
    };
  });
  const subtotal = cartLines.reduce((sum, line) => sum + (line.unitPrice * line.quantity), 0);
  const couponDiscount = Math.min(Number(order?.discount_value) || 0, subtotal);
  const manualDiscount = Math.min(Number(order?.manual_discount) || 0, Math.max(0, subtotal - couponDiscount));
  const total = Math.max(0, subtotal - couponDiscount - manualDiscount);

  const save = async () => {
    if (cart.length === 0) {
      toast.error('Para remover todos os itens, cancele o pedido em vez de zerar o carrinho.');
      return;
    }
    if (cartLines.some(line => !line.product)) {
      toast.error('Um produto do pedido não está mais disponível no estoque. Remova-o ou confira o cadastro antes de salvar.');
      return;
    }

    setSaving(true);
    try {
      const result = await replaceStockOrderItems(order.id, cart.map(item => ({
        product_id: item.product_id,
        variation: item.variation,
        quantity: item.quantity,
      })));
      onOpenChange(false);
      if (result?.changed === false) toast.message('Nenhuma alteração nos itens.');
      else toast.success('Itens ajustados e estoque recalculado.');
      onSaved?.();
    } catch (error) {
      toast.error(error.message || 'Não foi possível ajustar os itens');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={nextOpen => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-blue-600" />
            Ajustar itens do pedido
          </DialogTitle>
        </DialogHeader>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 shrink-0">
          Este ajuste só vale antes de gerar ou enviar a cobrança. O estoque é conferido no momento de salvar e o total será recalculado.
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 -mx-6 px-6">
          <div className="border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 border-b">
              <div>
                <p className="font-semibold text-sm">Carrinho ajustado</p>
                <p className="text-xs text-muted-foreground">Itens que continuam no pedido mantêm o preço combinado; novos itens usam o preço atual.</p>
              </div>
              <span className="font-bold whitespace-nowrap">{formatCurrency(total)}</span>
            </div>
            <div className="divide-y">
              {cartLines.length === 0 ? (
                <p className="px-4 py-5 text-sm text-muted-foreground">Nenhum item. Para cancelar tudo, use “Cancelar pedido”.</p>
              ) : cartLines.map(line => (
                <div key={line.key} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{line.productName}</p>
                    <p className="text-xs text-muted-foreground">
                      {line.variation ? `${line.variation} · ` : ''}{formatCurrency(line.unitPrice)} por unidade
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => setQuantity(line.product_id, line.variation, line.quantity - 1)} disabled={saving}>
                      <Minus className="w-3.5 h-3.5" />
                    </Button>
                    <span className="w-8 text-center text-sm font-semibold">{line.quantity}</span>
                    <Button type="button" size="icon" variant="outline" className="h-8 w-8" onClick={() => setQuantity(line.product_id, line.variation, line.quantity + 1)} disabled={saving || line.quantity >= line.limit}>
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <span className="w-20 text-right text-sm font-semibold">{formatCurrency(line.unitPrice * line.quantity)}</span>
                </div>
              ))}
            </div>
            {(couponDiscount > 0 || manualDiscount > 0) && (
              <div className="border-t px-4 py-2 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                {couponDiscount > 0 && <span>Cupom mantido: −{formatCurrency(couponDiscount)}</span>}
                {manualDiscount > 0 && <span>Desconto manual mantido: −{formatCurrency(manualDiscount)}</span>}
              </div>
            )}
          </div>

          <div>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Adicionar produto, tamanho, categoria..." value={search} onChange={event => setSearch(event.target.value)} />
            </div>
          </div>

          {loadingProducts ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Carregando produtos em estoque...</p>
          ) : visibleProducts.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Package className="w-9 h-9 mx-auto mb-2 text-gray-300" />
              Nenhum produto disponível.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-1">
              {visibleProducts.map(product => {
                const variationName = selectedVariationName(product);
                const selectedVariation = variationName ? findStockVariation(product, variationName) : null;
                const availableNow = hasStockVariations(product)
                  ? stockItemQuantity(product, variationName)
                  : stockItemQuantity(product, null);
                const availableAfterRelease = availableNow + originalQuantity(product.id, variationName);
                const selectedKey = stockCartKey(product.id, variationName || null);
                return (
                  <div key={product.id} className="border rounded-xl p-3 space-y-3">
                    <div className="flex gap-3">
                      {product.images?.[0] && <img src={product.images[0]} alt="" className="w-12 h-12 rounded-lg object-cover bg-gray-100" />}
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm leading-tight">{product.name}</p>
                        <p className="text-xs text-muted-foreground mt-1">{formatCurrency(stockItemSalePrice(product, selectedVariation))}</p>
                      </div>
                    </div>
                    {hasStockVariations(product) && (
                      <select
                        className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
                        value={variationName || ''}
                        onChange={event => setSelectedVariations(current => ({ ...current, [product.id]: event.target.value }))}
                      >
                        <option value="">Selecione o tamanho</option>
                        {stockProductVariations(product).map(variation => {
                          const label = stockVariationLabel(variation);
                          const quantity = stockItemQuantity(product, label) + originalQuantity(product.id, label);
                          return <option key={label} value={label} disabled={quantity < 1}>{label} ({quantity} disponível)</option>;
                        })}
                      </select>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground">{availableAfterRelease} disponível{availableAfterRelease !== 1 ? 'is' : ''}</span>
                      <Button type="button" size="sm" onClick={() => addOne(product)} disabled={(!variationName && hasStockVariations(product)) || cartQuantity(selectedKey) >= availableAfterRelease || saving}>
                        <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="pt-3 flex justify-end gap-2 shrink-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Voltar</Button>
          <Button type="button" onClick={save} disabled={saving || cart.length === 0}>
            {saving ? 'Salvando...' : 'Salvar ajuste'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
