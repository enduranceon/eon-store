// Contatos do site: mensagens do formulário de contato. A equipe conversa com a
// pessoa e, se ela quiser treinar, cria o prospect a partir do contato. Nada aqui
// cria contrato ou cobrança, e o texto que a pessoa escreveu não muda.

export const CONTACT_STATUSES = [
  { value: 'new', label: 'Novo', open: true, tone: 'bg-amber-50 text-amber-800 border-amber-200' },
  { value: 'contacted', label: 'Em contato', open: true, tone: 'bg-blue-50 text-blue-800 border-blue-200' },
  { value: 'converted', label: 'Virou prospect', open: false, tone: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  { value: 'closed', label: 'Encerrado', open: false, tone: 'bg-slate-100 text-slate-600 border-slate-200' },
];

export const OPEN_CONTACT_STATUSES = new Set(
  CONTACT_STATUSES.filter(status => status.open).map(status => status.value),
);

export const CONTACT_CLOSE_REASONS = [
  'Dúvida respondida',
  'Não respondeu',
  'Não tem interesse',
  'Contato repetido',
];

export function contactStatus(value) {
  return CONTACT_STATUSES.find(status => status.value === value) || CONTACT_STATUSES[0];
}

export function isOpenContactRequest(request) {
  return OPEN_CONTACT_STATUSES.has(request?.status);
}

// Em aberto primeiro, do mais antigo ao mais novo (ninguém fica esquecido); depois os
// encerrados, com o desfecho mais recente antes.
export function sortContactRequests(requests = []) {
  return [...requests].sort((a, b) => {
    const openA = isOpenContactRequest(a);
    const openB = isOpenContactRequest(b);
    if (openA !== openB) return openA ? -1 : 1;
    if (openA) return String(a.created_at).localeCompare(String(b.created_at));
    return String(b.status_changed_at || b.updated_at).localeCompare(String(a.status_changed_at || a.updated_at));
  });
}

// Quantos contatos esperam resposta: os novos e os já em conversa.
export function summarizeContactRequests(requests = []) {
  let fresh = 0;
  let open = 0;
  for (const request of requests) {
    if (!isOpenContactRequest(request)) continue;
    open += 1;
    if (request.status === 'new') fresh += 1;
  }
  return { open, new: fresh };
}

// Observação do "Novo prospect" criado a partir do contato.
export function contactProspectNotes(request, sinceLabel) {
  return [
    `Veio do formulário de contato do site${sinceLabel ? ` (em ${sinceLabel})` : ''}.`,
    request?.subject ? `Assunto: ${request.subject}` : null,
    request?.message ? `Mensagem: ${request.message}` : null,
  ].filter(Boolean).join('\n');
}
