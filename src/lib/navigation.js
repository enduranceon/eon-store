// A navegação organiza as telas existentes sem alterar seus dados ou operações.
// Cada destino tem um único item selecionável, inclusive quando a URL é antiga.
export const NAV_AREAS = [
  { id: 'today', label: 'Hoje', description: 'O que exige minha ação agora?', to: '/hoje', icon: 'today', badge: 'today' },
  { id: 'people', label: 'Pessoas', description: 'Quem é a pessoa e qual seu vínculo?', to: '/pessoas', icon: 'people', badge: 'clients' },
  {
    id: 'assessment', label: 'Assessoria', description: 'O ciclo do aluno', icon: 'assessment',
    items: [
      { id: 'renewals', label: 'Renovações', to: '/assessoria/renovacoes', icon: 'renewals', badge: 'renewals' },
      { id: 'contracts', label: 'Contratos', to: '/assessoria/contratos', icon: 'contracts', badge: 'assessoria' },
      { id: 'leaves', label: 'Licenças', to: '/assessoria/licencas', icon: 'leaves' },
      { id: 'prospects', label: 'Prospects', to: '/assessoria/prospects', icon: 'prospects', badge: 'prospects' },
      { id: 'audit', label: 'Auditoria', to: '/assessoria/auditoria', icon: 'audit' },
      { id: 'plans', label: 'Planos', to: '/assessoria/planos', icon: 'plans' },
    ],
  },
  {
    id: 'store', label: 'Loja', description: 'Vendas, produtos e entregas', icon: 'store',
    items: [
      { id: 'orders', label: 'Pedidos', to: '/pedidos', icon: 'orders', badge: 'orders' },
      { id: 'products', label: 'Produtos', to: '/produtos', icon: 'products' },
      { id: 'collections', label: 'Coleções', to: '/campanhas', icon: 'collections' },
      { id: 'presale', label: 'Pré-venda', to: '/produtos/pre-venda', icon: 'presale' },
      { id: 'returns', label: 'Devoluções', to: '/devolucoes', icon: 'returns' },
    ],
  },
  { id: 'events', label: 'Eventos', description: 'Inscrições e operação', to: '/eventos', icon: 'events', badge: 'events' },
  {
    id: 'finance', label: 'Financeiro', description: 'Cobrar, receber, conferir e repassar', icon: 'finance',
    items: [
      { id: 'charges', label: 'Cobranças', to: '/financeiro', icon: 'charges', badge: 'openSales', exact: true },
      { id: 'cashflow', label: 'Fluxo de caixa', to: '/financeiro/fluxo-caixa', icon: 'cashflow' },
      { id: 'reconciliation', label: 'Conciliação', to: '/financeiro/conciliacao', icon: 'reconciliation', badge: 'financialQuality' },
      { id: 'refunds', label: 'Estornos', to: '/estornos', icon: 'refunds' },
      { id: 'payouts', label: 'Repasses', to: '/assessoria/repasse', icon: 'payouts' },
    ],
  },
  {
    id: 'communication', label: 'Comunicação', description: 'Contatos e acompanhamento', icon: 'communication',
    items: [
      { id: 'contact_queue', label: 'Fila de contatos', to: '/comunicacao', icon: 'communication', exact: true },
      { id: 'message_rules', label: 'Modelos e regras', to: '/comunicacao/configuracoes', icon: 'settings' },
    ],
  },
  {
    id: 'indicators', label: 'Indicadores', description: 'Evolução e relatórios', icon: 'indicators',
    items: [
      { id: 'overview', label: 'Visão geral', to: '/admin', icon: 'overview', exact: true },
      { id: 'assessment_indicators', label: 'Assessoria', to: '/assessoria/indicadores', icon: 'indicators' },
      { id: 'analytics', label: 'Analytics', to: '/analytics', icon: 'analytics' },
      { id: 'reports', label: 'Relatórios', to: '/relatorios', icon: 'reports' },
    ],
  },
  {
    id: 'settings', label: 'Configurações', description: 'Equipe, cadastros e parâmetros', icon: 'settings',
    items: [
      { id: 'team', label: 'Equipe', to: '/assessoria/coaches', icon: 'coaches' },
      { id: 'categories', label: 'Loja · Categorias', to: '/categorias', icon: 'categories' },
      { id: 'suppliers', label: 'Loja · Fornecedores', to: '/fornecedores', icon: 'suppliers' },
      { id: 'coupons', label: 'Loja · Cupons', to: '/cupons', icon: 'coupons' },
      { id: 'revenue_centers', label: 'Financeiro · Centros de receita', to: '/centros-receita', icon: 'revenue' },
      { id: 'payment_methods', label: 'Financeiro · Métodos', to: '/configuracoes/pagamento', icon: 'payment' },
      { id: 'assessment_settings', label: 'Assessoria · Parâmetros', to: '/assessoria/configuracoes', icon: 'settings' },
      { id: 'health', label: 'Administração · Saúde', to: '/admin/saude', icon: 'health' },
    ],
  },
];

const LEGACY_SELECTIONS = [
  ['/clientes', 'people', 'people'],
  ['/assessoria/alunos', 'people', 'people'],
  ['/assessoria/regua', 'communication', 'message_rules'],
  ['/assessoria/fechamento', 'finance', 'payouts'],
  ['/assessoria/central-financeira', 'indicators', 'assessment_indicators'],
  ['/treinadores', 'settings', 'team'],
  ['/assessoria', 'indicators', 'assessment_indicators', true],
  ['/estoque/pedidos', 'store', 'orders'],
  ['/estoque/movimentacoes', 'store', 'products'],
  ['/estoque', 'store', 'products'],
  ['/biblioteca-produtos', 'store', 'products'],
];

function matchesRoute(pathname, to, exact = false) {
  return pathname === to || (!exact && pathname.startsWith(`${to}/`));
}

export function resolveNavigation(pathname) {
  const path = String(pathname || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
  const legacy = LEGACY_SELECTIONS.find(([prefix, , , exact]) => matchesRoute(path, prefix, exact));
  if (legacy) return { areaId: legacy[1], itemId: legacy[2] };

  const candidates = NAV_AREAS.flatMap(area => {
    if (area.to) return matchesRoute(path, area.to) ? [{ areaId: area.id, itemId: area.id, length: area.to.length }] : [];
    return area.items
      .filter(item => matchesRoute(path, item.to, item.exact))
      .map(item => ({ areaId: area.id, itemId: item.id, length: item.to.length }));
  });
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0]
    ? { areaId: candidates[0].areaId, itemId: candidates[0].itemId }
    : { areaId: null, itemId: null };
}
