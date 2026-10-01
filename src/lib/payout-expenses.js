// Lançamentos manuais do fechamento do treinador: repasse extra, desconto e
// gasto/reembolso. Usados no modal do fechamento (ClosingDetail) e no extrato
// (tela + PDF). O tipo fica em expense_category: 'repasse_extra', 'desconto'
// ou a categoria do gasto. O valor gravado já vem com sinal: desconto é
// negativo e o resto é positivo (a API e o banco conferem).

export const MANUAL_ENTRY_KINDS = [
  { value: 'repasse_extra', label: 'Repasse extra' },
  { value: 'desconto', label: 'Desconto' },
  { value: 'gasto', label: 'Gasto / reembolso' },
];

// Categorias de gasto/reembolso. Lista fixa; "outros" cobre o resto. Para
// adicionar categoria, inclua aqui.
export const EXPENSE_CATEGORIES = [
  { value: 'reembolso_combustivel', label: 'Reembolso combustível' },
  { value: 'insumos_treino',        label: 'Insumos de treino' },
  { value: 'escala_evento',         label: 'Escala / evento' },
  { value: 'outros',                label: 'Outros' },
];

const LABELS = {
  ...Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.value, c.label])),
  repasse_extra: 'Repasse extra',
  desconto: 'Desconto',
  ajuste: 'Ajuste',
};

// Rótulo legível de uma categoria; fallback para o próprio valor ou "Ajuste".
export function expenseCategoryLabel(value) {
  if (!value) return 'Ajuste';
  return LABELS[value] || value;
}

// Tipo do lançamento a partir da categoria gravada.
export function manualEntryKind(category) {
  if (category === 'repasse_extra' || category === 'desconto') return category;
  return 'gasto';
}

// Valor com sinal a partir do valor digitado (sempre positivo na tela).
export function signedManualAmount(kind, value) {
  const amount = Math.abs(Number(value));
  return kind === 'desconto' ? -amount : amount;
}
