// Categorias de gasto/reembolso lançadas no fechamento do treinador.
// Usadas no modal de ajuste (ClosingDetail) e no extrato (tela + PDF).
// Lista fixa; "outros" cobre o resto. Para adicionar categoria, inclua aqui.
export const EXPENSE_CATEGORIES = [
  { value: 'reembolso_combustivel', label: 'Reembolso combustível' },
  { value: 'insumos_treino',        label: 'Insumos de treino' },
  { value: 'escala_evento',         label: 'Escala / evento' },
  { value: 'ajuste',                label: 'Ajuste' },
  { value: 'outros',                label: 'Outros' },
];

const LABELS = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.value, c.label]));

// Rótulo legível de uma categoria; fallback para o próprio valor ou "Ajuste".
export function expenseCategoryLabel(value) {
  if (!value) return 'Ajuste';
  return LABELS[value] || value;
}
