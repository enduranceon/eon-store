// ─────────────────────────────────────────────────────────────────
// Feriados nacionais brasileiros + cálculo de dia útil
// ─────────────────────────────────────────────────────────────────

// Calcula o domingo de Páscoa pelo algoritmo de Meeus/Gauss.
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// Soma N dias a uma data UTC.
function addDaysUTC(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Formata Date → 'YYYY-MM-DD' (UTC).
function fmt(date) {
  return date.toISOString().slice(0, 10);
}

// Retorna Set de feriados nacionais brasileiros num ano dado.
// Inclui fixos + móveis (Carnaval, Sexta Santa, Corpus Christi).
export function nationalHolidays(year) {
  const easter = easterDate(year);
  return new Set([
    // Fixos
    `${year}-01-01`, // Confraternização Universal
    `${year}-04-21`, // Tiradentes
    `${year}-05-01`, // Dia do Trabalho
    `${year}-09-07`, // Independência
    `${year}-10-12`, // Nossa Senhora Aparecida
    `${year}-11-02`, // Finados
    `${year}-11-15`, // Proclamação da República
    `${year}-11-20`, // Consciência Negra (feriado nacional desde 2024)
    `${year}-12-25`, // Natal
    // Móveis
    fmt(addDaysUTC(easter, -48)), // Segunda-feira de carnaval
    fmt(addDaysUTC(easter, -47)), // Terça-feira de carnaval
    fmt(addDaysUTC(easter, -2)),  // Sexta-feira Santa
    fmt(addDaysUTC(easter,  60)), // Corpus Christi
  ]);
}

// Cache pra não recalcular feriados de cada ano toda hora.
const holidayCache = new Map();
function getHolidays(year) {
  if (!holidayCache.has(year)) holidayCache.set(year, nationalHolidays(year));
  return holidayCache.get(year);
}

// Verifica se uma string 'YYYY-MM-DD' é dia útil (não é sábado, domingo nem feriado).
export function isBusinessDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay(); // 0=dom 6=sáb
  if (dow === 0 || dow === 6) return false;
  if (getHolidays(y).has(yyyymmdd)) return false;
  return true;
}

// Se a data cair em fim de semana ou feriado, devolve o próximo dia útil.
// Se já for dia útil, devolve a própria data.
export function nextBusinessDay(yyyymmdd) {
  let current = yyyymmdd;
  // Salva-vidas: no máximo 30 saltos (cobre semanas inteiras de feriados)
  for (let i = 0; i < 30; i++) {
    if (isBusinessDay(current)) return current;
    const [y, m, d] = current.split('-').map(Number);
    const next = addDaysUTC(new Date(Date.UTC(y, m - 1, d)), 1);
    current = fmt(next);
  }
  return current; // safety: nunca deveria chegar aqui
}

// Soma N dias a uma data 'YYYY-MM-DD' e retorna no mesmo formato.
export function addDaysStr(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return fmt(addDaysUTC(new Date(Date.UTC(y, m - 1, d)), days));
}
