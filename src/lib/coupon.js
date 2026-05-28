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

// Registra o uso (audit). O contador uses_count é atualizado por TRIGGER no DB.
export async function recordCouponUse({ coupon, order, orderType, customerIdentifier, customerName, discount }) {
  if (!coupon || !order) return;
  const { error } = await supabase.from('coupon_uses').insert({
    coupon_id:           coupon.id,
    coupon_code:         coupon.code,
    order_id:            order.id,
    order_type:          orderType,
    order_number:        order.order_number,
    customer_identifier: customerIdentifier || null,
    customer_name:       customerName || null,
    discount_applied:    discount || 0,
  });
  if (error) console.error('Erro ao registrar uso de cupom:', error);
}

// Devolve o uso (marca como cancelado). O decremento de uses_count é via TRIGGER.
// Idempotente: se já foi devolvido, não faz nada.
export async function returnCouponUse(orderId, orderType) {
  const { data: uses, error: selErr } = await supabase
    .from('coupon_uses').select('id, cancelled')
    .eq('order_id', orderId)
    .eq('order_type', orderType)
    .eq('cancelled', false);
  if (selErr) { console.error('Erro ao buscar usos:', selErr); return; }
  if (!uses || uses.length === 0) return;

  for (const use of uses) {
    const { error } = await supabase
      .from('coupon_uses').update({ cancelled: true }).eq('id', use.id);
    if (error) console.error('Erro ao devolver uso:', error);
  }
}
