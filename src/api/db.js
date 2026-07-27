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

// Tenta ordenar por `field`. Se a coluna não existir (42703), faz fallback
// entre `created_date` ↔ `created_at`. Reconstrói a query a cada tentativa
// para não acumular cláusulas ORDER BY inválidas.
async function safeOrder(buildQuery, field, ascending) {
  let { data, error } = await buildQuery().order(field, { ascending });
  if (error?.code === '42703') {
    const fallback = field === 'created_date' ? 'created_at'
                   : field === 'created_at'   ? 'created_date'
                   : null;
    if (fallback) {
      ({ data, error } = await buildQuery().order(fallback, { ascending }));
    }
    // Última tentativa: sem ordenação
    if (error?.code === '42703') {
      ({ data, error } = await buildQuery());
    }
  }
  if (error) throw error;
  return data ?? [];
}

function createSupabaseProxy(tableName) {
  return {
    async list(sortBy = '-created_date') {
      const { field, ascending } = parseSortBy(sortBy);
      return safeOrder(() => supabase.from(tableName).select('*'), field, ascending);
    },

    async filter(filters = {}, sortBy = '-created_date') {
      const { field, ascending } = parseSortBy(sortBy);
      // Constrói uma factory que cria a query do zero a cada chamada
      const buildQuery = () => {
        let q = supabase.from(tableName).select('*');
        for (const [key, value] of Object.entries(filters)) {
          if (value === null || value === undefined) {
            q = q.is(key, null);
          } else if (Array.isArray(value)) {
            q = q.in(key, value);
          } else {
            q = q.eq(key, value);
          }
        }
        return q;
      };
      return safeOrder(buildQuery, field, ascending);
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
  Coupon:           'coupons',
  // Universal
  RevenueCenter:    'revenue_centers',
  DiscountLog:      'discount_log',
  // Régua de renovação
  RenewalRule:             'renewal_rules',
  ContractRenewalAction:   'contract_renewal_actions',
  CommunicationSetting:     'communication_settings',
  CommunicationRule:        'communication_rules',
  // Módulo Assessoria
  AssessmentModality:           'assessment_modalities',
  AssessmentPlan:               'assessment_plans',
  AssessmentCoach:              'assessment_coaches',
  AssessmentContract:           'assessment_contracts',
  AssessmentContractCoachHist:  'assessment_contract_coach_history',
  AssessmentLeave:              'assessment_leaves',
  AssessmentContractEvent:      'assessment_contract_event',
  PaymentMethodConfig:          'payment_methods',
  PayoutRoleModalityRate:       'payout_role_modality_rates',
  PayoutGrowthTier:             'payout_growth_tiers',
  PayoutMonthlyClosing:         'payout_monthly_closings',
  PayoutMonthlyStatementItem:   'payout_monthly_statement_items',
};

const entities = Object.fromEntries(
  Object.entries(TABLE_MAP).map(([name, table]) => [name, createSupabaseProxy(table)])
);

export function normalizePhone(value) {
  return value ? value.replace(/\D/g, '') : value;
}

export async function getCampaignBySlugOrId(slugOrId) {
  const { data: bySlug, error: slugErr } = await supabase
    .from('presale_campaigns')
    .select('*')
    .eq('slug', slugOrId)
    .order('created_date', { ascending: false })
    .limit(1);
  if (slugErr) throw slugErr;
  if (bySlug?.[0]) return bySlug[0];
  const { data, error } = await supabase
    .from('presale_campaigns')
    .select('*')
    .eq('id', slugOrId)
    .limit(1);
  if (error) throw error;
  if (!data?.[0]) throw new Error('Campanha não encontrada');
  return data[0];
}

// Trainers are seeded via SQL migration; this is a no-op
async function seedTrainers() {}

export { supabase };

export const db = {
  entities,
  helpers: {
    seedTrainers,
  },
};

export default db;
