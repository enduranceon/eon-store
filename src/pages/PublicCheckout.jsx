import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ShoppingCart, Plus, Minus, Trash2, Store, ChevronRight, ChevronLeft, Lock, Tag, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PreSaleCampaign, PreSaleProduct, PreSaleOrder, PreSaleTrainer, findOrCreateCustomer } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export default function PublicCheckout() {
  const { campaignId } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [products, setProducts] = useState([]);
  const [trainers, setTrainers] = useState([]);
  const CART_KEY = `eon_cart_${campaignId}`;
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
  });
  const [step, setStep] = useState('shop');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [form, setForm] = useState({ full_name: '', whatsapp: '', email: '', trainer: '', delivery_method: '', delivery_city: '' });
  const [submitting, setSubmitting] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => { PreSaleTrainer.list().then(setTrainers); }, []);
  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }, [cart]);

  useEffect(() => {
    PreSaleCampaign.get(campaignId)
      .then(c => {
        setCampaign(c);
        return PreSaleProduct.list().then(p => {
          const active = p.filter(prod =>
            prod.status === 'active' &&
            ((prod.campaign_ids || []).includes(campaignId) || prod.campaign_id === campaignId)
          );
          if (c.product_order?.length) {
            active.sort((a, b) => {
              const ia = c.product_order.indexOf(a.id);
              const ib = c.product_order.indexOf(b.id);
              return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            });
          }
          setProducts(active);
        });
      })
      .catch(() => setNotFound(true));
  }, [campaignId]);

  if (notFound) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center px-4">
        <Store className="w-12 h-12 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-gray-800">Campanha não encontrada</h2>
        <p className="text-gray-500 mt-2 text-sm">Este link de pré-venda é inválido ou expirou.</p>
      </div>
    </div>
  );

  if (!campaign) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (campaign.status !== 'active') return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center px-4">
        <Store className="w-12 h-12 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-gray-800">Pré-venda encerrada</h2>
        <p className="text-gray-500 mt-2 text-sm">Esta campanha já foi encerrada.</p>
      </div>
    </div>
  );

  const addToCart = (product, variation = null, qty = 1) => {
    const key = `${product.id}-${variation?.name || ''}`;
    setCart(prev => {
      const existing = prev.find(i => i.key === key);
      if (existing) return prev.map(i => i.key === key ? { ...i, quantity: i.quantity + qty } : i);
      const salePrice = variation?.sale_price || product.sale_price || 0;
      const costPrice = variation?.cost_price || product.cost_price || 0;
      const regularPrice = variation?.regular_price || product.regular_price || 0;
      return [...prev, { key, product, variation, quantity: qty, sale_price: salePrice, cost_price: costPrice, regular_price: regularPrice }];
    });
    toast.success(`${product.name}${variation ? ' — ' + variation.name : ''} adicionado!`);
  };

  const updateQty = (key, delta) => {
    setCart(prev => {
      const updated = prev.map(i => i.key === key ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i);
      return updated.filter(i => i.quantity > 0);
    });
  };

  const removeFromCart = (key) => setCart(prev => prev.filter(i => i.key !== key));

  const cartTotal = cart.reduce((acc, i) => acc + i.sale_price * i.quantity, 0);
  const cartCost  = cart.reduce((acc, i) => acc + i.cost_price * i.quantity, 0);
  const cartCount = cart.reduce((acc, i) => acc + i.quantity, 0);
  const cartSavings = cart.reduce((acc, i) => {
    const reg = i.regular_price || 0;
    return acc + (reg > i.sale_price ? (reg - i.sale_price) * i.quantity : 0);
  }, 0);

  const handleSubmit = async () => {
    if (!form.full_name.trim()) return toast.error('Informe seu nome completo');
    if (!form.whatsapp.trim()) return toast.error('Informe seu WhatsApp');
    if (cart.length === 0) return toast.error('Adicione produtos ao carrinho');
    if (!form.delivery_method) return toast.error('Selecione a forma de entrega');
    if (form.delivery_method === 'pickup' && !form.delivery_city) return toast.error('Selecione a cidade de retirada');
    setSubmitting(true);
    try {
      const customer = await findOrCreateCustomer(form);
      const items = cart.map(i => ({
        product_id: i.product.id,
        product_name: i.product.name,
        variation: i.variation?.name || null,
        quantity: i.quantity,
        sale_price: i.sale_price,
        cost_price: i.cost_price,
      }));
      const order = await PreSaleOrder.create({
        campaign_id: campaignId,
        customer_id: customer.id,
        checkout_name: form.full_name,
        checkout_whatsapp: form.whatsapp,
        checkout_email: form.email,
        checkout_trainer: form.trainer,
        items,
        total_value: cartTotal,
        total_cost: cartCost,
        delivery_method: form.delivery_method,
        delivery_city: form.delivery_city || null,
        payment_status: 'awaiting_charge',
        delivery_status: 'awaiting_supplier',
      });
      localStorage.removeItem(CART_KEY);
      navigate(`/confirmacao/${order.id}`);
    } catch (e) {
      toast.error('Erro ao finalizar pedido: ' + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const categories = [...new Set(products.map(p => p.category).filter(Boolean))];
  const visibleProducts = products.filter(p => categoryFilter === 'all' || p.category === categoryFilter);

  return (
    <div className="min-h-screen bg-[#f5f5f5]">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="bg-[#1a1a2e] text-white sticky top-0 z-20 shadow-md">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center shrink-0">
              <Store className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-xs text-blue-300 font-medium tracking-wide uppercase">EON Store</p>
              <h1 className="text-sm font-bold leading-none">{campaign.name}</h1>
            </div>
          </div>

          {step === 'shop' && cartCount > 0 && (
            <button
              onClick={() => setStep('checkout')}
              className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 transition-colors px-4 py-2 rounded-xl text-sm font-semibold"
            >
              <div className="relative">
                <ShoppingCart className="w-4 h-4" />
                <span className="absolute -top-2 -right-2 w-4 h-4 bg-red-500 rounded-full text-[10px] flex items-center justify-center font-bold">
                  {cartCount}
                </span>
              </div>
              <span>{formatCurrency(cartTotal)}</span>
              {cartSavings > 0 && (
                <span className="text-xs bg-green-500 text-white px-1.5 py-0.5 rounded-full">
                  -{formatCurrency(cartSavings)}
                </span>
              )}
              <ChevronRight className="w-4 h-4 opacity-70" />
            </button>
          )}
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6">

        {/* ── Loja ────────────────────────────────────────────────────── */}
        {step === 'shop' ? (
          <div>
            {products.length === 0 ? (
              <div className="text-center py-24">
                <Store className="w-14 h-14 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 font-medium">Nenhum produto disponível ainda</p>
              </div>
            ) : (
              <>
                {/* Filtros de categoria */}
                {categories.length >= 2 && (
                  <div className="mb-6">
                    <div className="flex gap-2.5 overflow-x-auto pb-1 scrollbar-none" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                      {['all', ...categories].map(c => {
                        const count = c === 'all' ? products.length : products.filter(p => p.category === c).length;
                        const active = categoryFilter === c;
                        return (
                          <button
                            key={c}
                            onClick={() => setCategoryFilter(c)}
                            className={cn(
                              'flex items-center gap-2 px-4 py-2.5 rounded-2xl font-semibold text-sm whitespace-nowrap transition-all duration-150 shrink-0 border-2',
                              active
                                ? 'bg-[#1a1a2e] text-white border-[#1a1a2e] shadow-md'
                                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:shadow-sm'
                            )}
                          >
                            {c === 'all' ? 'Todos' : c}
                            <span className={cn(
                              'text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center',
                              active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                            )}>
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Grid de produtos */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                  {visibleProducts.map(p => (
                    <ProductCard key={p.id} product={p} cart={cart} onAdd={addToCart} onQty={updateQty} />
                  ))}
                </div>
              </>
            )}

            {/* ── Barra do carrinho ─────────────────────────────────── */}
            {cartCount > 0 && (
              <div className="fixed bottom-0 left-0 right-0 z-10 bg-white border-t border-gray-200 shadow-[0_-4px_24px_rgba(0,0,0,0.08)] px-4 pb-safe pt-3 pb-4">
                <div className="max-w-6xl mx-auto">
                  {cartSavings > 0 && (
                    <p className="text-center text-xs text-green-600 font-semibold mb-2">
                      🎉 Você economiza {formatCurrency(cartSavings)} nesta pré-venda
                    </p>
                  )}
                  <button
                    onClick={() => setStep('checkout')}
                    className="w-full bg-[#1a1a2e] hover:bg-black text-white py-4 rounded-2xl font-bold text-base flex items-center justify-between px-6 transition-colors active:scale-[0.99]"
                  >
                    <span className="flex items-center gap-2">
                      <ShoppingCart className="w-5 h-5" />
                      {cartCount} {cartCount === 1 ? 'item' : 'itens'}
                    </span>
                    <span className="flex items-center gap-2">
                      {formatCurrency(cartTotal)}
                      <ChevronRight className="w-5 h-5 opacity-60" />
                    </span>
                  </button>
                </div>
              </div>
            )}
            {cartCount > 0 && <div className="h-28" />}
          </div>

        ) : (
          /* ── Checkout ──────────────────────────────────────────────── */
          <div className="max-w-xl mx-auto space-y-5">
            <button
              onClick={() => setStep('shop')}
              className="flex items-center gap-1.5 text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Voltar aos produtos
            </button>

            {/* Resumo do pedido */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-bold text-gray-900">Seu pedido</h3>
                <span className="text-sm text-gray-500">{cartCount} {cartCount === 1 ? 'item' : 'itens'}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {cart.map(i => (
                  <div key={i.key} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-14 h-14 rounded-xl overflow-hidden bg-gray-50 border border-gray-100 shrink-0">
                      {(i.product.images?.[0] || i.product.image) ? (
                        <img src={i.product.images?.[0] || i.product.image} alt={i.product.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Package className="w-5 h-5 text-gray-300" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{i.product.name}</p>
                      {i.variation && <p className="text-xs text-gray-500 mt-0.5">{i.variation.name}</p>}
                      <div className="flex items-center gap-2 mt-1.5">
                        <button onClick={() => updateQty(i.key, -1)} className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors">
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="text-sm font-bold w-5 text-center">{i.quantity}</span>
                        <button onClick={() => updateQty(i.key, 1)} className="w-6 h-6 rounded-full bg-gray-900 text-white flex items-center justify-center hover:bg-black transition-colors">
                          <Plus className="w-3 h-3" />
                        </button>
                        <span className="text-xs text-gray-400 ml-1">{formatCurrency(i.sale_price)} cada</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <p className="text-sm font-bold text-gray-900">{formatCurrency(i.sale_price * i.quantity)}</p>
                      <button onClick={() => removeFromCart(i.key)} className="text-gray-300 hover:text-red-400 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-5 py-4 bg-gray-50 space-y-1">
                {cartSavings > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-green-600 font-medium flex items-center gap-1"><Tag className="w-3.5 h-3.5" /> Economia da pré-venda</span>
                    <span className="text-green-600 font-bold">-{formatCurrency(cartSavings)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="font-bold text-gray-900">Total</span>
                  <span className="text-xl font-bold text-blue-600">{formatCurrency(cartTotal)}</span>
                </div>
              </div>
            </div>

            {/* Dados do cliente */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-bold text-gray-900">Seus dados</h3>
                <p className="text-xs text-gray-500 mt-0.5">Usaremos seu WhatsApp para enviar as informações de pagamento</p>
              </div>
              <div className="px-5 py-4 space-y-4">
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Nome completo *</Label>
                  <Input
                    value={form.full_name}
                    onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                    placeholder="Seu nome completo"
                    className="mt-1.5 h-11 rounded-xl border-gray-200"
                  />
                </div>
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">WhatsApp *</Label>
                  <Input
                    value={form.whatsapp}
                    onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))}
                    placeholder="(47) 99999-9999"
                    className="mt-1.5 h-11 rounded-xl border-gray-200"
                  />
                </div>
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">E-mail</Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="seu@email.com"
                    className="mt-1.5 h-11 rounded-xl border-gray-200"
                  />
                </div>
                <div>
                  <Label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Treinador</Label>
                  {trainers.length > 0 ? (
                    <select
                      value={form.trainer}
                      onChange={e => setForm(f => ({ ...f, trainer: e.target.value }))}
                      className="mt-1.5 w-full h-11 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Selecione seu treinador...</option>
                      {trainers.map(t => (
                        <option key={t.id} value={t.name}>{t.name}</option>
                      ))}
                      <option value="__outro">Outro / Não tenho treinador</option>
                    </select>
                  ) : (
                    <Input
                      value={form.trainer}
                      onChange={e => setForm(f => ({ ...f, trainer: e.target.value }))}
                      placeholder="Nome do seu treinador"
                      className="mt-1.5 h-11 rounded-xl border-gray-200"
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Entrega */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-bold text-gray-900">Forma de entrega</h3>
              </div>
              <div className="px-5 py-4 space-y-3">
                {/* Retirada */}
                <label className={cn(
                  'flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all',
                  form.delivery_method === 'pickup'
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                )}>
                  <input
                    type="radio"
                    name="delivery_method"
                    value="pickup"
                    checked={form.delivery_method === 'pickup'}
                    onChange={() => setForm(f => ({ ...f, delivery_method: 'pickup', delivery_city: '' }))}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div className="flex-1">
                    <p className="font-semibold text-gray-900 text-sm">Retirada em Treino Coletivo</p>
                    <p className="text-xs text-gray-500 mt-0.5">Retire seu pedido no treino coletivo da sua cidade</p>

                    {/* Cidades */}
                    {form.delivery_method === 'pickup' && (
                      <div className="flex gap-2 mt-3">
                        {['Florianópolis', 'São Paulo'].map(city => (
                          <button
                            key={city}
                            type="button"
                            onClick={() => setForm(f => ({ ...f, delivery_city: city }))}
                            className={cn(
                              'flex-1 py-2 px-3 rounded-xl text-sm font-semibold border-2 transition-all',
                              form.delivery_city === city
                                ? 'border-blue-500 bg-blue-500 text-white'
                                : 'border-gray-200 text-gray-600 hover:border-blue-300'
                            )}
                          >
                            {city}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </label>

                {/* Frete */}
                <label className={cn(
                  'flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all',
                  form.delivery_method === 'shipping'
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                )}>
                  <input
                    type="radio"
                    name="delivery_method"
                    value="shipping"
                    checked={form.delivery_method === 'shipping'}
                    onChange={() => setForm(f => ({ ...f, delivery_method: 'shipping', delivery_city: '' }))}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">Frete</p>
                    {form.delivery_method === 'shipping' && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                        O valor do frete será calculado e enviado separadamente via WhatsApp.
                      </p>
                    )}
                  </div>
                </label>
              </div>
            </div>

            {/* CTA + Trust */}
            <div className="space-y-3">
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="w-full h-14 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60 text-white rounded-2xl font-bold text-base transition-colors flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Finalizando...</>
                ) : (
                  <>Finalizar pedido · {formatCurrency(cartTotal)}</>
                )}
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
    </div>
  );
}

/* ── ProductCard ──────────────────────────────────────────────────────────── */
function ProductCard({ product: p, cart, onAdd, onQty }) {
  const variations  = p.variations || [];
  const genders     = [...new Set(variations.map(v => v.gender).filter(Boolean))];
  const hasGenders  = genders.length > 0;
  const hasVars     = variations.length > 0;

  const [selGender, setSelGender] = useState(null);
  const [selVar,    setSelVar]    = useState(null);
  const [qty,       setQty]       = useState(1);

  const visibleVars = hasGenders
    ? (selGender ? variations.filter(v => v.gender === selGender) : [])
    : variations;

  const cartKeyNoVar = `${p.id}-`;
  const cartKeyVar   = selVar ? `${p.id}-${selVar.name}` : null;
  const inCartNoVar  = !hasVars ? cart.find(i => i.key === cartKeyNoVar) : null;
  const inCartVar    = cartKeyVar ? cart.find(i => i.key === cartKeyVar) : null;

  const handleGender = (g) => { setSelGender(g === selGender ? null : g); setSelVar(null); setQty(1); };
  const handleSize   = (v) => { setSelVar(selVar?.name === v.name ? null : v); setQty(1); };
  const handleAdd    = () => { onAdd(p, selVar, qty); setSelVar(null); setQty(1); };

  const displayPrice   = selVar?.sale_price   || p.sale_price   || 0;
  const displayRegular = selVar?.regular_price || p.regular_price || 0;
  const discountPct    = displayRegular > displayPrice
    ? Math.round((1 - displayPrice / displayRegular) * 100) : 0;

  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col border border-gray-100">

      {/* Imagem */}
      <ProductImageCarousel product={p} />

      {/* Conteúdo */}
      <div className="p-3 flex flex-col flex-1 gap-2">

        {/* Nome */}
        <div>
          <h3 className="font-semibold text-gray-900 text-sm leading-snug line-clamp-2">{p.name}</h3>
          {p.supplier && <p className="text-xs text-gray-400 mt-0.5">{p.supplier}</p>}
        </div>

        {/* Preço */}
        <div>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-lg font-bold text-gray-900">{formatCurrency(displayPrice)}</span>
            {discountPct > 0 && (
              <span className="text-xs text-gray-400 line-through">{formatCurrency(displayRegular)}</span>
            )}
          </div>
          {discountPct > 0 && (
            <span className="inline-block text-[11px] font-bold bg-green-500 text-white px-1.5 py-0.5 rounded-md mt-0.5">
              {discountPct}% OFF
            </span>
          )}
        </div>

        {/* Variações */}
        {hasVars ? (
          <div className="flex flex-col gap-2 mt-auto">

            {/* Chips de gênero */}
            {hasGenders && (
              <div className="flex gap-1.5 flex-wrap">
                {genders.map(g => (
                  <button
                    key={g}
                    onClick={() => handleGender(g)}
                    className={cn(
                      'text-xs px-3 py-1 rounded-full border font-semibold transition-all duration-150',
                      selGender === g
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'border-gray-200 text-gray-600 hover:border-gray-400'
                    )}
                  >
                    {g === 'Masculino' ? 'Masc.' : g === 'Feminino' ? 'Fem.' : g}
                  </button>
                ))}
              </div>
            )}

            {/* Chips de tamanho (quadrados, estilo Nike) */}
            {visibleVars.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {visibleVars.map((v, i) => {
                  const label    = v.size || v.name;
                  const selected = selVar?.name === v.name;
                  const inCart   = cart.find(ci => ci.key === `${p.id}-${v.name}`);
                  return (
                    <button
                      key={i}
                      onClick={() => handleSize(v)}
                      className={cn(
                        'min-w-[36px] h-9 px-2 rounded-lg border text-xs font-bold transition-all duration-150 relative',
                        selected
                          ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                          : 'border-gray-200 text-gray-700 hover:border-gray-400 bg-white'
                      )}
                    >
                      {label}
                      {inCart && !selected && (
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-blue-500 rounded-full border border-white" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Stepper de quantidade + botão */}
            {selVar ? (
              <div className="flex gap-2 items-center mt-1">
                <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden shrink-0">
                  <button
                    onClick={() => setQty(q => Math.max(1, q - 1))}
                    className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <span className="w-8 text-center text-sm font-bold text-gray-900">{qty}</span>
                  <button
                    onClick={() => setQty(q => q + 1)}
                    className="w-9 h-9 flex items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  onClick={handleAdd}
                  className="flex-1 h-9 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-xl text-xs font-bold transition-colors"
                >
                  {inCartVar ? `+ Adicionar` : 'Adicionar'}
                </button>
              </div>
            ) : (
              <button
                disabled
                className="w-full h-9 bg-gray-100 text-gray-400 rounded-xl text-xs font-semibold cursor-not-allowed mt-1"
              >
                {hasGenders && !selGender ? 'Selecione o gênero' : 'Selecione o tamanho'}
              </button>
            )}

            {/* Indicador de já está no carrinho */}
            {inCartVar && selVar && (
              <div className="flex items-center justify-between bg-blue-50 rounded-xl px-3 py-2">
                <span className="text-xs text-blue-700 font-medium">No carrinho: {inCartVar.quantity} un.</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => onQty(inCartVar.key, -1)} className="w-6 h-6 rounded-full border border-blue-200 flex items-center justify-center hover:bg-blue-100">
                    <Minus className="w-3 h-3 text-blue-600" />
                  </button>
                  <button onClick={() => onQty(inCartVar.key, 1)} className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </div>

        ) : (
          /* Sem variações */
          <div className="mt-auto">
            {inCartNoVar ? (
              <div className="flex items-center justify-between bg-blue-50 rounded-xl px-3 py-2">
                <span className="text-xs text-blue-700 font-medium">No carrinho: {inCartNoVar.quantity} un.</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => onQty(inCartNoVar.key, -1)} className="w-6 h-6 rounded-full border border-blue-200 flex items-center justify-center hover:bg-blue-100">
                    <Minus className="w-3 h-3 text-blue-600" />
                  </button>
                  <button onClick={() => onQty(inCartNoVar.key, 1)} className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => onAdd(p, null, 1)}
                className="w-full h-9 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-colors"
              >
                Adicionar ao carrinho
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── ProductImageCarousel ─────────────────────────────────────────────────── */
function ProductImageCarousel({ product }) {
  const [idx, setIdx] = useState(0);
  const images = product.images?.length ? product.images : (product.image ? [product.image] : []);

  if (images.length === 0) {
    return (
      <div className="aspect-square bg-gray-50 flex items-center justify-center">
        <Package className="w-10 h-10 text-gray-200" />
      </div>
    );
  }

  const prev = (e) => { e.stopPropagation(); setIdx(i => (i - 1 + images.length) % images.length); };
  const next = (e) => { e.stopPropagation(); setIdx(i => (i + 1) % images.length); };

  return (
    <div className="relative aspect-square overflow-hidden bg-gray-50 group">
      <img src={images[idx]} alt={product.name} className="w-full h-full object-cover transition-opacity duration-200" />
      {images.length > 1 && (
        <>
          <button onClick={prev} className="absolute left-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={next} className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <ChevronRight className="w-4 h-4" />
          </button>
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
            {images.map((_, i) => (
              <button key={i} onClick={(e) => { e.stopPropagation(); setIdx(i); }}
                className={cn('w-1.5 h-1.5 rounded-full transition-colors', i === idx ? 'bg-white' : 'bg-white/40')}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Package({ className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}
