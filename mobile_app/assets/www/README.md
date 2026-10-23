# Frontend Estático - KL Web

Esta pasta contém a versão estática do frontend KL Web, otimizada para deployment em:
- Netlify
- Vercel
- Cloudflare Pages
- Qualquer host de arquivos estáticos

## 📁 Estrutura

```
frontend-static/
├── index.html          # Página principal
├── app.js              # Lógica do frontend (configurada para cross-origin)
├── style.css           # Estilos
├── core.min.css        # CSS mínimo
├── auth-guide.css      # Estilos de autenticação
├── profile-page.css    # Estilos do perfil
├── master-page.css     # Estilos do painel master
├── responsive.css      # Estilos responsivos
├── workspace.min.js    # Lógica do workspace
├── reset-password.html # Página de recuperação de senha
├── netlify.toml        # Configuração do Netlify
└── README.md          # Este arquivo
```

## 🔗 Configuração de API

O `app.js` está configurado para detectar automaticamente o domínio e conectar ao backend correto:

- **klweb.com.br** → Conecta em `https://kl-web.onrender.com`
- **www.klweb.com.br** → Conecta em `https://kl-web.onrender.com`
- **kl-web.onrender.com** → Conecta no próprio domínio (relativo)
- **localhost** → Conecta em `http://localhost:3000`

## 🚀 Deployment

### Netlify
1. Arraste esta pasta para o Netlify
2. Configure o domínio customizado: `klweb.com.br`
3. Configure DNS apontando para o Netlify

### Vercel
```bash
cd frontend-static
vercel
```

### Cloudflare Pages
1. Crie projeto no Cloudflare Pages
2. Configure para usar esta pasta como build output
3. Configure domínio customizado

## 🔄 Atualizações

Quando fizer mudanças no frontend original (`frontend/`), copie os arquivos para esta pasta:

```bash
# No Windows
xcopy /E /I /Y frontend\* frontend-static\

# No Linux/Mac
cp -r frontend/* frontend-static/
```

**Importante**: Após copiar, verifique se as configurações de API no `app.js` estão corretas para o domínio estático.

## 📝 Notas

- Esta versão NÃO inclui o backend
- Todas as chamadas de API são para o backend no Render
- Socket.io está configurado para cross-origin
- Não há necessidade de Node.js no host do frontend
