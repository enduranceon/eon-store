import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_AREAS, resolveNavigation } from './navigation.js';

test('the nine areas retain one selected item for existing list and detail routes', () => {
  assert.equal(NAV_AREAS.length, 9);
  const paths = [
    ['/hoje', 'today', 'today'],
    ['/pessoas/123?aba=contracts', 'people', 'people'],
    ['/clientes/123', 'people', 'people'],
    ['/assessoria/alunos/123', 'people', 'people'],
    ['/assessoria/renovacoes', 'assessment', 'renewals'],
    ['/assessoria/contratos/123', 'assessment', 'contracts'],
    ['/assessoria/fechamento/123/extrato/456', 'finance', 'closings'],
    ['/financeiro', 'finance', 'charges'],
    ['/financeiro/conciliacao', 'finance', 'reconciliation'],
    ['/comunicacao', 'communication', 'contact_queue'],
    ['/comunicacao/configuracoes', 'communication', 'message_rules'],
    ['/admin', 'indicators', 'overview'],
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
  assert.equal(items.length, 37);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.equal(new Set(items.map(item => item.to)).size, items.length);
});
