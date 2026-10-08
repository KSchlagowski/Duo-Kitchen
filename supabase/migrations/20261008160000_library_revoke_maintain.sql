-- F-04 follow-up (implementation review F1): revoke MAINTAIN on the public library from authenticated.
--
-- On PostgreSQL 17 Supabase's default privileges grant MAINTAIN (VACUUM, ANALYZE, REINDEX, CLUSTER,
-- REFRESH MATERIALIZED VIEW, LOCK TABLE) along with everything else on a new public table.
-- 20261008150000_shared_recipe_library.sql revoked every write privilege from authenticated but not
-- this one, so the library was not fully client-read-only at the grant level. PostgREST cannot issue
-- these commands, but the library's contract is "SELECT only", and
-- supabase/tests/household_isolation.sql now asserts MAINTAIN is absent too. anon already lost it
-- through "revoke all".

revoke maintain on public.products from authenticated;
revoke maintain on public.recipes from authenticated;
revoke maintain on public.recipe_components from authenticated;
revoke maintain on public.recipe_ingredients from authenticated;
revoke maintain on public.recipe_steps from authenticated;
