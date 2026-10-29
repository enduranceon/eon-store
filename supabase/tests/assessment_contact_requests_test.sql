BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(17);

-- Cadastro direto no banco (a tela não cria contatos; só o site envia).
INSERT INTO public.assessment_contact_requests (id, full_name, whatsapp, subject, message) VALUES
  ('89000000-0000-4000-a000-0000000000e1', 'PESSOA CONTATO FICTÍCIA', '+5548999990601',
   'Dúvida sobre planos', 'Gostaria de entender como funciona o acompanhamento.');
SELECT is(
  (SELECT source || '/' || status FROM public.assessment_contact_requests
   WHERE id = '89000000-0000-4000-a000-0000000000e1'),
  'site/new',
  'a contact starts as coming from the site and new'
);
SELECT is(
  (SELECT full_name FROM public.assessment_contact_requests
   WHERE id = '89000000-0000-4000-a000-0000000000e1'),
  'Pessoa Contato Fictícia',
  'the person name follows the system standard'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_contact_requests (full_name, whatsapp, subject, message)
    VALUES ('Pessoa Curta Fictícia', '+5548999990602', 'Assunto', 'curta')$$,
  '23514', NULL::text,
  'a message needs at least ten characters'
);
SELECT throws_ok(
  $$INSERT INTO public.assessment_contact_requests (full_name, whatsapp, subject, message, status)
    VALUES ('Pessoa Status Fictícia', '+5548999990603', 'Assunto', 'Mensagem de teste válida', 'lost')$$,
  '23514', NULL::text,
  'only the known statuses are accepted'
);

UPDATE public.assessment_contact_requests
SET status = 'closed', closed_reason = 'Desistiu', source = 'site',
    message = 'Texto alterado depois do envio', subject = 'Outro assunto'
WHERE id = '89000000-0000-4000-a000-0000000000e1';
SELECT is(
  (SELECT status || '/' || closed_reason || '/' || subject || '/' || message
   FROM public.assessment_contact_requests
   WHERE id = '89000000-0000-4000-a000-0000000000e1'),
  'closed/Desistiu/Dúvida sobre planos/Gostaria de entender como funciona o acompanhamento.',
  'closing keeps the reason and the text the person sent cannot be edited'
);
UPDATE public.assessment_contact_requests SET status = 'contacted'
WHERE id = '89000000-0000-4000-a000-0000000000e1';
SELECT is(
  (SELECT closed_reason FROM public.assessment_contact_requests
   WHERE id = '89000000-0000-4000-a000-0000000000e1'),
  NULL,
  'reopening clears the closing reason'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.assessment_contact_requests', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.assessment_contact_requests', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.assessment_contact_requests', 'DELETE')
  AND NOT has_function_privilege('anon', 'public.submit_public_contact_request(uuid, text, text, text, text, text, text, jsonb, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.submit_public_contact_request(uuid, text, text, text, text, text, text, jsonb, text, text)', 'EXECUTE'),
  'browsers cannot read or write the contacts, nor call the site function'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assessment_contact_requests'::regclass),
  'row level security is on'
);

-- Envio pelo site.
CREATE FUNCTION pg_temp.send_contact(p_request uuid, p_name text, p_phone text, p_message text)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.submit_public_contact_request(
    p_request, p_name, p_phone, 'contato@example.test', 'Dúvida sobre treinos', p_message,
    'https://example.test/contato', '{"utm_source":"teste"}'::jsonb, 'ip-hash-contato', p_phone || '-hash'
  )
$$;
GRANT EXECUTE ON FUNCTION pg_temp.send_contact(uuid, text, text, text) TO service_role;
INSERT INTO eon_private.public_form_rate_limits (ip_hash, phone_hash)
SELECT 'ip-hash-limite', '+5548999990609-hash' FROM generate_series(1, 4);
SET LOCAL ROLE service_role;

SELECT is(
  pg_temp.send_contact('89000000-0000-4000-a000-0000000000d1', 'Pessoa Site Contato',
                       '+5548999990604', 'Quero saber sobre os treinos coletivos.')->>'status',
  'created',
  'the site sends the contact'
);
SELECT is(
  (SELECT source || '/' || status || '/' || email FROM public.assessment_contact_requests
   WHERE request_id = '89000000-0000-4000-a000-0000000000d1'),
  'site/new/contato@example.test',
  'the contact is stored as new and coming from the site'
);
SELECT is(
  pg_temp.send_contact('89000000-0000-4000-a000-0000000000d1', 'Pessoa Site Contato',
                       '+5548999990604', 'Quero saber sobre os treinos coletivos.')->>'status',
  'duplicate',
  'sending the same form again does not create a second contact'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_contact('89000000-0000-4000-a000-0000000000d1', 'Outro Nome Contato',
                                '+5548999990604', 'Quero saber sobre os treinos coletivos.')$$,
  'P0001', 'Esta chave de envio já foi usada com outros dados',
  'a reused send key with other data is refused'
);
SELECT is(
  pg_temp.send_contact('89000000-0000-4000-a000-0000000000d2', 'Pessoa Site Contato',
                       '+5548999990604', 'Quero saber sobre os treinos coletivos.')->>'status',
  'duplicate',
  'the same person with the same message is not added twice while it is open'
);
SELECT is(
  (SELECT count(*)::int FROM public.assessment_contact_requests WHERE whatsapp = '+5548999990604'),
  1,
  'only one contact exists for that person and message'
);
UPDATE public.assessment_contact_requests SET status = 'closed', closed_reason = 'Respondido'
WHERE request_id = '89000000-0000-4000-a000-0000000000d1';
SELECT is(
  pg_temp.send_contact('89000000-0000-4000-a000-0000000000d3', 'Pessoa Site Contato',
                       '+5548999990604', 'Quero saber sobre os treinos coletivos.')->>'status',
  'created',
  'after the first contact is closed, the same message becomes a new contact'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_contact('89000000-0000-4000-a000-0000000000d4', 'Pessoa Curta Contato',
                                '+5548999990605', 'curta')$$,
  '22023', 'Dados obrigatórios inválidos',
  'a message that is too short is refused'
);
SELECT throws_ok(
  $$SELECT pg_temp.send_contact('89000000-0000-4000-a000-0000000000d5', 'Pessoa Limite Contato',
                                '+5548999990609', 'Mensagem de teste do limite de envios.')$$,
  'P0001', 'Este telefone já enviou vários cadastros hoje',
  'the same attempt limit as the site enrollment applies'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
