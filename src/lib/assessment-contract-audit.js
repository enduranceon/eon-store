import {
  CONTRACT_LIFECYCLE_TYPES,
  buildContractLifecycleRows,
  classifyContractLifecycle,
  currentLifecycleMonthStart,
  getContractCancellationDate,
  getContractMonthlyValue,
  getContractTotalValue,
  getLifecycleMonthStart,
  isContractVoidedSale,
  summarizeContractLifecycle,
} from '@/lib/assessment-contract-lifecycle';

export const AUDIT_TYPES = CONTRACT_LIFECYCLE_TYPES;

export const AUDIT_TONE_CLASS = {
  green:  'bg-green-50 text-green-700 border-green-200',
  blue:   'bg-blue-50 text-blue-700 border-blue-200',
  amber:  'bg-amber-50 text-amber-700 border-amber-200',
  orange: 'bg-orange-50 text-orange-700 border-orange-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  red:    'bg-red-50 text-red-700 border-red-200',
  rose:   'bg-rose-50 text-rose-700 border-rose-200',
  slate:  'bg-slate-50 text-slate-700 border-slate-200',
};

export const getAuditMonthStart = getLifecycleMonthStart;
export const getCancellationDate = getContractCancellationDate;
export const getContractValue = getContractTotalValue;
export const getMonthlyValue = getContractMonthlyValue;
export const isVoidedSale = isContractVoidedSale;
export const classifyContractAudit = classifyContractLifecycle;
export const buildContractAuditRows = buildContractLifecycleRows;
export const summarizeContractAudit = summarizeContractLifecycle;
export const currentAuditMonthStart = currentLifecycleMonthStart;
