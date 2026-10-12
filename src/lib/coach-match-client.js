// This client only talks to the isolated match functions, never the financial API.
export class CoachMatchError extends Error {
  constructor(message, { status = 500, code = 'match_error' } = {}) {
    super(message);
    this.name = 'CoachMatchError';
    this.status = status;
    this.code = code;
  }
}

export function createCoachMatchClient({ supabaseUrl, publicKey, getSession, fetchImpl = fetch }) {
  const base = supabaseUrl?.replace(/\/$/, '');

  async function request(functionName, path, { method = 'GET', body, authenticated = false, signal } = {}) {
    if (!base || !publicKey) throw new CoachMatchError('Formulário indisponível neste ambiente', { code: 'match_not_configured' });
    const headers = { apikey: publicKey };
    if (authenticated) {
      const { data, error } = await getSession();
      if (error || !data?.session?.access_token) {
        throw new CoachMatchError('Sua sessão expirou. Entre novamente para continuar.', { status: 401, code: 'missing_session' });
      }
      headers.Authorization = `Bearer ${data.session.access_token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(`${base}/functions/v1/${functionName}${path}`, {
      method, headers, signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new CoachMatchError(result?.message || result?.error || 'Não foi possível acessar o formulário', {
        status: response.status, code: result?.code || 'match_error',
      });
    }
    if (!result || result.data == null) {
      throw new CoachMatchError('O formulário retornou uma resposta inesperada. Tente atualizar.', { code: 'invalid_match_response' });
    }
    return result.data;
  }

  const coachPath = coachId => `/coach-match/${encodeURIComponent(coachId)}`;
  const admin = (coachId, action = '', body, signal) => request('coach-match-admin', `${coachPath(coachId)}${action}`, {
    authenticated: true, method: body === undefined ? 'GET' : 'POST', body, signal,
  });
  return {
    get: (coachId, { signal } = {}) => admin(coachId, '', undefined, signal),
    issueInvite: coachId => admin(coachId, '/invite', {}),
    revokeInvite: (coachId, inviteId) => admin(coachId, '/revoke', { invite_id: inviteId }),
    review: (coachId, submissionId, decision) => admin(coachId, '/review', { submission_id: submissionId, decision }),
    publicRequest: (action, token, answers) => request('coach-match-form', '', {
      method: 'POST', body: { action, token, ...(answers ? { answers } : {}) },
    }),
  };
}
