import { deliveryDateWarning } from '@/lib/order-board';

// Aviso abaixo do campo "Data de entrega" quando a data parece errada.
export default function DeliveryDateWarning({ date, order, today }) {
  const text = deliveryDateWarning(date, order, today);
  return text ? <p className="mt-1 text-[11px] text-amber-800">{text}</p> : null;
}
