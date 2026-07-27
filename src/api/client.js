import { supabase } from '@/api/db';
import { invalidatePageCacheByTag } from '@/lib/page-cache';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const SUPABASE_PUBLIC_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const API_BASE_URL = `${SUPABASE_URL}/functions/v1/api-v1`;

export class ApiError extends Error {
  constructor(message, { status = 500, code = 'api_error', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function getAccessToken(explicitToken) {
  if (explicitToken) return explicitToken;

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw new ApiError('Não foi possível recuperar a sessão', {
      status: 401,
      code: 'session_error',
      details: error.message,
    });
  }

  const token = data.session?.access_token;
  if (!token) {
    throw new ApiError('Sessão não autenticada', {
      status: 401,
      code: 'missing_session',
    });
  }

  return token;
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : null;

  if (!response.ok) {
    throw new ApiError(payload?.message || payload?.error || 'Erro ao acessar a API', {
      status: response.status,
      code: payload?.code || 'api_error',
      details: payload?.details || null,
    });
  }

  return payload;
}

export async function apiRequest(path, {
  method = 'GET',
  body,
  accessToken,
  idempotencyKey,
  signal,
} = {}) {
  if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY) {
    throw new ApiError('API não configurada no frontend', {
      status: 500,
      code: 'api_not_configured',
    });
  }

  const token = await getAccessToken(accessToken);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const response = await fetch(`${API_BASE_URL}${normalizedPath}`, {
    method,
    signal,
    headers: {
      apikey: SUPABASE_PUBLIC_KEY,
      Authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return parseResponse(response);
}

export function getCurrentAdmin(options = {}) {
  return apiRequest('/session', options);
}

export async function listOrderReturns(options = {}) {
  const response = await apiRequest('/returns', options);
  return response.data;
}

export async function receiveOrderReturn(returnId, options = {}) {
  const response = await apiRequest(`/returns/${returnId}/receive`, {
    ...options,
    method: 'POST',
  });
  return response.data;
}

export async function completeOrderReturn(returnId, options = {}) {
  const response = await apiRequest(`/returns/${returnId}/complete`, {
    ...options,
    method: 'POST',
  });
  return response.data;
}

export async function cancelOrder(orderType, orderId, reason, options = {}) {
  const response = await apiRequest(`/orders/${orderType}/${orderId}/cancel`, {
    ...options,
    method: 'POST',
    body: { reason },
  });
  return response.data;
}

export async function updateOrderDueDate(
  orderType,
  orderId,
  dueDate,
  idempotencyKey,
  options = {},
) {
  const response = await apiRequest(`/orders/${orderType}/${orderId}/due-date`, {
    ...options,
    method: 'PATCH',
    body: { due_date: dueDate },
    idempotencyKey,
  });
  const tableByType = {
    presale: 'presale_orders',
    stock: 'stock_orders',
    contract: 'assessment_contracts',
  };
  if (tableByType[orderType]) invalidatePageCacheByTag(tableByType[orderType]);
  invalidatePageCacheByTag('asaas_payments');
  return response.data;
}

export async function createOrderCharge(
  orderType,
  orderId,
  {
    billingType,
    dueDate,
    installments = 1,
    cpf,
    source,
  },
  options = {},
) {
  const body = {
    billing_type: billingType,
    due_date: dueDate,
    ...(orderType === 'contract'
      ? { source }
      : { installments, cpf }),
  };
  const response = await apiRequest(
    `/orders/${orderType}/${orderId}/charge`,
    {
      ...options,
      method: 'POST',
      idempotencyKey: options.idempotencyKey || crypto.randomUUID(),
      body,
    },
  );
  const tableByType = {
    presale: 'presale_orders',
    stock: 'stock_orders',
    contract: 'assessment_contracts',
  };
  if (tableByType[orderType]) invalidatePageCacheByTag(tableByType[orderType]);
  invalidatePageCacheByTag('asaas_payments');
  invalidatePageCacheByTag('sales_status_events');
  if (orderType === 'contract') invalidatePageCacheByTag('assessment_contract_event');
  return response.data;
}

export async function syncOrderChargeStatus(orderType, orderId, options = {}) {
  const response = await apiRequest(
    `/orders/${orderType}/${orderId}/charge/status`,
    {
      ...options,
      method: 'POST',
    },
  );
  const tableByType = {
    presale: 'presale_orders',
    stock: 'stock_orders',
    contract: 'assessment_contracts',
  };
  if (tableByType[orderType]) invalidatePageCacheByTag(tableByType[orderType]);
  invalidatePageCacheByTag('asaas_payments');
  return response.data;
}

export async function cancelOrderCharge(
  orderType,
  orderId,
  reason,
  options = {},
) {
  const response = await apiRequest(
    `/orders/${orderType}/${orderId}/charge/cancel`,
    {
      ...options,
      method: 'POST',
      idempotencyKey: options.idempotencyKey || crypto.randomUUID(),
      body: { reason },
    },
  );
  const tableByType = {
    presale: 'presale_orders',
    stock: 'stock_orders',
    contract: 'assessment_contracts',
  };
  if (tableByType[orderType]) invalidatePageCacheByTag(tableByType[orderType]);
  invalidatePageCacheByTag('asaas_payments');
  invalidatePageCacheByTag('sales_status_events');
  if (orderType === 'contract') invalidatePageCacheByTag('assessment_contract_event');
  return response.data;
}

export async function voidAssessmentContractSale(contractId, options = {}) {
  const response = await apiRequest(
    `/orders/contract/${contractId}/void-sale`,
    {
      ...options,
      method: 'POST',
      idempotencyKey: options.idempotencyKey || crypto.randomUUID(),
      body: {},
    },
  );
  invalidatePageCacheByTag('assessment_contracts');
  invalidatePageCacheByTag('asaas_payments');
  invalidatePageCacheByTag('assessment_contract_event');
  invalidatePageCacheByTag('sales_status_events');
  invalidatePageCacheByTag('payout_pending_repasse');
  return response.data;
}

export async function changeAssessmentContractPlan(
  contractId,
  {
    planId,
    startDate,
    installments,
    enrollmentFee,
    manualDiscount,
    discountReason = null,
  },
  options = {},
) {
  const response = await apiRequest(
    `/orders/contract/${contractId}/plan`,
    {
      ...options,
      method: 'PATCH',
      idempotencyKey: options.idempotencyKey || crypto.randomUUID(),
      body: {
        plan_id: planId,
        start_date: startDate,
        installments,
        enrollment_fee: enrollmentFee,
        manual_discount: manualDiscount,
        discount_reason: discountReason,
      },
    },
  );
  invalidatePageCacheByTag('assessment_contracts');
  invalidatePageCacheByTag('asaas_payments');
  invalidatePageCacheByTag('assessment_contract_event');
  invalidatePageCacheByTag('sales_status_events');
  invalidatePageCacheByTag('payout_pending_repasse');
  return response.data;
}

function invalidateAssessmentContractLifecycle() {
  invalidatePageCacheByTag('assessment_contracts');
  invalidatePageCacheByTag('assessment_leaves');
  invalidatePageCacheByTag('assessment_contract_coach_history');
  invalidatePageCacheByTag('assessment_contract_event');
  invalidatePageCacheByTag('asaas_payments');
}

export async function updateAssessmentContractDates(
  contractId,
  { startDate, endDate, expectedUpdatedAt },
  options = {},
) {
  const response = await apiRequest(`/orders/contract/${contractId}/dates`, {
    ...options,
    method: 'PATCH',
    body: {
      start_date: startDate,
      end_date: endDate,
      expected_updated_at: expectedUpdatedAt,
    },
  });
  invalidateAssessmentContractLifecycle();
  return response.data;
}

export async function changeAssessmentContractCoach(
  contractId,
  { coachId, expectedUpdatedAt },
  options = {},
) {
  const response = await apiRequest(`/orders/contract/${contractId}/coach`, {
    ...options,
    method: 'PATCH',
    body: { coach_id: coachId, expected_updated_at: expectedUpdatedAt },
  });
  invalidateAssessmentContractLifecycle();
  return response.data;
}

export async function startAssessmentContractLeave(
  contractId,
  { startDate, endDate, reason = null, expectedUpdatedAt },
  options = {},
) {
  const response = await apiRequest(`/orders/contract/${contractId}/leaves`, {
    ...options,
    method: 'POST',
    body: {
      start_date: startDate,
      end_date: endDate,
      reason,
      expected_updated_at: expectedUpdatedAt,
    },
  });
  invalidateAssessmentContractLifecycle();
  return response.data;
}

export async function finishAssessmentContractLeave(
  contractId,
  leaveId,
  expectedUpdatedAt,
  options = {},
) {
  const response = await apiRequest(
    `/orders/contract/${contractId}/leaves/${leaveId}/finish`,
    {
      ...options,
      method: 'POST',
      body: { expected_updated_at: expectedUpdatedAt },
    },
  );
  invalidateAssessmentContractLifecycle();
  return response.data;
}

export async function cancelAssessmentContract(
  contractId,
  { cancellationDate, cancellationFeePct, reason = null, expectedUpdatedAt },
  options = {},
) {
  const response = await apiRequest(`/orders/contract/${contractId}/cancel`, {
    ...options,
    method: 'POST',
    body: {
      cancellation_date: cancellationDate,
      cancellation_fee_pct: cancellationFeePct,
      reason,
      expected_updated_at: expectedUpdatedAt,
    },
  });
  invalidateAssessmentContractLifecycle();
  invalidatePageCacheByTag('payout_pending_repasse');
  return response.data;
}

export async function saveAssessmentContractExternalCharge(
  contractId,
  {
    externalLink,
    dueDate,
    paymentMethod,
    invoiceNumber = null,
    source = 'contract_detail',
    expectedUpdatedAt,
  },
  options = {},
) {
  const response = await apiRequest(
    `/orders/contract/${contractId}/external-charge`,
    {
      ...options,
      method: 'PUT',
      body: {
        external_link: externalLink,
        due_date: dueDate,
        payment_method: paymentMethod,
        invoice_number: invoiceNumber,
        source,
        expected_updated_at: expectedUpdatedAt,
      },
    },
  );
  invalidateAssessmentContractLifecycle();
  return response.data;
}

export async function removeAssessmentContractExternalCharge(
  contractId,
  expectedUpdatedAt,
  options = {},
) {
  const response = await apiRequest(
    `/orders/contract/${contractId}/external-charge`,
    {
      ...options,
      method: 'DELETE',
      body: { expected_updated_at: expectedUpdatedAt },
    },
  );
  invalidateAssessmentContractLifecycle();
  return response.data;
}

export async function markAssessmentContractPaymentMessageSent(
  contractId,
  {
    source = 'contract_detail',
    externalLink = null,
    dueDate = null,
    metadata = {},
    expectedUpdatedAt,
  },
  options = {},
) {
  const response = await apiRequest(
    `/orders/contract/${contractId}/payment-message`,
    {
      ...options,
      method: 'POST',
      body: {
        source,
        external_link: externalLink,
        due_date: dueDate,
        metadata,
        expected_updated_at: expectedUpdatedAt,
      },
    },
  );
  invalidateAssessmentContractLifecycle();
  return response.data;
}

export async function resolveAssessmentRenewal(
  renewalId,
  {
    resolution,
    reasonCode,
    reason,
    expectedUpdatedAt,
    expectedPaymentStatus,
    expectedChargeId = null,
    externalCancellationConfirmed = false,
    externalConfirmationNote = null,
    serviceStarted = false,
  },
  options = {},
) {
  const response = await apiRequest(
    `/orders/contract/${renewalId}/renewal-resolution`,
    {
      ...options,
      method: 'POST',
      idempotencyKey: options.idempotencyKey || crypto.randomUUID(),
      body: {
        resolution,
        reason_code: reasonCode,
        reason,
        expected_updated_at: expectedUpdatedAt,
        expected_payment_status: expectedPaymentStatus,
        expected_charge_id: expectedChargeId,
        external_cancellation_confirmed: externalCancellationConfirmed,
        external_confirmation_note: externalConfirmationNote,
        service_started: serviceStarted,
      },
    },
  );
  invalidatePageCacheByTag('assessment_contracts');
  invalidatePageCacheByTag('asaas_payments');
  invalidatePageCacheByTag('assessment_contract_event');
  invalidatePageCacheByTag('sales_status_events');
  invalidatePageCacheByTag('payout_pending_repasse');
  return response.data;
}

export async function refundOrder(orderType, orderId, reason, options = {}) {
  const response = await apiRequest(`/orders/${orderType}/${orderId}/refund`, {
    ...options,
    method: 'POST',
    body: { reason },
  });
  return response.data;
}

export async function cancelOrderItem(
  orderType,
  orderId,
  itemIndex,
  { reason = '', wasDelivered = false } = {},
  options = {},
) {
  const response = await apiRequest(`/orders/${orderType}/${orderId}/items/${itemIndex}/cancel`, {
    ...options,
    method: 'POST',
    body: { reason, was_delivered: wasDelivered },
  });
  return response.data;
}

export async function listPaymentMethods(options = {}) {
  const response = await apiRequest('/payments/methods', options);
  return response.data;
}

export async function recordManualPayment(
  orderType,
  orderId,
  { paymentMethodId, paymentDate, total },
  options = {},
) {
  const response = await apiRequest(`/orders/${orderType}/${orderId}/manual-payment`, {
    ...options,
    method: 'POST',
    body: {
      payment_method_id: paymentMethodId,
      payment_date: paymentDate,
      total,
    },
  });
  return response.data;
}

export async function adjustManualPayment(
  orderType,
  orderId,
  { total, manualDiscount, discountReason = '', discountRecurring = false },
  options = {},
) {
  const response = await apiRequest(`/orders/${orderType}/${orderId}/manual-payment`, {
    ...options,
    method: 'PATCH',
    body: {
      total,
      manual_discount: manualDiscount,
      discount_reason: discountReason,
      discount_recurring: discountRecurring,
    },
  });
  return response.data;
}

export async function reopenManualPayment(orderType, orderId, options = {}) {
  const response = await apiRequest(`/orders/${orderType}/${orderId}/manual-payment`, {
    ...options,
    method: 'DELETE',
  });
  return response.data;
}

function catalogResourcePath(resource, id) {
  const base = `/catalog/${encodeURIComponent(resource)}`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

function matchesFilters(row, filters) {
  return Object.entries(filters).every(([key, value]) => {
    if (value === null || value === undefined) return row[key] == null;
    if (Array.isArray(value)) return value.includes(row[key]);
    return row[key] === value;
  });
}

function catalogWritePayload(data) {
  const payload = { ...data };
  delete payload.id;
  delete payload.created_at;
  delete payload.created_date;
  delete payload.updated_at;
  delete payload.updated_date;
  return payload;
}

export function createCatalogEntity(resource, cacheTag) {
  const list = async (sortBy = '-created_date') => {
    const path = `${catalogResourcePath(resource)}?sort=${encodeURIComponent(sortBy)}`;
    const response = await apiRequest(path);
    return response.data;
  };

  return {
    list,

    async filter(filters = {}, sortBy = '-created_date') {
      const rows = await list(sortBy);
      return rows.filter(row => matchesFilters(row, filters));
    },

    async get(id) {
      const response = await apiRequest(catalogResourcePath(resource, id));
      return response.data;
    },

    async create(data) {
      const response = await apiRequest(catalogResourcePath(resource), {
        method: 'POST',
        body: catalogWritePayload(data),
      });
      invalidatePageCacheByTag(cacheTag);
      return response.data;
    },

    async update(id, data) {
      const response = await apiRequest(catalogResourcePath(resource, id), {
        method: 'PATCH',
        body: catalogWritePayload(data),
      });
      invalidatePageCacheByTag(cacheTag);
      return response.data;
    },

    async delete(id) {
      await apiRequest(catalogResourcePath(resource, id), { method: 'DELETE' });
      invalidatePageCacheByTag(cacheTag);
      return true;
    },
  };
}
