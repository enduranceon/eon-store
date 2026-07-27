import {
  markAssessmentContractPaymentMessageSent,
  markOrderPaymentMessageSent,
  recordCommunicationEvent,
} from '@/api/client';
import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { TASK_BUCKET, TASK_KIND, taskEventType } from '@/lib/communication-tasks';

export function hasNativePaymentInfo(task) {
  return Boolean(task?.asaasPaymentLink || task?.asaasPixCopy || task?.asaasChargeId);
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
    item_summary: task.itemSummary || null,
    items: task.items || [],
    due_date: dueDate || null,
    external_payment_link: trimmedLink || null,
    has_asaas_link: Boolean(task.asaasPaymentLink || task.asaasPixCopy),
    community_link: task.kind === TASK_KIND.ONBOARDING_WELCOME ? (communityLink || null) : null,
  };

  if (isChargeTask) {
    if (task.sourceType === 'contract') {
      await markAssessmentContractPaymentMessageSent(task.sourceId, {
        source: 'communication_center',
        externalLink: nativePaymentInfo ? null : (trimmedLink || task.externalPaymentLink || null),
        dueDate: nativePaymentInfo ? null : (dueDate || task.dueDate || defaultPaymentDueDate()),
        expectedUpdatedAt: task.updatedAt,
        metadata: {
          task_kind: task.kind,
          rule_slug: task.ruleSlug || null,
          rule_name: task.ruleName || null,
          channel: 'whatsapp',
          message,
          item_summary: task.itemSummary || null,
          items: task.items || [],
        },
      });
      return;
    }

    await markOrderPaymentMessageSent(
      task.sourceType === 'stock' ? 'stock' : 'presale',
      task.sourceId,
      {
        externalPaymentLink: nativePaymentInfo ? null : (trimmedLink || task.externalPaymentLink || null),
        dueDate: nativePaymentInfo ? null : (dueDate || task.dueDate || defaultPaymentDueDate()),
        metadata: payload,
      },
    );
  } else {
    await recordCommunicationEvent({
      source_type: task.sourceType,
      source_id: task.sourceId,
      event_type: eventType,
      payload,
      reason: `${task.title} pela Central de Comunicação`,
    });
  }
}

function actionEventReason(task, action) {
  if (action === 'snoozed') return `${task.title} adiada pela Central de Comunicação`;
  return `${task.title} ignorada pela Central de Comunicação`;
}

async function registerCommunicationTaskAction(task, action, options = {}) {
  const reason = String(options.reason || '').trim();
  const snoozeUntil = options.snoozeUntil || null;
  const payload = {
    source: 'communication_center',
    action,
    task_kind: task.kind,
    rule_slug: task.ruleSlug || null,
    rule_name: task.ruleName || null,
    item_summary: task.itemSummary || null,
    items: task.items || [],
    reason: reason || null,
    snooze_until: action === 'snoozed' ? snoozeUntil : null,
  };
  const notes = reason
    ? `${actionEventReason(task, action)}: ${reason}`
    : actionEventReason(task, action);

  if (task.sourceType === 'contract') {
    await recordCommunicationEvent({
      source_type: 'contract', source_id: task.sourceId,
      event_type: 'communication_task_ignored', payload, reason: notes,
    });
  } else {
    await recordCommunicationEvent({
      source_type: task.sourceType === 'stock' ? 'stock' : 'presale',
      source_id: task.sourceId,
      event_type: 'communication_task_ignored', payload, reason: notes,
    });
  }
}

export async function registerCommunicationIgnore(task, options = {}) {
  await registerCommunicationTaskAction(task, 'ignored', options);
}

export async function registerCommunicationSnooze(task, options = {}) {
  if (!options.snoozeUntil) throw new Error('Informe a data para adiar');
  await registerCommunicationTaskAction(task, 'snoozed', options);
}
