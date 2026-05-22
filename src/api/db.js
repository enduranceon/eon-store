import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

function parseSortBy(sortBy = '-created_date') {
  const desc = sortBy.startsWith('-');
  const field = desc ? sortBy.slice(1) : sortBy;
  return { field, ascending: !desc };
}

// Convert empty strings to null for UUID foreign-key fields
function sanitize(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && v === '' && k.endsWith('_id')) {
      out[k] = null;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function createSupabaseProxy(tableName) {
  return {
    async list(sortBy = '-created_date') {
      const { field, ascending } = parseSortBy(sortBy);
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .order(field, { ascending });
      if (error) throw error;
      return data ?? [];
    },

    async filter(filters = {}, sortBy = '-created_date') {
      const { field, ascending } = parseSortBy(sortBy);
      let query = supabase.from(tableName).select('*');
      for (const [key, value] of Object.entries(filters)) {
        if (value === null || value === undefined) {
          query = query.is(key, null);
        } else if (Array.isArray(value)) {
          query = query.in(key, value);
        } else {
          query = query.eq(key, value);
        }
      }
      query = query.order(field, { ascending });
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },

    async create(data) {
      const { id: _id, created_date: _cd, order_number: _on, ...rest } = data;
      const { data: created, error } = await supabase
        .from(tableName)
        .insert(sanitize(rest))
        .select()
        .single();
      if (error) throw error;
      return created;
    },

    async update(id, data) {
      const { id: _id, created_date: _cd, ...rest } = data;
      const { data: updated, error } = await supabase
        .from(tableName)
        .update(sanitize({ ...rest, updated_date: new Date().toISOString() }))
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return updated;
    },

    async delete(id) {
      const { error } = await supabase.from(tableName).delete().eq('id', id);
      if (error) throw error;
      return true;
    },

    async get(id) {
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
  };
}

const TABLE_MAP = {
  PreSaleCampaign:  'presale_campaigns',
  PreSaleProduct:   'presale_products',
  PreSaleCustomer:  'presale_customers',
  PreSaleOrder:     'presale_orders',
  PreSaleSupplier:  'presale_suppliers',
  PreSaleCategory:  'presale_categories',
  PreSaleTrainer:   'presale_trainers',
  StockProduct:     'stock_products',
  StockOrder:       'stock_orders',
  Product:          'products',
};

const entities = Object.fromEntries(
  Object.entries(TABLE_MAP).map(([name, table]) => [name, createSupabaseProxy(table)])
);

export function normalizePhone(value) {
  return value ? value.replace(/\D/g, '') : value;
}

export function normalizeEmail(value) {
  return value ? value.trim().toLowerCase() : value;
}

async function findOrCreateCustomer({ full_name, whatsapp, email, trainer }) {
  const cleanPhone = normalizePhone(whatsapp);
  const cleanEmail = normalizeEmail(email);

  let existing = null;
  if (cleanPhone) {
    const { data, error } = await supabase
      .from('presale_customers')
      .select('*')
      .eq('whatsapp', cleanPhone)
      .maybeSingle();
    if (error) throw error;
    existing = data;
  }
  if (!existing && cleanEmail) {
    const { data, error } = await supabase
      .from('presale_customers')
      .select('*')
      .eq('email', cleanEmail)
      .maybeSingle();
    if (error) throw error;
    existing = data;
  }
  if (existing) {
    const updates = {};
    if (full_name && full_name !== existing.full_name) updates.full_name = full_name;
    if (cleanEmail && cleanEmail !== existing.email) updates.email = cleanEmail;
    if (trainer && trainer !== existing.trainer) updates.trainer = trainer;
    if (Object.keys(updates).length > 0) {
      return entities.PreSaleCustomer.update(existing.id, updates);
    }
    return existing;
  }
  return entities.PreSaleCustomer.create({ full_name, whatsapp: cleanPhone, email: cleanEmail, trainer });
}

export async function getCampaignBySlugOrId(slugOrId) {
  const { data: bySlug } = await supabase
    .from('presale_campaigns')
    .select('*')
    .eq('slug', slugOrId)
    .maybeSingle();
  if (bySlug) return bySlug;
  const { data, error } = await supabase
    .from('presale_campaigns')
    .select('*')
    .eq('id', slugOrId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Campanha não encontrada');
  return data;
}

// Trainers are seeded via SQL migration; this is a no-op
async function seedTrainers() {}

export { supabase };

export const db = {
  entities,
  helpers: {
    findOrCreateCustomer,
    seedTrainers,
  },
};

export default db;
