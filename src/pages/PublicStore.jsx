import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Plus, Minus, Trash2, Store, ChevronRight, Lock, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StockProduct, StockOrder } from '@/api/entities';
import { normalizePhone, normalizeEmail } from '@/api/db';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import CouponInput from '@/components/CouponInput';
import { computeDiscount, validateCoupon, recordCouponUse } from '@/lib/coupon';

const CART_KEY = 'eon_loja_cart';

export default function PublicStore() {
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState('shop');
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
  });
  const [form, setForm] = useState({ name: '', whatsapp: '', email: '', payment_method: '', delivery_method: '', delivery_city: '' });
  const [submitting, setSubmitting] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState(null);

  useEffect(() => {
    StockProduct.list()
      .then(p => setProducts(p.filter(x => x.status === 'active')))
      .catch(() => toast.error('Erro ao carregar produtos'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }, [cart]);

  const addToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(i => i.product_id === product.id);
      if (existing) return prev.map(i => i.product_id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { product_id: product.id, product_name: product.name, sale_price: product.sale_price, cost_price: product.cost_price || 0, quantity: 1, image: product.images?.[0] || null }];
    });
    toast.success(`${product.name} adicionado!`);
  };

  const updateQty = (product_id, delta) => {
    setCart(prev => prev.map(i => i.product_id === product_id ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i).filter(i => i.quantity > 0));
  };

  const removeFromCart = (product_id) => setCart(prev => prev.filter(i => i.product_id !== product_id));

  const cartTotal = cart.reduce((acc, i) => acc + i.sale_price * i.quantity, 0);
  const cartCount = cart.reduce((acc, i) => acc + i.quantity, 0);

  const discount   = appliedCoupon ? computeDiscount(appliedCoupon, cartTotal) : 0;
  const finalTotal = Math.max(0, cartTotal - discount);
  const maxInstallments = Math.min(6, Math.max(1, Math.floor(finalTotal / 50)));

  useEffect(() => {
    if (appliedCoupon?.min_purchase && cartTotal < Number(appliedCoupon.min_purchase)) {
      toast.warning(`Cupom ${appliedCoupon.code} removido — pedido abaixo do mínimo`);
      setAppliedCoupon(null);
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
      // Re-validar preços e estoque
      const freshProducts = await StockProduct.list();
      const validatedItems = cart.map(i => {
        const prod = freshProducts.find(p => p.id === i.product_id);
        if (!prod || prod.status !== 'active') throw new Error(`"${i.product_name}" não está mais disponível.`);
        if (prod.quantity < i.quantity) throw new Error(`Estoque insuficiente para "${prod.name}". Disponível: ${prod.quantity} un.`);
        return { product_id: prod.id, product_name: prod.name, quantity: i.quantity, sale_price: prod.sale_price, cost_price: prod.cost_price || 0 };
      });

      const subtotal = validatedItems.reduce((acc, i) => acc + i.sale_price * i.quantity, 0);
      const cleanEmail = normalizeEmail(form.email);

      // Revalida cupom
      let finalDiscount = 0;
      let validatedCoupon = null;
      if (appliedCoupon) {
        const recheck = await validateCoupon(appliedCoupon.code, subtotal, cleanWhatsapp);
        if (!recheck.ok) {
          toast.error(`Cupom ${appliedCoupon.code}: ${recheck.error}`);
          setAppliedCoupon(null);
          setSubmitting(false);
          return;
        }
        validatedCoupon = recheck.coupon;
        finalDiscount = recheck.discount;
      }
      const total = Math.max(0, subtotal - finalDiscount);

      const order = await StockOrder.create({
        customer_name: form.name,
        customer_whatsapp: cleanWhatsapp,
        customer_email: cleanEmail || null,
        items: validatedItems,
        total_value: total,
        payment_method: form.payment_method,
        payment_status: 'awaiting_charge',
        due_date: null,
        delivery_status: 'awaiting_delivery',
        delivery_method: form.delivery_method,
        delivery_city: form.delivery_city || null,
        coupon_code: validatedCoupon?.code || null,
        discount_value: finalDiscount,
      });

      if (validatedCoupon) {
        await recordCouponUse({
          coupon: validatedCoupon,
          order,
          orderType: 'stock',
          customerIdentifier: cleanWhatsapp,
          customerName: form.name,
          discount: finalDiscount,
        });
      }

      localStorage.removeItem(CART_KEY);
      navigate(`/loja/confirmacao/${order.id}`, { state: { order } });
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
      <header className="bg-[#1a1a2e] text-white sticky top-0 z-20 shadow-md">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center shrink-0">
              <Store className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-xs text-blue-300 font-medium tracking-wide uppercase">EON Store</p>
              <h1 className="text-sm font-bold leading-none">Loja</h1>
            </div>
          </div>
          {step === 'shop' && cartCount > 0 && (
            <button
              onClick={() => setStep('checkout')}
              className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 transition-colors px-4 py-2 rounded-xl text-sm font-semibold"
            >
              <div className="relative">
                <ShoppingCart className="w-4 h-4" />
                <span className="absolute -top-2 -right-2 w-4 h-4 bg-red-500 rounded-full text-[10px] flex items-center justify-center font-bold">{cartCount}</span>
              </div>
              <span>{formatCurrency(cartTotal)}</span>
              <ChevronRight className="w-4 h-4 opacity-70" />
            </button>
          )}
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {step === 'shop' ? (
          <div>
            {products.length === 0 ? (
              <div className="text-center py-24">
                <Store className="w-14 h-14 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 font-medium">Nenhum produto disponível no momento</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                {products.map(p => {
                  const inCart = cart.find(i => i.product_id === p.id);
                  const outOfStock = p.quantity <= 0;
                  const discountPct = p.regular_price > p.sale_price ? Math.round((1 - p.sale_price / p.regular_price) * 100) : 0;
                  return (
                    <div key={p.id} className={cn('bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-100 flex flex-col', outOfStock && 'opacity-60')}>
                      <div className="relative aspect-square bg-gray-50">
                        {p.images?.[0] ? (
                          <img src={p.images[0]} alt={p.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Store className="w-10 h-10 text-gray-200" />
                          </div>
                        )}
                        {outOfStock && (
                          <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                            <span className="text-xs font-bold text-gray-500 bg-white px-2 py-1 rounded-full border">Esgotado</span>
                          </div>
                        )}
                        {discountPct > 0 && !outOfStock && (
                          <span className="absolute top-2 left-2 text-[11px] font-bold bg-green-500 text-white px-1.5 py-0.5 rounded-md">{discountPct}% OFF</span>
                        )}
                      </div>
                      <div className="p-3 flex flex-col flex-1 gap-2">
                        <h3 className="font-semibold text-gray-900 text-sm leading-snug line-clamp-2">{p.name}</h3>
                        <div>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-lg font-bold text-gray-900">{formatCurrency(p.sale_price)}</span>
                            {discountPct > 0 && <span className="text-xs text-gray-400 line-through">{formatCurrency(p.regular_price)}</span>}
                          </div>
                          <p className="text-xs text-gray-400">{p.quantity} disponível{p.quantity !== 1 ? 'is' : ''}</p>
                        </div>
                        <div className="mt-auto">
                          {inCart ? (
                            <div className="flex items-center justify-between bg-blue-50 rounded-xl px-3 py-2">
                              <span className="text-xs text-blue-700 font-medium">{inCart.quantity} no carrinho</span>
                              <div className="flex items-center gap-1">
                                <button onClick={() => updateQty(p.id, -1)} className="w-6 h-6 rounded-full border border-blue-200 flex items-center justify-center hover:bg-blue-100">
                                  <Minus className="w-3 h-3 text-blue-600" />
                                </button>
                                <button
                                  onClick={() => inCart.quantity < p.quantity ? updateQty(p.id, 1) : toast.error('Quantidade máxima atingida')}
                                  className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              disabled={outOfStock}
                              onClick={() => addToCart(p)}
                              className={cn('w-full h-9 rounded-xl text-xs font-bold transition-colors',
                                outOfStock ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'
                              )}
                            >
                              {outOfStock ? 'Esgotado' : 'Adicionar'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {cartCount > 0 && (
              <div className="fixed bottom-0 left-0 right-0 z-10 bg-white border-t shadow-[0_-4px_24px_rgba(0,0,0,0.08)] px-4 pt-3 pb-4">
                <div className="max-w-6xl mx-auto">
                  <button
                    onClick={() => setStep('checkout')}
                    className="w-full bg-[#1a1a2e] hover:bg-black text-white py-4 rounded-2xl font-bold text-base flex items-center justify-between px-6 transition-colors"
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
              ← Voltar aos produtos
            </button>

            {/* Resumo */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-bold text-gray-900">Seu pedido</h3>
                <span className="text-sm text-gray-500">{cartCount} {cartCount === 1 ? 'item' : 'itens'}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {cart.map(i => (
                  <div key={i.product_id} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-gray-50 border border-gray-100 shrink-0">
                      {i.image ? <img src={i.image} alt={i.product_name} className="w-full h-full object-cover" /> : <div className="w-full h-full bg-gray-100" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{i.product_name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <button onClick={() => updateQty(i.product_id, -1)} className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-100"><Minus className="w-3 h-3" /></button>
                        <span className="text-sm font-bold w-5 text-center">{i.quantity}</span>
                        <button onClick={() => updateQty(i.product_id, 1)} className="w-6 h-6 rounded-full bg-gray-900 text-white flex items-center justify-center hover:bg-black"><Plus className="w-3 h-3" /></button>
                        <span className="text-xs text-gray-400 ml-1">{formatCurrency(i.sale_price)} cada</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <p className="text-sm font-bold">{formatCurrency(i.sale_price * i.quantity)}</p>
                      <button onClick={() => removeFromCart(i.product_id)} className="text-gray-300 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
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
    </div>
  );
}
