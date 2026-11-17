import { toast } from 'sonner';
import { cancelOrderEffects, cancelOrderResultNotice } from '@/lib/order-cancel-notice';
import { isSafePaymentUrl } from '@/lib/sales';

// Depois de cancelar: diz o que aconteceu com o estoque e, quando a cobrança era
// um link externo, deixa o link à vista para cancelar a fatura no Asaas (o
// pedido perde o link ao cancelar).
export function notifyOrderCancelled(order, result, orderType) {
  const notice = cancelOrderResultNotice(order, result, orderType);
  toast.success(notice.message);
  if (notice.externalLink) {
    toast.warning('Cancele também a fatura no Asaas: o sistema não faz isso.', {
      description: isSafePaymentUrl(notice.externalLink)
        ? <a href={notice.externalLink} target="_blank" rel="noopener noreferrer" className="underline break-all">{notice.externalLink}</a>
        : notice.externalLink,
      duration: 30000,
    });
  }
}

// O que cancelar o pedido faz de verdade (ver `order-cancel-notice.js`): a
// janela de confirmação não promete estoque nem cobrança que não acontecem.
export default function CancelOrderEffects({ order, orderType }) {
  const { delivered, apiCharge, externalLink } = cancelOrderEffects(order);
  return (
    <ul className="list-disc pl-4 space-y-1">
      <li>O pedido inteiro será cancelado.</li>
      {orderType === 'stock' && (delivered ? (
        <li>
          Como o pedido <strong>já foi entregue</strong>, as peças <strong>não voltam</strong> para o estoque agora:
          registre a devolução em Loja &gt; Devoluções quando elas voltarem.
        </li>
      ) : (
        <li>As peças reservadas <strong>voltam para o estoque</strong>.</li>
      ))}
      {apiCharge && <li>A cobrança do Asaas criada pelo sistema também é cancelada.</li>}
      {externalLink && (
        <li>
          A fatura do link externo <strong>não é cancelada no Asaas</strong>: cancele lá depois.
          O link sai deste pedido e fica só no histórico.
        </li>
      )}
    </ul>
  );
}
