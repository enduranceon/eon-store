import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_AREAS, resolveNavigation } from './navigation.js';

test('the nine areas retain one selected item for existing list and detail routes', () => {
  assert.equal(NAV_AREAS.length, 9);
  const paths = [
    ['/admin', 'overview', 'overview'],
    ['/pessoas/123?aba=contracts', 'people', 'people'],
    ['/clientes/123', 'people', 'people'],
    ['/assessoria/alunos/123', 'people', 'people'],
    ['/assessoria/renovacoes', 'assessment', 'renewals'],
    ['/assessoria/contratos/123', 'assessment', 'contracts'],
    ['/assessoria/ex-alunos-tecnofit', 'assessment', 'tecnofit_archive'],
    ['/assessoria/fechamento/123/extrato/456', 'finance', 'payouts'],
    ['/assessoria/repasse', 'finance', 'payouts'],
    ['/assessoria', 'indicators', 'assessment_indicators'],
    ['/assessoria/central-financeira', 'indicators', 'assessment_indicators'],
    ['/assessoria/movimento?periodo=year', 'indicators', 'assessment_movement'],
    ['/treinadores', 'settings', 'team'],
    ['/assessoria/coaches', 'settings', 'team'],
    ['/assessoria/coaches/123', 'settings', 'team'],
    ['/assessoria/lista-de-espera', 'assessment', 'waitlist'],
    ['/assessoria/contatos-do-site', 'assessment', 'contact_requests'],
    ['/financeiro', 'finance', 'charges'],
    ['/financeiro/conciliacao', 'finance', 'reconciliation'],
    ['/comunicacao', 'communication', 'contact_queue'],
    ['/comunicacao/configuracoes', 'communication', 'message_rules'],
    ['/admin/saude', 'settings', 'health'],
    ['/produtos/pre-venda/123', 'store', 'presale'],
    ['/estoque/pedidos/123', 'store', 'orders'],
    ['/eventos/123', 'events', 'events'],
  ];
  for (const [path, areaId, itemId] of paths) {
    assert.deepEqual(resolveNavigation(path), { areaId, itemId }, path);
  }
});

test('navigation items have unique identifiers and destinations', () => {
  const items = NAV_AREAS.flatMap(area => area.items || [area]);
  assert.equal(items.length, 36);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.equal(new Set(items.map(item => item.to)).size, items.length);
});

test('contextual tabs preserve all destinations previously linked from the sidebar', () => {
  // /hoje deixou de ser uma tela: redireciona para a Visão geral (/admin).
  const previousDestinations = [
    '/pessoas', '/assessoria/renovacoes', '/assessoria/contratos',
    '/assessoria/licencas', '/assessoria/prospects', '/assessoria/auditoria',
    '/assessoria/planos', '/pedidos', '/produtos', '/campanhas',
    '/produtos/pre-venda', '/devolucoes', '/eventos', '/financeiro',
    '/financeiro/fluxo-caixa', '/financeiro/conciliacao', '/estornos',
    '/assessoria/central-financeira', '/assessoria/repasse',
    '/assessoria/fechamento', '/comunicacao', '/comunicacao/configuracoes',
    '/admin', '/assessoria/indicadores', '/assessoria', '/analytics',
    '/relatorios', '/assessoria/coaches', '/treinadores', '/categorias',
    '/fornecedores', '/cupons', '/centros-receita',
    '/configuracoes/pagamento', '/assessoria/configuracoes', '/admin/saude',
  ];
  assert.equal(previousDestinations.length, 36);
  for (const path of previousDestinations) {
    assert.notEqual(resolveNavigation(path).areaId, null, path);
  }
});

test('the overview is the first entry and only /admin itself selects it', () => {
  assert.equal(NAV_AREAS[0].id, 'overview');
  assert.equal(NAV_AREAS[0].to, '/admin');
  assert.equal(NAV_AREAS[0].badge, undefined, 'no badge: the attention strip carries the summary');
  assert.equal(NAV_AREAS.some(area => area.id === 'today'), false, 'no duplicated Hoje/Visão geral entry');
  assert.deepEqual(resolveNavigation('/admin'), { areaId: 'overview', itemId: 'overview' });
  assert.deepEqual(resolveNavigation('/admin/'), { areaId: 'overview', itemId: 'overview' });
  assert.deepEqual(resolveNavigation('/admin/saude'), { areaId: 'settings', itemId: 'health' });
  assert.deepEqual(resolveNavigation('/admin/qualquer'), { areaId: null, itemId: null });
});
