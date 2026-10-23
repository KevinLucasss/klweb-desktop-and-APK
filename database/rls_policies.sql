-- ========================================================================
-- POLÍTICAS DE ROW-LEVEL SECURITY (RLS) - KL WEB / DEMANDIA
-- Aplicado em todas as 24 tabelas do banco de dados PostgreSQL (Supabase)
-- ========================================================================

-- ------------------------------------------------------------------------
-- 1. FUNÇÕES AUXILIARES DE CONTEXTO (SECURITY DEFINER)
-- ------------------------------------------------------------------------
-- Permitem resolver com segurança o id do usuário e o id da empresa
-- tanto via Supabase Auth (auth.uid() -> users.auth_user_id)
-- quanto via variáveis de sessão (app.current_user_id / app.current_company_id).
-- Usam STABLE e subquery para cache por query (evitando re-execução por linha).

CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_user_id', true), '')::integer,
    (SELECT id FROM public.users WHERE auth_user_id = (SELECT auth.uid()) LIMIT 1)
  );
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_company_id()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_company_id', true), '')::integer,
    (SELECT company_id FROM public.users WHERE auth_user_id = (SELECT auth.uid()) LIMIT 1)
  );
$$;

-- Restringe execução das funções auxiliares
REVOKE EXECUTE ON FUNCTION public.get_current_user_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_current_user_company_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_current_user_company_id() TO authenticated, service_role;

-- ------------------------------------------------------------------------
-- 2. ÍNDICES DE SUPORTE À PERFORMANCE DAS POLÍTICAS RLS
-- ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_companies_owner_id ON companies(owner_id);
CREATE INDEX IF NOT EXISTS idx_demand_attachments_demand_id ON demand_attachments(demand_id);
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_support_chats_user_id ON support_chats(user_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_user_id ON feedbacks(user_id);

-- ------------------------------------------------------------------------
-- 3. HABILITAÇÃO DO RLS EM TODAS AS 24 TABELAS
-- ------------------------------------------------------------------------
ALTER TABLE ai_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE demands ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_change_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------
-- 4. POLÍTICAS DE ACESSO TOTAL PARA SERVICE_ROLE EM TODAS AS TABELAS
-- (Garante acesso administrativo do backend e zera alertas do linter)
-- ------------------------------------------------------------------------

DROP POLICY IF EXISTS "service_role_all_ai_chat_messages" ON ai_chat_messages;
CREATE POLICY "service_role_all_ai_chat_messages" ON ai_chat_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_automations" ON automations;
CREATE POLICY "service_role_all_automations" ON automations FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_companies" ON companies;
CREATE POLICY "service_role_all_companies" ON companies FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_contacts" ON contacts;
CREATE POLICY "service_role_all_contacts" ON contacts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_demand_attachments" ON demand_attachments;
CREATE POLICY "service_role_all_demand_attachments" ON demand_attachments FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_demand_checklist_items" ON demand_checklist_items;
CREATE POLICY "service_role_all_demand_checklist_items" ON demand_checklist_items FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_demand_comments" ON demand_comments;
CREATE POLICY "service_role_all_demand_comments" ON demand_comments FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_demands" ON demands;
CREATE POLICY "service_role_all_demands" ON demands FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_email_change_requests" ON email_change_requests;
CREATE POLICY "service_role_all_email_change_requests" ON email_change_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_email_change_tokens" ON email_change_tokens;
CREATE POLICY "service_role_all_email_change_tokens" ON email_change_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_email_verifications" ON email_verifications;
CREATE POLICY "service_role_all_email_verifications" ON email_verifications FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_events" ON events;
CREATE POLICY "service_role_all_events" ON events FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_feedbacks" ON feedbacks;
CREATE POLICY "service_role_all_feedbacks" ON feedbacks FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_files" ON files;
CREATE POLICY "service_role_all_files" ON files FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_notification_preferences" ON notification_preferences;
CREATE POLICY "service_role_all_notification_preferences" ON notification_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_notifications" ON notifications;
CREATE POLICY "service_role_all_notifications" ON notifications FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_password_change_requests" ON password_change_requests;
CREATE POLICY "service_role_all_password_change_requests" ON password_change_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_password_reset_tokens" ON password_reset_tokens;
CREATE POLICY "service_role_all_password_reset_tokens" ON password_reset_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_playbooks" ON playbooks;
CREATE POLICY "service_role_all_playbooks" ON playbooks FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_security_logs" ON security_logs;
CREATE POLICY "service_role_all_security_logs" ON security_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_support_chats" ON support_chats;
CREATE POLICY "service_role_all_support_chats" ON support_chats FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_support_messages" ON support_messages;
CREATE POLICY "service_role_all_support_messages" ON support_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_trial_reminders" ON trial_reminders;
CREATE POLICY "service_role_all_trial_reminders" ON trial_reminders FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_users" ON users;
CREATE POLICY "service_role_all_users" ON users FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------------
-- 5. POLÍTICAS DE AUTENTICAÇÃO E MULTI-TENANCY (ROLE: AUTHENTICATED)
-- ------------------------------------------------------------------------

-- === 5.1. EMPRESAS (COMPANIES) ===
DROP POLICY IF EXISTS "companies_select_policy" ON companies;
CREATE POLICY "companies_select_policy" ON companies
FOR SELECT TO authenticated
USING (
  id = (SELECT public.get_current_user_company_id())
  OR owner_id = (SELECT public.get_current_user_id())
);

DROP POLICY IF EXISTS "companies_update_policy" ON companies;
CREATE POLICY "companies_update_policy" ON companies
FOR UPDATE TO authenticated
USING (owner_id = (SELECT public.get_current_user_id()))
WITH CHECK (owner_id = (SELECT public.get_current_user_id()));

-- === 5.2. USUÁRIOS (USERS) ===
DROP POLICY IF EXISTS "users_select_policy" ON users;
CREATE POLICY "users_select_policy" ON users
FOR SELECT TO authenticated
USING (
  id = (SELECT public.get_current_user_id())
  OR (company_id IS NOT NULL AND company_id = (SELECT public.get_current_user_company_id()))
);

DROP POLICY IF EXISTS "users_update_policy" ON users;
CREATE POLICY "users_update_policy" ON users
FOR UPDATE TO authenticated
USING (id = (SELECT public.get_current_user_id()))
WITH CHECK (id = (SELECT public.get_current_user_id()));

-- === 5.3. DEMANDAS (DEMANDS) ===
DROP POLICY IF EXISTS "demands_select_policy" ON demands;
CREATE POLICY "demands_select_policy" ON demands
FOR SELECT TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "demands_insert_policy" ON demands;
CREATE POLICY "demands_insert_policy" ON demands
FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "demands_update_policy" ON demands;
CREATE POLICY "demands_update_policy" ON demands
FOR UPDATE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()))
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "demands_delete_policy" ON demands;
CREATE POLICY "demands_delete_policy" ON demands
FOR DELETE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

-- === 5.4. CHECKLIST DA DEMANDA (DEMAND_CHECKLIST_ITEMS) ===
DROP POLICY IF EXISTS "demand_checklist_select_policy" ON demand_checklist_items;
CREATE POLICY "demand_checklist_select_policy" ON demand_checklist_items
FOR SELECT TO authenticated
USING (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

DROP POLICY IF EXISTS "demand_checklist_insert_policy" ON demand_checklist_items;
CREATE POLICY "demand_checklist_insert_policy" ON demand_checklist_items
FOR INSERT TO authenticated
WITH CHECK (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

DROP POLICY IF EXISTS "demand_checklist_update_policy" ON demand_checklist_items;
CREATE POLICY "demand_checklist_update_policy" ON demand_checklist_items
FOR UPDATE TO authenticated
USING (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
))
WITH CHECK (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

DROP POLICY IF EXISTS "demand_checklist_delete_policy" ON demand_checklist_items;
CREATE POLICY "demand_checklist_delete_policy" ON demand_checklist_items
FOR DELETE TO authenticated
USING (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

-- === 5.5. COMENTÁRIOS DA DEMANDA (DEMAND_COMMENTS) ===
DROP POLICY IF EXISTS "demand_comments_select_policy" ON demand_comments;
CREATE POLICY "demand_comments_select_policy" ON demand_comments
FOR SELECT TO authenticated
USING (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

DROP POLICY IF EXISTS "demand_comments_insert_policy" ON demand_comments;
CREATE POLICY "demand_comments_insert_policy" ON demand_comments
FOR INSERT TO authenticated
WITH CHECK (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

DROP POLICY IF EXISTS "demand_comments_update_policy" ON demand_comments;
CREATE POLICY "demand_comments_update_policy" ON demand_comments
FOR UPDATE TO authenticated
USING (
  demand_id IN (SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id()))
  AND user_id = (SELECT public.get_current_user_id())
)
WITH CHECK (
  demand_id IN (SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id()))
  AND user_id = (SELECT public.get_current_user_id())
);

DROP POLICY IF EXISTS "demand_comments_delete_policy" ON demand_comments;
CREATE POLICY "demand_comments_delete_policy" ON demand_comments
FOR DELETE TO authenticated
USING (
  demand_id IN (SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id()))
  AND user_id = (SELECT public.get_current_user_id())
);

-- === 5.6. ANEXOS DA DEMANDA (DEMAND_ATTACHMENTS) ===
DROP POLICY IF EXISTS "demand_attachments_select_policy" ON demand_attachments;
CREATE POLICY "demand_attachments_select_policy" ON demand_attachments
FOR SELECT TO authenticated
USING (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

DROP POLICY IF EXISTS "demand_attachments_insert_policy" ON demand_attachments;
CREATE POLICY "demand_attachments_insert_policy" ON demand_attachments
FOR INSERT TO authenticated
WITH CHECK (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

DROP POLICY IF EXISTS "demand_attachments_delete_policy" ON demand_attachments;
CREATE POLICY "demand_attachments_delete_policy" ON demand_attachments
FOR DELETE TO authenticated
USING (demand_id IN (
  SELECT id FROM public.demands WHERE company_id = (SELECT public.get_current_user_company_id())
));

-- === 5.7. CONTATOS DO CRM (CONTACTS) ===
DROP POLICY IF EXISTS "contacts_select_policy" ON contacts;
CREATE POLICY "contacts_select_policy" ON contacts
FOR SELECT TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "contacts_insert_policy" ON contacts;
CREATE POLICY "contacts_insert_policy" ON contacts
FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "contacts_update_policy" ON contacts;
CREATE POLICY "contacts_update_policy" ON contacts
FOR UPDATE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()))
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "contacts_delete_policy" ON contacts;
CREATE POLICY "contacts_delete_policy" ON contacts
FOR DELETE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

-- === 5.8. EVENTOS / CALENDÁRIO (EVENTS) ===
DROP POLICY IF EXISTS "events_select_policy" ON events;
CREATE POLICY "events_select_policy" ON events
FOR SELECT TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "events_insert_policy" ON events;
CREATE POLICY "events_insert_policy" ON events
FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "events_update_policy" ON events;
CREATE POLICY "events_update_policy" ON events
FOR UPDATE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()))
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "events_delete_policy" ON events;
CREATE POLICY "events_delete_policy" ON events
FOR DELETE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

-- === 5.9. AUTOMAÇÕES (AUTOMATIONS) ===
DROP POLICY IF EXISTS "automations_select_policy" ON automations;
CREATE POLICY "automations_select_policy" ON automations
FOR SELECT TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "automations_insert_policy" ON automations;
CREATE POLICY "automations_insert_policy" ON automations
FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "automations_update_policy" ON automations;
CREATE POLICY "automations_update_policy" ON automations
FOR UPDATE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()))
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "automations_delete_policy" ON automations;
CREATE POLICY "automations_delete_policy" ON automations
FOR DELETE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

-- === 5.10. ARQUIVOS / ARMAZÉM (FILES) ===
DROP POLICY IF EXISTS "files_select_policy" ON files;
CREATE POLICY "files_select_policy" ON files
FOR SELECT TO authenticated
USING (
  (company_id IS NOT NULL AND company_id = (SELECT public.get_current_user_company_id()))
  OR user_id = (SELECT public.get_current_user_id())
);

DROP POLICY IF EXISTS "files_insert_policy" ON files;
CREATE POLICY "files_insert_policy" ON files
FOR INSERT TO authenticated
WITH CHECK (
  (company_id IS NOT NULL AND company_id = (SELECT public.get_current_user_company_id()))
  OR user_id = (SELECT public.get_current_user_id())
);

DROP POLICY IF EXISTS "files_delete_policy" ON files;
CREATE POLICY "files_delete_policy" ON files
FOR DELETE TO authenticated
USING (
  (company_id IS NOT NULL AND company_id = (SELECT public.get_current_user_company_id()))
  OR user_id = (SELECT public.get_current_user_id())
);

-- === 5.11. CHAT DA IA AUTÔNOMA (AI_CHAT_MESSAGES) ===
DROP POLICY IF EXISTS "ai_chat_messages_select_policy" ON ai_chat_messages;
CREATE POLICY "ai_chat_messages_select_policy" ON ai_chat_messages
FOR SELECT TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "ai_chat_messages_insert_policy" ON ai_chat_messages;
CREATE POLICY "ai_chat_messages_insert_policy" ON ai_chat_messages
FOR INSERT TO authenticated
WITH CHECK (company_id = (SELECT public.get_current_user_company_id()));

DROP POLICY IF EXISTS "ai_chat_messages_delete_policy" ON ai_chat_messages;
CREATE POLICY "ai_chat_messages_delete_policy" ON ai_chat_messages
FOR DELETE TO authenticated
USING (company_id = (SELECT public.get_current_user_company_id()));

-- === 5.12. PLAYBOOKS E PROCEDIMENTOS (PLAYBOOKS) ===
DROP POLICY IF EXISTS "playbooks_select_policy" ON playbooks;
CREATE POLICY "playbooks_select_policy" ON playbooks
FOR SELECT TO authenticated
USING (
  is_system IS TRUE
  OR company_id = (SELECT public.get_current_user_company_id())
);

DROP POLICY IF EXISTS "playbooks_insert_policy" ON playbooks;
CREATE POLICY "playbooks_insert_policy" ON playbooks
FOR INSERT TO authenticated
WITH CHECK (
  company_id = (SELECT public.get_current_user_company_id())
  AND (is_system IS FALSE OR is_system IS NULL)
);

DROP POLICY IF EXISTS "playbooks_update_policy" ON playbooks;
CREATE POLICY "playbooks_update_policy" ON playbooks
FOR UPDATE TO authenticated
USING (
  company_id = (SELECT public.get_current_user_company_id())
  AND (is_system IS FALSE OR is_system IS NULL)
)
WITH CHECK (
  company_id = (SELECT public.get_current_user_company_id())
  AND (is_system IS FALSE OR is_system IS NULL)
);

DROP POLICY IF EXISTS "playbooks_delete_policy" ON playbooks;
CREATE POLICY "playbooks_delete_policy" ON playbooks
FOR DELETE TO authenticated
USING (
  company_id = (SELECT public.get_current_user_company_id())
  AND (is_system IS FALSE OR is_system IS NULL)
);

-- === 5.13. NOTIFICAÇÕES (NOTIFICATIONS) ===
DROP POLICY IF EXISTS "notifications_select_policy" ON notifications;
CREATE POLICY "notifications_select_policy" ON notifications
FOR SELECT TO authenticated
USING (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "notifications_update_policy" ON notifications;
CREATE POLICY "notifications_update_policy" ON notifications
FOR UPDATE TO authenticated
USING (user_id = (SELECT public.get_current_user_id()))
WITH CHECK (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "notifications_delete_policy" ON notifications;
CREATE POLICY "notifications_delete_policy" ON notifications
FOR DELETE TO authenticated
USING (user_id = (SELECT public.get_current_user_id()));

-- === 5.14. PREFERÊNCIAS DE NOTIFICAÇÃO (NOTIFICATION_PREFERENCES) ===
DROP POLICY IF EXISTS "notif_prefs_select_policy" ON notification_preferences;
CREATE POLICY "notif_prefs_select_policy" ON notification_preferences
FOR SELECT TO authenticated
USING (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "notif_prefs_insert_policy" ON notification_preferences;
CREATE POLICY "notif_prefs_insert_policy" ON notification_preferences
FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "notif_prefs_update_policy" ON notification_preferences;
CREATE POLICY "notif_prefs_update_policy" ON notification_preferences
FOR UPDATE TO authenticated
USING (user_id = (SELECT public.get_current_user_id()))
WITH CHECK (user_id = (SELECT public.get_current_user_id()));

-- === 5.15. SUPORTE INTERNO (SUPPORT_CHATS & SUPPORT_MESSAGES) ===
DROP POLICY IF EXISTS "support_chats_select_policy" ON support_chats;
CREATE POLICY "support_chats_select_policy" ON support_chats
FOR SELECT TO authenticated
USING (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "support_chats_insert_policy" ON support_chats;
CREATE POLICY "support_chats_insert_policy" ON support_chats
FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "support_chats_update_policy" ON support_chats;
CREATE POLICY "support_chats_update_policy" ON support_chats
FOR UPDATE TO authenticated
USING (user_id = (SELECT public.get_current_user_id()))
WITH CHECK (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "support_messages_select_policy" ON support_messages;
CREATE POLICY "support_messages_select_policy" ON support_messages
FOR SELECT TO authenticated
USING (chat_id IN (
  SELECT id FROM public.support_chats WHERE user_id = (SELECT public.get_current_user_id())
));

DROP POLICY IF EXISTS "support_messages_insert_policy" ON support_messages;
CREATE POLICY "support_messages_insert_policy" ON support_messages
FOR INSERT TO authenticated
WITH CHECK (chat_id IN (
  SELECT id FROM public.support_chats WHERE user_id = (SELECT public.get_current_user_id())
));

-- === 5.16. FEEDBACKS (FEEDBACKS) ===
DROP POLICY IF EXISTS "feedbacks_select_policy" ON feedbacks;
CREATE POLICY "feedbacks_select_policy" ON feedbacks
FOR SELECT TO authenticated
USING (user_id = (SELECT public.get_current_user_id()));

DROP POLICY IF EXISTS "feedbacks_insert_policy" ON feedbacks;
CREATE POLICY "feedbacks_insert_policy" ON feedbacks
FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT public.get_current_user_id()));

-- === 5.17. LOGS DE SEGURANÇA (SECURITY_LOGS) ===
DROP POLICY IF EXISTS "security_logs_select_policy" ON security_logs;
CREATE POLICY "security_logs_select_policy" ON security_logs
FOR SELECT TO authenticated
USING (user_id = (SELECT public.get_current_user_id()));

-- ------------------------------------------------------------------------
-- FIM DAS POLÍTICAS DE RLS
-- ------------------------------------------------------------------------
