# Deployment - KL Web / DemandIA-MVP

## 🏗️ Arquitetura de Deploy

O sistema está dividido em duas partes para deploy em domínios diferentes:

### 1. **Backend (Node.js/Express - API Only)** - https://kl-web.onrender.com
- **Localização**: Pasta `backend/`
- **Contém**: `server.js`, `ai.js`, `planLimits.js`, `.env`
- **Responsável por**:
  - API REST (/api/*)
  - WebSocket (Socket.io)
  - Conexão com PostgreSQL (Supabase)
  - Integração com Mercado Pago
  - Integração com Resend (email)
  - Integração com Google Gemini (IA)
- **NÃO serve frontend** - Apenas API e WebSocket

### 2. **Frontend Estático** - https://klweb.com.br
- **Localização**: Pasta `frontend-static/`
- **Contém**: `index.html`, `app.js`, `style.css`, assets
- **Responsável por**:
  - Interface do usuário
  - Cliente Socket.io
  - Chamadas para API do backend
  - Nenhuma lógica de backend

---

## 🚀 Deployment

### Backend - Render.com

1. **Crie um novo Web Service no Render**
   - Conecte o repositório
   - Configure:
     - **Build Command**: `npm install`
     - **Start Command**: `node backend/server.js`
     - **Root Directory**: `.` (raiz do projeto)

2. **Configure as Environment Variables no Render**
   - `GEMINI_API_KEY` - Chave do Google Gemini
   - `MERCADOPAGO_ACCESS_TOKEN` - Token do Mercado Pago
   - `MERCADOPAGO_WEBHOOK_SECRET` - Secret do webhook do Mercado Pago
   - `RESEND_API_KEY` - Chave do Resend
   - `RESEND_FROM` - Email de envio (ex: `KL Web <seu@email.com>`)
   - `DATABASE_URL` - Connection string do Supabase
   - `JWT_SECRET` - Segredo para JWT (use um valor forte e único)
   - `MASTER_PASSWORD` - Senha do painel master
   - `GROQ_API_KEY` - Chave do Groq (opcional)
   - `OWNER_EMAIL` - Email do dono do sistema
   - `ALLOWED_ORIGINS` - `https://klweb.com.br,https://www.klweb.com.br`

3. **Deploy**
   - O Render vai fazer deploy automático
   - A URL será algo como `https://kl-web.onrender.com`

### Frontend Estático - Netlify / Vercel / Cloudflare Pages

#### Opção 1: Netlify (Recomendado)

1. **Arraste a pasta `frontend-static/` para o Netlify**
   - Ou conecte o repositório e configure:
     - **Publish directory**: `frontend-static`
     - **Build command**: (deixe vazio)
     - **Custom domain**: `klweb.com.br`

2. **Configure DNS**
   - No seu provedor de DNS, aponte `klweb.com.br` para o Netlify:
     - Tipo: `CNAME`
     - Nome: `@`
     - Valor: `seu-site.netlify.app`

3. **SSL**
   - O Netlify fornece SSL automático via Let's Encrypt

#### Opção 2: Vercel

1. **Deploy via Vercel CLI**
   ```bash
   cd frontend-static
   vercel
   ```

2. **Configure domínio customizado**
   - No painel do Vercel, adicione `klweb.com.br`

3. **Configure DNS**
   - Tipo: `CNAME`
   - Nome: `@`
   - Valor: `cname.vercel-dns.com`

#### Opção 3: Cloudflare Pages

1. **Criar projeto no Cloudflare Pages**
   - Conecte o repositório
   - Configure:
     - **Build command**: (deixe vazio)
     - **Build output directory**: `frontend-static`

2. **Configure domínio customizado**
   - Adicione `klweb.com.br` no painel do Cloudflare

---

## 🔗 Configuração de CORS

O backend está configurado para aceitar requisições de:

1. **klweb.com.br** (frontend estático)
2. **www.klweb.com.br** (frontend estático com www)
3. **kl-web.onrender.com** (próprio backend, para testes)
4. **localhost** (desenvolvimento local)

### Como o CORS funciona:

```javascript
// No backend/server.js
const allowedOrigins = [
    'https://klweb.com.br',
    'https://www.klweb.com.br',
    process.env.RENDER_EXTERNAL_URL // Adiciona automaticamente a URL do Render
];
```

### Como o frontend conecta:

```javascript
// No frontend-static/app.js
const API_BASE = (function() {
    if (window.location.hostname === 'klweb.com.br' || window.location.hostname === 'www.klweb.com.br') {
        return 'https://kl-web.onrender.com'; // Usa o backend no Render
    }
    // ... outras lógicas
})();
```

---

## 🧪 Testes Locais

### Testar com frontend estático local

1. **Inicie o backend**
   ```bash
   cd backend
   node server.js
   ```

2. **Sirva o frontend estático**
   ```bash
   cd frontend-static
   python -m http.server 8080
   # ou
   npx serve .
   ```

3. **Abra no navegador**
   - `http://localhost:8080`
   - O frontend vai tentar conectar em `http://localhost:3000` (backend)

### Testar com domínios

1. **Backend local**
   ```bash
   cd backend
   node server.js
   ```

2. **Edite `frontend-static/app.js` temporariamente**
   ```javascript
   const API_BASE = 'http://localhost:3000';
   ```

3. **Deploy o frontend estático**
   - Deploy no Netlify/Vercel
   - Teste com o backend local (use ngrok para expor o backend local)

---

## 📝 Variáveis de Ambiente

### Backend (.env)
```
GEMINI_API_KEY=seu_gemini_key
PORT=3000
MERCADOPAGO_ACCESS_TOKEN=seu_mp_token
MERCADOPAGO_WEBHOOK_SECRET=seu_mp_webhook_secret
RESEND_API_KEY=seu_resend_key
RESEND_FROM=KL Web <seu@email.com>
DATABASE_URL=postgresql://postgres:senha@db.projeto.supabase.co:5432/postgres
JWT_SECRET=seu_jwt_secret_forte
MASTER_PASSWORD=senha_master_forte
GROQ_API_KEY=seu_groq_key
OWNER_EMAIL=seu@email.com
ALLOWED_ORIGINS=https://klweb.com.br,https://www.klweb.com.br
```

### Frontend (JavaScript)
As configurações de API estão embutidas no `app.js`:
- Detecta automaticamente o domínio
- Redireciona para o backend correto
- Configura Socket.io com CORS

---

## 🔒 Segurança

### Backend
- CORS configurado apenas para domínios permitidos
- JWT para autenticação
- Environment variables para secrets
- Rate limiting (recomendado adicionar)
- Helmet.js (recomendado adicionar)

### Frontend
- HTTPS obrigatório (SSL automático em Netlify/Vercel)
- Content Security Policy (configurado no netlify.toml)
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff

---

## 📊 Monitoramento

### Backend (Render)
- Logs disponíveis no painel do Render
- Métricas de uso
- Alertas de erro

### Frontend (Netlify/Vercel)
- Logs de deploy
- Analytics
- Form submissions (se usado)

---

## 🔄 CI/CD

### Backend
- Deploy automático no Render ao fazer push no branch principal
- Testes recomendados antes do deploy

### Frontend
- Deploy automático no Netlify/Vercel ao fazer push
- Pré-visualização em cada PR

---

## 🐛 Troubleshooting

### Erro de CORS
- Verifique se `ALLOWED_ORIGINS` está configurado corretamente
- Verifique se o domínio do frontend está na lista
- Verifique se o frontend está usando HTTPS

### Socket.io não conecta
- Verifique se o backend está configurado para CORS
- Verifique se o path do Socket.io está correto
- Verifique se o token está sendo enviado

### Webhook do Mercado Pago
- Verifique se a URL do webhook está configurada no Mercado Pago
- Verifique se `MERCADOPAGO_WEBHOOK_SECRET` está correto
- Verifique se o backend está acessível externamente

---

## 📞 Suporte

Para problemas de deployment:
1. Verifique os logs do backend (Render)
2. Verifique os logs do frontend (Netlify/Vercel)
3. Teste localmente antes de deploy
4. Verifique as variáveis de ambiente
