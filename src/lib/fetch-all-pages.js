// O Supabase devolve no máximo 1000 linhas por consulta (limite do PostgREST
// do projeto). Para listas maiores, busca página por página até vir uma
// página incompleta. Quem chama monta a consulta com ordenação estável
// (desempate por id) para as páginas não repetirem nem pularem linhas.
export const PAGE_SIZE = 1000;

export async function fetchAllPages(buildQuery, { pageSize = PAGE_SIZE } = {}) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}
