import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Search, Plus, Minus, X, ShoppingCart, Check, User, Package } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StockProduct, StockOrder, PreSaleCustomer } from '@/api/entities';
import { formatCurrency } from '@/lib/utils';
import DiscountInput from '@/components/DiscountInput';
import { toast } from 'sonner';

// Métodos de pagamento aceitos no fluxo admin
const PAYMENT_METHODS = [
  { value: 'pix_manual',    label: 'PIX manual',         description: 'Cliente pagou via PIX direto, sem gateway', paid: true  },
  { value: 'cash',          label: 'Dinheiro',           description: 'Pagamento em espécie',                     paid: true  },
  { value: 'card_machine',  label: 'Máquina de cartão',  description: 'Cartão presencial (Cielo, Stone, etc.)',   paid: true  },
  { value: 'bank_transfer', label: 'Transferência',      description: 'TED, DOC bancário',                        paid: true  },
  { value: 'pix',           label: 'PIX via Asaas',      description: 'Gera link/QR e marca como aguardando',     paid: false },
  { value: 'boleto',        label: 'Boleto via Asaas',   description: 'Gera boleto e marca como aguardando',      paid: false },
];

export default function StockOrderNewAdmin() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedCustomerId = searchParams.get('customer_id') || '';

  const [products, setProducts]   = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);

  const [customerId, setCustomerId] = useState(preselectedCustomerId);
  const [customerSearch, setCustomerSearch] = useState('');
  const [productSearch, setProductSearch]   = useState('');

  const [cart, setCart]     = useState([]); // [{ product_id, quantity }]
  const [paymentMethod, setPaymentMethod] = useState('pix_manual');
  const [notes, setNotes]   = useState('');
  const [discount, setDiscount] = useState({ value: 0, reason: '' });

  useEffect(() => {
    const load = async () => {
      try {
        const [p, c] = await Promise.all([
          StockProduct.list().catch(() => []),
          PreSaleCustomer.list('full_name').catch(() => []),
        ]);
        setProducts(p.filter(x => x.status === 'active'));
        setCustomers(c);
      } catch (e) {
        console.error(e);
        toast.error('Erro ao carregar dados');
      } finally { setLoading(false); }
    };
    load();
  }, []);

  // Cliente selecionado
  const selectedCustomer = customers.find(c => c.id === customerId);

  // Lista filtrada de clientes (busca)
  const filteredCustomers = useMemo(() => {
    if (!customerSearch) return customers.slice(0, 20);
    const q = customerSearch.toLowerCase();
    return customers
      .filter(c =>
        c.full_name?.toLowerCase().includes(q) ||
        c.whatsapp?.includes(customerSearch.replace(/\D/g, '')) ||
        c.email?.toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [customers, customerSearch]);

  // Produtos filtrados
  const filteredProducts = useMemo(() => {
    if (!productSearch) return products;
    const q = productSearch.toLowerCase();
    return products.filter(p => p.name?.toLowerCase().includes(q));
  }, [products, productSearch]);

  // Cart helpers
  const getQty = (productId) => cart.find(i => i.product_id === productId)?.quantity || 0;
  const setQty = (productId, qty) => {
    setCart(prev => {
      const existing = prev.find(i => i.product_id === productId);
      if (qty <= 0) return prev.filter(i => i.product_id !== productId);
      if (existing)  return prev.map(i => i.product_id === productId ? { ...i, quantity: qty } : i);
      return [...prev, { product_id: productId, quantity: qty }];
    });
  };
  const addOne    = (productId) => setQty(productId, getQty(productId) + 1);
  const removeOne = (productId) => setQty(productId, getQty(productId) - 1);

  // Cart items com dados do produto
  const cartItems = cart.map(i => {
    const prod = products.find(p => p.id === i.product_id);
    return { ...i, product: prod };
  }).filter(i => i.product);

  const subtotal = cartItems.reduce((s, i) => s + (i.product.sale_price * i.quantity), 0);
  const totalAfterDiscount = Math.max(0, subtotal - (Number(discount.value) || 0));

  // Submit
  const save = async () => {
    if (!customerId)     return toast.error('Selecione um cliente');
    if (cart.length === 0) return toast.error('Adicione pelo menos 1 produto');
    if (!selectedCustomer) return toast.error('Cliente inválido');

    setSaving(true);
    try {
      const validatedItems = cartItems.map(i => ({
        product_id:   i.product.id,
        product_name: i.product.name,
        quantity:     i.quantity,
        sale_price:   Number(i.product.sale_price),
        cost_price:   Number(i.product.cost_price || 0),
      }));

      const payload = {
        customer_id:       customerId,
        customer_name:     selectedCustomer.full_name,
        customer_whatsapp: selectedCustomer.whatsapp || null,
        customer_email:    selectedCustomer.email || null,
        customer_cpf:      selectedCustomer.cpf || null,
        items:             validatedItems,
        total_value:       totalAfterDiscount,
        manual_discount:   Number(discount.value) || 0,
        discount_reason:   discount.reason || null,
        payment_preference: paymentMethod,
        payment_method:    null,
        payment_status:    'awaiting_charge',
        due_date:          null,
        payment_date:      null,
        delivery_status:   'awaiting_delivery',
        delivery_method:   'pickup',
        internal_notes:    notes || null,
      };

      const order = await StockOrder.create(payload);
      toast.success(`Pedido ${order.order_number} criado. Registre ou gere a cobrança para efetivar a venda.`);
      navigate(`/estoque/pedidos/${order.id}`);
    } catch (e) {
      toast.error(e.message || 'Erro ao criar pedido');
    } finally { setSaving(false); }
  };

  if (loading) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="text-xl font-bold">Novo pedido da loja</h2>
          <p className="text-sm text-muted-foreground">Fluxo administrativo — venda direta ao cliente</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Coluna esquerda — Cliente + Produtos */}
        <div className="lg:col-span-2 space-y-5">

          {/* Cliente */}
          <Card>
            <CardContent className="p-5">
              <Label className="flex items-center gap-1.5 mb-2">
                <User className="w-4 h-4" /> Cliente *
              </Label>
              {selectedCustomer ? (
                <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-xl p-3">
                  <div>
                    <p className="font-semibold">{selectedCustomer.full_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {selectedCustomer.whatsapp || '—'}
                      {selectedCustomer.email && ` · ${selectedCustomer.email}`}
                    </p>
                  </div>
                  <button onClick={() => setCustomerId('')}
                    className="text-xs text-blue-600 hover:underline">
                    Trocar
                  </button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input className="pl-9"
                      placeholder="Buscar nome, WhatsApp ou email..."
                      value={customerSearch}
                      onChange={e => setCustomerSearch(e.target.value)} />
                  </div>
                  <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border divide-y">
                    {filteredCustomers.length === 0 ? (
                      <p className="text-sm text-muted-foreground p-3 text-center">Nenhum cliente</p>
                    ) : filteredCustomers.map(c => (
                      <button key={c.id}
                        onClick={() => { setCustomerId(c.id); setCustomerSearch(''); }}
                        className="w-full text-left p-2.5 hover:bg-blue-50 transition-colors flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-sm">{c.full_name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {c.whatsapp || c.email || '—'}
                          </p>
                        </div>
                        <ChevronRightIcon />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Produtos */}
          <Card>
            <CardContent className="p-5">
              <Label className="flex items-center gap-1.5 mb-2">
                <Package className="w-4 h-4" /> Produtos
              </Label>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input className="pl-9"
                  placeholder="Buscar produto..."
                  value={productSearch}
                  onChange={e => setProductSearch(e.target.value)} />
              </div>

              {filteredProducts.length === 0 ? (
                <p className="text-sm text-muted-foreground p-6 text-center">
                  Nenhum produto encontrado.
                </p>
              ) : (
                <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                  {filteredProducts.map(p => {
                    const qty = getQty(p.id);
                    return (
                      <div key={p.id} className="flex items-center gap-3 p-2.5 rounded-lg border hover:border-blue-300 transition-colors">
                        {/* Foto */}
                        {p.image_url ? (
                          <img src={p.image_url} alt={p.name} className="w-12 h-12 rounded object-cover shrink-0" />
                        ) : (
                          <div className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center shrink-0">
                            <Package className="w-5 h-5 text-gray-400" />
                          </div>
                        )}

                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{p.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatCurrency(p.sale_price)} · estoque: {p.quantity}
                          </p>
                        </div>

                        {qty > 0 ? (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => removeOne(p.id)}
                              className="w-7 h-7 rounded-full border border-gray-200 hover:bg-gray-100 flex items-center justify-center">
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="font-semibold w-6 text-center text-sm">{qty}</span>
                            <button onClick={() => addOne(p.id)}
                              disabled={qty >= p.quantity}
                              className="w-7 h-7 rounded-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white flex items-center justify-center">
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <Button size="sm" variant="outline"
                            disabled={p.quantity <= 0}
                            onClick={() => addOne(p.id)}>
                            <Plus className="w-3 h-3 mr-1" /> Adicionar
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Coluna direita — Carrinho + Pagamento */}
        <div className="space-y-5">

          {/* Carrinho */}
          <Card className="sticky top-4">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center gap-2 pb-2 border-b">
                <ShoppingCart className="w-4 h-4" />
                <p className="font-semibold">Carrinho ({cart.length})</p>
              </div>

              {cartItems.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  Adicione produtos pra começar
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {cartItems.map(i => (
                    <div key={i.product_id} className="flex items-center gap-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{i.product.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {i.quantity}× {formatCurrency(i.product.sale_price)}
                        </p>
                      </div>
                      <p className="font-semibold shrink-0">{formatCurrency(i.quantity * i.product.sale_price)}</p>
                      <button onClick={() => setQty(i.product_id, 0)}
                        className="text-gray-400 hover:text-red-500">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Desconto manual (compact) */}
              {cartItems.length > 0 && (
                <div className="pt-3 border-t">
                  <DiscountInput
                    subtotal={subtotal}
                    currentDiscount={Number(discount.value) || 0}
                    currentReason={discount.reason}
                    compact
                    onSave={(v, r) => setDiscount({ value: v, reason: r })}
                  />
                  {/* O compact não tem botão de salvar — atualiza via onSave inline.
                      Como queremos refletir mudanças em tempo real, usamos handlers próprios: */}
                </div>
              )}

              {/* Totais */}
              <div className="pt-3 border-t space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                {Number(discount.value) > 0 && (
                  <div className="flex items-center justify-between text-green-700">
                    <span>Desconto</span>
                    <span>− {formatCurrency(Number(discount.value))}</span>
                  </div>
                )}
                <div className="flex items-center justify-between pt-1 border-t">
                  <span className="font-medium">Total</span>
                  <span className="text-xl font-bold text-blue-700">{formatCurrency(totalAfterDiscount)}</span>
                </div>
              </div>

              {/* Forma de pagamento */}
              <div>
                <Label>Forma de pagamento *</Label>
                <div className="grid grid-cols-1 gap-1.5 mt-2">
                  {PAYMENT_METHODS.map(m => (
                    <button key={m.value}
                      onClick={() => setPaymentMethod(m.value)}
                      className={`text-left p-2.5 rounded-lg border-2 transition-all ${
                        paymentMethod === m.value
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-blue-300'
                      }`}>
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">{m.label}</p>
                        {m.paid && (
                          <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-semibold">
                            já pago
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{m.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label>Observações (opcional)</Label>
                <Textarea rows={2} className="mt-1 text-sm" value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Notas internas..." />
              </div>

              <Button className="w-full" size="lg"
                disabled={saving || !customerId || cart.length === 0}
                onClick={save}>
                <Check className="w-4 h-4 mr-2" />
                {saving ? 'Criando...' : `Criar pedido · ${formatCurrency(subtotal)}`}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// Small chevron component
function ChevronRightIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
    </svg>
  );
}
