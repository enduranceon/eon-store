import { runAssessmentContractTransitions } from '@/api/client';

export async function applyAssessmentContractTransitions(contracts = []) {
  try {
    const result = await runAssessmentContractTransitions();
    const changedById = new Map((result?.changed || []).map(row => [row.id, row]));
    contracts.forEach(contract => {
      const changed = changedById.get(contract.id);
      if (changed) Object.assign(contract, changed);
    });
  } catch (error) {
    // As transições não devem impedir a leitura da página. A API fará uma nova
    // tentativa na próxima atualização e mantém a gravação fora do frontend.
    console.warn('[assessment-contract-transitions] falha ao aplicar:', error);
  }
  return contracts;
}
