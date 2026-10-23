# Sistema de Segurança - KL Web

## 🛡️ Visão Geral

Este documento descreve todas as medidas de segurança implementadas para proteger o KL Web contra hackers e invasões.

---

## 🔒 Camadas de Segurança

### **1. Validação e Sanitização de Input**

#### **Sanitização de Input**
- Remove caracteres perigosos (`<`, `>`, `javascript:`, event handlers)
- Remove comentários SQL (`--`)
- Trim de espaços em branco

#### **Validação de Email**
- Regex para formato válido
- Verificação de caracteres perigosos (`<`, `>`, `;`, `"`, `'`, `\`)

#### **Validação de Telefone**
- Remove caracteres não numéricos
- Valida tamanho mínimo (10 dígitos + código país)

#### **Validação de Texto**
- Limita tamanho máximo (padrão: 255 caracteres)
- Sanitiza automaticamente

---

### **2. Proteção Contra SQL Injection**

#### **Uso de Parâmetros**
- O driver `pg` usa parâmetros nativamente (não concatena strings)
- Todas as queries usam `$1`, `$2`, etc.

#### **Escape de LIKE Patterns**
- Escapa caracteres especiais de LIKE (`%`, `_`, `\`)
- Previne ataques via padrões de busca

---

### **3. Detecção de Atividade Suspeita**

#### **Monitor de Segurança (SecurityMonitor)**
- Rastreia IPs com atividade suspeita
- Bloqueia IPs após 10 tentativas em 1 minuto
- Bloqueio temporário de 15 minutos
- Log automático de atividades suspeitas

#### **Padrões de Ataque Detectados**
- SQL Injection (`SELECT`, `UNION`, `DROP`, `DELETE`, `INSERT`, `UPDATE`)
- XSS (`<script>`, `javascript:`, event handlers, `alert()`)
- Cookie theft (`document.cookie`)
- Redirection (`window.location`)
- Code injection (`eval()`, `exec()`)

#### **Logging**
- Log no console
- Log no banco de dados (tabela `security_logs`)
- Integração futura com Sentry/LogRocket

---

### **4. Middleware de Segurança**

#### **Security Check Middleware**
- Verifica se IP está bloqueado
- Checa padrões de ataque em body e query
- Sanitiza campos sensíveis automaticamente
- Bloqueia requisições maliciosas

#### **Validate Sensitive Data**
- Remove stack traces em produção
- Remove informações de ambiente
- Máscara de dados sensíveis em respostas

---

### **5. Proteção Contra CSRF**

#### **Geração de Token CSRF**
- Gera token aleatório de 32 bytes (hex)
- Armazena na sessão do usuário

#### **Validação de Token CSRF**
- Valida em métodos que modificam dados (POST, PUT, DELETE, PATCH)
- Compara token do header com token da sessão
- Bloqueia requisições sem token válido

---

### **6. Logging de Segurança**

#### **Log Security Event**
- Timestamp
- Evento
- IP
- User-Agent
- Path
- Method
- UserID
- UserEmail
- CompanyID
- Informações adicionais

#### **Integração Futura**
- Sentry (monitoramento de erros)
- LogRocket (session replay)
- Datadog (monitoramento de performance)

---

### **7. Proteção Contra Brute Force**

#### **Advanced Auth Limiter**
- Limite: 5 tentativas em 15 minutos (reduzido de 10)
- Skip para IPs confiáveis (configurável via `TRUSTED_IPS`)
- Headers de rate limit na resposta
- Mensagem clara para usuário

#### **Tracking de Login Attempts**
- Rastreia tentativas por email/IP
- Bloqueia após 5 tentativas em 5 minutos
- Limpa contador após login bem-sucedido
- Tempo de bloqueio: 5 minutos

---

### **8. Validação de File Upload**

#### **Validação MIME Type**
- Apenas tipos permitidos:
  - Imagens: JPEG, PNG, GIF, WebP
  - Documentos: PDF, DOC, DOCX, XLS, XLSX
  - Texto: TXT
  - Comprimidos: ZIP

#### **Validação de Tamanho**
- Limite: 50MB
- Apaga arquivo se exceder

#### **Validação de Nome**
- Remove path traversal (`..`, `/`, `\`)
- Apaga arquivo se nome inválido

---

### **9. Máscara de Dados Sensíveis**

#### **Mask Sensitive Data**
- Email: `jo***@gmail.com`
- Telefone: `11****99`
- Remove tokens e passwords de respostas
- Remove stack traces em produção

---

### **10. Proteção Contra XSS em Respostas**

#### **Escape XSS**
- Converte `<` para `&lt;`
- Converte `>` para `&gt;`
- Converte `&` para `&amp;`
- Converte `"` para `&quot;`
- Converte `'` para `&#39;`

---

### **11. Headers de Segurança**

#### **Set Security Headers**
- Remove `X-Powered-By` (expose versão do servidor)
- Remove `Server` (expose tecnologia)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security` (apenas em produção)

---

### **12. Monitoramento de Login Múltiplo**

#### **Track Login Attempt**
- Rastreia tentativas por email/IP
- Bloqueia após 5 tentativas em 5 minutos
- Tempo de bloqueio: 5 minutos
- Log de eventos de bloqueio

#### **Clear Login Attempt**
- Limpa contador após login bem-sucedido
- Limpa contador após 5 minutos sem atividade

---

### **13. Verificação de Origem de Requisição**

#### **Verify Request Origin**
- Valida header `Origin`
- Apenas origens permitidas em produção:
  - `https://klweb.com.br`
  - `https://www.klweb.com.br`
  - `https://kl-web.onrender.com`
- Bloqueia requisições de origens desconhecidas

---

### **14. Headers de Segurança Adicionais (Helmet)**

#### **Content Security Policy (CSP)**
- `default-src: 'self'`
- `script-src: 'self', 'unsafe-inline', CDNs permitidos`
- `style-src: 'self', 'unsafe-inline'`
- `img-src: 'self', data:, blob:`
- `font-src: 'self', data:`
- `connect-src: 'self', APIs permitidas`
- `media-src: 'self'`
- `object-src: 'none'`
- `frame-src: 'none'`
- `base-uri: 'self'`
- `form-action: 'self'`
- `frame-ancestors: 'none'`
- `upgrade-insecure-requests` (apenas em produção)

#### **Outros Headers**
- `X-DNS-Prefetch-Control: off`
- `X-Download-Options: noopen`
- `X-Permitted-Cross-Domain-Policies: none`

---

### **15. Rate Limiting**

#### **Global Limiter**
- 100 requisições por 15 minutos
- Aplicado a todas as rotas

#### **Auth Limiter (Avançado)**
- 5 tentativas de login por 15 minutos
- Aplicado em `/api/auth/login` e `/api/auth/register`
- Skip para IPs confiáveis

#### **Verify Email Limiter**
- 20 tentativas por 15 minutos
- Aplicado em `/api/auth/verify-email`

#### **Resend Verification Limiter**
- 6 tentativas por 15 minutos
- Aplicado em `/api/auth/resend-verification`

#### **Email Change Limiter**
- 30 tentativas por 15 minutos
- Aplicado em rotas de mudança de email

#### **Automation Limiter**
- 10 mensagens por minuto
- Aplicado em `/api/automation/send`

---

### **16. Proteção de Banco de Dados**

#### **Tokens Hash (Prioridade 3)**
- `password_reset_tokens`: Hash de tokens com bcrypt
- `email_change_tokens`: Hash de tokens com bcrypt
- Expiração em milissegundos
- Marcação de uso (`used_at`)

#### **Company ID (Prioridade 4)**
- `notifications.company_id`: NOT NULL com CASCADE
- `security_logs.company_id`: NULLABLE com SET NULL
- Índices para queries por empresa

#### **Tipos de Data/Hora (Prioridade 7)**
- `events.event_date`: VARCHAR → DATE
- `events.event_time`: VARCHAR → TIME
- `updated_at`: Adicionado em empresas, usuários, contatos, automações
- Triggers automáticos para atualizar `updated_at`

#### **Índices de Performance**
- Índices para tabelas de tokens
- Índices compostos (company + status)
- Índices únicos para tokens ativos

---

### **17. Autenticação e Autorização**

#### **JWT Authentication**
- Tokens assinados com `JWT_SECRET`
- Expiração configurável
- Versão de token (`token_version`) para revogação
- Revogação de sessões (incrementa `token_version`)

#### **2FA (TOTP)**
- Autenticação de dois fatores opcional
- Tokens de backup
- Limite de tentativas
- Logging de eventos 2FA

#### **Role-Based Access Control**
- OWNER: Acesso total
- MANAGER: Acesso limitado
- USER: Acesso básico
- ADMIN: Acesso administrativo

---

### **18. Socket.io Security**

#### **Autenticação**
- Validação de JWT na conexão
- User ID no socket
- Desconexão forçada ao revogar sessão

#### **CORS**
- Origens permitidas configuradas
- Validação de origin

---

### **19. Logs de Auditoria**

#### **Audit Log**
- Todas as ações sensíveis são logadas
- Timestamp, user, action, IP
- Armazenado em `security_logs`

#### **Eventos Logados**
- Login bem-sucedido
- Login falhado
- Mudança de senha
- Mudança de email
- Criação de usuário
- Exclusão de usuário
- Acesso a arquivos
- Mudança de plano

---

### **20. Proteção de Ambiente**

#### **Variáveis de Ambiente**
- `.env` nunca commitado
- Segredos nunca expostos no código
- Validação de variáveis obrigatórias

#### **Database URL**
- Parse seguro de connection string
- Tratamento de caracteres especiais

---

## 🚀 Resumo de Segurança

### **Proteções Implementadas:**
1. ✅ Validação e sanitização de input
2. ✅ Proteção contra SQL Injection
3. ✅ Detecção de atividade suspeita
4. ✅ Middleware de segurança
5. ✅ Proteção contra CSRF
6. ✅ Logging de segurança
7. ✅ Proteção contra brute force
8. ✅ Validação de file upload
9. ✅ Máscara de dados sensíveis
10. ✅ Proteção contra XSS
11. ✅ Headers de segurança
12. ✅ Monitoramento de login múltiplo
13. ✅ Verificação de origem
14. ✅ Rate limiting
15. ✅ Proteção de banco de dados
16. ✅ Autenticação JWT
17. ✅ 2FA (TOTP)
18. ✅ RBAC
19. ✅ Socket.io security
20. ✅ Logs de auditoria
21. ✅ Row-Level Security (RLS) em 100% das tabelas do banco de dados (79 políticas ativas)
22. ✅ Criptografia em repouso AES-256-GCM com Auth Tag em dados pessoais de usuários (Nome, Telefone, CPF) e contatos do CRM (Nome, Telefone, E-mail, Notas)

### **Nível de Segurança:**
- 🔒 **Alto** - SISTEMA BASTANTE SEGURO

### **Recomendações Futuras:**
- Implementar integração com Sentry
- Implementar integração com LogRocket
- Adicionar WAF (Web Application Firewall)
- Implementar testes de penetração regulares
- Adicionar monitoramento 24/7
- Implementar backup automático do banco
- Criar política de retenção de logs

---

## 📞 Em Caso de Incidente

### **O que fazer:**
1. Verificar logs de segurança (`security_logs`)
2. Verificar logs do console
3. Identificar IP malicioso
4. Bloquear IP no firewall (se necessário)
5. Notificar usuários afetados
6. Revisar medidas de segurança
7. Implementar correções

### **Contatos:**
- Suporte: [suporte@klweb.com.br]
- Security: [security@klweb.com.br]

---

## 📝 Última Atualização

- **Data**: 2026-10-07
- **Versão**: 1.0
- **Autor**: Devin AI Assistant
