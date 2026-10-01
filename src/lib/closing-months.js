// Fechamento de repasse só para mês encerrado: a mesma regra da função
// generate-monthly-closing e do banco (eon_private.guard_payout_closing_month).
// Meses no formato "YYYY-MM"; today no formato "YYYY-MM-DD" (data local).

function shiftMonth(month, amount) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + amount, 1)).toISOString().slice(0, 7);
}

export function lastEndedMonth(today) {
  return shiftMonth(today.slice(0, 7), -1);
}

export function monthHasEnded(month, today) {
  return month.slice(0, 7) < today.slice(0, 7);
}

// Primeiro dia em que o fechamento do mês pode ser gerado.
export function monthOpensOn(month) {
  return `${shiftMonth(month.slice(0, 7), 1)}-01`;
}

// Meses encerrados, do mais recente para trás.
export function endedMonths(today, count = 24) {
  const last = lastEndedMonth(today);
  return Array.from({ length: count }, (_, index) => shiftMonth(last, -index));
}
