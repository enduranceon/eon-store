import { getCoachPanel } from '@/api/client';
import { usePageData } from '@/hooks/usePageData';

// O painel inteiro vem de uma chamada só; as três telas (visão geral, alunos e mês a mês)
// usam a mesma chave e dividem o resultado.
export function useCoachPanel() {
  return usePageData({
    key: 'coach:panel',
    loader: getCoachPanel,
    initialData: null,
    maxAge: 60_000,
    forceOnMount: true,
  });
}
