-- Workspace administrators may publish their own resources without license metadata.
-- Platform publication, actor authorization, RLS and asset integrity stay unchanged.
DO $migration$
DECLARE
  definition text;
  replacement text;
BEGIN
  SELECT pg_get_functiondef('private.loomic_catalog_publishable(text,uuid)'::regprocedure)
    INTO definition;
  replacement := regexp_replace(definition,
    $pattern$private\.loomic_catalog_license_is_verifiable\(\s*r\.license_name, r\.source_url, r\.license_url, r\.usage_restrictions\s*\)$pattern$,
    $value$(r.scope = 'workspace' OR private.loomic_catalog_license_is_verifiable(
          r.license_name, r.source_url, r.license_url, r.usage_restrictions
        ))$value$);
  IF replacement = definition THEN
    RAISE EXCEPTION 'Resource publication function differs from expected definition';
  END IF;
  EXECUTE replacement;
END;
$migration$;

ALTER TABLE public.design_resources
  DROP CONSTRAINT design_resources_published_license_check;
ALTER TABLE public.design_resources
  ADD CONSTRAINT design_resources_published_license_check CHECK (
    status <> 'published'
    OR scope = 'workspace'
    OR private.loomic_catalog_license_is_verifiable(
      license_name, source_url, license_url, usage_restrictions
    )
  );
