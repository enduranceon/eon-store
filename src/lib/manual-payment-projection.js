import { nextBusinessDay } from './business-days.js';

// Preview usado pelo formulário. O backend recalcula a mesma projeção e é a
// fonte de verdade no momento da gravação.
function addDaysLocal(yyyymmdd, days) {
  const [year, month, day] = yyyymmdd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// totalValue é opcional: sem ele, cada parcela sai sem `value` (só a data),
// usado pelo preview antes de saber o valor. Com ele, divide o valor
// igualmente entre as parcelas, sobra de arredondamento na última — mesma
// regra do backend, que é quem valida de verdade no momento de gravar.
export function projectInstallments(methodConfig, paymentDate, totalValue) {
  if (!methodConfig || !paymentDate) return [];
  const installments = Math.max(1, Math.min(12, Number(methodConfig.installments) || 1));
  const firstOffset = Number(methodConfig.credit_days_first) || 0;
  const nextOffset = Number(methodConfig.credit_days_between) || 32;
  const hasValue = Number.isFinite(totalValue);
  const projection = [];
  let previousDate = paymentDate;
  let allocated = 0;

  for (let number = 1; number <= installments; number += 1) {
    const rawDate = addDaysLocal(previousDate, number === 1 ? firstOffset : nextOffset);
    const creditDate = nextBusinessDay(rawDate);
    const row = {
      number,
      total: installments,
      // `date` alimenta o campo editável do formulário; os nomes canônicos
      // continuam disponíveis para o payload e para as telas financeiras.
      date: creditDate,
      due_date: creditDate,
      credit_date: creditDate,
    };
    if (hasValue) {
      const value = number === installments
        ? Math.round((totalValue - allocated) * 100) / 100
        : Math.round((totalValue / installments) * 100) / 100;
      row.value = value;
      allocated += value;
    }
    projection.push(row);
    previousDate = creditDate;
  }

  return projection;
}
