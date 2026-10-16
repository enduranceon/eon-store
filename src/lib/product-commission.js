// Comissão de produto para o coach de quem compra. A regra fica no produto
// (products.commission_type/commission_value); o banco registra a regra no
// pedido quando ele passa a pago e lança comissão e ajustes em
// product_commissions. Aqui só há formatação, prévia e resumo para as telas.
import { formatCompetence, formatCurrency } from './utils.js';

export const COMMISSION_TYPES = Object.freeze([
  { id: 'none', label: 'Sem comissão' },
  { id: 'percent', label: '% do valor pago' },
  { id: 'fixed', label: 'R$ por unidade' },
]);

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : NaN;
}

export function commissionFormFromProduct(product = {}) {
  if (!product.commission_type) return { type: 'none', value: '' };
  return { type: product.commission_type, value: String(product.commission_value ?? '') };
}

// Campos para gravar no produto. Devolve { error } quando a regra não fecha.
export function commissionPayload({ type, value } = {}) {
  if (!type || type === 'none') return { commission_type: null, commission_value: null };
  const amount = parseNumber(value);
  if (amount === null || Number.isNaN(amount) || amount <= 0) {
    return { error: type === 'percent' ? 'Informe a porcentagem da comissão' : 'Informe o valor da comissão por unidade' };
  }
  if (type === 'percent' && amount > 100) return { error: 'A comissão em % vai até 100' };
  return { commission_type: type, commission_value: Math.round(amount * 100) / 100 };
}

function percentText(value) {
  return `${String(Number(value)).replace('.', ',')}%`;
}

export function commissionRuleLabel(rule = {}, { short = false } = {}) {
  if (!rule.commission_type) return short ? '' : 'Sem comissão';
  if (rule.commission_type === 'percent') {
    return short ? percentText(rule.commission_value) : `${percentText(rule.commission_value)} do valor pago`;
  }
  return short ? `${formatCurrency(rule.commission_value)}/un.` : `${formatCurrency(rule.commission_value)} por unidade`;
}

// Quanto o coach recebe por unidade vendida a um preço, sem desconto.
export function commissionPerUnit(rule = {}, price = 0) {
  if (rule.commission_type === 'percent') return Math.round(Number(price || 0) * Number(rule.commission_value)) / 100;
  if (rule.commission_type === 'fixed') return Number(rule.commission_value) || 0;
  return 0;
}

const round = value => Math.round(value * 100) / 100;

// Prévia de um pedido ainda não pago, pelas regras de hoje: mesmo cálculo do
// banco (valor pago do item = preço + adicionais, proporcional ao desconto).
// rulesByItemProduct: product_id do item (estoque, pré-venda ou produto) -> regra.
export function estimateOrderCommission(order = {}, rulesByItemProduct = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  const active = items.filter(item => !item.cancelled);
  const lineOf = item => (Number(item.sale_price || 0) + Number(item.extras_total || 0)) * Number(item.quantity ?? 1);
  const lines = active.reduce((sum, item) => sum + lineOf(item), 0);
  const ratio = lines > 0 ? Math.min(1, Math.max(0, Number(order.total_value || 0)) / lines) : 0;
  const rows = [];
  for (const item of active) {
    const rule = rulesByItemProduct[item.product_id];
    if (!rule?.commission_type) continue;
    const quantity = Number(item.quantity ?? 1);
    const base = round(lineOf(item) * ratio);
    const amount = rule.commission_type === 'percent'
      ? round(base * Number(rule.commission_value) / 100)
      : round(Number(rule.commission_value) * quantity);
    rows.push({ product_name: item.product_name || 'Produto', quantity, base, amount, rule });
  }
  return { rows, total: round(rows.reduce((sum, row) => sum + row.amount, 0)) };
}

// Lançamentos de um pedido: saldo por coach e lista em ordem de criação.
export function summarizeOrderCommissions(entries = [], coachesById = {}) {
  const byCoach = new Map();
  for (const entry of entries) {
    const current = byCoach.get(entry.coach_id) || 0;
    byCoach.set(entry.coach_id, round(current + Number(entry.amount)));
  }
  const balances = [...byCoach.entries()]
    .map(([coachId, amount]) => ({ coachId, coachName: coachesById[coachId]?.name || 'Coach', amount }))
    .sort((a, b) => b.amount - a.amount || a.coachName.localeCompare(b.coachName, 'pt-BR'));
  const list = [...entries]
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.item_index - b.item_index)
    .map(entry => ({
      ...entry,
      amount: Number(entry.amount),
      coachName: coachesById[entry.coach_id]?.name || 'Coach',
      ruleLabel: commissionRuleLabel(entry, { short: true }),
      competenceLabel: formatCompetence(entry.competence, { short: true }),
      statusLabel: entry.closing_id ? 'No fechamento' : 'Aguardando fechamento',
    }));
  return { balances, list, total: round(entries.reduce((sum, entry) => sum + Number(entry.amount), 0)) };
}

export function commissionAmountText(amount) {
  const value = Number(amount) || 0;
  return value < 0 ? `− ${formatCurrency(Math.abs(value))}` : formatCurrency(value);
}
