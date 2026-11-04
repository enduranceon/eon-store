// Encerrar uma licença sem data de volta numa data escolhida.
//
// O dia escolhido é o último dia de licença (conta como dia parado, igual ao
// "hoje" do encerramento sem data). Os dias somados ao fim do contrato são
// (último dia - início) + 1, a mesma conta do banco (handle_leave_change).

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(date) {
  if (!DATE_PATTERN.test(String(date || ''))) return null;
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value;
}

function fromUtc(value) {
  return value.toISOString().slice(0, 10);
}

export function addDaysIso(date, days) {
  const base = toUtc(date);
  if (!base) return '';
  return fromUtc(new Date(base.getTime() + days * DAY_MS));
}

// Por que o dia não vale (texto para a tela), ou '' quando vale.
export function leaveLastDayProblem({ leaveStart, lastDay, today }) {
  if (!toUtc(lastDay)) return 'Informe uma data válida';
  if (toUtc(leaveStart) && lastDay < leaveStart) return 'O último dia não pode ser antes do início da licença';
  if (toUtc(today) && lastDay > today) return 'O último dia não pode estar no futuro';
  return '';
}

// Dias parados e novo fim do contrato, ou null quando o dia não vale.
export function leaveFinishPreview({ leaveStart, contractEnd, lastDay, today }) {
  if (leaveLastDayProblem({ leaveStart, lastDay, today })) return null;
  const start = toUtc(leaveStart);
  const end = toUtc(lastDay);
  const oldEnd = toUtc(contractEnd);
  if (!start || !end || !oldEnd) return null;
  const days = Math.round((end - start) / DAY_MS) + 1;
  return { days, newEnd: addDaysIso(contractEnd, days) };
}
