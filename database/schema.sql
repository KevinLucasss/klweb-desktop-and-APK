-- ========================================================================
-- SCHEMA OFICIAL POSTGRESQL (SUPABASE) - KL WEB / DEMANDIA
-- ========================================================================

-- 1. Empresas / Workspaces (Tenants)
CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    owner_id INT,
    invite_code VARCHAR(24) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Usuários do Sistema
-- NOTA DE SEGURANÇA:
-- A coluna 'password' armazena estritamente o hash Bcrypt (salt rounds = 10).
-- Os dados pessoais sensíveis ('name', 'phone', 'cpf') são armazenados criptografados
-- em repouso com algoritmo AES-256-GCM (prefixo enc:v1:).
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL, -- AES-256-GCM criptografado
    email VARCHAR(255) UNIQUE NOT NULL,
    phone TEXT NOT NULL, -- AES-256-GCM criptografado
    cpf TEXT DEFAULT '', -- AES-256-GCM criptografado
    password TEXT NOT NULL, -- Bcrypt hash (60 chars)
    role VARCHAR(50) DEFAULT 'USER', -- 'OWNER', 'MANAGER', 'USER'
    is_active INT DEFAULT 1,
    company_id INT REFERENCES companies(id) ON DELETE SET NULL,
    plan_tier VARCHAR(50) DEFAULT 'BASICO',
    plan_status VARCHAR(50) DEFAULT 'INACTIVE',
    membership_status VARCHAR(20) DEFAULT 'ACTIVE',
    requested_at TIMESTAMP WITH TIME ZONE,
    ai_usage_count INT DEFAULT 0,
    ai_usage_date DATE,
    reset_token TEXT, -- SHA-256 hash do token de recuperação
    reset_token_expires BIGINT,
    lgpd_consent INT DEFAULT 1,
    theme VARCHAR(20) DEFAULT 'light',
    font_size VARCHAR(20) DEFAULT '100%',
    daltonic_mode VARCHAR(10) DEFAULT 'off',
    token_version INT DEFAULT 0,
    totp_secret_enc TEXT,
    totp_enabled BOOLEAN DEFAULT FALSE,
    totp_last_step BIGINT,
    totp_backup_codes TEXT,
    site_role VARCHAR(20),
    email_verified INT DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Mensagens do Chat com a IA Autônoma (Cláudia)
CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id INT,
    user_name VARCHAR(255),
    sender VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Gestão de Demandas (Kanban)
CREATE TABLE IF NOT EXISTS demands (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id INT,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    priority VARCHAR(50) DEFAULT 'MEDIA',
    status VARCHAR(50) DEFAULT 'TODO',
    assigned_user_id INT,
    assigned_user_name VARCHAR(255),
    assigned_user_email VARCHAR(255),
    position INT DEFAULT 0,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Checklist da Demanda
CREATE TABLE IF NOT EXISTS demand_checklist_items (
    id SERIAL PRIMARY KEY,
    demand_id INT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    text VARCHAR(500) NOT NULL,
    done BOOLEAN DEFAULT FALSE,
    position INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Comentários da Demanda
CREATE TABLE IF NOT EXISTS demand_comments (
    id SERIAL PRIMARY KEY,
    demand_id INT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
    user_id INT,
    user_name VARCHAR(255),
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. Contatos do CRM (com criptografia AES-256-GCM em dados de contato e anotações)
CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL, -- AES-256-GCM criptografado
    phone TEXT NOT NULL, -- AES-256-GCM criptografado
    email TEXT, -- AES-256-GCM criptografado
    company_name VARCHAR(255) DEFAULT '',
    role VARCHAR(100) DEFAULT '',
    notes TEXT, -- AES-256-GCM criptografado
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Eventos / Calendário
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id INT,
    title VARCHAR(255) NOT NULL,
    event_date VARCHAR(50) NOT NULL,
    event_time VARCHAR(50),
    type VARCHAR(50) DEFAULT 'REUNIAO',
    description TEXT,
    client_name VARCHAR(150),
    client_phone VARCHAR(30),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. Automações
CREATE TABLE IF NOT EXISTS automations (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    trigger_event VARCHAR(100) NOT NULL,
    action_type VARCHAR(100) NOT NULL,
    action_target VARCHAR(255),
    action_payload TEXT,
    is_active INT DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. Notificações do Sistema
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INT,
    user_email VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'assignment',
    is_read INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Arquivos / Armazém Corporativo
CREATE TABLE IF NOT EXISTS files (
    id SERIAL PRIMARY KEY,
    company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id INT,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    file_size BIGINT,
    mime_type VARCHAR(100),
    file_path TEXT,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 12. Playbooks e Procedimentos da IA
CREATE TABLE IF NOT EXISTS playbooks (
    id SERIAL PRIMARY KEY,
    company_id INT REFERENCES companies(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) DEFAULT 'GERAL',
    steps_instruction TEXT,
    is_system BOOLEAN DEFAULT FALSE,
    is_active INT DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 13. Logs de Auditoria e Segurança
CREATE TABLE IF NOT EXISTS security_logs (
    id SERIAL PRIMARY KEY,
    user_id INT,
    user_email VARCHAR(255),
    action VARCHAR(255) NOT NULL,
    ip_address VARCHAR(100),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 14. Suporte / Atendimento Interno
CREATE TABLE IF NOT EXISTS support_chats (
    id SERIAL PRIMARY KEY,
    user_id INT,
    user_email VARCHAR(255) NOT NULL,
    user_name VARCHAR(255),
    subject VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'OPEN',
    is_unread INT DEFAULT 1,
    typing_user_id INT,
    typing_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support_messages (
    id SERIAL PRIMARY KEY,
    chat_id INT REFERENCES support_chats(id) ON DELETE CASCADE,
    sender_id INT,
    sender_type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 15. Feedbacks
CREATE TABLE IF NOT EXISTS feedbacks (
    id SERIAL PRIMARY KEY,
    user_id INT,
    user_email VARCHAR(255) NOT NULL,
    user_name VARCHAR(255),
    type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ========================================================================
-- POLÍTICAS DE ROW-LEVEL SECURITY (RLS)
-- As políticas completas de RLS para todas as tabelas estão definidas em:
-- database/rls_policies.sql
-- ========================================================================