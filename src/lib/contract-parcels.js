// Carnê de boleto/PIX parcelado do Asaas: situação e resumo das parcelas de um
// contrato. Funções puras (sem acesso a banco ou tela) para valer igual no card
// do contrato e, depois, no quadro de Renovações.

export const CARNE_PAYMENT_METHOD = 'carne_boleto_pix';

const PAID_IN_ASAAS = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']);

export function isPaidInAsaas(parcel) {
  return PAID_IN_ASAAS.has(String(parcel?.asaas_status || ''));
}

export function isParcelRecorded(parcel) {
  return Boolean(parcel?.payment_row_id);
}

function toUtc(iso) {
  const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / 86_400_000);
}

function dayMonth(iso) {
  const [, month, day] = String(iso).slice(0, 10).split('-');
  return `${day}/${month}`;
}

export function formatBrl(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(Number(value) || 0)
    .replace(/\s+/g, ' ');
}

// key: recorded | paid_unrecorded | overdue | due_today | upcoming | deleted | refunded
// tone: success | info | danger | warning | muted
export function parcelState(parcel, today) {
  if (isParcelRecorded(parcel)) {
    return {
      key: 'recorded',
      tone: 'success',
      label: parcel.paid_date ? `Paga em ${dayMonth(parcel.paid_date)}` : 'Paga',
    };
  }
  const status = String(parcel?.asaas_status || '');
  if (status === 'DELETED') return { key: 'deleted', tone: 'muted', label: 'Removida no Asaas' };
  if (status === 'REFUNDED' || status === 'REFUND_REQUESTED') {
    return { key: 'refunded', tone: 'warning', label: 'Estornada no Asaas' };
  }
  if (isPaidInAsaas(parcel)) {
    return { key: 'paid_unrecorded', tone: 'info', label: 'Paga no Asaas · falta registrar' };
  }
  const late = daysBetween(parcel.due_date, today);
  if (late > 0) {
    return { key: 'overdue', tone: 'danger', label: `Vencida há ${late} dia${late === 1 ? '' : 's'}` };
  }
  if (late === 0) return { key: 'due_today', tone: 'warning', label: 'Vence hoje' };
  return { key: 'upcoming', tone: 'muted', label: `Vence em ${dayMonth(parcel.due_date)}` };
}

const cents = value => Math.round((Number(value) || 0) * 100);

export function parcelsSummary(parcels, today) {
  const list = [...(parcels || [])].sort((a, b) => a.installment_number - b.installment_number);
  const states = list.map(parcel => ({ parcel, state: parcelState(parcel, today) }));
  const recorded = states.filter(item => item.state.key === 'recorded');
  const totalCents = list.reduce((sum, parcel) => sum + cents(parcel.value), 0);
  const recordedCents = recorded.reduce((sum, item) => sum + cents(item.parcel.value), 0);
  const nextOpen = states.find(item => item.state.key !== 'recorded'
    && item.state.key !== 'deleted' && item.state.key !== 'refunded');
  return {
    total: list.length,
    recorded: recorded.length,
    totalValue: totalCents / 100,
    recordedValue: recordedCents / 100,
    balance: (totalCents - recordedCents) / 100,
    overdue: states.filter(item => item.state.key === 'overdue').length,
    pendingRecord: states.filter(item => item.state.key === 'paid_unrecorded').length,
    complete: list.length > 0 && recorded.length === list.length,
    nextOpen: nextOpen ? nextOpen.parcel : null,
  };
}

// "2 de 3 parcelas pagas · R$ 390,00 de R$ 585,00 · saldo R$ 195,00"
export function carneProgressLabel(summary) {
  if (!summary.total) return '';
  const noun = summary.total === 1 ? 'parcela paga' : 'parcelas pagas';
  const base = `${summary.recorded} de ${summary.total} ${noun} · ${formatBrl(summary.recordedValue)} de ${formatBrl(summary.totalValue)}`;
  return summary.complete ? base : `${base} · saldo ${formatBrl(summary.balance)}`;
}

// Mensagem curta para o aluno com o link da parcela (copiar e colar).
export function parcelMessage({ firstName, parcel }) {
  const name = String(firstName || '').trim();
  const greeting = name ? `Oi, ${name}! ` : 'Oi! ';
  return `${greeting}Segue o link da parcela ${parcel.installment_number}/${parcel.total_installments} `
    + `(${formatBrl(parcel.value)}, vence em ${dayMonth(parcel.due_date)}): ${parcel.invoice_url}`;
}
