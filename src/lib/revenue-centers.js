// Regras de tela dos centros de receita. O banco preenche o centro padrão em
// cadastros novos (eon_private.fill_default_revenue_center); aqui fica a mesma
// regra para a tela já mostrar o centro escolhido, e o resumo do que está
// ligado a cada centro.

function isActive(center) {
  return center?.active !== false;
}

// O centro ativo de um tipo (assessoria, loja, eventos), quando só existe um.
// Com mais de um, não há padrão: quem cadastra escolhe.
export function defaultRevenueCenterId(centers, type) {
  const candidates = (centers || []).filter(center => center?.type === type && isActive(center));
  return candidates.length === 1 ? candidates[0].id : '';
}

const EMPTY_LINKS = Object.freeze({ plans: 0, products: 0, events: 0 });

// Quantos planos, produtos (loja e pré-venda) e eventos estão em cada centro,
// e quantos estão sem centro. Recebimento de cadastro sem centro aparece como
// "Sem centro atribuído" no Financeiro.
export function summarizeRevenueCenterLinks({ plans = [], products = [], events = [] } = {}) {
  const byCenter = {};
  const unassigned = { ...EMPTY_LINKS };
  const add = (rows, key) => {
    for (const row of rows || []) {
      const centerId = row?.revenue_center_id;
      if (!centerId) {
        unassigned[key] += 1;
        continue;
      }
      byCenter[centerId] = byCenter[centerId] || { ...EMPTY_LINKS };
      byCenter[centerId][key] += 1;
    }
  };
  add(plans, 'plans');
  add(products, 'products');
  add(events, 'events');
  return { byCenter, unassigned };
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// "21 planos · 58 produtos"; vazio quando nada está ligado.
export function revenueCenterLinksLabel(links) {
  const parts = [];
  if (links?.plans) parts.push(plural(links.plans, 'plano', 'planos'));
  if (links?.products) parts.push(plural(links.products, 'produto', 'produtos'));
  if (links?.events) parts.push(plural(links.events, 'evento', 'eventos'));
  return parts.join(' · ');
}
