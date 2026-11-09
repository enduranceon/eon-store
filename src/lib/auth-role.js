// Quem é a conta que acabou de entrar: administrador, coach ou nenhuma das duas.
//
// A decisão vem SEMPRE do servidor (a API valida o token e consulta o banco); o
// navegador só segue o resultado. Primeiro pergunta se é administrador, como sempre foi.
// Só quando o servidor diz "esta conta existe mas não é administradora" (403) é que
// pergunta se é coach. Qualquer outra falha (sessão inválida, rede, erro do servidor)
// não dá papel nenhum: a sessão é encerrada, como já era antes do login do coach.

export async function resolveAccountRole({ checkAdmin, checkCoach }) {
  try {
    await checkAdmin();
    return { role: 'admin', coach: null, error: null };
  } catch (adminError) {
    if (adminError?.status !== 403) {
      return { role: null, coach: null, error: adminError };
    }
  }

  try {
    const response = await checkCoach();
    return { role: 'coach', coach: response?.data ?? null, error: null };
  } catch (coachError) {
    return { role: null, coach: null, error: coachError };
  }
}

// A equipe cria o acesso com senha provisória e o coach precisa trocá-la no primeiro
// acesso. É um aviso de tela (o coach pode editar os próprios dados); a proteção dos
// dados não depende dele.
export function mustChangePassword(user) {
  return user?.user_metadata?.must_change_password === true;
}

export function homePathForRole(role) {
  if (role === 'coach') return '/coach';
  if (role === 'admin') return '/admin';
  return '/login';
}
