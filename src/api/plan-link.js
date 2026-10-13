// Link do plano (página pública /plano/:token): sem login, fala direto com a
// função pública public-plan-link.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const PUBLIC_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

async function request(method, query, body) {
  if (!SUPABASE_URL || !PUBLIC_KEY) throw new Error('Página não configurada');
  const response = await fetch(`${SUPABASE_URL}/functions/v1/public-plan-link${query}`, {
    method,
    headers: {
      apikey: PUBLIC_KEY,
      Authorization: `Bearer ${PUBLIC_KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.error || 'Não foi possível concluir agora. Tente de novo.');
    error.code = data?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export function loadPlanLink(token, coachId) {
  const params = new URLSearchParams({ token });
  if (coachId) params.set('coach', coachId);
  return request('GET', `?${params}`);
}

export function submitPlanLink(body) {
  return request('POST', '', body);
}
