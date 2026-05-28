import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value) {
  if (value === null || value === undefined) return 'R$ 0,00';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(value) || 0);
}

export function formatPercent(value) {
  if (value === null || value === undefined) return '0%';
  return `${(Number(value) || 0).toFixed(1)}%`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const str = String(dateStr);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(str + 'T00:00:00') : new Date(str);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('pt-BR');
  } catch {
    return '-';
  }
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleString('pt-BR');
  } catch {
    return '-';
  }
}

// Retorna YYYY-MM-DD no fuso horário LOCAL (não UTC).
// Usar sempre que comparar com colunas DATE do Postgres (due_date, payment_date, etc).
export function todayLocalStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Retorna YYYY-MM-DD de uma Date no fuso LOCAL
export function toLocalDateStr(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Converte timestamp UTC (ex: "2026-05-27T03:00:00.000Z") para YYYY-MM-DD LOCAL
// Evita o bug em que `created_at.slice(0,10)` retorna o dia em UTC,
// que pode estar 1 dia à frente do dia local (especialmente à noite no Brasil).
export function utcToLocalDateStr(utcStr) {
  if (!utcStr) return '';
  const d = new Date(utcStr);
  if (isNaN(d.getTime())) return '';
  return toLocalDateStr(d);
}

// Substitui variáveis em templates de mensagem (régua de comunicação)
export function renderMessageTemplate(template, ctx) {
  if (!template) return '';
  const dias = ctx.daysUntilEnd;
  const diasRestantesText = dias > 1 ? `${dias} dias`
    : dias === 1 ? '1 dia'
    : dias === 0 ? 'hoje'
    : dias === -1 ? 'ontem'
    : `${Math.abs(dias)} dias atrás`;
  const baseValor    = Number(ctx.plan?.price_total) || 0;
  const matricula    = Number(ctx.contract?.enrollment_fee) || 0;
  const desconto     = Number(ctx.contract?.manual_discount) || 0;
  const valorEfetivo = Math.max(0, baseValor + matricula - desconto);
  const planoLabel = ctx.plan?.name?.trim()
    || `${ctx.modality?.name || 'Plano'} · ${ctx.periodLabel || ''}`.trim();
  return template
    .replaceAll('{nome}',           (ctx.customer?.full_name || '').split(' ')[0])
    .replaceAll('{nome_completo}',  ctx.customer?.full_name || '')
    .replaceAll('{plano}',          planoLabel)
    .replaceAll('{vencimento}',     formatDate(ctx.contract?.end_date))
    .replaceAll('{dias_restantes}', diasRestantesText)
    .replaceAll('{valor}',          formatCurrency(valorEfetivo))
    .replaceAll('{mensalidade}',    formatCurrency(ctx.plan?.price_monthly))
    .replaceAll('{link_pagamento}', ctx.contract?.asaas_payment_link || '');
}
