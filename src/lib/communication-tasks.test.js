import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { createServer } from 'vite';

test('renewal communication keeps overdue work and follows the persisted stage', async () => {
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'dummy-anon-key';
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
  });

  try {
    const { buildCommunicationTasks, buildTaskMessage, taskEventType } =
      await server.ssrLoadModule('/src/lib/communication-tasks.js');
    const parentId = 'parent';
    const childId = 'child';
    const data = {
      contracts: [{
        id: parentId, status: 'active', payment_status: 'paid',
        end_date: '2026-10-01', customer_id: 'customer', plan_id: 'plan',
        created_at: '2026-01-01',
      }],
      customers: [{ id: 'customer', full_name: 'Ana Silva' }],
      plans: [{ id: 'plan', name: 'Trimestral', price_total: 300 }],
      contractEvents: [],
    };
    const rules = [
      {
        slug: 'renewal-reminder-14d', task_kind: 'renewal_reminder',
        days_offset: -10, active: true,
        message_template: 'Oi {nome}, seu plano {situacao_vencimento}.',
      },
      {
        slug: 'onboarding-welcome', task_kind: 'onboarding_welcome',
        days_offset: 0, active: true, message_template: 'Boas-vindas',
      },
    ];
    const build = () => buildCommunicationTasks(data, { rules, todayStr: '2026-10-15' });

    const reminder = build().find(task => task.kind === 'renewal_reminder');
    assert.ok(reminder);
    assert.match(reminder.statusLabel, /venceu há 14 dias/);
    assert.match(buildTaskMessage(reminder), /venceu em/);

    data.renewalPipeline = [{
      id: childId, parent_contract_id: parentId,
      renewal_stage: 'waiting_response', renewal_follow_up_at: '2026-10-10',
    }];
    assert.ok(build().some(task => task.title === 'Follow-up de renovação'));

    data.renewalPipeline = [{
      id: childId, contract_number: 'ASS-002',
      parent_contract_id: parentId, renewal_stage: 'charge_pending',
    }];
    const preparation = build().find(task => task.kind === 'renewal_charge_prepare');
    assert.equal(preparation?.sourceId, childId);
    assert.equal(preparation?.actionHref, '/assessoria/renovacoes');
    assert.equal(taskEventType(preparation), null);

    data.contractEvents = [{
      contract_id: childId, event_type: 'communication_task_ignored',
      payload: { rule_slug: 'renewal-charge-preparation', action: 'ignored' },
    }];
    assert.equal(build().some(task => task.kind === 'renewal_charge_prepare'), true);

    data.renewalPipeline = [{
      id: childId, parent_contract_id: parentId, renewal_stage: 'waiting_payment',
    }];
    assert.equal(build().some(task =>
      task.kind === 'renewal_reminder' || task.kind === 'renewal_charge_prepare'), false);
  } finally {
    await server.close();
  }
});
