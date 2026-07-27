import { supabase } from '@/api/db';

// Calcula o desconto de um cupom dado o subtotal (sem chamar API)
export function computeDiscount(coupon, subtotal) {
  if (!coupon) return 0;
  let d;
  if (coupon.discount_type === 'percentage') {
    d = subtotal * (Number(coupon.discount_value) / 100);
    if (coupon.max_discount) d = Math.min(d, Number(coupon.max_discount));
  } else {
    d = Math.min(Number(coupon.discount_value), subtotal);
  }
  return Math.round(d * 100) / 100;
}

// Valida cupom via Edge Function (anon não tem acesso direto à tabela coupons)
export async function validateCoupon(code, subtotal, customerIdentifier) {
  const cleanCode = (code || '').trim().toUpperCase();
  if (!cleanCode) return { ok: false, error: 'Informe o código' };

  try {
    const { data, error } = await supabase.functions.invoke('validate-coupon', {
      body: {
        code: cleanCode,
        subtotal,
        customer_identifier: customerIdentifier || null,
      },
    });
    if (error) return { ok: false, error: 'Erro ao validar cupom — tente novamente' };
    return data;
  } catch {
    return { ok: false, error: 'Erro ao validar cupom — tente novamente' };
  }
}

// O uso e a devolução do cupom são persistidos atomicamente pelos RPCs de
// criação, cancelamento e estorno de pedidos. O navegador não grava esta
// auditoria separadamente.
