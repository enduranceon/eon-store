-- Agenda o scan diario de renovacoes (prepare-renewals), que ate aqui so rodava
-- quando alguem clicava em "Verificar renovacoes" na tela. O pg_cron e pg_net ja
-- estavam habilitados desde 20260814161838 especificamente pra isso, mas o job
-- em si nunca chegou a ser criado -- e por isso que contratos podiam vencer sem
-- nunca ganhar um rascunho de renovacao (ex: aluna cujo contrato venceu e so foi
-- fechado manualmente, sem passar pela tela de Renovacoes).
--
-- O segredo usado no header x-cron-secret vive no Vault (nome
-- 'prepare_renewals_cron_secret'), nunca em texto puro neste arquivo. Ele
-- precisa ser IDENTICO ao secret CRON_SECRET configurado nas Edge Function
-- Secrets do projeto -- sem isso a funcao rejeita a chamada com 401 e o job
-- falha silenciosamente (o resultado fica em net._http_response, nao gera erro
-- visivel em lugar nenhum da aplicacao).
--
-- Horario: 08:00 UTC = 05:00 America/Sao_Paulo, antes do horario comercial, pra
-- os rascunhos ja estarem prontos na tela de Renovacoes quando o time chegar.
select cron.schedule(
  'prepare-renewals-daily',
  '0 8 * * *',
  $$
  select net.http_post(
    url := 'https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/prepare-renewals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- anon key: nao e segredo (ja vai embutida no bundle do frontend), so
      -- serve pra passar pelo gateway do Supabase antes da checagem interna
      -- da funcao (que e quem de fato valida o x-cron-secret abaixo).
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzaWxqcnJvZGd0bXRkaWxudXhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNTg5OTAsImV4cCI6MjA5NDYzNDk5MH0.YYaQ_MX4w_dHsKl6Tv9xPP4o4P8eL3gij-WQdL-4ZqA',
      'x-cron-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'prepare_renewals_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
