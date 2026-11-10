// Datas do negócio, sempre no fuso de Brasília (America/Sao_Paulo, sem horário de verão
// desde 2019). O painel da equipe roda no navegador (horário de Brasília) e a função do
// coach roda no servidor (UTC): para os dois darem exatamente o mesmo número, a conversão
// de um instante (timestamp) em dia de calendário nunca depende do fuso da máquina.
//
// Só a conversão de INSTANTE EM TEXTO (timestamp) para DIA é explícita aqui. A aritmética de
// dias entre datas já escritas (YYYY-MM-DD) constrói e lê a Date no mesmo fuso da máquina
// (meio-dia local), então o resultado também não depende do fuso.

export const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Dia (YYYY-MM-DD) de Brasília de um instante: Date, timestamp ISO ou número.
// Valor vazio ou inválido volta ''.
export function businessDayOf(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return dayFormatter.format(date);
}

// Hoje no fuso da máquina, como sempre foi no navegador (que roda em horário de Brasília).
// Quem roda no servidor (UTC) NUNCA depende deste padrão: passa a data de hoje de Brasília
// (businessDayOf(new Date())) explicitamente em todas as chamadas.
export function todayLocalStr() {
  return toLocalDateStr(new Date());
}

// Date construída no fuso da máquina (meia-noite ou meio-dia locais, como a aritmética de
// dias do módulo faz) lida de volta no MESMO fuso da máquina.
export function toLocalDateStr(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Timestamp UTC (ex.: "2026-05-27T01:30:00.000Z") para o dia de Brasília (26/05).
export function utcToLocalDateStr(utcStr) {
  return businessDayOf(utcStr);
}
