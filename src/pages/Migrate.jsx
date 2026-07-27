import { useMemo, useState } from 'react';
import { CheckCircle2, Database, ArrowRight } from 'lucide-react';
import {
  PreSaleCampaign,
  PreSaleCategory,
  PreSaleCustomer,
  PreSaleProduct,
  PreSaleSupplier,
  PreSaleTrainer,
} from '@/api/entities';
import { importLegacyPresaleOrder } from '@/api/client';

const TABLES = [
  { key: 'presale_suppliers', label: 'Fornecedores' },
  { key: 'presale_categories', label: 'Categorias' },
  { key: 'presale_trainers', label: 'Treinadores' },
  { key: 'presale_campaigns', label: 'Campanhas' },
  { key: 'presale_products', label: 'Produtos' },
  { key: 'presale_customers', label: 'Clientes' },
  { key: 'presale_orders', label: 'Pedidos' },
];

function readLocal(table) {
  try {
    const raw = localStorage.getItem(`eon_store_${table}`);
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function writable(record, omitted = []) {
  const output = { ...record };
  for (const key of ['id', 'created_at', 'created_date', 'updated_at', 'updated_date', ...omitted]) delete output[key];
  return output;
}

const LEGACY_ORDER_FIELDS = new Set([
  'order_number', 'campaign_id', 'customer_id', 'customer_name', 'customer_whatsapp', 'customer_email',
  'status', 'items', 'total_amount', 'notes', 'checkout_name', 'checkout_whatsapp', 'checkout_email',
  'total_value', 'total_cost', 'payment_status', 'delivery_status', 'payment_date', 'delivery_date',
  'internal_notes', 'delivery_method', 'delivery_city', 'payment_method', 'due_date', 'cancellation_reason',
  'coupon_code', 'discount_value', 'manual_discount', 'discount_reason', 'manual_fee', 'manual_payment',
  'external_payment_link', 'payment_preference', 'coach_id',
]);

function legacyOrderPayload(order) {
  return Object.fromEntries(Object.entries(writable(order)).filter(([key]) => LEGACY_ORDER_FIELDS.has(key)));
}

export default function Migrate() {
  const [status, setStatus] = useState('idle');
  const [log, setLog] = useState([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const source = useMemo(() => Object.fromEntries(TABLES.map(({ key }) => [key, readLocal(key)])), []);
  const counts = Object.fromEntries(TABLES.map(({ key }) => [key, source[key].length]));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const addLog = (msg, type = 'info') => setLog(current => [...current, { msg, type }]);

  const migrate = async () => {
    if (!total || status === 'running') return;
    setStatus('running');
    setLog([]);
    setProgress({ done: 0, total });
    const idMap = {};
    let done = 0;
    const step = () => setProgress({ done: ++done, total });

    try {
      for (const supplier of source.presale_suppliers) {
        const created = await PreSaleSupplier.create(writable(supplier));
        idMap[supplier.id] = created.id;
        step();
      }
      addLog('✓ Fornecedores importados', 'ok');

      for (const category of source.presale_categories) {
        const created = await PreSaleCategory.create(writable(category));
        idMap[category.id] = created.id;
        step();
      }
      addLog('✓ Categorias importadas', 'ok');

      const currentTrainers = await PreSaleTrainer.list('name');
      for (const trainer of source.presale_trainers) {
        const existing = currentTrainers.find(item => item.name?.toLowerCase() === trainer.name?.toLowerCase());
        const created = existing || await PreSaleTrainer.create(writable(trainer));
        idMap[trainer.id] = created.id;
        step();
      }
      addLog('✓ Treinadores importados', 'ok');

      for (const campaign of source.presale_campaigns) {
        const created = await PreSaleCampaign.create(writable(campaign, ['product_order']));
        idMap[campaign.id] = created.id;
        step();
      }
      addLog('✓ Campanhas importadas', 'ok');

      for (const product of source.presale_products) {
        const payload = writable(product);
        payload.campaign_id = product.campaign_id ? (idMap[product.campaign_id] || null) : null;
        payload.supplier_id = product.supplier_id ? (idMap[product.supplier_id] || null) : null;
        payload.campaign_ids = (product.campaign_ids || []).map(oldId => idMap[oldId]).filter(Boolean);
        const created = await PreSaleProduct.create(payload);
        idMap[product.id] = created.id;
        step();
      }
      for (const campaign of source.presale_campaigns) {
        const order = (campaign.product_order || []).map(oldId => idMap[oldId]).filter(Boolean);
        if (order.length) await PreSaleCampaign.update(idMap[campaign.id], { product_order: order });
      }
      addLog('✓ Produtos e ordem das campanhas importados', 'ok');

      for (const customer of source.presale_customers) {
        const created = await PreSaleCustomer.create(writable(customer, ['trainer']));
        idMap[customer.id] = created.id;
        step();
      }
      addLog('✓ Clientes importados', 'ok');

      for (const order of source.presale_orders) {
        const payload = legacyOrderPayload(order);
        payload.campaign_id = order.campaign_id ? (idMap[order.campaign_id] || null) : null;
        payload.customer_id = order.customer_id ? (idMap[order.customer_id] || null) : null;
        payload.items = (order.items || []).map(item => ({
          ...item,
          product_id: item.product_id ? (idMap[item.product_id] || item.product_id) : undefined,
        }));
        await importLegacyPresaleOrder(payload);
        step();
      }
      addLog('Migração concluída pela API autenticada.', 'done');
      setStatus('done');
    } catch (error) {
      addLog(`Migração interrompida: ${error.message}`, 'error');
      setStatus('error');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <div className="w-14 h-14 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Database className="w-7 h-7 text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Migração de Dados</h1>
          <p className="text-sm text-gray-500 mt-1">Importação legada protegida pela API administrativa</p>
        </div>

        <div className="bg-white rounded-2xl border divide-y">
          {TABLES.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between px-5 py-3">
              <span className="text-sm text-gray-600">{label}</span>
              <span className={`text-sm font-bold font-mono ${counts[key] ? 'text-blue-600' : 'text-gray-300'}`}>{counts[key]}</span>
            </div>
          ))}
          <div className="flex items-center justify-between px-5 py-3 bg-gray-50 rounded-b-2xl">
            <span className="font-semibold text-gray-700">Total</span>
            <span className="font-bold text-gray-900 font-mono">{total}</span>
          </div>
        </div>

        {status === 'running' && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-500"><span>Progresso</span><span>{progress.done}/{progress.total}</span></div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {total === 0 ? (
          <p className="text-center text-sm text-gray-500">Nenhum dado local encontrado nesta origem.</p>
        ) : (
          <button onClick={migrate} disabled={status === 'running' || status === 'done'} className="w-full h-12 rounded-xl font-semibold flex items-center justify-center gap-2 bg-blue-600 text-white disabled:opacity-50">
            {status === 'done' ? <><CheckCircle2 className="w-5 h-5" /> Concluído</> : <>Migrar pela API <ArrowRight className="w-5 h-5" /></>}
          </button>
        )}

        {log.length > 0 && (
          <div className="bg-gray-900 rounded-xl p-4 max-h-56 overflow-auto font-mono text-xs space-y-1">
            {log.map((entry, index) => <div key={index} className={entry.type === 'error' ? 'text-red-400' : entry.type === 'done' ? 'text-green-300 font-bold' : entry.type === 'ok' ? 'text-green-400' : 'text-gray-300'}>{entry.msg}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
