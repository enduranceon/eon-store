import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ShoppingCart, Plus, Minus, Trash2, Store, ChevronRight, ChevronLeft, Lock, Tag, CheckCircle2, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PreSaleProduct, PreSaleOrder, PreSaleTrainer, findOrCreateCustomer, getCampaignBySlugOrId } from '@/api/entities';
import { normalizePhone, normalizeEmail } from '@/api/db';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import CouponInput from '@/components/CouponInput';
import { computeDiscount, validateCoupon, recordCouponUse } from '@/lib/coupon';

const extrasTotal = (extras) => (extras || []).reduce((s, e) => s + (e.price || 0), 0);

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
  const [form, setForm] = useState({ full_name: '', whatsapp: '', email: '', trainer: '', delivery_method: '', delivery_city: '', payment_method: '' });
  const [submitting, setSubmitting] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [appliedCoupon, setAppliedCoupon] = useState(null);

  useEffect(() => { PreSaleTrainer.list().then(setTrainers); }, []);
  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }, [cart]);

  useEffect(() => {
    getCampaignBySlugOrId(campaignId)
      .then(c => {
        setCampaign(c);
        return PreSaleProduct.list().then(p => {
          const active = p.filter(prod =>
            prod.status === 'active' &&
            ((prod.campaign_ids || []).includes(c.id) || prod.campaign_id === c.id)
          );
          if (c.product_order?.length) {
            active.sort((a, b) => {
              const ia = c.product_order.indexOf(a.id);
              const ib = c.product_order.indexOf(b.id);
              return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            });
          }
          setProducts(active);
          setCart(prev => {
            if (prev.length === 0) return prev;
            let changed = false;
            const reconciled = prev.filter(item => {
              const prod = active.find(p => p.id === item.product.id);
              if (!prod) { changed = true; return false; }
              return true;
            }).map(item => {
              const prod = active.find(p => p.id === item.product.id);
              const variation = item.variation ? (prod.variations || []).find(v => v.name === item.variation.name) : null;
              const freshSale    = variation?.sale_price    ?? prod.sale_price    ?? 0;
              const freshRegular = variation?.regular_price ?? prod.regular_price ?? 0;
              const freshProdExtras = prod.extras || [];
              const reconciledExtras = (item.extras || [])
                .map(e => { const fe = freshProdExtras.find(pe => pe.name === e.name); return fe ? { name: fe.name, price: fe.price || 0 } : null; })
                .filter(Boolean);
              const priceChanged = item.sale_price !== freshSale || item.regular_price !== freshRegular;
              const extrasChanged = reconciledExtras.length !== (item.extras || []).length ||
                reconciledExtras.some((e, i) => e.price !== (item.extras || [])[i]?.price);
              const extrasKey = reconciledExtras.map(e => e.name).sort().join('+');
              const correctKey = `${prod.id}-${variation?.name || ''}-${extrasKey}`;
              if (priceChanged || extrasChanged || item.key !== correctKey) {
                changed = true;
                return { ...item, key: correctKey, product: prod, variation: variation || item.variation, sale_price: freshSale, regular_price: freshRegular, extras: reconciledExtras };
              }
              return { ...item, product: prod };
            });
            if (changed) toast.info('Carrinho atualizado com os preços mais recentes');
            return changed ? reconciled : prev;
          });
        });
      })
      .catch(() => setNotFound(true));
  }, [campaignId]);

  const cartTotal = cart.reduce((acc, i) => acc + (i.sale_price + extrasTotal(i.extras)) * i.quantity, 0);
  const cartCount = cart.reduce((acc, i) => acc + i.quantity, 0);
  const cartSavings = cart.reduce((acc, i) => {
    const reg = i.regular_price || 0;
    return acc + (reg > i.sale_price ? (reg - i.sale_price) * i.quantity : 0);
  }, 0);

  // Desconto recalcula automaticamente quando o carrinho muda
  const discount   = appliedCoupon ? computeDiscount(appliedCoupon, cartTotal) : 0;
  const finalTotal = Math.max(0, cartTotal - discount);

  // Mantém o cupom consistente quando o subtotal muda
  useEffect(() => {
    if (appliedCoupon?.min_purchase && cartTotal < Number(appliedCoupon.min_purchase)) {
      toast.warning(`Cupom ${appliedCoupon.code} removido — pedido abaixo do mínimo`);
      setAppliedCoupon(null);
    }
  }, [cartTotal, appliedCoupon]);

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

  const campaignExpired = campaign.end_date && new Date() > new Date(campaign.end_date + 'T23:59:59');
  if (campaign.status !== 'active' || campaignExpired) {
    const deliveryDate = campaign.end_date && campaign.delivery_days
      ? new Date(new Date(campaign.end_date).getTime() + campaign.delivery_days * 86400000)
      : null;
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="bg-[#1a1a2e] text-white py-4 px-4">
          <div className="max-w-lg mx-auto flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center shrink-0">
              <Store className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-xs text-blue-300 font-medium tracking-wide uppercase">EON Store</p>
              <h1 className="text-sm font-bold leading-none">{campaign.name}</h1>
            </div>
          </div>
        </header>
        <div className="max-w-lg mx-auto px-4 py-12 text-center space-y-6">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto">
            <Store className="w-8 h-8 text-amber-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Pré-venda encerrada</h2>
            <p className="text-gray-500 mt-2">O período de pedidos desta campanha foi encerrado.</p>
          </div>
          {deliveryDate && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-6 text-left space-y-3">
              <p className="font-bold text-blue-900 text-lg">🚚 Entregas a partir de</p>
              <p className="text-3xl font-bold text-blue-700">
                {deliveryDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}
              </p>
              <p className="text-sm text-blue-700">
                Pedido encaminhado ao fornecedor. Assim que os produtos chegarem, as entregas serão organizadas.
              </p>
            </div>
          )}
          {!deliveryDate && (
            <p className="text-gray-500 text-sm">Em breve as informações de entrega serão divulgadas.</p>
          )}
        </div>
      </div>
    );
  }

  const addToCart = (product, variation = null, qty = 1, extras = []) => {
    const extrasKey = extras.map(e => e.name).sort().join('+');
    const key = `${product.id}-${variation?.name || ''}-${extrasKey}`;
    setCart(prev => {
      const existing = prev.find(i => i.key === key);
      if (existing) return prev.map(i => i.key === key ? { ...i, quantity: i.quantity + qty } : i);
      const salePrice    = variation?.sale_price    ?? product.sale_price    ?? 0;
      const regularPrice = variation?.regular_price ?? product.regular_price ?? 0;
      return [...prev, { key, product, variation, extras, quantity: qty, sale_price: salePrice, regular_price: regularPrice }];
    });
    const extrasDesc = extras.length > 0 ? ` + ${extras.map(e => e.name).join(', ')}` : '';
    toast.success(`${product.name}${variation ? ' — ' + variation.name : ''}${extrasDesc} adicionado!`);
  };

  const updateQty = (key, delta) => {
    setCart(prev => {
      const updated = prev.map(i => i.key === key ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i);
      return updated.filter(i => i.quantity > 0);
    });
  };

  const removeFromCart = (key) => setCart(prev => prev.filter(i => i.key !== key));

  const handleSubmit = async () => {
    if (form.full_name.trim().length < 3) return toast.error('Informe seu nome completo');
    const cleanWhatsapp = normalizePhone(form.whatsapp);
    if (cleanWhatsapp.length < 10 || cleanWhatsapp.length > 11) return toast.error('WhatsApp inválido. Informe DDD + número (10 ou 11 dígitos)');
    if (cart.length === 0) return toast.error('Adicione produtos ao carrinho');
    if (!form.delivery_method) return toast.error('Selecione a forma de entrega');
    if (form.delivery_method === 'pickup' && !form.delivery_city) return toast.error('Selecione a cidade de retirada');
    if (!form.payment_method) return toast.error('Selecione a forma de pagamento');
    setSubmitting(true);
    try {
      const freshCampaign = await getCampaignBySlugOrId(campaignId);
      const nowExpired = freshCampaign.end_date && new Date() > new Date(freshCampaign.end_date + 'T23:59:59');
      if (freshCampaign.status !== 'active' || nowExpired) {
        toast.error('Esta pré-venda foi encerrada. Não é possível finalizar o pedido.');
        setSubmitting(false);
        return;
      }

      // Re-fetch products to validate prices server-side
      const freshProducts = await PreSaleProduct.list();
      const validatedItems = cart.map(i => {
        const prod = freshProducts.find(p => p.id === i.product.id);
        if (!prod) throw new Error(`Produto "${i.product.name}" não está mais disponível.`);
        const variation = i.variation ? (prod.variations || []).find(v => v.name === i.variation.name) : null;
        const freshSale = variation?.sale_price ?? prod.sale_price ?? 0;
        const freshCost = variation?.cost_price ?? prod.cost_price ?? 0;
        if (Math.round(i.sale_price * 100) !== Math.round(freshSale * 100)) throw new Error(`O preço de "${prod.name}" foi atualizado. Recarregue a página.`);
        if (!Number.isInteger(i.quantity) || i.quantity <= 0) throw new Error('Quantidade inválida no carrinho.');
        const freshProdExtras = prod.extras || [];
        const validatedExtras = (i.extras || []).map(sel => {
          const fe = freshProdExtras.find(e => e.name === sel.name);
          if (!fe) throw new Error(`O adicional "${sel.name}" não está mais disponível. Recarregue a página.`);
          if (Math.round(sel.price * 100) !== Math.round((fe.price || 0) * 100)) throw new Error(`O preço do adicional "${sel.name}" foi atualizado. Recarregue a página.`);
          return { name: fe.name, price: fe.price || 0 };
        });
        const itemExtrasTotal = validatedExtras.reduce((s, e) => s + e.price, 0);
        return {
          product_id: prod.id,
          product_name: prod.name,
          variation: variation?.name || null,
          extras: validatedExtras,
          extras_total: itemExtrasTotal,
          quantity: i.quantity,
          sale_price: freshSale,
          cost_price: freshCost,
        };
      });

      const freshSubtotal = validatedItems.reduce((acc, i) => acc + (i.sale_price + i.extras_total) * i.quantity, 0);
      const freshCostTotal = validatedItems.reduce((acc, i) => acc + i.cost_price * i.quantity, 0);

      // Revalida cupom (caso tenha expirado/esgotado entre apply e submit)
      let finalDiscount = 0;
      let validatedCoupon = null;
      if (appliedCoupon) {
        const recheck = await validateCoupon(appliedCoupon.code, freshSubtotal, cleanWhatsapp);
        if (!recheck.ok) {
          toast.error(`Cupom ${appliedCoupon.code}: ${recheck.error}`);
          setAppliedCoupon(null);
          setSubmitting(false);
          return;
        }
        validatedCoupon = recheck.coupon;
        finalDiscount = recheck.discount;
      }
      const freshTotal = Math.max(0, freshSubtotal - finalDiscount);

      const trainerValue = form.trainer === '__outro' ? '' : form.trainer;
      const cleanEmail = normalizeEmail(form.email);
      const customer = await findOrCreateCustomer({ ...form, whatsapp: cleanWhatsapp, email: cleanEmail, trainer: trainerValue });
      const order = await PreSaleOrder.create({
        campaign_id: campaign.id,
        customer_id: customer.id,
        checkout_name: form.full_name,
        checkout_whatsapp: cleanWhatsapp,
        checkout_email: cleanEmail,
        checkout_trainer: trainerValue,
        items: validatedItems,
        total_value: freshTotal,
        total_cost: freshCostTotal,
        delivery_method: form.delivery_method,
        delivery_city: form.delivery_city || null,
        payment_method: form.payment_method || null,
        payment_status: 'awaiting_charge',
        due_date: null,
        delivery_status: 'awaiting_supplier',
        coupon_code: validatedCoupon?.code || null,
        discount_value: finalDiscount,
      });

      // Registra uso do cupom (não bloqueia o fluxo se falhar)
      if (validatedCoupon) {
        await recordCouponUse({
          coupon: validatedCoupon,
          order,
          orderType: 'presale',
          customerIdentifier: cleanWhatsapp,
          customerName: form.full_name,
          discount: finalDiscount,
        });
      }

      localStorage.removeItem(CART_KEY);
      navigate(`/confirmacao/${order.id}`, { state: { order, campaignName: campaign.name } });
    } catch (e) {
      toast.error(e.message || 'Erro ao finalizar pedido. Tente novamente.');
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

      {/* ── Barra de pré-venda ─────────────────────────────────────────── */}
      {(campaign.end_date || campaign.delivery_days) && (() => {
        const now = new Date();
        const end = campaign.end_date ? new Date(campaign.end_date) : null;
        const daysLeft = end ? Math.max(0, Math.ceil((end - now) / 86400000)) : null;
        const deliveryEnd = end && campaign.delivery_days
          ? new Date(end.getTime() + campaign.delivery_days * 86400000) : null;
        return (
          <div className="bg-amber-50 border-b border-amber-200 sticky top-16 z-10">
            <div className="max-w-6xl mx-auto px-4 py-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-amber-800">
              <span className="font-bold uppercase tracking-widest bg-amber-300 text-amber-950 px-2.5 py-0.5 rounded-full text-[10px]">
                Pré-venda
              </span>
              {end && (
                <span className="flex items-center gap-1.5">
                  <span>📅</span>
                  <span>Aberta até <strong>{end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</strong></span>
                  {daysLeft > 0 && <span className="font-semibold bg-amber-200 px-1.5 py-0.5 rounded-full">{daysLeft} {daysLeft === 1 ? 'dia restante' : 'dias restantes'}</span>}
                  {daysLeft === 0 && <span className="font-semibold text-red-600">· Encerra hoje!</span>}
                </span>
              )}
              {deliveryEnd && (
                <span className="flex items-center gap-1.5">
                  <span>🚚</span>
                  <span>Entregas a partir de <strong>{deliveryEnd.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}</strong></span>
                </span>
              )}
            </div>
          </div>
        );
      })()}

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
                    <ProductCard key={p.id} product={p} cart={cart} onAdd={addToCart} onQty={updateQty} onOpen={setSelectedProduct} />
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

            {/* Lembrete pré-venda */}
            {(campaign.end_date || campaign.delivery_days) && (() => {
              const end = campaign.end_date ? new Date(campaign.end_date) : null;
              const deliveryEnd = end && campaign.delivery_days
                ? new Date(end.getTime() + campaign.delivery_days * 86400000) : null;
              return (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800 space-y-1">
                  <p className="font-semibold text-amber-900">⚠️ Atenção: isso é uma pré-venda</p>
                  {end && <p>Os pedidos ficam abertos até <strong>{end.toLocaleDateString('pt-BR')}</strong>. Após essa data, realizamos o pedido ao fornecedor.</p>}
                  {deliveryEnd && <p>🚚 Entregas a partir de <strong>{deliveryEnd.toLocaleDateString('pt-BR')}</strong>.</p>}
                </div>
              );
            })()}

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
                      {(i.extras || []).map((e, idx) => (
                        <p key={idx} className="text-xs text-blue-600 mt-0.5">+ {e.name} · {formatCurrency(e.price)}</p>
                      ))}
                      <div className="flex items-center gap-2 mt-1.5">
                        <button onClick={() => updateQty(i.key, -1)} className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors">
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="text-sm font-bold w-5 text-center">{i.quantity}</span>
                        <button onClick={() => updateQty(i.key, 1)} className="w-6 h-6 rounded-full bg-gray-900 text-white flex items-center justify-center hover:bg-black transition-colors">
                          <Plus className="w-3 h-3" />
                        </button>
                        <span className="text-xs text-gray-400 ml-1">{formatCurrency(i.sale_price + extrasTotal(i.extras))} cada</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <p className="text-sm font-bold text-gray-900">{formatCurrency((i.sale_price + extrasTotal(i.extras)) * i.quantity)}</p>
                      <button onClick={() => removeFromCart(i.key)} className="text-gray-300 hover:text-red-400 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-5 py-4 bg-gray-50 space-y-2">
                {cartSavings > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-green-600 font-medium flex items-center gap-1"><Tag className="w-3.5 h-3.5" /> Economia da pré-venda</span>
                    <span className="text-green-600 font-bold">-{formatCurrency(cartSavings)}</span>
                  </div>
                )}

                {/* Cupom de desconto */}
                <div className="py-1">
                  <CouponInput
                    subtotal={cartTotal}
                    customerIdentifier={normalizePhone(form.whatsapp)}
                    applied={appliedCoupon ? { code: appliedCoupon.code, discount } : null}
                    onApply={(c) => setAppliedCoupon(c)}
                    onRemove={() => setAppliedCoupon(null)}
                  />
                </div>

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

            {/* Forma de pagamento */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-bold text-gray-900">Forma de pagamento</h3>
                <p className="text-xs text-gray-500 mt-0.5">Qual método você prefere usar?</p>
              </div>
              <div className="px-5 py-4 space-y-3">
                <label className={cn(
                  'flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all',
                  form.payment_method === 'pix_boleto'
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                )}>
                  <input
                    type="radio"
                    name="payment_method"
                    value="pix_boleto"
                    checked={form.payment_method === 'pix_boleto'}
                    onChange={() => setForm(f => ({ ...f, payment_method: 'pix_boleto' }))}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">PIX ou Boleto</p>
                    <p className="text-xs text-gray-500 mt-0.5">Pagamento à vista</p>
                  </div>
                </label>

                <label className={cn(
                  'flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all',
                  form.payment_method.startsWith('card_')
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                )}>
                  <input
                    type="radio"
                    name="payment_method"
                    value="card"
                    checked={form.payment_method.startsWith('card_')}
                    onChange={() => setForm(f => ({ ...f, payment_method: 'card_1x' }))}
                    className="mt-0.5 accent-blue-600"
                  />
                  <div className="flex-1">
                    <p className="font-semibold text-gray-900 text-sm">Cartão de crédito</p>
                    <p className="text-xs text-gray-500 mt-0.5">Em até 6x</p>

                    {form.payment_method.startsWith('card_') && (
                      <div className="grid grid-cols-3 gap-2 mt-3">
                        {Array.from({ length: Math.min(6, Math.max(1, Math.floor(finalTotal / 50))) }, (_, i) => i + 1).map(n => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setForm(f => ({ ...f, payment_method: `card_${n}x` }))}
                            className={cn(
                              'py-2.5 rounded-xl border-2 text-xs font-bold transition-all',
                              form.payment_method === `card_${n}x`
                                ? 'border-blue-500 bg-blue-500 text-white'
                                : 'border-gray-200 text-gray-700 hover:border-blue-300 bg-white'
                            )}
                          >
                            <p>{n}x</p>
                            <p className={cn('font-normal mt-0.5', form.payment_method === `card_${n}x` ? 'text-blue-100' : 'text-gray-400')}>
                              {formatCurrency(finalTotal / n)}
                            </p>
                          </button>
                        ))}
                      </div>
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
                  <>Finalizar pedido · {formatCurrency(finalTotal)}</>
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

      {selectedProduct && (
        <ProductDetailModal
          product={selectedProduct}
          cart={cart}
          onAdd={(p, v, q) => { addToCart(p, v, q); }}
          onQty={updateQty}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}

/* ── ProductCard ──────────────────────────────────────────────────────────── */
function ProductCard({ product: p, cart, onAdd, onQty, onOpen }) {
  const variations  = p.variations || [];
  const genders     = [...new Set(variations.map(v => v.gender).filter(Boolean))];
  const hasGenders  = genders.length > 0;
  const hasVars     = variations.length > 0;
  const productExtras = p.extras || [];

  const [selGender, setSelGender] = useState(null);
  const [selVar,    setSelVar]    = useState(null);
  const [qty,       setQty]       = useState(1);
  const [selExtras, setSelExtras] = useState(() =>
    productExtras.filter(e => e.required).map(e => ({ name: e.name, price: e.price || 0 }))
  );

  const visibleVars = hasGenders
    ? (selGender ? variations.filter(v => v.gender === selGender) : [])
    : variations;

  const extrasKey    = selExtras.map(e => e.name).sort().join('+');
  const currentKey   = `${p.id}-${selVar?.name || ''}-${extrasKey}`;
  const inCart       = cart.find(i => i.key === currentKey);

  const toggleExtra = (extra) => {
    if (extra.required) return;
    setSelExtras(prev =>
      prev.find(e => e.name === extra.name)
        ? prev.filter(e => e.name !== extra.name)
        : [...prev, { name: extra.name, price: extra.price || 0 }]
    );
  };

  const requiredMet  = productExtras.filter(e => e.required).every(r => selExtras.find(e => e.name === r.name));
  const selectedExtrasCost = extrasTotal(selExtras);

  const handleGender = (g) => { setSelGender(g === selGender ? null : g); setSelVar(null); setQty(1); };
  const handleSize   = (v) => { setSelVar(selVar?.name === v.name ? null : v); setQty(1); };
  const handleAdd    = () => { onAdd(p, selVar, qty, selExtras); setSelVar(null); setQty(1); };

  const displayPrice   = selVar?.sale_price   || p.sale_price   || 0;
  const displayRegular = selVar?.regular_price || p.regular_price || 0;
  const discountPct    = displayRegular > displayPrice
    ? Math.round((1 - displayPrice / displayRegular) * 100) : 0;

  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col border border-gray-100">

      {/* Imagem */}
      <div className="cursor-pointer" onClick={() => onOpen(p)}>
        <ProductImageCarousel product={p} />
      </div>

      {/* Conteúdo */}
      <div className="p-3 flex flex-col flex-1 gap-2">

        {/* Nome */}
        <div className="cursor-pointer" onClick={() => onOpen(p)}>
          <h3 className="font-semibold text-gray-900 text-sm leading-snug line-clamp-2">{p.name}</h3>
          {p.supplier && <p className="text-xs text-gray-400 mt-0.5">{p.supplier}</p>}
        </div>

        {/* Preço */}
        <div>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-lg font-bold text-gray-900">
              {formatCurrency(displayPrice + selectedExtrasCost)}
            </span>
            {discountPct > 0 && (
              <span className="text-xs text-gray-400 line-through">{formatCurrency(displayRegular)}</span>
            )}
          </div>
          {selectedExtrasCost > 0 && (
            <span className="text-xs text-blue-600">{formatCurrency(displayPrice)} + {formatCurrency(selectedExtrasCost)} adicionais</span>
          )}
          {discountPct > 0 && (
            <span className="inline-block text-[11px] font-bold bg-green-500 text-white px-1.5 py-0.5 rounded-md mt-0.5">
              {discountPct}% OFF
            </span>
          )}
        </div>

        {/* Adicionais */}
        {productExtras.length > 0 && (
          <div className="space-y-1">
            {productExtras.map((extra, i) => {
              const sel = selExtras.find(e => e.name === extra.name);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleExtra(extra)}
                  disabled={extra.required}
                  className={cn(
                    'w-full flex items-center justify-between px-2 py-1.5 rounded-lg border text-xs transition-all',
                    sel
                      ? 'bg-blue-50 border-blue-400 text-blue-800 font-medium'
                      : 'border-gray-200 text-gray-600 hover:border-blue-300',
                    extra.required && 'cursor-default'
                  )}
                >
                  <span>{extra.required && <span className="text-red-500 mr-0.5">*</span>}{extra.name}{extra.required && <span className="text-gray-400 ml-1 font-normal">(obrigatório)</span>}</span>
                  <span className={sel ? 'text-blue-700 font-semibold' : 'text-gray-400'}>+{formatCurrency(extra.price || 0)}</span>
                </button>
              );
            })}
          </div>
        )}

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
                  const varInCart = cart.some(ci => ci.key.startsWith(`${p.id}-${v.name}-`));
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
                      {varInCart && !selected && (
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
                  disabled={!requiredMet}
                  className={cn('flex-1 h-9 rounded-xl text-xs font-bold transition-colors',
                    requiredMet
                      ? 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  )}
                >
                  {!requiredMet ? 'Selecione os adicionais' : inCart ? '+ Adicionar' : 'Adicionar'}
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
            {inCart && selVar && (
              <div className="flex items-center justify-between bg-blue-50 rounded-xl px-3 py-2">
                <span className="text-xs text-blue-700 font-medium">No carrinho: {inCart.quantity} un.</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => onQty(inCart.key, -1)} className="w-6 h-6 rounded-full border border-blue-200 flex items-center justify-center hover:bg-blue-100">
                    <Minus className="w-3 h-3 text-blue-600" />
                  </button>
                  <button onClick={() => onQty(inCart.key, 1)} className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </div>

        ) : (
          /* Sem variações */
          <div className="mt-auto">
            {inCart ? (
              <div className="flex items-center justify-between bg-blue-50 rounded-xl px-3 py-2">
                <span className="text-xs text-blue-700 font-medium">No carrinho: {inCart.quantity} un.</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => onQty(inCart.key, -1)} className="w-6 h-6 rounded-full border border-blue-200 flex items-center justify-center hover:bg-blue-100">
                    <Minus className="w-3 h-3 text-blue-600" />
                  </button>
                  <button onClick={() => onQty(inCart.key, 1)} className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => onAdd(p, null, 1, selExtras)}
                disabled={!requiredMet}
                className={cn('w-full h-9 rounded-xl text-xs font-bold transition-colors',
                  requiredMet
                    ? 'bg-blue-600 hover:bg-blue-700 text-white'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                )}
              >
                {requiredMet ? 'Adicionar ao carrinho' : 'Selecione os adicionais'}
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

/* ── ProductDetailModal ───────────────────────────────────────────────────── */
function ProductDetailModal({ product: p, cart, onAdd, onQty, onClose }) {
  const variations     = p.variations || [];
  const genders        = [...new Set(variations.map(v => v.gender).filter(Boolean))];
  const hasGenders     = genders.length > 0;
  const hasVars        = variations.length > 0;
  const productExtras  = p.extras || [];

  const [selGender, setSelGender] = useState(null);
  const [selVar,    setSelVar]    = useState(null);
  const [qty,       setQty]       = useState(1);
  const [imgIdx,    setImgIdx]    = useState(0);
  const [selExtras, setSelExtras] = useState(() =>
    productExtras.filter(e => e.required).map(e => ({ name: e.name, price: e.price || 0 }))
  );

  const images = p.images?.length ? p.images : (p.image ? [p.image] : []);

  const visibleVars = hasGenders
    ? (selGender ? variations.filter(v => v.gender === selGender) : [])
    : variations;

  const extrasKey   = selExtras.map(e => e.name).sort().join('+');
  const currentKey  = `${p.id}-${selVar?.name || ''}-${extrasKey}`;
  const inCart      = cart.find(i => i.key === currentKey);

  const toggleExtra = (extra) => {
    if (extra.required) return;
    setSelExtras(prev =>
      prev.find(e => e.name === extra.name)
        ? prev.filter(e => e.name !== extra.name)
        : [...prev, { name: extra.name, price: extra.price || 0 }]
    );
  };

  const requiredMet        = productExtras.filter(e => e.required).every(r => selExtras.find(e => e.name === r.name));
  const selectedExtrasCost = extrasTotal(selExtras);

  const handleGender = (g) => { setSelGender(g === selGender ? null : g); setSelVar(null); setQty(1); };
  const handleSize   = (v) => { setSelVar(selVar?.name === v.name ? null : v); setQty(1); };
  const handleAdd    = () => { onAdd(p, selVar, qty, selExtras); setSelVar(null); setQty(1); };

  const displayPrice   = selVar?.sale_price   || p.sale_price   || 0;
  const displayRegular = selVar?.regular_price || p.regular_price || 0;
  const discountPct    = displayRegular > displayPrice
    ? Math.round((1 - displayPrice / displayRegular) * 100) : 0;

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-3xl max-h-[92vh] overflow-y-auto"
        style={{ animation: 'slideUp 0.3s ease-out' }}
      >

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/60 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Image gallery */}
        {images.length > 0 ? (
          <div className="relative">
            <div className="bg-gray-50 flex items-center justify-center">
              <img src={images[imgIdx]} alt={p.name} className="w-full h-auto max-h-[70vh] object-contain" />
            </div>
            {images.length > 1 && (
              <>
                <button
                  onClick={() => setImgIdx(i => (i - 1 + images.length) % images.length)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/60 transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setImgIdx(i => (i + 1) % images.length)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center hover:bg-black/60 transition-colors"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                  {images.map((_, i) => (
                    <button key={i} onClick={() => setImgIdx(i)}
                      className={cn('w-2 h-2 rounded-full transition-colors', i === imgIdx ? 'bg-white' : 'bg-white/40')}
                    />
                  ))}
                </div>
              </>
            )}
            {/* Thumbnails */}
            {images.length > 1 && (
              <div className="flex gap-2 px-5 py-3 overflow-x-auto bg-gray-50/50">
                {images.map((img, i) => (
                  <button
                    key={i}
                    onClick={() => setImgIdx(i)}
                    className={cn(
                      'w-14 h-14 rounded-xl overflow-hidden shrink-0 border-2 transition-all',
                      i === imgIdx ? 'border-blue-500 shadow-md' : 'border-transparent opacity-60 hover:opacity-100'
                    )}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="aspect-[16/10] bg-gray-50 flex items-center justify-center">
            <Package className="w-16 h-16 text-gray-200" />
          </div>
        )}

        {/* Product info */}
        <div className="px-5 pt-4 pb-6 space-y-4">
          {/* Name & supplier */}
          <div>
            {p.category && (
              <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide mb-1">{p.category}{p.subcategory ? ` · ${p.subcategory}` : ''}</p>
            )}
            <h2 className="text-xl font-bold text-gray-900 leading-tight">{p.name}</h2>
            {p.supplier && <p className="text-sm text-gray-500 mt-1">{p.supplier}</p>}
          </div>

          {/* Price */}
          <div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl font-bold text-gray-900">{formatCurrency(displayPrice + selectedExtrasCost)}</span>
              {discountPct > 0 && (
                <>
                  <span className="text-base text-gray-400 line-through">{formatCurrency(displayRegular)}</span>
                  <span className="text-sm font-bold bg-green-500 text-white px-2 py-0.5 rounded-lg">
                    {discountPct}% OFF
                  </span>
                </>
              )}
            </div>
            {selectedExtrasCost > 0 && (
              <p className="text-sm text-blue-600 mt-0.5">{formatCurrency(displayPrice)} + {formatCurrency(selectedExtrasCost)} em adicionais</p>
            )}
            {discountPct > 0 && (
              <p className="text-sm text-green-600 font-medium mt-1">
                Economia de {formatCurrency(displayRegular - displayPrice)} na pré-venda
              </p>
            )}
          </div>

          {/* Description / Notes */}
          {p.notes && (
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">{p.notes}</p>
            </div>
          )}

          {/* Adicionais */}
          {productExtras.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Adicionais</p>
              <div className="space-y-2">
                {productExtras.map((extra, i) => {
                  const sel = selExtras.find(e => e.name === extra.name);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleExtra(extra)}
                      disabled={extra.required}
                      className={cn(
                        'w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 text-sm transition-all',
                        sel
                          ? 'bg-blue-50 border-blue-400 text-blue-900 font-medium'
                          : 'border-gray-200 text-gray-700 hover:border-blue-300',
                        extra.required && 'cursor-default'
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className={cn('w-4 h-4 rounded border-2 flex items-center justify-center shrink-0', sel ? 'bg-blue-600 border-blue-600' : 'border-gray-300')}>
                          {sel && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 10 8"><path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        </span>
                        {extra.name}
                        {extra.required && <span className="text-xs text-gray-400">(obrigatório)</span>}
                      </span>
                      <span className={cn('font-semibold', sel ? 'text-blue-700' : 'text-gray-500')}>
                        +{formatCurrency(extra.price || 0)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Variations */}
          {hasVars ? (
            <div className="space-y-3">
              {/* Gender selector */}
              {hasGenders && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Gênero</p>
                  <div className="flex gap-2 flex-wrap">
                    {genders.map(g => (
                      <button
                        key={g}
                        onClick={() => handleGender(g)}
                        className={cn(
                          'px-4 py-2 rounded-xl border-2 font-semibold text-sm transition-all duration-150',
                          selGender === g
                            ? 'bg-gray-900 text-white border-gray-900'
                            : 'border-gray-200 text-gray-600 hover:border-gray-400'
                        )}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Size selector */}
              {visibleVars.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Tamanho</p>
                  <div className="flex gap-2 flex-wrap">
                    {visibleVars.map((v, i) => {
                      const label    = v.size || v.name;
                      const selected = selVar?.name === v.name;
                      const varInCart = cart.some(ci => ci.key.startsWith(`${p.id}-${v.name}-`));
                      return (
                        <button
                          key={i}
                          onClick={() => handleSize(v)}
                          className={cn(
                            'min-w-[44px] h-11 px-3 rounded-xl border-2 text-sm font-bold transition-all duration-150 relative',
                            selected
                              ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                              : 'border-gray-200 text-gray-700 hover:border-gray-400 bg-white'
                          )}
                        >
                          {label}
                          {varInCart && !selected && (
                            <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full border-2 border-white" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Qty + Add to cart */}
              {selVar ? (
                <div className="flex gap-3 items-center pt-2">
                  <div className="flex items-center border-2 border-gray-200 rounded-xl overflow-hidden shrink-0">
                    <button
                      onClick={() => setQty(q => Math.max(1, q - 1))}
                      className="w-11 h-11 flex items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <span className="w-10 text-center text-base font-bold text-gray-900">{qty}</span>
                    <button
                      onClick={() => setQty(q => q + 1)}
                      className="w-11 h-11 flex items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    onClick={handleAdd}
                    disabled={!requiredMet}
                    className={cn('flex-1 h-12 rounded-xl font-bold text-sm transition-colors',
                      requiredMet
                        ? 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    )}
                  >
                    {!requiredMet ? 'Selecione os adicionais obrigatórios' : `Adicionar · ${formatCurrency((displayPrice + selectedExtrasCost) * qty)}`}
                  </button>
                </div>
              ) : (
                <button
                  disabled
                  className="w-full h-12 bg-gray-100 text-gray-400 rounded-xl font-semibold cursor-not-allowed"
                >
                  {hasGenders && !selGender ? 'Selecione o gênero' : 'Selecione o tamanho'}
                </button>
              )}

              {/* Already in cart indicator */}
              {inCart && selVar && (
                <div className="flex items-center justify-between bg-blue-50 rounded-xl px-4 py-3">
                  <span className="text-sm text-blue-700 font-medium">No carrinho: {inCart.quantity} un.</span>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => onQty(inCart.key, -1)} className="w-7 h-7 rounded-full border border-blue-200 flex items-center justify-center hover:bg-blue-100">
                      <Minus className="w-3.5 h-3.5 text-blue-600" />
                    </button>
                    <button onClick={() => onQty(inCart.key, 1)} className="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* No variations */
            <div>
              {inCart ? (
                <div className="flex items-center justify-between bg-blue-50 rounded-xl px-4 py-3">
                  <span className="text-sm text-blue-700 font-medium">No carrinho: {inCart.quantity} un.</span>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => onQty(inCart.key, -1)} className="w-7 h-7 rounded-full border border-blue-200 flex items-center justify-center hover:bg-blue-100">
                      <Minus className="w-3.5 h-3.5 text-blue-600" />
                    </button>
                    <button onClick={() => onQty(inCart.key, 1)} className="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { onAdd(p, null, 1, selExtras); }}
                  disabled={!requiredMet}
                  className={cn('w-full h-12 rounded-xl font-bold text-sm transition-colors',
                    requiredMet
                      ? 'bg-blue-600 hover:bg-blue-700 text-white'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  )}
                >
                  {!requiredMet ? 'Selecione os adicionais obrigatórios' : `Adicionar ao carrinho · ${formatCurrency(displayPrice + selectedExtrasCost)}`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
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
