-- MANUAL REVIEW DRAFT ONLY. This file is not in supabase/migrations and must
-- never be applied before receipt-aware clients are released and old clients,
-- queued requests, and in-flight legacy transactions have been dealt with.
-- Revoking these grants breaks deployed legacy clients. Do not execute this
-- script against any shared or production database as part of this work.
begin;
do $$
declare signature text; fn regprocedure;
begin
  if current_setting('ff.confirm_receipt_cutover', true) is distinct from 'reviewed' then
    raise exception 'receipt cutover not approved; legacy clients still require these RPCs';
  end if;
  foreach signature in array array[
    'public.ff_league_create(text,numeric)', 'public.ff_league_create(text,numeric,text)',
    'public.ff_squad_buy(uuid,uuid)', 'public.ff_squad_sell(uuid,uuid)',
    'public.ff_squad_transfer(uuid,uuid,uuid)', 'public.ff_squad_set_captains(uuid,uuid,uuid)',
    'public.ff_squad_substitute(uuid,uuid,uuid,integer)',
    'public.ff_squad_save_assignments(uuid,uuid[],uuid[],uuid[],uuid,uuid,uuid,integer)',
    'public.ff_lineup_save(uuid,uuid,text,uuid[],uuid,uuid)', 'public.ff_lineup_confirm(uuid,uuid)'
  ] loop
    fn := to_regprocedure(signature);
    if fn is not null then
      execute format('revoke execute on function %s from public, anon, authenticated',fn);
      if has_function_privilege('authenticated',fn,'execute') then
        raise exception 'authenticated still inherits execute on %',fn;
      end if;
      if not has_function_privilege('ff_migration_owner',fn,'execute') then
        raise exception 'receipt executor cannot invoke %',fn;
      end if;
    end if;
  end loop;
end $$;
commit;
