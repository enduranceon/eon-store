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
  if (!customerId) return '/pessoas';

  const base = `/pessoas/${customerId}`;
  const normalizedTab = STUDENT_PROFILE_TAB_VALUES.has(tab) ? tab : STUDENT_PROFILE_TABS.overview;

  if (normalizedTab === STUDENT_PROFILE_TABS.overview) return base;
  return `${base}?aba=${encodeURIComponent(normalizedTab)}`;
}

export function legacyCustomerProfilePath(customerId) {
  if (!customerId) return '/clientes';
  return `/clientes/${customerId}`;
}

export function legacyPersonRedirectPath({ id = null, search = '', hash = '', fromAssessment = false } = {}) {
  const params = new URLSearchParams(search);
  if (fromAssessment && !id && !params.has('vinculo') && !params.has('tipo') && !params.has('filtro')) {
    params.set('vinculo', 'assessment');
  }
  const query = params.toString();
  return `/pessoas${id ? `/${id}` : ''}${query ? `?${query}` : ''}${hash}`;
}
