import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages } from './fetch-all-pages.js';

// Imita o PostgREST: cada consulta devolve no máximo `cap` linhas do intervalo pedido.
function fakeTable(total, { cap = 1000, failAt = null } = {}) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1 }));
  const ranges = [];
  const buildQuery = () => ({
    range(from, to) {
      ranges.push([from, to]);
      if (failAt !== null && from >= failAt) {
        return Promise.resolve({ data: null, error: { code: 'XX000', message: 'falhou' } });
      }
      const end = Math.min(to + 1, from + cap);
      return Promise.resolve({ data: rows.slice(from, end), error: null });
    },
  });
  return { buildQuery, ranges };
}

test('a list beyond the 1000-row cap comes back whole, page by page', async () => {
  const { buildQuery, ranges } = fakeTable(2500);
  const { data, error } = await fetchAllPages(buildQuery);

  assert.equal(error, null);
  assert.equal(data.length, 2500);
  assert.deepEqual(data.map(row => row.id), Array.from({ length: 2500 }, (_, i) => i + 1));
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('a short list takes a single request, and an exact multiple stops on the empty page', async () => {
  const small = fakeTable(37);
  assert.equal((await fetchAllPages(small.buildQuery)).data.length, 37);
  assert.equal(small.ranges.length, 1);

  const exact = fakeTable(2000);
  assert.equal((await fetchAllPages(exact.buildQuery)).data.length, 2000);
  assert.deepEqual(exact.ranges, [[0, 999], [1000, 1999], [2000, 2999]]);

  const empty = fakeTable(0);
  assert.deepEqual((await fetchAllPages(empty.buildQuery)).data, []);
});

test('an error on any page is returned instead of a partial list', async () => {
  const { buildQuery } = fakeTable(2500, { failAt: 1000 });
  const { data, error } = await fetchAllPages(buildQuery);

  assert.equal(data, null);
  assert.equal(error.code, 'XX000');
});
