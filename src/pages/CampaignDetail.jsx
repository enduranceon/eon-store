import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Edit2, Save, X, ExternalLink, Copy, Package, ShoppingCart, DollarSign, TrendingUp, LayoutGrid, GripVertical, Plus, Search, Link2Off, BarChart2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PreSaleCampaign, PreSaleOrder, PreSaleProduct } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from 'sonner';

const STATUS_LABEL = { active: 'Ativa', ended: 'Encerrada', archived: 'Arquivada' };
const STATUS_BADGE = { active: 'success', ended: 'warning', archived: 'secondary' };
const PAYMENT_LABEL = { awaiting_charge: 'Pedido recebido', message_sent: 'Mensagem enviada', charge_sent: 'Cobrança enviada', paid: 'Pago', partially_paid: 'Parcial', cancelled: 'Cancelado', refunded: 'Reembolsado' };
const PAYMENT_BADGE = { paid: 'success', partially_paid: 'warning', awaiting_charge: 'secondary', message_sent: 'warning', charge_sent: 'info', cancelled: 'destructive', refunded: 'outline' };
const EFFECTIVE_SALE_STATUSES = new Set(['paid', 'message_sent', 'charge_sent', 'partially_paid', 'pending']);

function isEffectiveSale(order) {
  if (['cancelled', 'refunded'].includes(order.payment_status)) return false;
  if (order.asaas_charge_id || order.asaas_payment_link || order.external_payment_link) return true;
  return EFFECTIVE_SALE_STATUSES.has(order.payment_status);
}

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [productOrder, setProductOrder] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);

  const load = async () => {
    try {
    const [c, allOrders, allProds] = await Promise.all([PreSaleCampaign.get(id), PreSaleOrder.list(), PreSaleProduct.list()]);
    setCampaign(c);
    setForm({ ...c });
    const campaignProducts = allProds.filter(p => (p.campaign_ids || []).includes(id) || p.campaign_id === id);
    setOrders(allOrders.filter(o => o.campaign_id === id));
    setAllProducts(allProds);
    setProducts(campaignProducts);
    // Inicializa a ordem: usa a ordem salva ou a ordem padrão (criação)
    const savedOrder = c.product_order || [];
    const orderedIds = [
      ...savedOrder.filter(pid => campaignProducts.find(p => p.id === pid)),
      ...campaignProducts.filter(p => !savedOrder.includes(p.id)).map(p => p.id),
    ];
    setProductOrder(orderedIds);
    } catch { toast.error('Erro ao carregar campanha'); }
  };

  useEffect(() => { load(); }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await PreSaleCampaign.update(id, form);
      toast.success('Campanha atualizada!');
      setEditing(false);
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveOrder = async (order) => {
    setSavingOrder(true);
    try {
      await PreSaleCampaign.update(id, { product_order: order });
      setProductOrder(order);
      setShowOrderModal(false);
      toast.success('Ordem salva!');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingOrder(false);
    }
  };

  const handleLinkProducts = async (productIds) => {
    try {
      await Promise.all(productIds.map(async pid => {
        const p = allProducts.find(x => x.id === pid);
        const existing = p?.campaign_ids || [];
        if (!existing.includes(id)) {
          await PreSaleProduct.update(pid, { campaign_ids: [...existing, id] });
        }
      }));
      toast.success(`${productIds.length} produto(s) vinculado(s)!`);
      setShowLinkModal(false);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleUnlink = async (pid) => {
    if (!confirm('Desvincular este produto da campanha?')) return;
    try {
      const p = allProducts.find(x => x.id === pid);
      const existing = p?.campaign_ids || [];
      await PreSaleProduct.update(pid, { campaign_ids: existing.filter(x => x !== id) });
      toast.success('Produto desvinculado');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const checkoutUrl = `${window.location.origin}/checkout/${campaign?.slug || id}`;
  const copyCheckout = () => { navigator.clipboard.writeText(checkoutUrl); toast.success('Link copiado!'); };

  if (!campaign) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const activeOrders = orders.filter(o => o.payment_status !== 'cancelled');
  const effectiveOrders = activeOrders.filter(isEffectiveSale);
  const totalSold = effectiveOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPaid = effectiveOrders.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPending = effectiveOrders.filter(o => o.payment_status !== 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalCost = effectiveOrders.reduce((acc, o) => acc + (o.total_cost || 0), 0);
  const grossProfit = totalSold - totalCost;
  const margin = totalSold > 0 ? (grossProfit / totalSold) * 100 : 0;
  const uniqueCustomers = new Set(activeOrders.map(o => o.customer_id || o.checkout_whatsapp)).size;

  // Produtos mais vendidos por item de pedido
  const productQty = {};
  effectiveOrders.forEach(o => {
    (o.items || []).forEach(item => {
      const key = `${item.product_name}${item.variation ? ' - ' + item.variation : ''}`;
      productQty[key] = (productQty[key] || 0) + (item.quantity || 1);
    });
  });
  const topProducts = Object.entries(productQty).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ArrowLeft className="w-4 h-4" /></Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">{campaign.name}</h2>
          <p className="text-sm text-muted-foreground">{campaign.supplier} · {formatDate(campaign.start_date)} → {formatDate(campaign.end_date)}</p>
        </div>
        <Badge variant={STATUS_BADGE[campaign.status]}>{STATUS_LABEL[campaign.status]}</Badge>
        <Button variant="outline" asChild>
          <Link to={`/campanhas/${id}/relatorio`}><BarChart2 className="w-4 h-4" /> Relatório</Link>
        </Button>
        {!editing ? (
          <Button variant="outline" onClick={() => setEditing(true)}><Edit2 className="w-4 h-4" /> Editar</Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(false)}><X className="w-4 h-4" /></Button>
            <Button onClick={handleSave} disabled={saving}><Save className="w-4 h-4" /> {saving ? 'Salvando...' : 'Salvar'}</Button>
          </div>
        )}
      </div>

      {/* Link do checkout */}
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="flex-1">
            <p className="text-xs font-medium text-blue-800 mb-1">Link do Checkout Público</p>
            <p className="text-sm font-mono text-blue-700 break-all">{checkoutUrl}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={copyCheckout}><Copy className="w-3.5 h-3.5" /> Copiar</Button>
            <Button size="sm" asChild><a href={checkoutUrl} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" /> Abrir</a></Button>
          </div>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total vendido', value: formatCurrency(totalSold), icon: DollarSign, color: 'blue' },
          { label: 'Total pago', value: formatCurrency(totalPaid), icon: DollarSign, color: 'green' },
          { label: 'Pendente', value: formatCurrency(totalPending), icon: DollarSign, color: 'yellow' },
          { label: 'Lucro bruto', value: formatCurrency(grossProfit), sub: `Margem: ${margin.toFixed(1)}%`, icon: TrendingUp, color: 'purple' },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="text-xl font-bold mt-1">{k.value}</p>
              {k.sub && <p className="text-xs text-muted-foreground">{k.sub}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Pedidos', value: activeOrders.length },
          { label: 'Clientes', value: uniqueCustomers },
          { label: 'Custo total', value: formatCurrency(totalCost) },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="p-4 text-center">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="text-xl font-bold mt-1">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Produtos da campanha */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="w-4 h-4" /> Produtos ({products.length})
            </CardTitle>
            <div className="flex gap-2">
              {products.length > 1 && (
                <Button variant="outline" size="sm" onClick={() => setShowOrderModal(true)}>
                  <LayoutGrid className="w-3.5 h-3.5" /> Organizar
                </Button>
              )}
              <Button size="sm" onClick={() => setShowLinkModal(true)}>
                <Plus className="w-3.5 h-3.5" /> Vincular produto
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {products.length === 0 ? (
            <div className="text-center py-10">
              <Package className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Nenhum produto vinculado ainda</p>
              <Button size="sm" className="mt-3" onClick={() => setShowLinkModal(true)}>
                <Plus className="w-3.5 h-3.5" /> Vincular produto
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {productOrder.map((pid, idx) => {
                const p = products.find(x => x.id === pid);
                if (!p) return null;
                const img = p.images?.[0];
                return (
                  <div key={pid} className="group relative border rounded-xl overflow-hidden bg-white hover:shadow-md transition-shadow">
                    <div className="aspect-square bg-gray-100">
                      {img ? (
                        <img src={img} alt={p.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Package className="w-7 h-7 text-gray-300" />
                        </div>
                      )}
                      <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-black/50 text-white text-[10px] font-bold flex items-center justify-center">{idx + 1}</div>
                      <button
                        onClick={() => handleUnlink(p.id)}
                        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-red-500 text-white hidden group-hover:flex items-center justify-center shadow"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="p-2">
                      <p className="text-xs font-semibold text-gray-900 truncate">{p.name}</p>
                      <p className="text-xs text-blue-600 font-medium">{p.sale_price ? `R$ ${Number(p.sale_price).toFixed(2).replace('.', ',')}` : '—'}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pedidos + Top produtos */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> Pedidos ({orders.length})</CardTitle>
              {orders.length > 0 && (() => {
                const nonCancelled = orders.filter(o => o.payment_status !== 'cancelled');
                const delivered = nonCancelled.filter(o => o.delivery_status === 'delivered').length;
                const total = nonCancelled.length;
                if (total === 0) return null;
                const pct = Math.round((delivered / total) * 100);
                return (
                  <div className="mt-2">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>{delivered} de {total} entregues</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1.5">
                      <div className="h-1.5 rounded-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
            </CardHeader>
            <CardContent>
              {orders.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">Nenhum pedido ainda</p>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {orders.map(o => (
                    <Link key={o.id} to={`/pedidos/${o.id}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-colors">
                      <div>
                        <p className="text-sm font-mono font-semibold text-blue-700">{o.order_number}</p>
                        <p className="text-xs text-muted-foreground">{o.checkout_name} · {formatDate(o.created_date)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={PAYMENT_BADGE[o.payment_status] || 'secondary'} className="text-xs">{PAYMENT_LABEL[o.payment_status]}</Badge>
                        <span className="text-sm font-semibold">{formatCurrency(o.total_value)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Package className="w-4 h-4" /> Top produtos</CardTitle></CardHeader>
          <CardContent>
            {topProducts.length === 0 ? <p className="text-sm text-muted-foreground">—</p> : (
              <div className="space-y-2">
                {topProducts.map(([name, qty]) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate">{name}</span>
                    <span className="font-semibold ml-2 shrink-0">{qty} un.</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Modal de vincular produtos */}
      {showLinkModal && (
        <LinkProductsModal
          allProducts={allProducts}
          linkedIds={products.map(p => p.id)}
          onLink={handleLinkProducts}
          onClose={() => setShowLinkModal(false)}
        />
      )}

      {/* Modal de ordenação */}
      {showOrderModal && (
        <ProductOrderModal
          products={products}
          order={productOrder}
          saving={savingOrder}
          onSave={saveOrder}
          onClose={() => setShowOrderModal(false)}
        />
      )}

      {/* Edição da campanha */}
      {editing && (
        <Card>
          <CardHeader><CardTitle className="text-base">Editar Campanha</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div><Label>Nome</Label><Input value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Fornecedor</Label><Input value={form.supplier || ''} onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} className="mt-1" /></div>
              <div>
                <Label>Status</Label>
                <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Ativa</SelectItem>
                    <SelectItem value="ended">Encerrada</SelectItem>
                    <SelectItem value="archived">Arquivada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div><Label>Data início</Label><Input type="date" value={form.start_date || ''} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} className="mt-1" /></div>
              <div><Label>Data encerramento</Label><Input type="date" value={form.end_date || ''} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} className="mt-1" /></div>
              <div>
                <Label>Prazo de entrega (dias)</Label>
                <Input
                  type="number" min="1" placeholder="Ex: 45"
                  value={form.delivery_days || ''}
                  onChange={e => setForm(f => ({ ...f, delivery_days: e.target.value ? parseInt(e.target.value) : null }))}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">Após encerramento da campanha</p>
              </div>
            </div>
            <div><Label>Descrição</Label><Textarea value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1" rows={3} /></div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LinkProductsModal({ allProducts, linkedIds, onLink, onClose }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);

  const available = allProducts.filter(p =>
    !linkedIds.includes(p.id) &&
    (p.name.toLowerCase().includes(search.toLowerCase()) ||
     (p.category || '').toLowerCase().includes(search.toLowerCase()))
  );

  const toggle = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-xl">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-900">Vincular produtos</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{selected.length > 0 ? `${selected.length} selecionado(s)` : 'Selecione os produtos para adicionar à campanha'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-4 py-3 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              autoFocus
              placeholder="Buscar produto..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 h-9 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {available.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              {allProducts.length === linkedIds.length ? 'Todos os produtos já estão vinculados.' : 'Nenhum produto encontrado.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {available.map(p => {
                const sel = selected.includes(p.id);
                const img = p.images?.[0];
                return (
                  <button
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    className={`text-left border-2 rounded-xl overflow-hidden transition-all ${sel ? 'border-blue-500 shadow-md' : 'border-transparent hover:border-gray-200'}`}
                  >
                    <div className="aspect-square bg-gray-100 relative">
                      {img ? <img src={img} alt={p.name} className="w-full h-full object-cover" /> : (
                        <div className="w-full h-full flex items-center justify-center"><Package className="w-7 h-7 text-gray-300" /></div>
                      )}
                      {sel && (
                        <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
                          <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center">
                            <Save className="w-4 h-4 text-white" />
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="p-2 bg-white">
                      <p className="text-xs font-semibold text-gray-900 truncate">{p.name}</p>
                      <p className="text-xs text-blue-600">{p.sale_price ? `R$ ${Number(p.sale_price).toFixed(2).replace('.', ',')}` : '—'}</p>
                      {p.category && <p className="text-[10px] text-muted-foreground">{p.category}</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t flex justify-end gap-3">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => onLink(selected)} disabled={selected.length === 0}>
            <Plus className="w-4 h-4" /> Vincular {selected.length > 0 ? `${selected.length} produto(s)` : ''}
          </Button>
        </div>
      </div>
    </div>
  );
}

function reorder(arr, from, to) {
  const result = [...arr];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

function ProductOrderModal({ products, order, saving, onSave, onClose }) {
  const [localOrder, setLocalOrder] = useState(order);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  const displayed = dragIdx !== null && overIdx !== null && dragIdx !== overIdx
    ? reorder(localOrder, dragIdx, overIdx)
    : localOrder;

  const getProduct = (id) => products.find(p => p.id === id);

  const handleDragStart = (e, idx) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverIdx(idx);
  };

  const handleDrop = (e, idx) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    setLocalOrder(prev => reorder(prev, dragIdx, idx));
    setDragIdx(null);
    setOverIdx(null);
  };

  const handleDragEnd = () => {
    setDragIdx(null);
    setOverIdx(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-100">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-lg font-bold">Organizar produtos</h2>
          <p className="text-sm text-muted-foreground">Arraste os cards para definir a ordem no checkout</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => onSave(localOrder)} disabled={saving}>
            <Save className="w-4 h-4" />
            {saving ? 'Salvando...' : 'Salvar ordem'}
          </Button>
        </div>
      </div>

      {/* Grid de produtos */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {displayed.map((pid, idx) => {
            const p = getProduct(pid);
            if (!p) return null;
            const isDragging = dragIdx !== null && displayed[dragIdx] === pid && dragIdx === idx && overIdx === null;
            const isOver = overIdx === idx && dragIdx !== idx;
            const img = p.images?.[0] || p.image;

            return (
              <div
                key={pid}
                draggable
                onDragStart={e => handleDragStart(e, idx)}
                onDragOver={e => handleDragOver(e, idx)}
                onDrop={e => handleDrop(e, idx)}
                onDragEnd={handleDragEnd}
                className={`bg-white rounded-xl border-2 overflow-hidden cursor-grab active:cursor-grabbing select-none transition-all ${
                  isOver
                    ? 'border-blue-500 shadow-lg scale-105'
                    : dragIdx === idx
                    ? 'border-dashed border-gray-300 opacity-40'
                    : 'border-transparent shadow-sm hover:shadow-md hover:border-gray-200'
                }`}
              >
                {/* Imagem */}
                <div className="aspect-square bg-gray-100 relative">
                  {img ? (
                    <img src={img} alt={p.name} className="w-full h-full object-cover pointer-events-none" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Package className="w-8 h-8 text-gray-300" />
                    </div>
                  )}
                  {/* Badge de posição */}
                  <div className="absolute top-2 left-2 w-6 h-6 rounded-full bg-black/60 text-white text-xs font-bold flex items-center justify-center">
                    {idx + 1}
                  </div>
                  {/* Ícone de arrastar */}
                  <div className="absolute top-2 right-2 text-white/70">
                    <GripVertical className="w-4 h-4" />
                  </div>
                </div>
                {/* Info */}
                <div className="p-3">
                  <p className="text-sm font-semibold text-gray-900 truncate">{p.name}</p>
                  <p className="text-xs text-blue-600 font-medium mt-0.5">{p.sale_price ? `R$ ${Number(p.sale_price).toFixed(2).replace('.', ',')}` : '—'}</p>
                  {p.category && <p className="text-xs text-muted-foreground mt-0.5">{p.category}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
