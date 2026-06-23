import { supabase } from '@/api/db';
import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { TASK_BUCKET, TASK_KIND, taskEventType } from '@/lib/communication-tasks';

export function hasNativePaymentInfo(task) {
  return Boolean(task?.asaasPaymentLink || task?.asaasPixCopy || task?.asaasChargeId);
}

async function insertContractEvent(contractId, eventType, payload, notes) {
  const { error } = await supabase.from('assessment_contract_event').insert({
    contract_id: contractId,
    event_type: eventType,
    payload,
    notes,
  });
  if (error) throw error;
}

async function insertSaleEvent(task, newStatus, payload, reason) {
  const { error } = await supabase.from('sales_status_events').insert({
    order_type: task.sourceType === 'stock' ? 'stock' : 'presale',
    order_id: task.sourceId,
    previous_status: task.paymentStatus || null,
    new_status: newStatus,
    reason,
    metadata: payload,
  });
  if (error) throw error;
}

// Persiste o envio de uma mensagem (cobrança, onboarding ou renovação):
// atualiza o registro de origem quando for cobrança e grava o evento de
// histórico. Compartilhado entre a Central de Comunicação e o perfil do aluno
// para manter uma única fonte de verdade do que é escrito.
export async function registerCommunicationSend(task, options = {}) {
  const message = String(options.message || '').trim();
  const trimmedLink = String(options.externalLink || '').trim();
  const dueDate = options.dueDate || '';
  const communityLink = String(options.communityLink || '').trim();

  const eventType = taskEventType(task);
  const isChargeTask = task.bucket === TASK_BUCKET.CHARGES;
  const nativePaymentInfo = hasNativePaymentInfo(task);

  const payload = {
    source: 'communication_center',
    task_kind: task.kind,
    rule_slug: task.ruleSlug || null,
    rule_name: task.ruleName || null,
    channel: 'whatsapp',
    message,
    due_date: dueDate || null,
    external_payment_link: trimmedLink || null,
    has_asaas_link: Boolean(task.asaasPaymentLink || task.asaasPixCopy),
    community_link: task.kind === TASK_KIND.ONBOARDING_WELCOME ? (communityLink || null) : null,
  };

  if (isChargeTask) {
    const updates = { payment_message_sent_at: new Date().toISOString() };
    if (!nativePaymentInfo) {
      updates.external_payment_link = trimmedLink || null;
      updates.due_date = dueDate || defaultPaymentDueDate();
    }
    if (['awaiting_charge', 'pending'].includes(task.paymentStatus)) {
      updates.payment_status = 'charge_sent';
    }

    const { error } = await supabase
      .from(task.tableName)
      .update(updates)
      .eq('id', task.sourceId);
    if (error) throw error;

    if (task.sourceType === 'contract') {
      await insertContractEvent(task.sourceId, eventType, payload, 'Mensagem enviada pela Central de Comunicação');
    } else {
      await insertSaleEvent(
        task,
        updates.payment_status || task.paymentStatus || 'charge_sent',
        payload,
        task.kind === TASK_KIND.CHARGE_OVERDUE ? 'Cobrança vencida reenviada' : 'Cobrança enviada pela Central de Comunicação',
      );
    }
  } else {
    await insertContractEvent(task.sourceId, eventType, payload, `${task.title} pela Central de Comunicação`);
  }
}
