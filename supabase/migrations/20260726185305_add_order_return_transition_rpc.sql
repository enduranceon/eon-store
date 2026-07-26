-- Faz a transição da devolução e a eventual reposição de estoque na mesma
-- transação. A função só é executável pelo backend (service_role); usuários do
-- frontend passam antes pelo guard administrativo da Edge Function api-v1.
create or replace function public.transition_order_return(
  p_return_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_return public.order_returns%rowtype;
  v_stock_restocked boolean := false;
begin
  if p_action not in ('receive', 'complete') then
    raise exception using
      errcode = '22023',
      message = 'Ação de devolução inválida';
  end if;

  -- Serializa ações concorrentes sobre a mesma devolução.
  select *
    into v_return
    from public.order_returns
   where id = p_return_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Devolução não encontrada';
  end if;

  if p_action = 'receive' then
    if v_return.status = 'received' then
      return jsonb_build_object(
        'return', to_jsonb(v_return),
        'stock_restocked', false
      );
    end if;

    if v_return.status <> 'pending_return' then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Não é possível receber uma devolução com status %s',
          v_return.status
        );
    end if;

    update public.order_returns
       set status = 'received',
           received_at = now()
     where id = p_return_id
     returning * into v_return;
  else
    if v_return.status = 'completed' then
      return jsonb_build_object(
        'return', to_jsonb(v_return),
        'stock_restocked', false
      );
    end if;

    if v_return.status <> 'received' then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Não é possível concluir uma devolução com status %s',
          v_return.status
        );
    end if;

    if v_return.quantity <= 0 then
      raise exception using
        errcode = '22023',
        message = 'Quantidade da devolução deve ser positiva';
    end if;

    if v_return.product_id is not null then
      update public.stock_products
         set quantity = coalesce(quantity, 0) + v_return.quantity,
             updated_date = now()
       where id = v_return.product_id;

      if not found then
        raise exception using
          errcode = 'P0002',
          message = 'Produto de estoque não encontrado';
      end if;

      v_stock_restocked := true;
    end if;

    update public.order_returns
       set status = 'completed',
           completed_at = now()
     where id = p_return_id
     returning * into v_return;
  end if;

  return jsonb_build_object(
    'return', to_jsonb(v_return),
    'stock_restocked', v_stock_restocked
  );
end;
$$;

revoke all on function public.transition_order_return(uuid, text) from public;
revoke all on function public.transition_order_return(uuid, text) from anon;
revoke all on function public.transition_order_return(uuid, text) from authenticated;
grant execute on function public.transition_order_return(uuid, text) to service_role;
