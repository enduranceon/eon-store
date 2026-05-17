/**
 * db.js — Camada de dados com localStorage
 * API idêntica ao padrão Supabase usado no EON-HUB:
 *   db.entities.X.list()
 *   db.entities.X.filter({ field: value })
 *   db.entities.X.create(data)
 *   db.entities.X.update(id, data)
 *   db.entities.X.delete(id)
 *   db.entities.X.get(id)
 *
 * Para migrar para Supabase: substituir createLocalProxy por createSupabaseProxy
 */

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateOrderNumber() {
  const all = readStore('presale_orders');
  const max = all.reduce((acc, o) => {
    const num = parseInt(o.order_number?.replace('PED-', '') || '0', 10);
    return num > acc ? num : acc;
  }, 0);
  return `PED-${String(max + 1).padStart(6, '0')}`;
}

function readStore(table) {
  try {
    const raw = localStorage.getItem(`eon_store_${table}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeStore(table, data) {
  localStorage.setItem(`eon_store_${table}`, JSON.stringify(data));
}

function createLocalProxy(tableName) {
  return {
    async list(sortBy = '-created_date') {
      let data = readStore(tableName);
      if (sortBy) {
        const desc = sortBy.startsWith('-');
        const field = desc ? sortBy.slice(1) : sortBy;
        data = [...data].sort((a, b) => {
          const av = a[field] ?? '';
          const bv = b[field] ?? '';
          return desc ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
        });
      }
      return data;
    },

    async filter(filters = {}, sortBy = '-created_date') {
      let data = readStore(tableName);
      for (const [key, value] of Object.entries(filters)) {
        if (value === null || value === undefined) {
          data = data.filter(r => r[key] == null);
        } else if (Array.isArray(value)) {
          data = data.filter(r => value.includes(r[key]));
        } else {
          data = data.filter(r => r[key] === value);
        }
      }
      if (sortBy) {
        const desc = sortBy.startsWith('-');
        const field = desc ? sortBy.slice(1) : sortBy;
        data = [...data].sort((a, b) => {
          const av = a[field] ?? '';
          const bv = b[field] ?? '';
          return desc ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
        });
      }
      return data;
    },

    async create(data) {
      const all = readStore(tableName);
      const record = {
        ...data,
        id: generateId(),
        created_date: data.created_date ?? new Date().toISOString(),
        // Número de pedido automático para orders
        ...(tableName === 'presale_orders' && !data.order_number
          ? { order_number: generateOrderNumber() }
          : {}),
      };
      all.push(record);
      writeStore(tableName, all);
      return record;
    },

    async update(id, data) {
      const all = readStore(tableName);
      const idx = all.findIndex(r => r.id === id);
      if (idx === -1) throw new Error('Record not found');
      all[idx] = { ...all[idx], ...data, updated_date: new Date().toISOString() };
      writeStore(tableName, all);
      return all[idx];
    },

    async delete(id) {
      const all = readStore(tableName);
      writeStore(tableName, all.filter(r => r.id !== id));
      return true;
    },

    async get(id) {
      const all = readStore(tableName);
      const record = all.find(r => r.id === id);
      if (!record) throw new Error('Record not found');
      return record;
    },
  };
}

const TABLE_MAP = {
  PreSaleCampaign:   'presale_campaigns',
  PreSaleProduct:    'presale_products',
  PreSaleCustomer:   'presale_customers',
  PreSaleOrder:      'presale_orders',
  PreSaleSupplier:   'presale_suppliers',
  PreSaleCategory:   'presale_categories',
  PreSaleTrainer:    'presale_trainers',
};

const entities = Object.fromEntries(
  Object.entries(TABLE_MAP).map(([name, table]) => [name, createLocalProxy(table)])
);

// Helper para buscar cliente por WhatsApp ou email
async function findOrCreateCustomer({ full_name, whatsapp, email, trainer }) {
  const all = await entities.PreSaleCustomer.list();
  const existing = all.find(
    c =>
      (whatsapp && c.whatsapp === whatsapp) ||
      (email && c.email === email)
  );
  if (existing) return existing;
  return entities.PreSaleCustomer.create({ full_name, whatsapp, email, trainer });
}

const DEFAULT_TRAINERS = [
  'Bruno Jeremias', 'Elinai Freitas', 'Guto Fernandes',
  'Thais Prando', 'Denis Santana', 'Jéssica Vieira',
];

async function seedTrainers() {
  const existing = readStore('presale_trainers');
  if (existing.length > 0) return;
  const seeded = DEFAULT_TRAINERS.map(name => ({
    name,
    id: generateId(),
    created_date: new Date().toISOString(),
  }));
  writeStore('presale_trainers', seeded);
}

export const db = {
  entities,
  helpers: {
    findOrCreateCustomer,
    seedTrainers,
  },
};

export default db;
