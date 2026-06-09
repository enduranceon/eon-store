import { Fragment, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Printer, Package, ShoppingCart, Users, DollarSign, CheckCircle2, Clock, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PreSaleCampaign, PreSaleOrder, PreSaleProduct } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';
import { isEffectiveSale } from '@/lib/sales';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export default function CampaignReport() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [rows, setRows] = useState([]);
  const [receipts, setReceipts] = useState({});
  const [stats, setStats] = useState({ orders: 0, customers: 0, total: 0, items: 0 });
  const [deliveryStats, setDeliveryStats] = useState({ delivered: 0, total: 0 });
  const receiptsRef = useRef({});
  const saveTimer = useRef(null);

  useEffect(() => {
    Promise.all([
      PreSaleCampaign.get(id),
      PreSaleOrder.filter({ campaign_id: id }),
      PreSaleProduct.list(),
    ]).then(([camp, orders, products]) => {
      setCampaign(camp);
      const initialReceipts = camp.receipts || {};
      setReceipts(initialReceipts);
      receiptsRef.current = initialReceipts;

      const productMap = Object.fromEntries(products.map(p => [p.id, p]));
      const agg = {};
      let totalValue = 0, totalItems = 0;
      const customerSet = new Set();

      const activeOrders = orders.filter(isEffectiveSale);
      const deliveredCount = activeOrders.filter(o => o.delivery_status === 'delivered').length;
      setDeliveryStats({ delivered: deliveredCount, total: activeOrders.length });

      activeOrders.forEach(o => {
        customerSet.add(o.customer_id || o.checkout_whatsapp);
        totalValue += o.total_value || 0;
        (o.items || []).filter(it => !it.cancelled).forEach(item => {
          const key = `${item.product_id}__${item.variation || ''}`;
          if (!agg[key]) {
            const prod = productMap[item.product_id];
            let sku = prod?.sku || '';
            if (item.variation && prod?.variations) {
              const v = prod.variations.find(v => v.name === item.variation);
              if (v?.sku) sku = v.sku;
            }
            agg[key] = {
              receipt_key: key,
              sku,
              product_id: item.product_id,
              product_name: item.product_name,
              variation: item.variation || '',
              qty: 0,
              sale_price: item.sale_price || 0,
            };
          }
          agg[key].qty += item.quantity || 1;
          totalItems += item.quantity || 1;
        });
      });

      const sorted = Object.values(agg).sort((a, b) => {
        const nc = a.product_name.localeCompare(b.product_name);
        return nc !== 0 ? nc : a.variation.localeCompare(b.variation);
      });

      setRows(sorted);
      setStats({ orders: activeOrders.length, customers: customerSet.size, total: totalValue, items: totalItems });
    });
  }, [id]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        PreSaleCampaign.update(id, { receipts: receiptsRef.current }).catch(() => {});
      }
    };
  }, [id]);

  const updateReceipt = (key, value) => {
    const qty = Math.max(0, parseInt(value) || 0);
    const updated = {
      ...receiptsRef.current,
      [key]: { qty, updated_at: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })() },
    };
    setReceipts(updated);
    receiptsRef.current = updated;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await PreSaleCampaign.update(id, { receipts: updated });
      } catch {
        toast.error('Erro ao salvar recebimento');
      }
    }, 700);
  };

  const exportCSV = () => {
    const header = ['SKU', 'Produto', 'Variação', 'Qtd. Pedida', 'Qtd. Recebida', 'Pendente', 'Preço Unit. (R$)', 'Total (R$)'];
    const data = rows.map(r => {
      const rec = receipts[r.receipt_key]?.qty || 0;
      const pending = Math.max(0, r.qty - rec);
      return [
        r.sku, r.product_name, r.variation || '-',
        r.qty, rec, pending,
        r.sale_price.toFixed(2).replace('.', ','),
        (r.qty * r.sale_price).toFixed(2).replace('.', ','),
      ];
    });
    const csv = [header, ...data].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pedido-fornecedor-${campaign?.name?.replace(/\s+/g, '-') || id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!campaign) return (
    <div className="flex items-center justify-center h-64 text-muted-foreground">Carregando...</div>
  );

  // Totais de recebimento
  const totalOrdered = rows.reduce((s, r) => s + r.qty, 0);
  const totalReceived = rows.reduce((s, r) => s + (receipts[r.receipt_key]?.qty || 0), 0);
  const totalPending = Math.max(0, totalOrdered - totalReceived);
  const receiptPct = totalOrdered > 0 ? Math.min(100, Math.round((totalReceived / totalOrdered) * 100)) : 0;

  // Agrupa por produto para subtotais
  const byProduct = rows.reduce((acc, r) => {
    if (!acc[r.product_name]) acc[r.product_name] = [];
    acc[r.product_name].push(r);
    return acc;
  }, {});

  const deliveryPct = deliveryStats.total > 0
    ? Math.round((deliveryStats.delivered / deliveryStats.total) * 100) : 0;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 print:hidden">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/campanhas/${id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">Relatório · {campaign.name}</h2>
          <p className="text-sm text-muted-foreground">Gerado em {formatDate(new Date().toISOString())}</p>
        </div>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="w-4 h-4" /> Imprimir
        </Button>
        <Button onClick={exportCSV} disabled={rows.length === 0}>
          <Download className="w-4 h-4" /> Exportar CSV
        </Button>
      </div>

      {/* Cabeçalho impressão */}
      <div className="hidden print:block mb-4">
        <h1 className="text-2xl font-bold">{campaign.name}</h1>
        <p className="text-sm text-gray-500">Pedido ao fornecedor · {formatDate(new Date().toISOString())}</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Pedidos ativos', value: stats.orders, icon: ShoppingCart },
          { label: 'Clientes', value: stats.customers, icon: Users },
          { label: 'Total de itens', value: `${stats.items} un.`, icon: Package },
          { label: 'Receita total', value: formatCurrency(stats.total), icon: DollarSign },
        ].map(k => (
          <div key={k.label} className="bg-white rounded-xl border p-4">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className="text-2xl font-bold mt-1">{k.value}</p>
          </div>
        ))}
      </div>

      {/* Barras de progresso */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recebimento do fornecedor */}
        <div className="bg-white rounded-xl border p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-blue-600" />
              <span className="font-semibold text-sm">Recebimento do fornecedor</span>
            </div>
            <span className="text-sm font-bold text-blue-700">{receiptPct}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2.5 mb-3">
            <div
              className={cn('h-2.5 rounded-full transition-all', receiptPct === 100 ? 'bg-green-500' : 'bg-blue-500')}
              style={{ width: `${receiptPct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-500" /> {totalReceived} recebidos</span>
            <span className="flex items-center gap-1"><Clock className="w-3 h-3 text-amber-500" /> {totalPending} pendentes</span>
            <span>{totalOrdered} pedidos total</span>
          </div>
        </div>

        {/* Entrega aos clientes */}
        <div className="bg-white rounded-xl border p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-600" />
              <span className="font-semibold text-sm">Entrega aos clientes</span>
            </div>
            <span className="text-sm font-bold text-green-700">{deliveryPct}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2.5 mb-3">
            <div
              className={cn('h-2.5 rounded-full transition-all', deliveryPct === 100 ? 'bg-green-500' : 'bg-emerald-500')}
              style={{ width: `${deliveryPct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-500" /> {deliveryStats.delivered} entregues</span>
            <span className="flex items-center gap-1"><Clock className="w-3 h-3 text-amber-500" /> {deliveryStats.total - deliveryStats.delivered} pendentes</span>
            <span>{deliveryStats.total} pedidos total</span>
          </div>
        </div>
      </div>

      {/* Tabela */}
      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border p-16 text-center text-muted-foreground">
          <Package className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>Nenhum pedido ativo nesta campanha ainda.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <h3 className="font-bold">Itens por SKU / variação</h3>
            <span className="text-sm text-muted-foreground print:hidden">
              Edite a coluna "Recebido" conforme as peças chegam
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">SKU</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Variação</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Pedido</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground print:hidden">Recebido</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">Pendente</th>
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground print:hidden">Total (R$)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.entries(byProduct).map(([productName, items]) => {
                  const subOrdered = items.reduce((s, r) => s + r.qty, 0);
                  const subReceived = items.reduce((s, r) => s + (receipts[r.receipt_key]?.qty || 0), 0);
                  const subPending = Math.max(0, subOrdered - subReceived);
                  const subVal = items.reduce((s, r) => s + r.qty * r.sale_price, 0);

                  return (
                    <Fragment key={productName}>
                      {items.map((r, i) => {
                        const received = receipts[r.receipt_key]?.qty || 0;
                        const pending = Math.max(0, r.qty - received);
                        const fullyReceived = received >= r.qty && r.qty > 0;
                        const partial = received > 0 && received < r.qty;

                        return (
                          <tr key={`${productName}-${i}`} className={cn(
                            'transition-colors',
                            fullyReceived ? 'bg-green-50 hover:bg-green-100' :
                            partial ? 'bg-amber-50 hover:bg-amber-100' :
                            'hover:bg-gray-50'
                          )}>
                            <td className="px-4 py-2.5 font-mono text-xs text-blue-700">
                              {r.sku || <span className="text-gray-300 italic">—</span>}
                            </td>
                            <td className="px-4 py-2.5 font-medium">{r.product_name}</td>
                            <td className="px-4 py-2.5 text-muted-foreground">{r.variation || '—'}</td>
                            <td className="px-4 py-2.5 text-right font-bold text-lg">{r.qty}</td>
                            <td className="px-4 py-2.5 text-right print:hidden">
                              <div className="flex items-center justify-end gap-2">
                                {fullyReceived && <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />}
                                <input
                                  type="number"
                                  min={0}
                                  max={r.qty}
                                  value={received === 0 ? '' : received}
                                  placeholder="0"
                                  onChange={e => updateReceipt(r.receipt_key, e.target.value)}
                                  className={cn(
                                    'w-16 text-right text-sm font-semibold rounded-lg border px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400',
                                    fullyReceived ? 'bg-green-100 border-green-300 text-green-800' :
                                    partial ? 'bg-amber-100 border-amber-300 text-amber-800' :
                                    'bg-white border-gray-200'
                                  )}
                                />
                              </div>
                            </td>
                            <td className={cn('px-4 py-2.5 text-right font-semibold', pending === 0 && r.qty > 0 ? 'text-green-600' : pending > 0 ? 'text-amber-600' : 'text-gray-400')}>
                              {pending === 0 && r.qty > 0 ? '✓' : pending}
                            </td>
                            <td className="px-4 py-2.5 text-right text-muted-foreground print:hidden">
                              {formatCurrency(r.qty * r.sale_price)}
                            </td>
                          </tr>
                        );
                      })}

                      {items.length > 1 && (
                        <tr className="bg-blue-50 border-t border-blue-100">
                          <td className="px-4 py-2" />
                          <td className="px-4 py-2 text-xs font-semibold text-blue-700" colSpan={2}>
                            Subtotal · {productName}
                          </td>
                          <td className="px-4 py-2 text-right font-bold text-blue-700">{subOrdered}</td>
                          <td className="px-4 py-2 text-right font-bold text-blue-700 print:hidden">{subReceived}</td>
                          <td className={cn('px-4 py-2 text-right font-bold', subPending === 0 ? 'text-green-600' : 'text-amber-600')}>
                            {subPending === 0 ? '✓' : subPending}
                          </td>
                          <td className="px-4 py-2 text-right font-bold text-blue-700 print:hidden">{formatCurrency(subVal)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 bg-gray-50">
                <tr>
                  <td className="px-4 py-3 font-bold" colSpan={3}>TOTAL GERAL</td>
                  <td className="px-4 py-3 text-right font-bold text-xl">{totalOrdered}</td>
                  <td className="px-4 py-3 text-right font-bold print:hidden">{totalReceived}</td>
                  <td className={cn('px-4 py-3 text-right font-bold text-lg', totalPending === 0 && totalOrdered > 0 ? 'text-green-600' : 'text-amber-600')}>
                    {totalPending === 0 && totalOrdered > 0 ? '✓ Tudo recebido' : totalPending}
                  </td>
                  <td className="px-4 py-3 text-right font-bold print:hidden">{formatCurrency(stats.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
