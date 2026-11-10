// Regras de apresentação da área do coach: o que merece atenção, filtros e ordem da lista
// de alunos, resumo de um período e contagem regressiva dos eventos. Tudo parte dos dados
// que o servidor já entrega ao coach (alunos, meses e eventos): aqui não entra valor em
// dinheiro nem contato de aluno, e nada é recalculado fora das regras do painel da equipe.
//
// Datas chegam como "AAAA-MM-DD" e são comparadas por número de dia (UTC), então o
// resultado não muda com o fuso do aparelho.

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

const normalize = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function dayNumber(day) {
  const match = DAY_PATTERN.exec(String(day || ''));
  if (!match) return null;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(value) ? null : Math.round(value / 86_400_000);
}

// Dias de `from` até `to` (positivo quando `to` é depois). null se alguma data não vale.
export function daysBetween(from, to) {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a === null || b === null ? null : b - a;
}

export function greetingFor(hour) {
  const value = Number(hour);
  if (value >= 5 && value < 12) return 'Bom dia';
  if (value >= 12 && value < 18) return 'Boa tarde';
  return 'Boa noite';
}

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function longDateLabel(day) {
  const match = DAY_PATTERN.exec(String(day || ''));
  if (!match) return '';
  const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${Number(match[3])} de ${MONTHS[Number(match[2]) - 1]}`;
}

// "08/11" a partir de AAAA-MM-DD (data curta para listas).
export function shortDateLabel(day) {
  const match = DAY_PATTERN.exec(String(day || ''));
  return match ? `${match[3]}/${match[2]}` : '';
}

export function monthShort(day) {
  const match = DAY_PATTERN.exec(String(day || ''));
  return match ? MONTHS[Number(match[2]) - 1].slice(0, 3) : '';
}

export function dayOfMonth(day) {
  const match = DAY_PATTERN.exec(String(day || ''));
  return match ? String(Number(match[3])) : '';
}

// "hoje", "amanhã", "em 5 dias", "ontem", "há 3 dias".
export function relativeDays(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return '';
  if (days === 0) return 'hoje';
  if (days === 1) return 'amanhã';
  if (days === -1) return 'ontem';
  return days > 0 ? `em ${days} dias` : `há ${Math.abs(days)} dias`;
}

// "faltam 12 dias", "termina hoje", "venceu há 3 dias".
export function daysLeftLabel(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return '';
  if (days < 0) return `venceu ${relativeDays(days)}`;
  if (days === 0) return 'termina hoje';
  return `faltam ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

// Há quanto tempo algo aconteceu, em palavras: "hoje", "há 12 dias", "há 3 meses", "há 1 ano".
export function agoLabel(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return '';
  const past = Math.max(0, -days);
  if (past === 0) return 'hoje';
  if (past === 1) return 'ontem';
  if (past < 60) return `há ${past} dias`;
  if (past < 365) return `há ${Math.floor(past / 30)} meses`;
  const years = Math.floor(past / 365);
  return `há ${years} ${years === 1 ? 'ano' : 'anos'}`;
}

// Parte da vida do contrato já percorrida, de 0 a 100. null quando faltam as datas.
export function contractProgress(student, today) {
  const total = daysBetween(student?.started_on, student?.ends_on);
  const done = daysBetween(student?.started_on, today);
  if (total === null || done === null || total <= 0) return null;
  return {
    percent: Math.max(0, Math.min(100, Math.round((done / total) * 100))),
    daysLeft: daysBetween(today, student.ends_on),
    totalDays: total,
  };
}

export const ATTENTION_WINDOW_DAYS = 30;

// O que pede a atenção do coach em um aluno, ou null se está tudo bem:
//  - contrato que já passou do fim e o aluno segue na lista ("venceu");
//  - contrato que acaba nos próximos 30 dias ("vence");
//  - renovação em andamento e licença (o coach acompanha, não precisa agir sozinho).
// Quem está em renovação ou licença não aparece como "vencendo": a conversa já começou.
export function studentAttention(student, today, windowDays = ATTENTION_WINDOW_DAYS) {
  const key = student?.situation?.key;
  if (key === 'leave') return { key: 'leave', tone: 'neutral', label: 'Em licença', days: null, rank: 3 };
  if (key === 'renewal') return { key: 'renewal', tone: 'info', label: 'Renovação em andamento', days: null, rank: 2 };
  const days = daysBetween(today, student?.ends_on);
  if (days === null) return null;
  if (days < 0) return { key: 'expired', tone: 'danger', label: `Venceu ${relativeDays(days)}`, days, rank: 0 };
  if (days <= windowDays) {
    return { key: 'ending', tone: days <= 7 ? 'danger' : days <= 15 ? 'warning' : 'info', label: `Vence ${relativeDays(days)}`, days, rank: 1 };
  }
  return null;
}

// Alunos que pedem atenção, do mais urgente ao menos: venceu, vence (mais perto primeiro),
// renovação, licença. Desempate por nome para a ordem não mudar a cada abertura.
export function attentionItems(students = [], today, windowDays = ATTENTION_WINDOW_DAYS) {
  return students
    .map(student => ({ student, attention: studentAttention(student, today, windowDays) }))
    .filter(item => item.attention)
    .sort((a, b) => a.attention.rank - b.attention.rank
      || (a.attention.days ?? 0) - (b.attention.days ?? 0)
      || String(a.student.name).localeCompare(String(b.student.name), 'pt-BR'));
}

export const STUDENT_FILTERS = Object.freeze([
  { key: 'todos', label: 'Todos' },
  { key: 'vencendo', label: 'Vencendo' },
  { key: 'renovacao', label: 'Em renovação' },
  { key: 'licenca', label: 'Em licença' },
]);

function matchesFilter(attention, filter) {
  if (!filter || filter === 'todos') return true;
  if (filter === 'vencendo') return attention?.key === 'ending' || attention?.key === 'expired';
  if (filter === 'renovacao') return attention?.key === 'renewal';
  if (filter === 'licenca') return attention?.key === 'leave';
  return true;
}

export function filterCounts(students = [], today) {
  const counts = { todos: students.length, vencendo: 0, renovacao: 0, licenca: 0 };
  for (const student of students) {
    const attention = studentAttention(student, today);
    if (matchesFilter(attention, 'vencendo')) counts.vencendo += 1;
    else if (attention?.key === 'renewal') counts.renovacao += 1;
    else if (attention?.key === 'leave') counts.licenca += 1;
  }
  return counts;
}

export function filterStudents(students = [], { query = '', filter = 'todos', modality = '' } = {}, today) {
  const needle = normalize(query);
  return students.filter(student => {
    if (needle && !normalize(student.name).includes(needle)) return false;
    if (modality && normalize(student.modality) !== normalize(modality)) return false;
    return matchesFilter(studentAttention(student, today), filter);
  });
}

export const STUDENT_SORTS = Object.freeze([
  { key: 'nome', label: 'Nome (A a Z)' },
  { key: 'vencimento', label: 'Vencimento mais próximo' },
  { key: 'novos', label: 'Começaram há menos tempo' },
  { key: 'antigos', label: 'Começaram há mais tempo' },
]);

export function sortStudents(students = [], sort = 'nome') {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR');
  const list = [...students];
  if (sort === 'vencimento') {
    return list.sort((a, b) => String(a.ends_on || '9999').localeCompare(String(b.ends_on || '9999')) || byName(a, b));
  }
  if (sort === 'novos') return list.sort((a, b) => String(b.started_on || '').localeCompare(String(a.started_on || '')) || byName(a, b));
  if (sort === 'antigos') return list.sort((a, b) => String(a.started_on || '9999').localeCompare(String(b.started_on || '9999')) || byName(a, b));
  return list.sort(byName);
}

// Modalidades presentes, sem repetir e em ordem alfabética.
export function modalitiesOf(students = []) {
  const seen = new Map();
  for (const student of students) {
    const key = normalize(student.modality);
    if (key && !seen.has(key)) seen.set(key, student.modality);
  }
  return [...seen.values()].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
}

// O nome do plano costuma começar pela modalidade ("Corrida - Semestral"); como a modalidade
// já aparece ao lado, mostra só o resto ("Semestral").
export function planLabel(student) {
  const plan = String(student?.plan || '').trim();
  const modality = String(student?.modality || '').trim();
  if (!plan) return '';
  if (!modality) return plan;
  const planKey = normalize(plan);
  const modalityKey = normalize(modality);
  if (!planKey.startsWith(modalityKey)) return plan;
  const rest = plan.slice(modality.length).replace(/^[\s\-–—·:|/]+/, '').trim();
  return rest || plan;
}

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}

function hashOf(text) {
  let hash = 0;
  for (const char of String(text || '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash;
}

// Cores fixas por modalidade conhecida; as outras recebem uma cor estável pelo nome.
// As classes ficam escritas por inteiro para o Tailwind enxergá-las.
const MODALITY_TONES = [
  { chip: 'bg-blue-50 text-blue-700 ring-blue-200', dot: 'bg-blue-500', bar: '#3b82f6' },
  { chip: 'bg-violet-50 text-violet-700 ring-violet-200', dot: 'bg-violet-500', bar: '#8b5cf6' },
  { chip: 'bg-cyan-50 text-cyan-700 ring-cyan-200', dot: 'bg-cyan-500', bar: '#06b6d4' },
  { chip: 'bg-amber-50 text-amber-800 ring-amber-200', dot: 'bg-amber-500', bar: '#f59e0b' },
  { chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500', bar: '#10b981' },
  { chip: 'bg-rose-50 text-rose-700 ring-rose-200', dot: 'bg-rose-500', bar: '#f43f5e' },
];
const KNOWN_MODALITIES = { corrida: 0, triathlon: 1, natacao: 2, ciclismo: 3 };

export function modalityTone(modality) {
  const key = normalize(modality);
  const index = key in KNOWN_MODALITIES ? KNOWN_MODALITIES[key] : hashOf(key) % MODALITY_TONES.length;
  return MODALITY_TONES[index];
}

const AVATAR_TONES = [
  'bg-blue-100 text-blue-700', 'bg-violet-100 text-violet-700', 'bg-cyan-100 text-cyan-700',
  'bg-amber-100 text-amber-800', 'bg-emerald-100 text-emerald-700', 'bg-rose-100 text-rose-700',
];

export function avatarTone(name) {
  return AVATAR_TONES[hashOf(normalize(name)) % AVATAR_TONES.length];
}

// Participação de cada modalidade na base ativa, em %, somando 100 (a maior fatia absorve
// o arredondamento).
export function modalityShares(groups = []) {
  const total = groups.reduce((sum, group) => sum + (Number(group.students) || 0), 0);
  if (!total) return [];
  const shares = groups.map(group => ({
    modality: group.modality,
    students: Number(group.students) || 0,
    percent: Math.round(((Number(group.students) || 0) / total) * 100),
  })).sort((a, b) => b.students - a.students || String(a.modality).localeCompare(String(b.modality), 'pt-BR'));
  const drift = 100 - shares.reduce((sum, item) => sum + item.percent, 0);
  if (drift !== 0 && shares.length) shares[0].percent += drift;
  return shares;
}

// Soma dos últimos `months` meses do painel (entradas, retornos, renovações, saídas), o
// saldo e os meses de destaque. Mês sem movimento nenhum não é destaque.
export function periodSummary(monthly = [], months = 12) {
  const slice = monthly.slice(-Math.max(1, months));
  const total = slice.reduce((sum, month) => ({
    entries: sum.entries + (month.entries || 0),
    returns: sum.returns + (month.returns || 0),
    renewals: sum.renewals + (month.renewals || 0),
    exits: sum.exits + (month.exits || 0),
  }), { entries: 0, returns: 0, renewals: 0, exits: 0 });
  const net = total.entries + total.returns - total.exits;
  let best = null;
  let worst = null;
  for (const month of slice) {
    if (month.net > 0 && (!best || month.net > best.net)) best = month;
    if (month.exits > 0 && (!worst || month.exits > worst.exits)) worst = month;
  }
  // Mesma conta do painel da equipe: a média só conta os meses que começaram com alunos.
  const churnValues = slice.filter(month => (month.base_start || 0) > 0).map(month => Number(month.churn_rate) || 0);
  const averageChurn = churnValues.length ? churnValues.reduce((a, b) => a + b, 0) / churnValues.length : 0;
  return {
    ...total,
    net,
    averageChurn,
    firstLabel: slice[0]?.label || '',
    lastLabel: slice[slice.length - 1]?.label || '',
    startBase: slice[0]?.base_start ?? 0,
    endBase: slice[slice.length - 1]?.base_end ?? 0,
    best: best ? { label: best.label, net: best.net } : null,
    worst: worst ? { label: worst.label, exits: worst.exits } : null,
  };
}

// Frase curta que resume o período, em linguagem de gente.
export function periodSentence(summary, months) {
  const gained = summary.entries + summary.returns;
  const span = months === 1 ? 'no último mês' : `nos últimos ${months} meses`;
  const gain = `${gained} ${gained === 1 ? 'aluno entrou' : 'alunos entraram'}`;
  const loss = summary.exits === 0 ? 'ninguém saiu' : `${summary.exits} ${summary.exits === 1 ? 'saiu' : 'saíram'}`;
  const net = summary.net === 0 ? 'saldo zerado' : `saldo de ${summary.net > 0 ? '+' : '−'}${Math.abs(summary.net)}`;
  return `${span[0].toUpperCase()}${span.slice(1)}: ${gain}, ${loss} e o ${net}.`;
}

// ─ Eventos ─────────────────────────────────────────────────────────────────

// Quando o evento acontece, em relação a hoje: "hoje", "amanhã", "em 6 dias", "acontecendo
// agora" (vários dias e já começou), ou "há 3 dias" quando já passou.
export function eventCountdown(event, today) {
  const start = daysBetween(today, event?.event_date);
  const end = daysBetween(today, event?.end_date || event?.event_date);
  if (start === null) return { label: 'Data a definir', tone: 'neutral', past: false, soon: false };
  if (end !== null && end < 0) return { label: `Foi ${relativeDays(end)}`, tone: 'neutral', past: true, soon: false };
  if (start < 0) return { label: 'Acontecendo agora', tone: 'success', past: false, soon: true };
  if (start === 0) return { label: 'É hoje', tone: 'danger', past: false, soon: true };
  if (start === 1) return { label: 'É amanhã', tone: 'danger', past: false, soon: true };
  return { label: `Em ${start} dias`, tone: start <= 7 ? 'warning' : 'info', past: false, soon: start <= 7 };
}

// Participação das inscrições (pagas, a pagar, canceladas) em %, para a barra de progresso.
export function registrationShares({ paid = 0, not_paid: notPaid = 0, cancelled = 0 } = {}) {
  const total = paid + notPaid + cancelled;
  if (!total) return { total: 0, paid: 0, notPaid: 0, cancelled: 0 };
  return {
    total,
    paid: (paid / total) * 100,
    notPaid: (notPaid / total) * 100,
    cancelled: (cancelled / total) * 100,
  };
}
