# Checkout público de pré-venda

## Regra de identidade

Uma pessoa que informa nome, WhatsApp ou e-mail no checkout ainda não provou
que controla um cadastro interno com esses dados. Por isso, o checkout público:

- grava nome, WhatsApp e e-mail como snapshot do pedido;
- cria o pedido com `customer_id = NULL`;
- não cria, atualiza nem escolhe automaticamente um registro em
  `presale_customers`;
- não devolve `cost_price` na resposta pública.

Na tela administrativa do pedido, a equipe pode escolher um cliente existente
depois de conferir os dados. Se a pessoa ainda não estiver cadastrada, o
cadastro deve ser criado primeiro na área Clientes. Esta etapa não oferece um
atalho de criação seguido de vínculo porque duas gravações separadas poderiam
deixar um cliente órfão se a segunda falhasse.

A operação protegida altera somente `customer_id` e `updated_date`, preserva o
snapshot original do checkout e registra o operador e as identidades anterior
e nova em `sales_status_events`. Ela compara a versão e o cliente que a tela
carregou para impedir que outra sessão ou uma mesclagem seja sobrescrita
silenciosamente. Pedidos pagos,
parcialmente pagos, cancelados ou reembolsados não aceitam troca de cliente. Um
pedido já vinculado também não pode trocar de cliente depois de registrar uma
cobrança; um pedido ainda sem vínculo pode receber a associação inicial enquanto
a cobrança externa continua aberta. O vínculo também é recusado enquanto existir
uma operação financeira preparada ou aguardando reconciliação para o pedido. A
mesma trava vale para atualizações diretas e mesclagens de clientes, evitando que
a identidade mude entre a preparação local e a resposta do provedor.

## Cobrança atual

Cobrança externa e pagamento externo/manual continuam usando o pedido e seus
campos de snapshot. Eles não exigem um cliente vinculado. A integração Asaas
continua fora do modo operacional atual. O banco e a tela impedem que uma
cobrança pelo provedor seja iniciada antes de confirmar o cliente; o CPF usado
fica associado ao cadastro que está carregado na tela.

## Publicação

Esta mudança depende de banco, API e frontend. A sequência segura é:

1. validar todas as migrações e os testes pgTAP em um banco local descartável;
2. validar o plano remoto de migrações sem escrita;
3. aplicar somente as migrações pendentes, sem seed, roles ou Vault;
4. conferir no banco remoto o histórico, as assinaturas e as permissões das RPCs;
5. publicar a `api-v1` somente depois desse readback;
6. publicar o frontend apenas depois da nova API.

O workflow executa essa ordem na `main` e falha antes de qualquer publicação se
`SUPABASE_ACCESS_TOKEN` ou `SUPABASE_DB_PASSWORD` não estiverem configurados.
Uma falha depois da migração deve ser corrigida com nova execução ou
forward-fix; rollback da Netlify não reverte banco nem Edge Function. Enquanto
o release estiver entre banco, API e frontend, cobrança e pagamento
externo/manual continuam disponíveis. A criação de cobrança Asaas pode ficar
temporariamente bloqueada, o que é compatível com o uso operacional atual.

As previews usam o backend de produção. Nelas, a verificação deve ser somente
visual e de leitura: não enviar checkout, não vincular cliente e não executar
outras ações administrativas. Testes ponta a ponta ficam restritos ao Supabase
local ou a um ambiente de staging isolado.

## Limites desta etapa

Esta etapa impede alteração e associação indevidas do cadastro. Limitação de
taxa e idempotência do checkout público continuam como trabalho separado para
não misturar uma mudança de identidade com uma mudança no protocolo de envio.
