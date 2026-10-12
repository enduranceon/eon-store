export function getCoachMatchView(snapshot, elapsedMs = 0) {
  if (!snapshot?.coach?.id || !snapshot.coach.name || !Array.isArray(snapshot.invites)
    || !Object.hasOwn(snapshot, 'latest') || !Object.hasOwn(snapshot, 'published')
    || !Number.isFinite(Date.parse(snapshot.server_time))
    || (snapshot.latest && (!snapshot.latest.id || !['pending', 'approved', 'rejected', 'superseded'].includes(snapshot.latest.status)))
    || (snapshot.published && (!snapshot.published.id || snapshot.published.status !== 'approved'))) {
    throw new Error('Não foi possível confirmar o estado do formulário. Atualize para tentar novamente.');
  }
  const now = Date.parse(snapshot.server_time) + Math.max(0, elapsedMs);
  return {
    pending: snapshot.latest?.status === 'pending' ? snapshot.latest : null,
    published: snapshot.published?.status === 'approved' ? snapshot.published : null,
    currentInvite: snapshot.invites.find(invite => !invite.revoked_at && Date.parse(invite.expires_at) > now) || null,
  };
}

export function coachMatchStatusMessage(status) {
  if (status === 'pending') return 'Sua última resposta está aguardando revisão. Você pode enviar uma atualização.';
  if (status === 'approved') return 'Sua última resposta foi aprovada. Se alterar algo, a versão aprovada continua disponível até nova aprovação.';
  if (status === 'rejected') return 'Sua última resposta não foi publicada. Você pode revisar e reenviar. Uma versão aprovada anteriormente continua disponível.';
  if (status === 'superseded') return 'Esta resposta foi substituída por um envio mais recente. Reabra o link para conferir a versão atual.';
  return null;
}
