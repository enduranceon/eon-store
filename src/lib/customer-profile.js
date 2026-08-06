export const STUDENT_PROFILE_TABS = {
  overview: 'overview',
  contracts: 'contracts',
  financial: 'financial',
  products: 'products',
  timeline: 'timeline',
  communication: 'communication',
  registration: 'registration',
};

const STUDENT_PROFILE_TAB_VALUES = new Set(Object.values(STUDENT_PROFILE_TABS));

export function studentProfilePath(customerId, tab = STUDENT_PROFILE_TABS.overview) {
  if (!customerId) return '/assessoria/alunos';

  const base = `/assessoria/alunos/${customerId}`;
  const normalizedTab = STUDENT_PROFILE_TAB_VALUES.has(tab) ? tab : STUDENT_PROFILE_TABS.overview;

  if (normalizedTab === STUDENT_PROFILE_TABS.overview) return base;
  return `${base}?aba=${encodeURIComponent(normalizedTab)}`;
}

export function legacyCustomerProfilePath(customerId) {
  if (!customerId) return '/clientes';
  return `/clientes/${customerId}`;
}
