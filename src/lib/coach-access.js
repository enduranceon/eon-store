// Mensagem pronta para a equipe mandar o acesso ao coach. A senha provisória aparece
// uma única vez para quem administra; o coach troca no primeiro acesso.

export function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

export function accessMessage({ name, link, email, password }) {
  const first = firstNameOf(name);
  return [
    `Olá${first ? `, ${first}` : ''}! Seu acesso ao sistema da Endurance ON está pronto.`,
    '',
    `Link: ${link}`,
    `E-mail: ${email}`,
    `Senha provisória: ${password}`,
    '',
    'No primeiro acesso o sistema pede para você criar uma senha nova.',
  ].join('\n');
}

// Por que não dá para criar o acesso agora (texto para a equipe), ou null se dá.
export function accessBlocker(coach) {
  if (!coach) return 'Coach não encontrado.';
  if (coach.auth_user_id) return null;
  if (coach.active === false) return 'Coach inativo não pode ter acesso. Ative o cadastro primeiro.';
  const email = String(coach.email || '').trim();
  if (!email || !email.includes('@')) return 'Cadastre um e-mail válido para o coach antes de criar o acesso.';
  return null;
}
