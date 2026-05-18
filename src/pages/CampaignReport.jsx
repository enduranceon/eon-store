import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Download, Printer, Package, ShoppingCart, Users, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PreSaleCampaign, PreSaleOrder, PreSaleProduct } from '@/api/entities';
import { formatCurrency, formatDate } from '@/lib/utils';

export default function CampaignReport() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [rows, setRows] = useState([]);   // { sku, product_name, variation, qty, sale_price, total }
  const [stats, setStats] = useState({ orders: 0, customers: 0, total: 0, items: 0 });

  useEffect(() => {
    Promise.all([
      PreSaleCampaign.get(id),
      PreSaleOrder.filter({ campaign_id: id }),
      PreSaleProduct.list(),
    ]).then(([camp, orders, products]) => {
      setCampaign(camp);

      // Mapa de produto_id → product para lookup de SKU
      const productMap = Object.fromEntries(products.map(p => [p.id, p]));

      // Agrupa itens de todos os pedidos por (product_id + variation)
      const agg = {};
      let totalValue = 0;
      let totalItems = 0;
      const customerSet = new Set();

      const activeOrders = orders.filter(o => o.payment_status !== 'cancelled');
      activeOrders.forEach(o => {
        customerSet.add(o.customer_id || o.checkout_whatsapp);
        totalValue += o.total_value || 0;
        (o.items || []).forEach(item => {
          const key = `${item.product_id}__${item.variation || ''}`;
          if (!agg[key]) {
            // Busca SKU: no produto ou na variação específica
            const prod = productMap[item.product_id];
            let sku = prod?.sku || '';
            if (item.variation && prod?.variations) {
              const v = prod.variations.find(v => v.name === item.variation);
              if (v?.sku) sku = v.sku;
            }
            agg[key] = {
              sku,
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

      // Ordena: por produto nome, depois variação
      const sorted = Object.values(agg).sort((a, b) => {
        const nc = a.product_name.localeCompare(b.product_name);
        if (nc !== 0) return nc;
        return a.variation.localeCompare(b.variation);
      });

      setRows(sorted);
      setStats({ orders: activeOrders.length, customers: customerSet.size, total: totalValue, items: totalItems });
    });
  }, [id]);

  const exportCSV = () => {
    const header = ['SKU', 'Produto', 'Variação', 'Qtd. Pedida', 'Preço Unit. (R$)', 'Total (R$)'];
    const data = rows.map(r => [
      r.sku,
      r.product_name,
      r.variation || '-',
      r.qty,
      r.sale_price.toFixed(2).replace('.', ','),
      (r.qty * r.sale_price).toFixed(2).replace('.', ','),
    ]);
    const csv = [header, ...data].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    const bom = '﻿'; // UTF-8 BOM para Excel
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
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

  // Agrupa por produto para exibir subtotais
  const byProduct = rows.reduce((acc, r) => {
    if (!acc[r.product_name]) acc[r.product_name] = [];
    acc[r.product_name].push(r);
    return acc;
  }, {});

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 print:hidden">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/campanhas/${id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">Relatório · {campaign.name}</h2>
          <p className="text-sm text-muted-foreground">Pedido ao fornecedor · gerado em {formatDate(new Date().toISOString())}</p>
        </div>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="w-4 h-4" /> Imprimir
        </Button>
        <Button onClick={exportCSV} disabled={rows.length === 0}>
          <Download className="w-4 h-4" /> Exportar CSV
        </Button>
      </div>

      {/* Cabeçalho de impressão */}
      <div className="hidden print:block mb-6">
        <h1 className="text-2xl font-bold">{campaign.name}</h1>
        <p className="text-sm text-gray-500">Pedido ao fornecedor · {formatDate(new Date().toISOString())}</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Pedidos ativos', value: stats.orders, icon: ShoppingCart },
          { label: 'Clientes', value: stats.customers, icon: Users },
          { label: 'Total de itens', value: stats.items, icon: Package },
          { label: 'Receita total', value: formatCurrency(stats.total), icon: DollarSign },
        ].map(k => (
          <div key={k.label} className="bg-white rounded-xl border p-4">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className="text-2xl font-bold mt-1">{k.value}</p>
          </div>
        ))}
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
            <h3 className="font-bold">Itens para o fornecedor</h3>
            <span className="text-sm text-muted-foreground">{rows.length} SKU{rows.length !== 1 ? 's' : ''} · {stats.items} unidades</span>
          </div>

          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">SKU</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Produto</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Variação</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Qtd.</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground print:hidden">Preço Unit.</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground print:hidden">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {Object.entries(byProduct).map(([productName, items]) => {
                const subtotalQty = items.reduce((s, r) => s + r.qty, 0);
                const subtotalVal = items.reduce((s, r) => s + r.qty * r.sale_price, 0);
                return (
                  <>
                    {items.map((r, i) => (
                      <tr key={`${productName}-${i}`} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-mono text-xs text-blue-700">
                          {r.sku || <span className="text-gray-300 italic">sem SKU</span>}
                        </td>
                        <td className="px-4 py-2.5 font-medium">{r.product_name}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{r.variation || '—'}</td>
                        <td className="px-4 py-2.5 text-right font-bold text-lg">{r.qty}</td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground print:hidden">{formatCurrency(r.sale_price)}</td>
                        <td className="px-4 py-2.5 text-right print:hidden">{formatCurrency(r.qty * r.sale_price)}</td>
                      </tr>
                    ))}
                    {items.length > 1 && (
                      <tr className="bg-blue-50 border-t border-blue-100">
                        <td className="px-4 py-2" />
                        <td className="px-4 py-2 text-xs font-semibold text-blue-700" colSpan={2}>
                          Subtotal · {productName}
                        </td>
                        <td className="px-4 py-2 text-right font-bold text-blue-700">{subtotalQty}</td>
                        <td className="px-4 py-2 print:hidden" />
                        <td className="px-4 py-2 text-right font-bold text-blue-700 print:hidden">{formatCurrency(subtotalVal)}</td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
            <tfoot className="border-t-2 border-gray-200 bg-gray-50">
              <tr>
                <td className="px-4 py-3" colSpan={3}>
                  <span className="font-bold">TOTAL GERAL</span>
                </td>
                <td className="px-4 py-3 text-right font-bold text-xl">{stats.items}</td>
                <td className="px-4 py-3 print:hidden" />
                <td className="px-4 py-3 text-right font-bold print:hidden">{formatCurrency(stats.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
