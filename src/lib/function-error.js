// Mensagem de erro de uma Edge Function chamada com supabase.functions.invoke:
// em resposta 4xx/5xx o supabase-js devolve um erro genérico e a mensagem
// da função fica no corpo da resposta.
export async function functionErrorMessage(error, fallback) {
  try {
    if (error?.context?.json) {
      const body = await error.context.json();
      if (body?.error) return body.error;
    }
  } catch { /* corpo sem JSON */ }
  return error?.message || fallback;
}
