import { useState } from 'react';
import { CheckCircle2, Database, ArrowRight } from 'lucide-react';
import { supabase } from '@/api/db';

const TABLES = [
  { key: 'presale_suppliers',  label: 'Fornecedores' },
  { key: 'presale_categories', label: 'Categorias' },
  { key: 'presale_trainers',   label: 'Treinadores' },
  { key: 'presale_campaigns',  label: 'Campanhas' },
  { key: 'presale_products',   label: 'Produtos' },
  { key: 'presale_customers',  label: 'Clientes' },
  { key: 'presale_orders',     label: 'Pedidos' },
];

function readLocal(table) {
  try {
    const raw = localStorage.getItem(`eon_store_${table}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export default function Migrate() {
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [log, setLog]       = useState([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const counts = Object.fromEntries(TABLES.map(t => [t.key, readLocal(t.key).length]));
  const total  = Object.values(counts).reduce((a, b) => a + b, 0);

  const addLog = (msg, type = 'info') => setLog(l => [...l, { msg, type }]);

  const migrate = async () => {
    setStatus('running');
    setLog([]);
    const idMap = {};
    const newId = (oldId) => {
      if (!idMap[oldId]) idMap[oldId] = crypto.randomUUID();
      return idMap[oldId];
    };

    let done = 0;
    const allRecords = total;
    setProgress({ done: 0, total: allRecords });

    try {
      // 1. Suppliers
      const suppliers = readLocal('presale_suppliers');
      if (suppliers.length) {
        addLog(`Migrando ${suppliers.length} fornecedor(es)...`);
        for (const s of suppliers) {
          const { id: oldId, created_date, ...rest } = s;
          delete rest.updated_date;
          const { error } = await supabase.from('presale_suppliers').insert({
            id: newId(oldId), ...rest,
            created_date: created_date ?? new Date().toISOString(),
          });
          if (error) addLog(`  ⚠ "${s.name}": ${error.message}`, 'warn');
          setProgress({ done: ++done, total: allRecords });
        }
        addLog(`✓ Fornecedores OK`, 'ok');
      }

      // 2. Categories
      const categories = readLocal('presale_categories');
      if (categories.length) {
        addLog(`Migrando ${categories.length} categoria(s)...`);
        for (const c of categories) {
          const { id: oldId, created_date, ...rest } = c;
          delete rest.updated_date;
          const { error } = await supabase.from('presale_categories').insert({
            id: newId(oldId), ...rest,
            created_date: created_date ?? new Date().toISOString(),
          });
          if (error) addLog(`  ⚠ "${c.name}": ${error.message}`, 'warn');
          setProgress({ done: ++done, total: allRecords });
        }
        addLog(`✓ Categorias OK`, 'ok');
      }

      // 3. Trainers — merge with seeded ones
      const trainers = readLocal('presale_trainers');
      if (trainers.length) {
        addLog(`Migrando ${trainers.length} treinador(es)...`);
        const { data: existing } = await supabase.from('presale_trainers').select('name, id');
        const byName = Object.fromEntries((existing ?? []).map(t => [t.name.toLowerCase(), t.id]));
        for (const t of trainers) {
          const { id: oldId, created_date, ...rest } = t;
          delete rest.updated_date;
          const existingId = byName[t.name.toLowerCase()];
          if (existingId) {
            idMap[oldId] = existingId;
            addLog(`  → "${t.name}" já existe`, 'info');
          } else {
            const { error } = await supabase.from('presale_trainers').insert({
              id: newId(oldId), ...rest,
              created_date: created_date ?? new Date().toISOString(),
            });
            if (error) addLog(`  ⚠ "${t.name}": ${error.message}`, 'warn');
          }
          setProgress({ done: ++done, total: allRecords });
        }
        addLog(`✓ Treinadores OK`, 'ok');
      }

      // 4. Campaigns (product_order updated after products)
      const campaigns = readLocal('presale_campaigns');
      if (campaigns.length) {
        addLog(`Migrando ${campaigns.length} campanha(s)...`);
        for (const c of campaigns) {
          const { id: oldId, created_date, ...rest } = c;
          delete rest.product_order;
          delete rest.updated_date;
          const { error } = await supabase.from('presale_campaigns').insert({
            id: newId(oldId), ...rest, product_order: null,
            created_date: created_date ?? new Date().toISOString(),
          });
          if (error) addLog(`  ⚠ "${c.name}": ${error.message}`, 'warn');
          setProgress({ done: ++done, total: allRecords });
        }
        addLog(`✓ Campanhas OK`, 'ok');
      }

      // 5. Products
      const products = readLocal('presale_products');
      if (products.length) {
        addLog(`Migrando ${products.length} produto(s)...`);
        for (const p of products) {
          const { id: oldId, campaign_id, supplier_id, created_date, ...rest } = p;
          delete rest.updated_date;
          const { error } = await supabase.from('presale_products').insert({
            id: newId(oldId),
            campaign_id: campaign_id ? (idMap[campaign_id] ?? null) : null,
            supplier_id: supplier_id ? (idMap[supplier_id] ?? null) : null,
            ...rest,
            created_date: created_date ?? new Date().toISOString(),
          });
          if (error) addLog(`  ⚠ "${p.name}": ${error.message}`, 'warn');
          setProgress({ done: ++done, total: allRecords });
        }
        addLog(`✓ Produtos OK`, 'ok');
      }

      // Update product_order in campaigns now that products have new IDs
      for (const c of campaigns) {
        if (c.product_order?.length) {
          const newOrder = c.product_order.map(oid => idMap[oid]).filter(Boolean);
          if (newOrder.length) {
            await supabase.from('presale_campaigns')
              .update({ product_order: newOrder })
              .eq('id', idMap[c.id]);
          }
        }
      }

      // 6. Customers
      const customers = readLocal('presale_customers');
      if (customers.length) {
        addLog(`Migrando ${customers.length} cliente(s)...`);
        for (const cu of customers) {
          const { id: oldId, created_date, ...rest } = cu;
          delete rest.updated_date;
          const { error } = await supabase.from('presale_customers').insert({
            id: newId(oldId), ...rest,
            created_date: created_date ?? new Date().toISOString(),
          });
          if (error) addLog(`  ⚠ "${cu.full_name}": ${error.message}`, 'warn');
          setProgress({ done: ++done, total: allRecords });
        }
        addLog(`✓ Clientes OK`, 'ok');
      }

      // 7. Orders
      const orders = readLocal('presale_orders');
      if (orders.length) {
        addLog(`Migrando ${orders.length} pedido(s)...`);
        for (const o of orders) {
          const { id: oldId, campaign_id, customer_id, order_number, created_date, ...rest } = o;
          delete rest.updated_date;
          const remappedItems = (o.items ?? []).map(item => ({
            ...item,
            product_id: item.product_id ? (idMap[item.product_id] ?? item.product_id) : undefined,
          }));
          const { error } = await supabase.from('presale_orders').insert({
            id: newId(oldId),
            order_number,
            campaign_id: campaign_id ? (idMap[campaign_id] ?? null) : null,
            customer_id: customer_id ? (idMap[customer_id] ?? null) : null,
            ...rest,
            items: remappedItems,
            created_date: created_date ?? new Date().toISOString(),
          });
          if (error) addLog(`  ⚠ "${order_number}": ${error.message}`, 'warn');
          setProgress({ done: ++done, total: allRecords });
        }
        addLog(`✓ Pedidos OK`, 'ok');
      }

      addLog('Migração concluída com sucesso!', 'done');
      setStatus('done');
    } catch (err) {
      addLog(`Erro inesperado: ${err.message}`, 'error');
      setStatus('error');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="w-14 h-14 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Database className="w-7 h-7 text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Migração de Dados</h1>
          <p className="text-sm text-gray-500 mt-1">Transfere os dados locais para o Supabase</p>
        </div>

        {/* Counts */}
        <div className="bg-white rounded-2xl border divide-y">
          {TABLES.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between px-5 py-3">
              <span className="text-sm text-gray-600">{label}</span>
              <span className={`text-sm font-bold font-mono ${counts[key] > 0 ? 'text-blue-600' : 'text-gray-300'}`}>
                {counts[key]}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between px-5 py-3 bg-gray-50 rounded-b-2xl">
            <span className="font-semibold text-gray-700">Total</span>
            <span className="font-bold text-gray-900 font-mono">{total}</span>
          </div>
        </div>

        {/* Progress bar */}
        {status === 'running' && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-gray-500">
              <span>Progresso</span>
              <span>{progress.done}/{progress.total}</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Button */}
        {total === 0 ? (
          <div className="text-center py-4">
            <p className="text-gray-500 text-sm">Nenhum dado encontrado nesta origem.</p>
            <p className="text-gray-400 text-xs mt-1">Certifique-se de abrir esta página na porta correta (ex: localhost:5173)</p>
          </div>
        ) : (
          <button
            onClick={migrate}
            disabled={status === 'running' || status === 'done'}
            className="w-full h-12 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all
              disabled:opacity-50 disabled:cursor-not-allowed
              bg-blue-600 hover:bg-blue-700 text-white"
          >
            {status === 'running' ? (
              <><span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4" /> Migrando...</>
            ) : status === 'done' ? (
              <><CheckCircle2 className="w-5 h-5" /> Migração concluída!</>
            ) : (
              <><ArrowRight className="w-5 h-5" /> Migrar {total} registros para Supabase</>
            )}
          </button>
        )}

        {/* Log */}
        {log.length > 0 && (
          <div className="bg-gray-900 rounded-xl p-4 text-xs font-mono max-h-56 overflow-y-auto space-y-0.5">
            {log.map((entry, i) => (
              <div key={i} className={
                entry.type === 'ok'   ? 'text-green-400' :
                entry.type === 'warn' ? 'text-yellow-400' :
                entry.type === 'error' ? 'text-red-400' :
                entry.type === 'done' ? 'text-green-300 font-bold' :
                'text-gray-400'
              }>
                {entry.msg}
              </div>
            ))}
          </div>
        )}

        {status === 'done' && (
          <p className="text-center text-sm text-gray-500">
            Pode fechar esta página e usar o app normalmente em{' '}
            <a href="https://eon-store.netlify.app" className="text-blue-600 underline" target="_blank" rel="noreferrer">
              eon-store.netlify.app
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
