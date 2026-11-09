// Alunos ativos, MRR e modalidades de hoje na Visão geral. Reaproveita a
// classificação canônica dos contratos (buildContractLifecycleRows): é ela que
// decide vigência, rascunho, licença, cancelamento e venda descartada, a mesma
// usada em Indicadores e Analytics. Aqui só se agrupa.
//
// - Aluno ativo é PESSOA única com ao menos um contrato que conta como ativo
//   hoje; linhas de contrato não são pessoas.
// - MRR é a soma do valor mensal equivalente dos contratos que contam no MRR
//   (helper canônico: desconto, prazo vendido e pro rata já aplicados). Não é
//   dinheiro recebido.
// - Modalidade vem do plano do contrato. A pessoa com contratos ativos em mais
//   de uma modalidade aparece em cada uma ("alunos vinculados"), e o total da
//   EON continua contando-a uma vez. O MRR é atribuído por contrato, sem dupla contagem.

import { buildContractLifecycleRows } from './assessment-contract-lifecycle.js';

const cents = value => Math.round((Number(value) || 0) * 100);
export const UNCLASSIFIED_MODALITY = 'unclassified';

function personKey(row) {
  return row.customer_id || `contract:${row.id}`;
}

function modalityOf(row) {
  const modality = row.modality || null;
  return {
    id: modality?.id || UNCLASSIFIED_MODALITY,
    name: modality?.name || 'Sem modalidade',
  };
}

export function buildOverviewStudents({
  contracts = [],
  plans = [],
  modalities = [],
  customers = [],
  today,
} = {}) {
  const plansById = Object.fromEntries(plans.map(plan => [plan.id, plan]));
  const modalitiesById = Object.fromEntries(modalities.map(modality => [modality.id, modality]));
  const customersById = Object.fromEntries(customers.map(customer => [customer.id, customer]));
  const rows = buildContractLifecycleRows(contracts, { plansById, modalitiesById, today });
  const activeRows = rows.filter(row => row.lifecycle?.counts?.active);
  const mrrRows = rows.filter(row => row.lifecycle?.counts?.mrr);

  const people = new Map();
  for (const row of activeRows) {
    const key = personKey(row);
    if (!people.has(key)) {
      people.set(key, {
        key,
        customerId: row.customer_id || null,
        name: customersById[row.customer_id]?.full_name || '—',
        modalityIds: new Set(),
        contracts: [],
      });
    }
    const person = people.get(key);
    person.modalityIds.add(modalityOf(row).id);
    person.contracts.push({
      id: row.id,
      number: row.contract_number,
      modality: modalityOf(row).name,
      planName: row.plan?.name || row.plan_snapshot?.name || '—',
      monthly: row.lifecycle?.counts?.mrr ? Number(row.monthly) || 0 : 0,
    });
  }

  const mrrCents = mrrRows.reduce((sum, row) => sum + cents(row.monthly), 0);

  const groups = new Map();
  const ensureGroup = modality => {
    if (!groups.has(modality.id)) {
      groups.set(modality.id, { id: modality.id, name: modality.name, peopleKeys: new Set(), mrrPeople: new Set(), mrrCents: 0, contracts: 0 });
    }
    return groups.get(modality.id);
  };
  for (const row of activeRows) {
    const group = ensureGroup(modalityOf(row));
    group.peopleKeys.add(personKey(row));
    group.contracts += 1;
  }
  for (const row of mrrRows) {
    const group = ensureGroup(modalityOf(row));
    group.mrrCents += cents(row.monthly);
    group.mrrPeople.add(personKey(row));
  }

  const totalPeople = people.size;
  const composition = [...groups.values()]
    .map(group => ({
      id: group.id,
      name: group.name,
      people: group.peopleKeys.size,
      contracts: group.contracts,
      mrr: group.mrrCents / 100,
      peopleShare: totalPeople ? group.peopleKeys.size / totalPeople : 0,
      mrrShare: mrrCents ? group.mrrCents / mrrCents : 0,
      // MRR do recorte dividido pelas pessoas únicas com MRR no mesmo recorte.
      ticket: group.mrrPeople.size ? group.mrrCents / 100 / group.mrrPeople.size : null,
    }))
    .sort((a, b) => b.people - a.people || a.name.localeCompare(b.name, 'pt-BR'));

  const overlapPeople = [...people.values()].filter(person => person.modalityIds.size > 1).length;
  const linked = composition.reduce((sum, item) => sum + item.people, 0);

  return {
    activePeople: totalPeople,
    activeContracts: activeRows.length,
    mrr: mrrCents / 100,
    mrrContracts: mrrRows.length,
    composition,
    // Pessoas com contratos ativos em mais de uma modalidade: a soma das linhas passa do total.
    overlapPeople,
    linkedPeople: linked,
    hasOverlap: linked !== totalPeople,
    // Detalhes: cada número abre a lista que o compõe.
    peopleList: [...people.values()]
      .map(person => ({
        key: person.key,
        customerId: person.customerId,
        name: person.name,
        modalities: [...new Set(person.contracts.map(contract => contract.modality))],
        contracts: person.contracts,
        monthly: person.contracts.reduce((sum, contract) => sum + contract.monthly, 0),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    mrrList: mrrRows
      .map(row => ({
        id: row.id,
        number: row.contract_number,
        customerId: row.customer_id || null,
        name: customersById[row.customer_id]?.full_name || '—',
        modality: modalityOf(row).name,
        planName: row.plan?.name || row.plan_snapshot?.name || '—',
        monthly: Number(row.monthly) || 0,
      }))
      .sort((a, b) => b.monthly - a.monthly || a.name.localeCompare(b.name, 'pt-BR')),
  };
}
