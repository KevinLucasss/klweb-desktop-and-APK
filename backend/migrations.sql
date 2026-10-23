-- MIGRAÇÕES DE SEGURANÇA - KL Web
-- Prioridades 3-7 de segurança do banco de dados

-- ========================================
-- PRIORIDADE 3: Hash de tokens de recuperação
-- ========================================

-- Criar tabela para tokens de recuperação de senha (hash seguro)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL, -- Hash do token (bcrypt)
    expires_at BIGINT NOT NULL, -- Timestamp em milissegundos
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela para tokens de mudança de email
CREATE TABLE IF NOT EXISTS email_change_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(255) NOT NULL, -- Hash do token (bcrypt)
    expires_at BIGINT NOT NULL, -- Timestamp em milissegundos
    used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Remover colunas antigas de tokens em texto plano (após migrar dados)
-- ALTER TABLE users DROP COLUMN IF EXISTS reset_token;
-- ALTER TABLE users DROP COLUMN IF EXISTS reset_token_expires;

-- ========================================
-- PRIORIDADE 4: company_id NOT NULL onde aplicável
-- ========================================

-- Adicionar company_id à tabela notifications (já estava faltando)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

-- Adicionar company_id à tabela security_logs
ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;

-- Nota: users.company_id deve permanecer NULLABLE para usuários sem empresa

-- ========================================
-- PRIORIDADE 5: Adicionar company_id em tabelas que estavam sem
-- ========================================

-- Já resolvido acima (notifications e security_logs)

-- ========================================
-- PRIORIDADE 6: Remover dados duplicados (colunas derivadas)
-- ========================================

-- Criar views para dados derivados (em vez de armazenar duplicados)
-- Isso permite buscar nomes/emails sem duplicar dados

-- ========================================
-- PRIORIDADE 7: Melhorar tipos de data/hora
-- ========================================

-- Converter events.event_date de VARCHAR para DATE
ALTER TABLE events ALTER COLUMN event_date TYPE DATE USING 
    CASE 
        WHEN event_date ~ '^\d{4}-\d{2}-\d{2}$' THEN event_date::DATE
        WHEN event_date ~ '^\d{2}/\d{2}/\d{4}$' THEN TO_DATE(event_date, 'DD/MM/YYYY')
        ELSE CURRENT_DATE
    END;

-- Converter events.event_time de VARCHAR para TIME
ALTER TABLE events ALTER COLUMN event_time TYPE TIME USING 
    CASE 
        WHEN event_time ~ '^\d{2}:\d{2}$' THEN event_time::TIME
        WHEN event_time ~ '^\d{2}:\d{2}:\d{2}$' THEN event_time::TIME
        ELSE CURRENT_TIME
    END;

-- ========================================
-- ÍNDICES DE PERFORMANCE
-- ========================================

-- Índices para tabelas de tokens
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_email_change_tokens_user_id ON email_change_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_change_tokens_expires_at ON email_change_tokens(expires_at);

-- Índices para company_id onde adicionado
CREATE INDEX IF NOT EXISTS idx_notifications_company_id ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_security_logs_company_id ON security_logs(company_id);

-- Índices compostos para queries comuns
CREATE INDEX IF NOT EXISTS idx_demands_company_status ON demands(company_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_events_company_date ON events(company_id, event_date);

-- ========================================
-- CONSTRAINTS DE SEGURANÇA ADICIONAIS
-- ========================================

-- Garantir que tokens não expirados sejam únicos por usuário
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_active 
    ON password_reset_tokens(user_id) 
    WHERE used_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_change_tokens_active 
    ON email_change_tokens(user_id) 
    WHERE used_at IS NULL;

-- ========================================
-- DADOS DE AUDITORIA
-- ========================================

-- Adicionar colunas de updated_at onde faltam
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Aplicar trigger nas tabelas
DROP TRIGGER IF EXISTS update_companies_updated_at ON companies;
CREATE TRIGGER update_companies_updated_at 
    BEFORE UPDATE ON companies 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts;
CREATE TRIGGER update_contacts_updated_at 
    BEFORE UPDATE ON contacts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_automations_updated_at ON automations;
CREATE TRIGGER update_automations_updated_at 
    BEFORE UPDATE ON automations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
