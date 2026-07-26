import { supabase } from '@/api/db';

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
