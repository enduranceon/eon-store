// Faixa "Atenção" da Visão geral: no máximo quatro grupos com ação concreta,
// vindos dos mesmos casos e prazos das telas de destino. Não há score oculto.
//
// Ordem (critério fixo, empate pela ordem abaixo):
//   1. cobranças vencidas, dinheiro com prazo já vencido;
//   2. estornos pendentes, dinheiro a devolver;
//   3. renovações para cobrar, receita recorrente em risco;
//   4. contatos a fazer na Central de Comunicação.
// "Em atraso" descreve vencimento; "sem resposta" só existe no histórico de
// contato da Central. Nada aqui envia mensagem, registra pagamento ou estorna.

export const ATTENTION_ORDER = ['overdue', 'refunds', 'renewals', 'contacts'];

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

export function buildAttentionGroups({ overdue, refunds, renewalCharges, contacts } = {}) {
  const groups = [];
  if (overdue?.count > 0) {
    groups.push({
      id: 'overdue',
      label: plural(overdue.count, 'cobrança em atraso', 'cobranças em atraso'),
      detail: `${overdue.people} ${overdue.people === 1 ? 'pessoa' : 'pessoas'}`,
      amount: overdue.total,
      to: '/financeiro',
    });
  }
  if (refunds > 0) {
    groups.push({
      id: 'refunds',
      label: plural(refunds, 'estorno pendente', 'estornos pendentes'),
      to: '/estornos',
    });
  }
  if (renewalCharges > 0) {
    groups.push({
      id: 'renewals',
      label: plural(renewalCharges, 'renovação para cobrar', 'renovações para cobrar'),
      to: '/assessoria/renovacoes',
    });
  }
  if (contacts > 0) {
    groups.push({
      id: 'contacts',
      label: plural(contacts, 'contato a fazer', 'contatos a fazer'),
      to: '/comunicacao',
    });
  }
  return groups.sort((a, b) => ATTENTION_ORDER.indexOf(a.id) - ATTENTION_ORDER.indexOf(b.id)).slice(0, 4);
}
