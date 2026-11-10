const PAGE_SIZE = 1000;

async function readAll(client, table, customerId) {
  const rows = [];
  let cursor = null;
  while (true) {
    // Full records keep discounts, sold terms and lifecycle evidence together.
    let query = client.from(table).select('*').order('id', { ascending: true }).limit(PAGE_SIZE);
    if (customerId) query = query.eq('customer_id', customerId);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (!page.length) break;
    const nextCursor = page.at(-1)?.id;
    if (!nextCursor || (cursor && nextCursor <= cursor)) throw new Error('Assessment metrics pagination did not advance');
    cursor = nextCursor;
  }
  return rows.sort((a, b) => String(b.created_at || b.created_date || '').localeCompare(String(a.created_at || a.created_date || '')));
}

export function loadAssessmentMetricContracts(client, customerId) {
  return readAll(client, 'assessment_contracts', customerId);
}

export function loadAssessmentMetricPlans(client) {
  return readAll(client, 'assessment_plans');
}
