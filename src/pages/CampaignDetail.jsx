import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Edit2, Save, X, ExternalLink, Copy, Package, ShoppingCart, DollarSign, TrendingUp, LayoutGrid, GripVertical } from 'lucide-react';
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
const PAYMENT_LABEL = { awaiting_charge: 'Ag. cobrança', charge_sent: 'Cobrança enviada', paid: 'Pago', partially_paid: 'Parcial', cancelled: 'Cancelado', refunded: 'Reembolsado' };
const PAYMENT_BADGE = { paid: 'success', partially_paid: 'warning', awaiting_charge: 'secondary', charge_sent: 'info', cancelled: 'destructive', refunded: 'outline' };

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [productOrder, setProductOrder] = useState([]);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);

  const load = async () => {
    const [c, allOrders, allProducts] = await Promise.all([PreSaleCampaign.get(id), PreSaleOrder.list(), PreSaleProduct.list()]);
    setCampaign(c);
    setForm({ ...c });
    const campaignProducts = allProducts.filter(p => p.campaign_id === id);
    setOrders(allOrders.filter(o => o.campaign_id === id));
    setProducts(campaignProducts);
    // Inicializa a ordem: usa a ordem salva ou a ordem padrão (criação)
    const savedOrder = c.product_order || [];
    const orderedIds = [
      ...savedOrder.filter(pid => campaignProducts.find(p => p.id === pid)),
      ...campaignProducts.filter(p => !savedOrder.includes(p.id)).map(p => p.id),
    ];
    setProductOrder(orderedIds);
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

  const checkoutUrl = `${window.location.origin}/checkout/${id}`;
  const copyCheckout = () => { navigator.clipboard.writeText(checkoutUrl); toast.success('Link copiado!'); };

  if (!campaign) return <div className="p-8 text-center text-muted-foreground">Carregando...</div>;

  const activeOrders = orders.filter(o => o.payment_status !== 'cancelled');
  const totalSold = activeOrders.reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPaid = activeOrders.filter(o => o.payment_status === 'paid').reduce((acc, o) => acc + (o.total_value || 0), 0);
  const totalPending = totalSold - totalPaid;
  const totalCost = activeOrders.reduce((acc, o) => acc + (o.total_cost || 0), 0);
  const grossProfit = totalSold - totalCost;
  const margin = totalSold > 0 ? (grossProfit / totalSold) * 100 : 0;
  const uniqueCustomers = new Set(activeOrders.map(o => o.customer_id || o.checkout_whatsapp)).size;

  // Produtos mais vendidos por item de pedido
  const productQty = {};
  activeOrders.forEach(o => {
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pedidos */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> Pedidos ({orders.length})</CardTitle></CardHeader>
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

        <div className="space-y-4">
          {/* Produtos mais vendidos */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Package className="w-4 h-4" /> Top produtos</CardTitle></CardHeader>
            <CardContent>
              {topProducts.length === 0 ? <p className="text-sm text-muted-foreground">-</p> : (
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

          {/* Ordenação dos produtos */}
          <Card>
            <CardContent className="p-4">
              {products.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nenhum produto vinculado. Vincule na edição do produto.</p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-semibold">Ordem no checkout</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{products.length} produto{products.length !== 1 ? 's' : ''} nesta campanha</p>
                  </div>
                  <Button className="w-full" variant="outline" onClick={() => setShowOrderModal(true)}>
                    <LayoutGrid className="w-4 h-4" /> Organizar produtos
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

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
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Data início</Label><Input type="date" value={form.start_date || ''} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} className="mt-1" /></div>
              <div><Label>Data encerramento</Label><Input type="date" value={form.end_date || ''} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} className="mt-1" /></div>
            </div>
            <div><Label>Descrição</Label><Textarea value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1" rows={3} /></div>
          </CardContent>
        </Card>
      )}
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
