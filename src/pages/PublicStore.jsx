import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ChevronRight, Lock, Minus, Plus, Search, ShoppingCart, Store, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { normalizePhone } from '@/api/db';
import { createPublicStockOrder, getPublicStockCatalog } from '@/api/public';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import CouponInput from '@/components/CouponInput';
import { computeDiscount } from '@/lib/coupon';
import {
  findStockVariation,
  hasStockVariations,
  stockCartKey,
  stockItemCostPrice,
  stockItemQuantity,
  stockItemSalePrice,
  stockProductQuantity,
  stockProductVariations,
  stockVariationLabel,
} from '@/lib/stock-variations';

const CART_KEY = 'eon_loja_cart';

function productCategory(product) {
  return product.category?.trim() || 'Outros';
}

function availableVariations(product) {
  return stockProductVariations(product).filter(variation =>
    stockItemQuantity(product, stockVariationLabel(variation)) > 0
  );
}

function productDisplayPrice(product) {
  const prices = availableVariations(product)
    .map(variation => stockItemSalePrice(product, variation));
  return prices.length ? Math.min(...prices) : stockItemSalePrice(product);
}

function variationGroup(variation) {
  return variation.gender?.trim() || 'Opções';
}

function variationSizeLabel(variation) {
  return variation.size?.trim() || stockVariationLabel(variation);
}

export default function PublicStore() {
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState('shop');
  const [cart, setCart] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(CART_KEY)) || [];
      return stored.map(item => ({
        ...item,
        key: item.key || stockCartKey(item.product_id, item.variation),
      }));
    } catch { return []; }
  });
  const [selectedVariations, setSelectedVariations] = useState({});
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedQuantity, setSelectedQuantity] = useState(1);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('Todos');
  const [form, setForm] = useState({ name: '', whatsapp: '', email: '', payment_method: '', delivery_method: '', delivery_city: '' });
  const [submitting, setSubmitting] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState(null);

  useEffect(() => {
    getPublicStockCatalog()
      .then(p => {
        const activeProducts = p.filter(x => x.status === 'active');
        setProducts(activeProducts);

        // Carrinhos criados pela versão anterior não registravam a grade. Um
        // desses itens não pode ser enviado ao checkout sem o tamanho escolhido.
        const productsWithVariations = new Set(
          activeProducts.filter(hasStockVariations).map(product => product.id)
        );
        const legacyVariationItems = cart.filter(item =>
          productsWithVariations.has(item.product_id) && !item.variation
        );
        if (legacyVariationItems.length > 0) {
          setCart(currentCart => currentCart.filter(item =>
            !(productsWithVariations.has(item.product_id) && !item.variation)
          ));
          toast.warning('Escolha novamente o tamanho dos itens que estavam no carrinho.');
        }
      })
      .catch(() => toast.error('Erro ao carregar produtos'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }, [cart]);

  const defaultVariationName = (product) => {
    const available = stockProductVariations(product)
      .find(variation => stockItemQuantity(product, stockVariationLabel(variation)) > 0);
    return available ? stockVariationLabel(available) : '';
  };

  const currentVariationName = (product) => {
    if (!hasStockVariations(product)) return null;
    return selectedVariations[product.id] || defaultVariationName(product);
  };

  const openProduct = product => {
    if (hasStockVariations(product) && !selectedVariations[product.id]) {
      setSelectedVariations(current => ({
        ...current,
        [product.id]: defaultVariationName(product),
      }));
    }
    setSelectedQuantity(1);
    setSelectedProduct(product);
  };

  const addToCart = (product, quantity = 1) => {
    const requestedQuantity = Number(quantity);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
      toast.error('Informe uma quantidade válida');
      return false;
    }
    const variationName = currentVariationName(product);
    const variation = variationName ? findStockVariation(product, variationName) : null;
    const availableQuantity = stockItemQuantity(product, variationName);
    if (hasStockVariations(product) && !variation) {
      toast.error('Selecione o tamanho');
      return false;
    }
    if (availableQuantity <= 0) {
      toast.error('Produto esgotado nessa opção');
      return false;
    }
    const key = stockCartKey(product.id, variationName);
    const existing = cart.find(item => item.key === key);
    if ((existing?.quantity || 0) + requestedQuantity > availableQuantity) {
      toast.error(`Há somente ${availableQuantity} ${availableQuantity === 1 ? 'unidade disponível' : 'unidades disponíveis'} nessa opção`);
      return false;
    }
    const salePrice = stockItemSalePrice(product, variation);
    const costPrice = stockItemCostPrice(product, variation);
    setCart(prev => {
      const existingItem = prev.find(item => item.key === key);
      if (existingItem) {
        return prev.map(i => i.key === key
          ? { ...i, quantity: i.quantity + requestedQuantity, available_quantity: availableQuantity }
          : i
        );
      }
      return [...prev, {
        key,
        product_id: product.id,
        product_name: product.name,
        variation: variationName,
        sale_price: salePrice,
        cost_price: costPrice,
        available_quantity: availableQuantity,
        quantity: requestedQuantity,
        image: product.images?.[0] || null,
      }];
    });
    toast.success(`${requestedQuantity} ${requestedQuantity === 1 ? 'unidade adicionada' : 'unidades adicionadas'} de ${product.name}${variationName ? ` - ${variationName}` : ''}`);
    return true;
  };

  const updateQty = (key, delta) => {
    setCart(prev => prev.map(i => {
      if (i.key !== key) return i;
      const product = products.find(p => p.id === i.product_id);
      const max = product
        ? stockItemQuantity(product, i.variation)
        : (Number(i.available_quantity || 0) || 999999);
      return {
        ...i,
        available_quantity: max,
        quantity: Math.max(0, Math.min(max, i.quantity + delta)),
      };
    }).filter(i => i.quantity > 0));
  };

  const removeFromCart = (key) => setCart(prev => prev.filter(i => i.key !== key));

  const cartTotal = cart.reduce((acc, i) => acc + i.sale_price * i.quantity, 0);
  const cartCount = cart.reduce((acc, i) => acc + i.quantity, 0);
  const categories = [...new Set(products.map(productCategory))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const filteredProducts = products.filter(product => {
    const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR');
    const inCategory = category === 'Todos' || productCategory(product) === category;
    return inCategory && (!normalizedSearch || product.name.toLocaleLowerCase('pt-BR').includes(normalizedSearch));
  });
  // No detalhe, todas as variações cadastradas permanecem visíveis. O estoque
  // só define se a opção pode ser escolhida, para não esconder, por exemplo,
  // "Masculino" quando ele está temporariamente sem saldo.
  const selectedProductOptions = selectedProduct ? stockProductVariations(selectedProduct) : [];
  const selectedProductVariationName = selectedProduct ? currentVariationName(selectedProduct) : null;
  const selectedProductVariation = selectedProductVariationName
    ? findStockVariation(selectedProduct, selectedProductVariationName)
    : null;
  const selectedOptionGroup = selectedProductVariation ? variationGroup(selectedProductVariation) : selectedProductOptions[0] ? variationGroup(selectedProductOptions[0]) : null;
  const selectedGroupOptions = selectedProductOptions.filter(variation => variationGroup(variation) === selectedOptionGroup);
  const selectedProductCartItems = selectedProduct
    ? cart.filter(item => item.product_id === selectedProduct.id)
    : [];
  const selectedItemInCart = selectedProduct
    ? cart.find(item => item.key === stockCartKey(selectedProduct.id, selectedProductVariationName))
    : null;
  const selectedItemStock = selectedProduct
    ? stockItemQuantity(selectedProduct, selectedProductVariationName)
    : 0;
  const maxAddQuantity = Math.max(0, selectedItemStock - (selectedItemInCart?.quantity || 0));

  const discount   = appliedCoupon ? computeDiscount(appliedCoupon, cartTotal) : 0;
  const finalTotal = Math.max(0, cartTotal - discount);
  const maxInstallments = Math.min(6, Math.max(1, Math.floor(finalTotal / 50)));

  useEffect(() => {
    if (appliedCoupon?.min_purchase && cartTotal < Number(appliedCoupon.min_purchase)) {
      const timeout = window.setTimeout(() => {
        toast.warning(`Cupom ${appliedCoupon.code} removido — pedido abaixo do mínimo`);
        setAppliedCoupon(null);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
  }, [cartTotal, appliedCoupon]);

  const handleSubmit = async () => {
    if (form.name.trim().length < 3) return toast.error('Informe seu nome completo');
    const cleanWhatsapp = normalizePhone(form.whatsapp);
    if (cleanWhatsapp.length < 10 || cleanWhatsapp.length > 11) return toast.error('WhatsApp inválido. Informe DDD + número');
    if (cart.length === 0) return toast.error('Adicione produtos ao carrinho');
    if (!form.payment_method) return toast.error('Selecione a forma de pagamento');
    if (!form.delivery_method) return toast.error('Selecione a forma de entrega');
    if (form.delivery_method === 'pickup' && !form.delivery_city) return toast.error('Selecione a cidade de retirada');

    setSubmitting(true);
    try {
      const order = await createPublicStockOrder({
        customer: {
          full_name: form.name,
          whatsapp: cleanWhatsapp,
          email: form.email,
        },
        delivery: {
          method: form.delivery_method,
          city: form.delivery_city || null,
        },
        payment_preference: form.payment_method,
        coupon_code: appliedCoupon?.code || null,
        items: cart.map(i => ({
          product_id: i.product_id,
          variation: i.variation || null,
          quantity: i.quantity,
        })),
      });

      localStorage.removeItem(CART_KEY);
      navigate(`/loja/confirmacao/${order.public_token}`, { state: { order } });
    } catch (e) {
      toast.error(e.message || 'Erro ao finalizar pedido. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950 text-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600">
              <Store className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-none">EON Store</h1>
              <p className="mt-1 text-xs text-zinc-400">Loja oficial</p>
            </div>
          </div>
          {step === 'shop' && (
            <button
              onClick={() => setStep('checkout')}
              disabled={cartCount === 0}
              title="Abrir carrinho"
              className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 text-white transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ShoppingCart className="h-4 w-4" />
              {cartCount > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold">{cartCount}</span>}
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {step === 'shop' ? (
          <div className="space-y-6">
            <div className="flex flex-col gap-4 border-b border-gray-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-medium text-blue-700">Catálogo</p>
                <h2 className="mt-1 text-2xl font-bold tracking-normal text-gray-950">Encontre seu equipamento</h2>
              </div>
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar produto" className="h-10 border-gray-300 bg-white pl-9" />
              </div>
            </div>

            {products.length === 0 ? (
              <div className="text-center py-24">
                <Store className="w-14 h-14 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 font-medium">Nenhum produto disponível no momento</p>
              </div>
            ) : (
              <>
                {categories.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {['Todos', ...categories].map(option => (
                      <button key={option} type="button" onClick={() => setCategory(option)} className={cn(
                        'h-9 shrink-0 rounded-lg border px-3 text-sm font-semibold transition-colors',
                        category === option ? 'border-zinc-950 bg-zinc-950 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-500'
                      )}>
                        {option}
                      </button>
                    ))}
                  </div>
                )}

                {filteredProducts.length === 0 ? (
                  <div className="border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500">Nenhum produto encontrado.</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                    {filteredProducts.map(product => {
                      const productVariations = availableVariations(product);
                      const hasVariations = productVariations.length > 0;
                      const optionsInCart = cart.filter(item => item.product_id === product.id).reduce((total, item) => total + item.quantity, 0);
                      return (
                        <article key={product.id} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md">
                          <button type="button" onClick={() => openProduct(product)} className="relative aspect-square w-full bg-gray-100 text-left">
                            {product.images?.[0]
                              ? <img src={product.images[0]} alt={product.name} className="h-full w-full object-cover" />
                              : <span className="flex h-full w-full items-center justify-center"><Store className="h-8 w-8 text-gray-300" /></span>}
                          </button>
                          <div className="flex flex-1 flex-col gap-2 p-3">
                            <div>
                              {product.category && <p className="mb-1 text-xs font-medium text-gray-500">{product.category}</p>}
                              <h3 className="min-h-10 text-sm font-semibold leading-5 text-gray-950">{product.name}</h3>
                            </div>
                            <div className="mt-auto">
                              <p className="text-base font-bold text-gray-950">{formatCurrency(productDisplayPrice(product))}</p>
                              <p className="mt-0.5 text-xs text-gray-500">{hasVariations
                                ? `${productVariations.length} ${productVariations.length === 1 ? 'opção disponível' : 'opções disponíveis'}`
                                : `${stockProductQuantity(product)} ${stockProductQuantity(product) === 1 ? 'disponível' : 'disponíveis'}`}</p>
                            </div>
                            <button type="button" onClick={() => openProduct(product)} className="h-9 w-full rounded-lg border border-gray-300 text-xs font-bold text-gray-800 transition-colors hover:border-zinc-950 hover:bg-zinc-950 hover:text-white">
                              {optionsInCart > 0 ? `${optionsInCart} no carrinho` : hasVariations ? 'Escolher tamanho' : 'Ver produto'}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {cartCount > 0 && (
              <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-gray-200 bg-white px-4 pb-4 pt-3 shadow-[0_-4px_24px_rgba(0,0,0,0.08)]">
                <div className="mx-auto max-w-7xl">
                  <button
                    onClick={() => setStep('checkout')}
                    className="flex h-12 w-full items-center justify-between rounded-lg bg-zinc-950 px-5 text-sm font-bold text-white transition-colors hover:bg-zinc-800"
                  >
                    <span className="flex items-center gap-2"><ShoppingCart className="w-5 h-5" />{cartCount} {cartCount === 1 ? 'item' : 'itens'}</span>
                    <span className="flex items-center gap-2">{formatCurrency(cartTotal)}<ChevronRight className="w-5 h-5 opacity-60" /></span>
                  </button>
                </div>
              </div>
            )}
            {cartCount > 0 && <div className="h-28" />}
          </div>

        ) : (
          <div className="max-w-xl mx-auto space-y-5">
            <button onClick={() => setStep('shop')} className="flex items-center gap-1.5 text-gray-500 hover:text-gray-900 text-sm font-medium">
              <ArrowLeft className="h-4 w-4" /> Voltar aos produtos
            </button>

            {/* Resumo */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-bold text-gray-900">Seu pedido</h3>
                <span className="text-sm text-gray-500">{cartCount} {cartCount === 1 ? 'item' : 'itens'}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {cart.map(i => (
                  <div key={i.key} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-gray-50 border border-gray-100 shrink-0">
                      {i.image ? <img src={i.image} alt={i.product_name} className="w-full h-full object-cover" /> : <div className="w-full h-full bg-gray-100" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{i.product_name}</p>
                      {i.variation && <p className="text-xs text-blue-600 font-medium truncate">{i.variation}</p>}
                      <div className="flex items-center gap-2 mt-1">
                        <button onClick={() => updateQty(i.key, -1)} className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-100"><Minus className="w-3 h-3" /></button>
                        <span className="text-sm font-bold w-5 text-center">{i.quantity}</span>
                        <button onClick={() => updateQty(i.key, 1)} className="w-6 h-6 rounded-full bg-gray-900 text-white flex items-center justify-center hover:bg-black"><Plus className="w-3 h-3" /></button>
                        <span className="text-xs text-gray-400 ml-1">{formatCurrency(i.sale_price)} cada</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <p className="text-sm font-bold">{formatCurrency(i.sale_price * i.quantity)}</p>
                      <button onClick={() => removeFromCart(i.key)} className="text-gray-300 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-5 py-4 bg-gray-50 space-y-2">
                <CouponInput
                  subtotal={cartTotal}
                  customerIdentifier={normalizePhone(form.whatsapp)}
                  applied={appliedCoupon ? { code: appliedCoupon.code, discount } : null}
                  onApply={(c) => setAppliedCoupon(c)}
                  onRemove={() => setAppliedCoupon(null)}
                />
                {discount > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Subtotal</span>
                    <span className="text-gray-600">{formatCurrency(cartTotal)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-900">Total</span>
                  <span className="text-xl font-bold text-blue-600">{formatCurrency(finalTotal)}</span>
                </div>
              </div>
            </div>

            {/* Dados */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-bold text-gray-900">Seus dados</h3>
              </div>
              <div className="px-5 py-4 space-y-4">
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Nome completo *</Label>
                  <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Seu nome completo" className="mt-1.5 h-11 rounded-xl border-gray-200" />
                </div>
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">WhatsApp *</Label>
                  <Input value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} placeholder="(47) 99999-9999" className="mt-1.5 h-11 rounded-xl border-gray-200" />
                </div>
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">E-mail</Label>
                  <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="seu@email.com" className="mt-1.5 h-11 rounded-xl border-gray-200" />
                </div>
              </div>
            </div>

            {/* Entrega */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-bold text-gray-900">Forma de entrega</h3>
              </div>
              <div className="px-5 py-4 space-y-3">
                {[
                  { value: 'pickup', label: 'Retirada em Treino Coletivo', desc: 'Retire no treino coletivo da sua cidade' },
                  { value: 'shipping', label: 'Frete', desc: 'Valor calculado e enviado via WhatsApp' },
                ].map(opt => (
                  <label key={opt.value} className={cn('flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all', form.delivery_method === opt.value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300')}>
                    <input type="radio" name="delivery_method" value={opt.value} checked={form.delivery_method === opt.value}
                      onChange={() => setForm(f => ({ ...f, delivery_method: opt.value, delivery_city: '' }))} className="mt-0.5 accent-blue-600" />
                    <div className="flex-1">
                      <p className="font-semibold text-gray-900 text-sm">{opt.label}</p>
                      {form.delivery_method === opt.value && opt.value === 'pickup' && (
                        <div className="flex gap-2 mt-3">
                          {['Florianópolis', 'São Paulo'].map(city => (
                            <button key={city} type="button" onClick={() => setForm(f => ({ ...f, delivery_city: city }))}
                              className={cn('flex-1 py-2 px-3 rounded-xl text-sm font-semibold border-2 transition-all',
                                form.delivery_city === city ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-200 text-gray-600 hover:border-blue-300'
                              )}>
                              {city}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Pagamento */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-bold text-gray-900">Forma de pagamento</h3>
              </div>
              <div className="px-5 py-4 space-y-3">
                <label className={cn('flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all', form.payment_method === 'pix_boleto' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300')}>
                  <input type="radio" name="payment_method" value="pix_boleto" checked={form.payment_method === 'pix_boleto'}
                    onChange={() => setForm(f => ({ ...f, payment_method: 'pix_boleto' }))} className="mt-0.5 accent-blue-600" />
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">PIX ou Boleto</p>
                    <p className="text-xs text-gray-500 mt-0.5">Pagamento à vista</p>
                  </div>
                </label>

                <label className={cn('flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all', form.payment_method.startsWith('card_') ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300')}>
                  <input type="radio" name="payment_method" value="card" checked={form.payment_method.startsWith('card_')}
                    onChange={() => setForm(f => ({ ...f, payment_method: 'card_1x' }))} className="mt-0.5 accent-blue-600" />
                  <div className="flex-1">
                    <p className="font-semibold text-gray-900 text-sm">Cartão de crédito</p>
                    <p className="text-xs text-gray-500 mt-0.5">Em até {maxInstallments}x</p>
                    {form.payment_method.startsWith('card_') && (
                      <div className="grid grid-cols-3 gap-2 mt-3">
                        {Array.from({ length: maxInstallments }, (_, i) => i + 1).map(n => (
                          <button key={n} type="button" onClick={() => setForm(f => ({ ...f, payment_method: `card_${n}x` }))}
                            className={cn('py-2.5 rounded-xl border-2 text-xs font-bold transition-all',
                              form.payment_method === `card_${n}x` ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-200 text-gray-700 hover:border-blue-300 bg-white'
                            )}>
                            <p>{n}x</p>
                            <p className={cn('font-normal mt-0.5', form.payment_method === `card_${n}x` ? 'text-blue-100' : 'text-gray-400')}>{formatCurrency(finalTotal / n)}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              </div>
            </div>

            {/* CTA */}
            <div className="space-y-3">
              <button onClick={handleSubmit} disabled={submitting}
                className="w-full h-14 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-2xl font-bold text-base transition-colors flex items-center justify-center gap-2">
                {submitting ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />Finalizando...</> : <>Finalizar pedido · {formatCurrency(finalTotal)}</>}
              </button>
              <div className="flex items-center justify-center gap-4 text-xs text-gray-400">
                <span className="flex items-center gap-1"><Lock className="w-3 h-3" /> Dados protegidos</span>
                <span>·</span>
                <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Pedido confirmado por WhatsApp</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={Boolean(selectedProduct)} onOpenChange={open => !open && setSelectedProduct(null)}>
        {selectedProduct && (
          <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto rounded-lg border-0 p-0 sm:rounded-lg">
            <div className="grid sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="aspect-square bg-gray-100 sm:sticky sm:top-0">
                {selectedProduct.images?.[0]
                  ? <img src={selectedProduct.images[0]} alt={selectedProduct.name} className="h-full w-full object-cover" />
                  : <div className="flex h-full w-full items-center justify-center"><Store className="h-10 w-10 text-gray-300" /></div>}
              </div>
              <div className="space-y-6 p-5 sm:p-6">
                <DialogHeader className="space-y-2 pr-8 text-left">
                  {selectedProduct.category && <p className="text-xs font-semibold text-blue-700">{selectedProduct.category}</p>}
                  <DialogTitle className="text-xl leading-7 text-gray-950">{selectedProduct.name}</DialogTitle>
                  <DialogDescription className="text-base font-bold text-gray-950">{formatCurrency(productDisplayPrice(selectedProduct))}</DialogDescription>
                </DialogHeader>

                {selectedProduct.description && <p className="text-sm leading-6 text-gray-600">{selectedProduct.description}</p>}

                {selectedProductOptions.length > 0 && (
                  <div className="space-y-5">
                    {[...new Set(selectedProductOptions.map(variationGroup))].length > 1 && (
                      <div>
                        <p className="mb-2 text-sm font-semibold text-gray-900">Modelo</p>
                        <div className="flex flex-wrap gap-2">
                          {[...new Set(selectedProductOptions.map(variationGroup))].map(group => {
                            const nextVariation = selectedProductOptions.find(variation =>
                              variationGroup(variation) === group
                              && stockItemQuantity(selectedProduct, stockVariationLabel(variation)) > 0
                            );
                            const groupIsSoldOut = !nextVariation;
                            return (
                            <button key={group} type="button" disabled={groupIsSoldOut} onClick={() => {
                              if (nextVariation) {
                                setSelectedQuantity(1);
                                setSelectedVariations(current => ({ ...current, [selectedProduct.id]: stockVariationLabel(nextVariation) }));
                              }
                            }} className={cn(
                              'h-10 rounded-lg border px-3 text-sm font-semibold transition-colors',
                              selectedOptionGroup === group ? 'border-zinc-950 bg-zinc-950 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-500',
                              groupIsSoldOut && 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 line-through hover:border-gray-200'
                            )} title={groupIsSoldOut ? `${group} esgotado` : undefined}>
                              {group}
                            </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div>
                      <p className="mb-2 text-sm font-semibold text-gray-900">Tamanho</p>
                      <div className="flex flex-wrap gap-2" role="group" aria-label={`Tamanhos de ${selectedProduct.name}`}>
                        {selectedGroupOptions.map(variation => {
                          const label = stockVariationLabel(variation);
                          const isSoldOut = stockItemQuantity(selectedProduct, label) <= 0;
                          return (
                            <button key={label} type="button" disabled={isSoldOut} onClick={() => {
                              setSelectedQuantity(1);
                              setSelectedVariations(current => ({ ...current, [selectedProduct.id]: label }));
                            }} className={cn(
                              'flex h-10 min-w-11 items-center justify-center rounded-lg border px-3 text-sm font-semibold transition-colors',
                              selectedProductVariationName === label ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white text-gray-800 hover:border-blue-400',
                              isSoldOut && 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 line-through hover:border-gray-200'
                            )} title={isSoldOut ? `${variationSizeLabel(variation)} esgotado` : undefined}>
                              {variationSizeLabel(variation)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {selectedProductCartItems.length > 0 && (
                  <p className="border-y border-gray-100 py-3 text-sm text-blue-700">
                    No carrinho: {selectedProductCartItems.map(item => `${item.variation || selectedProduct.name} x${item.quantity}`).join(' | ')}
                  </p>
                )}

                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2">
                  <span className="text-sm font-semibold text-gray-900">Quantidade</span>
                  <div className="flex h-10 items-center rounded-lg border border-gray-300">
                    <button type="button" title="Diminuir quantidade" aria-label="Diminuir quantidade" disabled={selectedQuantity <= 1} onClick={() => setSelectedQuantity(quantity => Math.max(1, quantity - 1))} className="flex h-full w-10 items-center justify-center text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300">
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="flex h-full min-w-10 items-center justify-center border-x border-gray-300 px-2 text-sm font-bold text-gray-950">{selectedQuantity}</span>
                    <button type="button" title="Aumentar quantidade" aria-label="Aumentar quantidade" disabled={selectedQuantity >= maxAddQuantity} onClick={() => setSelectedQuantity(quantity => Math.min(maxAddQuantity, quantity + 1))} className="flex h-full w-10 items-center justify-center text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-300">
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <button type="button" disabled={maxAddQuantity <= 0} onClick={() => {
                  if (addToCart(selectedProduct, selectedQuantity)) setSelectedQuantity(1);
                }} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300">
                  <ShoppingCart className="h-4 w-4" />
                  {maxAddQuantity <= 0
                    ? 'Quantidade máxima no carrinho'
                    : selectedProductVariationName
                      ? `Adicionar ${selectedQuantity} ${variationSizeLabel(selectedProductVariation)}`
                      : `Adicionar ${selectedQuantity} ao carrinho`}
                </button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
