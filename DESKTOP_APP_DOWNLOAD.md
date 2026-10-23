# 🖥️ App Desktop do KL Web - Como Baixar e Instalar

## 🎯 O que é o App Desktop?

O app Desktop do KL Web é um aplicativo instalável (tipo .exe no Windows) que:
- ✅ **Instala no sistema** (fica na lista de programas como qualquer app)
- ✅ **Funciona offline** (requer internet para acessar o backend)
- ✅ **Ícone na área de trabalho**
- ✅ **Mais rápido** (cache local)
- ✅ **Menu dedicado** (Arquivo, Editar, Visualizar, Ajuda)
- ✅ **Atalhos de teclado** (Ctrl+R, Ctrl+Q, etc.)

## 📦 Como Baixar

### **Passo 1: Acessar o GitHub**

1. Vá para: https://github.com/KevinLucasss/Replit/releases
2. Procure pela tag: `v1.0.0-desktop`
3. Clique na release

### **Passo 2: Baixar o Arquivo**

**Para Windows:**
- Baixe: `KL Web Setup 1.0.0.exe` (instalador) ou `KL Web 1.0.0.exe` (portable)
- Tamanho: ~100-150MB

**Para Mac:**
- Baixe: `KL Web-1.0.0.dmg`
- Tamanho: ~100-150MB

**Para Linux:**
- Baixe: `KL Web-1.0.0.AppImage` ou `kl-web_1.0.0_amd64.deb`
- Tamanho: ~100-150MB

## 🚀 Como Instalar

### **Windows (.exe):**

**Instalador (Setup):**
1. Dê duplo clique em `KL Web Setup 1.0.0.exe`
2. Clique em "Instalar"
3. Escolha o diretório (padrão: C:\Program Files\KL Web)
4. Clique em "Instalar"
5. Aguarde a instalação
6. Clique em "Concluir"
7. O app aparece no Menu Iniciar

**Portable:**
1. Dê duplo clique em `KL Web 1.0.0.exe`
2. O app abre diretamente
3. Não requer instalação

### **Mac (.dmg):**

1. Dê duplo clique em `KL Web-1.0.0.dmg`
2. Arraste o ícone do KL Web para a pasta Aplicativos
3. Abra o app em Aplicativos
4. Se pedir permissão, abra em Preferências do Sistema → Segurança

### **Linux (.AppImage):**

1. Dê permissão de execução: `chmod +x KL Web-1.0.0.AppImage`
2. Dê duplo clique no arquivo
3. O app abre

## 🎮 Como Usar

### **Abrir o App:**

- **Windows**: Menu Iniciar → KL Web
- **Mac**: Aplicativos → KL Web
- **Linux**: Menu de Aplicativos → KL Web

### **Atalhos de Teclado:**

- `Ctrl+R` ou `Cmd+R`: Recarregar página
- `Ctrl+Q` ou `Cmd+Q`: Sair do app
- `Ctrl+Shift+I` ou `Cmd+Shift+I`: Abrir DevTools (debug)

### **Menu do App:**

**Arquivo:**
- Recarregar
- DevTools
- Sair

**Editar:**
- Desfazer
- Refazer
- Cortar
- Copiar
- Colar

**Visualizar:**
- Recarregar
- Recarregar forçado
- Toggle DevTools
- Reset Zoom
- Zoom In
- Zoom Out
- Tela Cheia

**Ajuda:**
- Sobre o KL Web
- Documentação
- Relatar Problema

## 🔧 Como é Feito o Build?

### **GitHub Actions Automático:**

1. **Push no GitHub**: O código é enviado
2. **Trigger**: Criar tag `v*` (ex: v1.0.0)
3. **Build Automático**: GitHub Actions constrói o app
4. **Release Automática**: Cria release no GitHub
5. **Arquivos Gerados**: .exe, .dmg, .AppImage

### **Workflow:**

```yaml
- Checkout code
- Setup Node.js
- Install dependencies
- Build Electron app
- Upload artifacts
- Create Release
```

## 🎯 Como Criar Nova Versão

### **Passo 1: Fazer Mudanças no Código**

Edite os arquivos em `desktop-app/`:
- `main.js` - Código principal
- `preload.js` - Script de preload
- `package.json` - Configuração

### **Passo 2: Commit no GitHub**

```bash
git add desktop-app/
git commit -m "Nova versão do app"
git push origin main
```

### **Passo 3: Criar Tag**

```bash
git tag v1.0.1
git push origin v1.0.1
```

### **Passo 4: Aguardar Build**

- GitHub Actions detecta a tag
- Executa o build automaticamente
- Cria release no GitHub
- Usuários baixam os arquivos

## 📊 Comparação: PWA vs Desktop App

| Funcionalidade | PWA | Desktop App |
|---------------|-----|-------------|
| **Instalação** | Do navegador | Download e instalação |
| **Peso** | 0KB (instala via navegador) | 100-150MB |
| **Ícone** | Home screen | Lista de programas |
| **Offline** | Parcial | Requer internet |
| **Menu** | Navegador | Menu dedicado |
| **Atalhos** | Navegador | Atalhos dedicados |
| **Atualização** | Automática | Manual (nova versão) |

## ⚠️ Limitações

- **Offline**: O app requer internet para acessar o backend (https://klweb.com.br)
- **Atualização**: Precisa baixar nova versão manualmente
- **Peso**: 100-150MB (devido ao Electron/Chromium)

## 🎯 Próximos Passos

1. ✅ Aguardar build do GitHub Actions
2. ✅ Baixar os arquivos gerados
3. ✅ Testar no Windows, Mac e Linux
4. ⏳ Criar página de download no site
5. ⏳ Adicionar banner no site para download

## 🔗 Links Úteis

- GitHub Releases: https://github.com/KevinLucasss/Replit/releases
- GitHub Actions: https://github.com/KevinLucasss/Replit/actions
- Site: https://klweb.com.br
- Backend: https://kl-web.onrender.com

## 💡 Dicas

- **Build automático**: Ao criar tag `v*`, o build é automático
- **Teste local**: Use `npm start` na pasta `desktop-app/` para testar
- **Build local**: Use `npm run build-win` (requer permissões)
- **Limpar cache**: Após instalar, limpe o cache do navegador

## 🎉 Status Atual

- ✅ Estrutura do app criada
- ✅ Workflow do GitHub Actions configurado
- ✅ Tag v1.0.0-desktop criada
- ⏳ Build em andamento no GitHub Actions
- ⏳ Aguardando release automática

**Após o build completar, os arquivos estarão disponíveis para download!**
