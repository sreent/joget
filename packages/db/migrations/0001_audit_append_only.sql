-- The audit log is append-only (design §9.3). These triggers reject UPDATE, DELETE and TRUNCATE on
-- the audit tables for every role, including the application's own role.
--
-- In production, also run the application as a role that does not own these tables and holds only
-- INSERT and SELECT on them: a table owner could otherwise disable the triggers. The signed seals
-- make any tampering that still happens detectable.
CREATE FUNCTION audit_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The % table is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_seals_append_only BEFORE UPDATE OR DELETE ON audit_seals
  FOR EACH ROW EXECUTE FUNCTION audit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_seals_no_truncate BEFORE TRUNCATE ON audit_seals
  FOR EACH STATEMENT EXECUTE FUNCTION audit_reject_mutation();
