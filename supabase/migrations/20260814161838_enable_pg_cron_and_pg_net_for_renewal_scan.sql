-- Habilita o agendador (pg_cron) e o cliente HTTP (pg_net) para que o scan de
-- renovações rode sozinho, sem depender de alguém clicar em "Verificar
-- renovações agora".
--
-- Só liga capacidade: nenhuma tabela, linha ou permissão de aplicação é tocada.
-- Nenhum job é criado aqui — o agendamento vem em migration separada, depois
-- que o CRON_SECRET estiver configurado.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;;
