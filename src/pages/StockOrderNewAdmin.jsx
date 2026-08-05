import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Search, Plus, Minus, X, ShoppingCart, Check, User, Package, Loader2, UserPlus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StockProduct, PreSaleCustomer } from '@/api/entities';
import { createOrderCharge, createStockOrder } from '@/api/client';
import { formatCurrency } from '@/lib/utils';
import { normalizePhone } from '@/lib/phone';
import { defaultAsaasDueDate } from '@/lib/payment-methods';
import { formatProductNumber } from '@/lib/sku';
import DiscountInput from '@/components/DiscountInput';
import { toast } from 'sonner';

// Cadastro rápido de cliente, direto do pedido. Só o essencial para a venda:
// o cadastro completo (endereço, nascimento, gênero) segue em /clientes.
// CPF é opcional aqui, mas obrigatório se a cobrança for PIX/boleto no Asaas —
// por isso o campo avisa em vez de bloquear.
const EMPTY_NEW_CUSTOMER = { full_name: '', whatsapp: '', email: '', cpf: '' };

// Métodos de pagamento aceitos no fluxo admin
const PAYMENT_METHODS = [
  { value: 'pix_manual',    label: 'PIX manual',         description: 'Cliente pagou via PIX direto, sem gateway', paid: true  },
  { value: 'cash',          label: 'Dinheiro',           description: 'Pagamento em espécie',                     paid: true  },
  { value: 'card_machine',  label: 'Máquina de cartão',  description: 'Cartão presencial (Cielo, Stone, etc.)',   paid: true  },
  { value: 'bank_transfer', label: 'Transferência',      description: 'TED, DOC bancário',                        paid: true  },
  { value: 'pix',           label: 'PIX via Asaas',      description: 'Cria o pedido e já gera link/QR para enviar', paid: false },
  { value: 'boleto',        label: 'Boleto via Asaas',   description: 'Cria o pedido e já gera boleto para enviar',  paid: false },
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
  const [newCustomerModal, setNewCustomerModal] = useState(false);
  const [newCustomer, setNewCustomer] = useState(EMPTY_NEW_CUSTOMER);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [productSearch, setProductSearch]   = useState('');

  const [cart, setCart]     = useState([]); // [{ product_id, quantity }]
  const [paymentMethod, setPaymentMethod] = useState('pix');
  const [dueDate, setDueDate] = useState(defaultAsaasDueDate);
  const [notes, setNotes]   = useState('');
  const [discount, setDiscount] = useState({ value: 0, reason: '' });

  useEffect(() => {
    const load = async () => {
      try {
        const [p, c] = await Promise.all([
          StockProduct.list().catch(() => []),
          PreSaleCustomer.list('full_name').catch(() => []),
        ]);
        setProducts(p.filter(x => x.status === 'active' && Number(x.quantity || 0) > 0));
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
    // includes('') é sempre true: sem a guarda de dígitos, buscar por nome
    // devolveria todo cliente que tem whatsapp cadastrado.
    const digits = customerSearch.replace(/\D/g, '');
    return customers
      .filter(c =>
        c.full_name?.toLowerCase().includes(q) ||
        (digits && c.whatsapp?.includes(digits)) ||
        c.email?.toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [customers, customerSearch]);

  // Produtos filtrados
  const filteredProducts = useMemo(() => {
    const inStock = products.filter(p => Number(p.quantity || 0) > 0);
    if (!productSearch) return inStock;
    const q = productSearch.toLowerCase();
    return inStock.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.category?.toLowerCase().includes(q) ||
      p.subcategory?.toLowerCase().includes(q) ||
      p.supplier?.toLowerCase().includes(q) ||
      String(p.product_number || '').includes(q)
    );
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

  // Cria o cliente e já o deixa selecionado, sem sair da tela do pedido.
  // Passa pelo PreSaleCustomer.create (API JWT), mesmo caminho do ContractForm.
  const createCustomer = async () => {
    if (!newCustomer.full_name?.trim()) return toast.error('Nome é obrigatório');
    setCreatingCustomer(true);
    try {
      const created = await PreSaleCustomer.create({
        full_name: newCustomer.full_name.trim(),
        whatsapp:  normalizePhone(newCustomer.whatsapp) || null,
        email:     newCustomer.email?.trim().toLowerCase() || null,
        cpf:       newCustomer.cpf?.replace(/\D/g, '') || null,
      });
      setCustomers(prev => [created, ...prev]);
      setCustomerId(created.id);
      setCustomerSearch('');
      setNewCustomerModal(false);
      setNewCustomer(EMPTY_NEW_CUSTOMER);
      toast.success(`${created.full_name} cadastrado e selecionado!`);
    } catch (e) {
      // O índice único de CPF estoura aqui quando o cliente já existe.
      if (e.message?.includes('uniq_presale_customers_cpf')) {
        toast.error('Esse CPF já está cadastrado em outro cliente — busque pelo nome.');
      } else {
        toast.error(e.message || 'Erro ao criar cliente');
      }
    } finally { setCreatingCustomer(false); }
  };

  // Submit
  const save = async () => {
    if (!customerId)     return toast.error('Selecione um cliente');
    if (cart.length === 0) return toast.error('Adicione pelo menos 1 produto');
    if (!selectedCustomer) return toast.error('Cliente inválido');
    const shouldCreateAsaasCharge = ['pix', 'boleto'].includes(paymentMethod);
    if (shouldCreateAsaasCharge && !String(selectedCustomer.cpf || '').replace(/\D/g, '')) {
      return toast.error('CPF do cliente é obrigatório para gerar cobrança Asaas');
    }
    if (shouldCreateAsaasCharge && !dueDate) return toast.error('Informe o vencimento da cobrança');

    setSaving(true);
    try {
      const validatedItems = cartItems.map(i => ({
        product_id: i.product.id,
        quantity: i.quantity,
      }));

      const payload = {
        customer_id: customerId,
        items: validatedItems,
        manual_discount: Number(discount.value) || 0,
        discount_reason: discount.reason || null,
        payment_preference: paymentMethod,
        internal_notes: notes || null,
      };

      const order = await createStockOrder(payload);
      if (shouldCreateAsaasCharge) {
        try {
          await createOrderCharge('stock', order.id, {
            billingType: paymentMethod === 'boleto' ? 'BOLETO' : 'PIX',
            dueDate,
            installments: 1,
            cpf: selectedCustomer.cpf,
          });
          toast.success(`Pedido ${order.order_number} criado com link de pagamento.`);
        } catch (chargeError) {
          toast.warning(`Pedido ${order.order_number} criado, mas a cobrança não foi gerada: ${chargeError.message || 'erro no Asaas'}`);
        }
        navigate(`/estoque/pedidos/${order.id}?cobrar=1`);
        return;
      }
      toast.success(`Pedido ${order.order_number} criado. Registre ou envie a cobrança para efetivar a venda.`);
      navigate(`/estoque/pedidos/${order.id}?cobrar=1`);
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
          <h2 className="text-xl font-bold">Venda manual da loja</h2>
          <p className="text-sm text-muted-foreground">Crie um pedido com produtos em estoque e envie ou registre a cobrança</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Coluna esquerda — Cliente + Produtos */}
        <div className="lg:col-span-2 space-y-5">

          {/* Cliente */}
          <Card>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <Label className="flex items-center gap-1.5">
                  <User className="w-4 h-4" /> Cliente *
                </Label>
                {!selectedCustomer && (
                  <button type="button" onClick={() => setNewCustomerModal(true)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline inline-flex items-center gap-1">
                    <UserPlus className="w-3.5 h-3.5" /> Novo cliente
                  </button>
                )}
              </div>
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
                      <div className="p-4 text-center space-y-2">
                        <p className="text-sm text-muted-foreground">
                          {customerSearch ? `Nenhum cliente para "${customerSearch}"` : 'Nenhum cliente'}
                        </p>
                        <Button type="button" size="sm" variant="outline"
                          onClick={() => {
                            // Aproveita o que já foi digitado: se parecer nome, pré-preenche.
                            const q = customerSearch.trim();
                            const pareceNome = q && !/^[\d\s()+-]+$/.test(q) && !q.includes('@');
                            setNewCustomer({
                              ...EMPTY_NEW_CUSTOMER,
                              full_name: pareceNome ? q : '',
                              whatsapp:  /^[\d\s()+-]+$/.test(q) ? q : '',
                              email:     q.includes('@') ? q : '',
                            });
                            setNewCustomerModal(true);
                          }}>
                          <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Cadastrar novo cliente
                        </Button>
                      </div>
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
                <Package className="w-4 h-4" /> Produtos em estoque
              </Label>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input className="pl-9"
                    placeholder="Buscar produto, código, categoria ou fornecedor..."
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
                        {(p.images?.[0] || p.image_url) ? (
                          <img src={p.images?.[0] || p.image_url} alt={p.name} className="w-12 h-12 rounded object-cover shrink-0" />
                        ) : (
                          <div className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center shrink-0">
                            <Package className="w-5 h-5 text-gray-400" />
                          </div>
                        )}

                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm truncate">{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatCurrency(p.sale_price)} · estoque: {p.quantity}
                              {p.product_number ? ` · ${formatProductNumber(p.product_number)}` : ''}
                              {p.category ? ` · ${p.category}` : ''}
                              {p.supplier ? ` · ${p.supplier}` : ''}
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
                            venda direta
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{m.description}</p>
                    </button>
                  ))}
                </div>
              </div>
              {['pix', 'boleto'].includes(paymentMethod) && (
                <div>
                  <Label>Vencimento da cobrança *</Label>
                  <Input className="mt-1" type="date" value={dueDate}
                    onChange={e => setDueDate(e.target.value)} />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    O sistema gera a cobrança Asaas assim que o pedido for criado.
                  </p>
                </div>
              )}

              <div>
                <Label>Observações (opcional)</Label>
                <Textarea rows={2} className="mt-1 text-sm" value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Notas internas..." />
              </div>

              <Button className="w-full" size="lg"
                disabled={saving || !customerId || cart.length === 0}
                onClick={save}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                {saving
                  ? 'Criando...'
                  : ['pix', 'boleto'].includes(paymentMethod)
                    ? `Criar e gerar link · ${formatCurrency(totalAfterDiscount)}`
                    : `Criar pedido · ${formatCurrency(totalAfterDiscount)}`}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Cadastro rápido de cliente */}
      <Dialog open={newCustomerModal} onOpenChange={o => !o && !creatingCustomer && setNewCustomerModal(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-blue-600" /> Novo cliente
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome completo *</Label>
              <Input className="mt-1" autoFocus
                value={newCustomer.full_name}
                onChange={e => setNewCustomer(f => ({ ...f, full_name: e.target.value }))}
                placeholder="Nome do cliente" />
            </div>
            <div>
              <Label>WhatsApp</Label>
              <Input className="mt-1"
                value={newCustomer.whatsapp}
                onChange={e => setNewCustomer(f => ({ ...f, whatsapp: e.target.value }))}
                placeholder="(48) 99999-9999" />
              <p className="text-[11px] text-muted-foreground mt-1">Usado para enviar o link de pagamento.</p>
            </div>
            <div>
              <Label>E-mail</Label>
              <Input className="mt-1" type="email"
                value={newCustomer.email}
                onChange={e => setNewCustomer(f => ({ ...f, email: e.target.value }))}
                placeholder="email@exemplo.com" />
            </div>
            <div>
              <Label>CPF</Label>
              <Input className="mt-1" inputMode="numeric"
                value={newCustomer.cpf}
                onChange={e => setNewCustomer(f => ({ ...f, cpf: e.target.value }))}
                placeholder="000.000.000-00" />
              <p className="text-[11px] text-amber-700 mt-1">
                Obrigatório se a cobrança for PIX ou boleto pelo Asaas. Dá para deixar em branco nas outras formas.
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Endereço, nascimento e demais dados podem ser completados depois em Clientes.
            </p>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" disabled={creatingCustomer}
                onClick={() => setNewCustomerModal(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={createCustomer} disabled={creatingCustomer}>
                {creatingCustomer ? 'Salvando...' : 'Cadastrar e usar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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
