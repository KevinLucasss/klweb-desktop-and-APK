/* =========================================================
   KL WEB / WORKSPACE CORPORATIVO - FRONTEND JAVASCRIPT
   SISTEMA RESILIENTE COM PERSISTÊNCIA LOCAL & SINCRONIZAÇÃO
   ========================================================= */

// Variavel Global de Apoio ao Painel Master (Única Declaração)
let globalUsersList = [];

// Exportar funções para o escopo global IMEDIATAMENTE para evitar ReferenceError em onclicks do HTML
window.openAuthentication = function (mode = 'login') {
    if (typeof state === 'undefined') {
        console.error('State not initialized yet');
        return;
    }
    state.isRegisterMode = mode === 'register';
    if (typeof updateAuthMode === 'function') updateAuthMode();

    const welcomeContainer = document.getElementById('welcome-screen');
    const authContainer = document.getElementById('auth-screen');
    const appContainer = document.getElementById('app-screen');

    if (welcomeContainer) welcomeContainer.style.display = 'none';
    if (authContainer) authContainer.style.display = 'flex';
    if (appContainer) appContainer.style.display = 'none';

    const errorBox = document.getElementById('auth-error-box');
    if (errorBox) errorBox.style.display = 'none';
    document.getElementById('auth-email')?.focus();
};

// Base da API para compatibilidade com Live Server (portas diferentes como 5500) e Replit
const API_BASE = (function () {
    if (typeof window === 'undefined') return '';
    if (window.__API_BASE__) return window.__API_BASE__;

    const hostname = window.location.hostname.toLowerCase();

    // Se estiver no domínio estático klweb.com.br (com ou sem www), usar o backend no Render
    if (hostname === 'klweb.com.br' || hostname === 'www.klweb.com.br' || hostname.includes('klweb.com.br')) {
        console.log('🌐 Detectado domínio estático klweb.com.br, usando backend:', 'https://kl-web.onrender.com');
        return 'https://kl-web.onrender.com';
    }

    // Se estiver no Render diretamente, usar vazio (caminho relativo)
    if (hostname === 'kl-web.onrender.com') {
        console.log('🌐 Detectado domínio do Render, usando caminho relativo');
        return '';
    }

    // Desenvolvimento local
    if (window.location.protocol === 'file:') {
        console.log('🌐 Protocolo file://, usando localhost:3000');
        return 'http://localhost:3000';
    }
    if (window.location.port && window.location.port !== '3000' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
        console.log('🌐 Desenvolvimento local com porta diferente, usando:', `${window.location.protocol}//${window.location.hostname}:3000`);
        return `${window.location.protocol}//${window.location.hostname}:3000`;
    }

    // Fallback para produção (se não detectar nada específico)
    console.log('🌐 Usando backend do Render como fallback');
    return 'https://kl-web.onrender.com';
})();

// Socket.io Connection
// O socket só conecta DEPOIS do login (o servidor agora exige o token na conexão), e reconecta
// com o token novo caso o usuário troque de conta sem recarregar a página.
let socket = null;
function connectSupportSocket() {
    if (typeof io === 'undefined') return null;
    const token = state.token || localStorage.getItem('klweb_token');
    if (!token) return null;
    if (socket) socket.disconnect();

    // Configurações do Socket.io para cross-origin
    const socketOptions = {
        auth: { token },
        transports: ['websocket', 'polling']
    };

    // Se estiver no domínio estático, usar o backend do Render com CORS
    if (window.location.hostname === 'klweb.com.br' || window.location.hostname === 'www.klweb.com.br') {
        socketOptions.path = '/socket.io/';
    }

    socket = io(API_BASE, socketOptions);
    registerBoardSocketListeners(socket);
    return socket;
}

function getApiUrl(url) {
    if (typeof url === 'string' && url.startsWith('/api') && API_BASE) {
        return `${API_BASE}${url}`;
    }
    return url;
}

if (API_BASE) {
    const originalFetch = window.fetch;
    window.fetch = function (resource, init) {
        if (typeof resource === 'string' && resource.startsWith('/api')) {
            resource = `${API_BASE}${resource}`;
        }
        return originalFetch.call(this, resource, init);
    };
}

const state = {
    token: localStorage.getItem('klweb_token') || null,
    users_db: JSON.parse(localStorage.getItem('klweb_users_db') || '[]'),
    user: JSON.parse(localStorage.getItem('klweb_user') || 'null'),
    demands: JSON.parse(localStorage.getItem('klweb_demands') || '[]'),
    contacts: JSON.parse(localStorage.getItem('klweb_contacts') || '[]'),
    members: JSON.parse(localStorage.getItem('klweb_members') || '[]'),
    events: JSON.parse(localStorage.getItem('klweb_events') || '[]'),
    automations: JSON.parse(localStorage.getItem('klweb_automations') || '[]'),
    notifications: JSON.parse(localStorage.getItem('klweb_notifications') || '[]'),
    analytics: null,
    isRegisterMode: false,
    currentDate: new Date(),
    selectedCalendarDate: null,
    lineChartInstance: null,
    doughnutChartInstance: null
};

// ==================== PREFERENCES & ACCESSIBILITY ====================
async function applyUserPreferences() {
    if (!state.token || !state.user) {
        return;
    }
    try {
        const response = await fetchWithAuth('/api/user/preferences');
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) return;
            return;
        }
        const prefs = await response.json();
        if (!prefs) return;

        const body = document.body;

        if (prefs.theme === 'dark') {
            body.classList.add('dark-mode');
        } else {
            body.classList.remove('dark-mode');
        }

        if (prefs.daltonic_mode === 'on') {
            body.classList.add('daltonic-mode');
        } else {
            body.classList.remove('daltonic-mode');
        }

        if (prefs.font_size) {
            body.style.fontSize = prefs.font_size;
        }
    } catch (error) {
        console.warn('Preferências não aplicadas:', error.message);
    }
}

async function saveUserPreferences(prefs) {
    try {
        const response = await fetchWithAuth('/api/user/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prefs)
        });

        if (response.ok) {
            console.log('Preferências salvas com sucesso');
        }
    } catch (error) {
        console.error('Erro ao salvar preferências:', error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    applyUserPreferences();
    initZoomAndTheme();
    initNavigation();
    initWelcomePointerBackground();

    if (state.user) {
        showApp();
    } else {
        showWelcomeScreen();
    }

    const btnProfile = document.getElementById('btn-open-profile');
    if (btnProfile) {
        btnProfile.addEventListener('click', openProfileModal);
    }

    const btnLogout = document.getElementById('btn-logout') || document.querySelector('.btn-logout');

    if (btnLogout) {
        btnLogout.addEventListener('click', (e) => {
            e.preventDefault();
            logout();
        });
    }

    if (state.user && state.token) {
        connectSupportSocket();
        initSupportChat();

        if (['OWNER', 'ADMIN'].includes(state.user.role)) {
            loadAdminSupportQueue();
        }
    }

    if (state.user && ['OWNER', 'ADMIN'].includes(state.user.role)) {
        const feedbackNav = document.getElementById('nav-feedback');
        const supportNav = document.getElementById('nav-support-dashboard');
        if (feedbackNav) {
            feedbackNav.style.display = 'block';
        }
        if (supportNav) {
            supportNav.style.display = 'block';
        }
    }

    if (state.user && state.token) refreshAuthenticatedUser();
    handlePaymentReturn();
});

async function refreshAuthenticatedUser() {
    try {
        const response = await fetchWithAuth('/api/auth/me');
        if (!response.ok) return;

        const data = await response.json();
        if (!data.user || !state.user) return;

        // O servidor renova o login (mais 7 dias) quando ele está perto de vencer.
        if (data.token) {
            state.token = data.token;
            localStorage.setItem('klweb_token', data.token);
        }

        const previousRole = state.user.role;
        state.user = { ...state.user, ...data.user };
        localStorage.setItem('klweb_user', JSON.stringify(state.user));
        if (typeof updateUserProfileUI === 'function') updateUserProfileUI();

        if (previousRole !== state.user.role) {
            const isSupportAdmin = ['OWNER', 'ADMIN'].includes(state.user.role);
            const feedbackNav = document.getElementById('nav-feedback');
            const supportNav = document.getElementById('nav-support-dashboard');
            if (feedbackNav) feedbackNav.style.display = isSupportAdmin ? 'block' : 'none';
            if (supportNav) supportNav.style.display = isSupportAdmin ? 'block' : 'none';

            connectSupportSocket();
            initSupportChat();
            if (isSupportAdmin) loadAdminSupportQueue();
            if (!isSupportAdmin && document.getElementById('tab-support-dashboard')?.classList.contains('active')) {
                switchTab('kanban');
            }
        }
        return state.user;
    } catch (error) {
        console.error('Erro ao sincronizar permissões da conta:', error);
        return null;
    }
}

async function handlePaymentReturn() {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('payment');
    if (!outcome) return;

    window.history.replaceState({}, document.title, window.location.pathname);

    if (outcome === 'failure') {
        showToast('O pagamento não foi concluído. Nenhum plano foi ativado.', 'error');
        return;
    }
    if (outcome === 'pending') {
        showToast('O pagamento está pendente de confirmação. Aguarde sem fazer outra compra.', 'info');
        return;
    }
    if (!state.token || !state.user) {
        showToast('Pagamento recebido. Entre na sua conta para verificar a ativação do plano.', 'info');
        return;
    }

    showToast('Pagamento recebido. Confirmando a ativação do plano...', 'info');
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const user = await refreshAuthenticatedUser();
        if (user && ['STARTER', 'PRO_IA'].includes(user.planTier) && user.planStatus === 'ACTIVE') {
            showToast(`Pagamento confirmado. Plano ${user.planTier === 'PRO_IA' ? 'Pro AI' : 'Starter'} ativado!`, 'success');
            return;
        }
        if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 2000));
    }

    showToast('Ainda aguardamos a confirmação do Mercado Pago. Não refaça o pagamento; seu plano será atualizado assim que a confirmação chegar.', 'info');
}

// initDefaultUsersDB() foi removida: nunca era chamada (state.users_db ja e carregado
// diretamente do localStorage na definicao de `state`, la em cima), e continha um usuario
// 'Dono' com email real e senha '123' fixos no bundle publico. Nao mudava comportamento
// nenhum remove-la, so tirava um dado sensivel morto do codigo.

function saveUsersDBLocal() {
    localStorage.setItem('klweb_users_db', JSON.stringify(state.users_db));
}

function saveMembersLocal() {
    localStorage.setItem('klweb_members', JSON.stringify(state.members));
}

async function requestCompanyJoin() {
    const codeInput = document.getElementById('request-join-code');
    const code = codeInput ? codeInput.value.trim().toUpperCase() : '';

    if (!code) {
        showToast('Por favor, informe o código de convite da empresa.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/company/request-join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyCode: code })
        });

        const data = await response.json();

        if (response.ok) {
            showToast(data.message, 'success');
            if (codeInput) codeInput.value = '';
            updateUserProfileUI();
            loadCompanyCode();
        } else {
            showToast(data.message || 'Erro ao solicitar entrada na empresa.', 'error');
        }
    } catch (error) {
        console.error('Erro ao solicitar entrada:', error);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

// ==================== COMPANY CODE & PENDING REQUESTS ====================
async function loadCompanyCode() {
    try {
        const response = await fetchWithAuth('/api/company/code');
        if (!response.ok) return;
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) return;
        const data = await response.json();

        if (data && data.code) {
            const codeDisplay = document.getElementById('company-code-display');
            if (codeDisplay) {
                codeDisplay.textContent = data.code;
            }
        }
    } catch (error) {
        console.error('Erro ao carregar código da empresa:', error);
    }
}

function copyCompanyCode() {
    const codeDisplay = document.getElementById('company-code-display');
    if (codeDisplay && codeDisplay.textContent !== '---') {
        navigator.clipboard.writeText(codeDisplay.textContent).then(() => {
            showToast('Código copiado para a área de transferência!', 'success');
        }).catch(() => {
            showToast('Erro ao copiar código.', 'error');
        });
    }
}

async function loadPendingRequests() {
    if (!state.user || !['OWNER', 'MANAGER'].includes(state.user.role)) {
        return;
    }

    try {
        const response = await fetchWithAuth('/api/company/pending-requests');
        const data = await response.json();

        if (response.ok) {
            const pendingList = document.getElementById('pending-requests-list');
            const pendingCount = document.getElementById('pending-count');

            if (pendingList) {
                if (data.length === 0) {
                    pendingList.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 1rem;">Nenhuma solicitação pendente.</p>';
                } else {
                    pendingList.innerHTML = data.map(user => `
                        <div class="member-item" style="border-left: 3px solid #f59e0b;">
                            <div class="member-info">
                                <div class="member-avatar">${escapeHtml(user.name.charAt(0).toUpperCase())}</div>
                                <div class="member-details">
                                    <div class="member-name">${escapeHtml(user.name)}</div>
                                    <div class="member-email">${escapeHtml(user.email)}</div>
                                    <div class="member-role" style="color: #f59e0b; font-size: 0.75rem;">Pendente desde ${new Date(user.requested_at).toLocaleDateString()}</div>
                                </div>
                            </div>
                            <div class="member-actions">
                                <button class="btn-primary" onclick="approveRequest(${user.id})" style="padding: 0.5rem 1rem; font-size: 0.85rem;" aria-label="Aprovar solicitação de ${escapeHtml(user.name)}">
                                    <i class="fa-solid fa-check"></i> Aprovar
                                </button>
                                <button class="btn-secondary" onclick="rejectRequest(${user.id})" style="padding: 0.5rem 1rem; font-size: 0.85rem; background: #ef4444; border-color: #ef4444;" aria-label="Rejeitar solicitação de ${escapeHtml(user.name)}">
                                    <i class="fa-solid fa-times"></i> Rejeitar
                                </button>
                            </div>
                        </div>
                    `).join('');
                }
            }

            if (pendingCount) {
                pendingCount.textContent = `${data.length} Pendente${data.length !== 1 ? 's' : ''}`;
            }
        }
    } catch (error) {
        console.error('Erro ao carregar solicitações pendentes:', error);
    }
}

async function approveRequest(userId) {
    try {
        const response = await fetchWithAuth('/api/company/approve-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });

        const data = await response.json();

        if (response.ok) {
            showToast(data.message, 'success');
            loadPendingRequests();
            loadCompanyMembers();
        } else {
            showToast(data.message || 'Erro ao aprovar solicitação.', 'error');
        }
    } catch (error) {
        console.error('Erro ao aprovar solicitação:', error);
        showToast('Erro ao aprovar solicitação.', 'error');
    }
}

async function rejectRequest(userId) {
    if (!confirm('Tem certeza que deseja rejeitar esta solicitação?')) {
        return;
    }

    try {
        const response = await fetchWithAuth('/api/company/reject-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });

        const data = await response.json();

        if (response.ok) {
            showToast(data.message, 'success');
            loadPendingRequests();
        } else {
            showToast(data.message || 'Erro ao rejeitar solicitação.', 'error');
        }
    } catch (error) {
        console.error('Erro ao rejeitar solicitação:', error);
        showToast('Erro ao rejeitar solicitação.', 'error');
    }
}

async function changeUserRole(userId, newRole) {
    if (!state.user || (state.user.companyRole !== 'OWNER' && state.user.role !== 'OWNER')) {
        showToast('Apenas o dono pode alterar cargos.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/company/change-role', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, newRole })
        });

        const data = await response.json();

        if (response.ok) {
            showToast(data.message, 'success');
            loadCompanyMembers();
        } else {
            showToast(data.message || 'Erro ao alterar cargo.', 'error');
        }
    } catch (error) {
        console.error('Erro ao alterar cargo:', error);
        showToast('Erro ao alterar cargo.', 'error');
    }
}

// ==================== STORAGE/UPLOAD FUNCTIONS ====================
function openUploadModal() {
    document.getElementById('modal-upload').style.display = 'flex';
    document.getElementById('file-upload').value = '';
    document.getElementById('upload-progress').style.display = 'none';
}

function closeUploadModal() {
    document.getElementById('modal-upload').style.display = 'none';
}

async function uploadFile() {
    const fileInput = document.getElementById('file-upload');
    const file = fileInput.files[0];

    if (!file) {
        showToast('Selecione um arquivo para enviar.', 'error');
        return;
    }

    const userPlan = (state.user && state.user.planTier) ? state.user.planTier.toUpperCase() : 'STARTER';
    const maxFileSizeMB = (userPlan === 'PRO_IA' || userPlan === 'PRO') ? 100 : 20;
    const maxSizeBytes = maxFileSizeMB * 1024 * 1024;

    if (file.size > maxSizeBytes) {
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
        showToast(`O arquivo (${fileSizeMB} MB) excede o limite de ${maxFileSizeMB} MB permitido para o seu plano (${userPlan}).`, 'error');
        fileInput.value = '';
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const progressDiv = document.getElementById('upload-progress');
    const uploadBar = document.getElementById('upload-bar');
    const uploadPercentage = document.getElementById('upload-percentage');

    progressDiv.style.display = 'block';
    uploadBar.style.width = '0%';
    uploadPercentage.textContent = '0%';

    try {
        let progress = 0;
        const progressInterval = setInterval(() => {
            progress += 10;
            if (progress <= 90) {
                uploadBar.style.width = progress + '%';
                uploadPercentage.textContent = progress + '%';
            } else {
                clearInterval(progressInterval);
            }
        }, 100);

        const response = await fetchWithAuth('/api/files/upload', {
            method: 'POST',
            body: formData
        });

        clearInterval(progressInterval);
        uploadBar.style.width = '100%';
        uploadPercentage.textContent = '100%';

        let data = null;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            try {
                data = await response.json();
            } catch (e) {
                data = null;
            }
        }
        if (!data) {
            const text = await response.text().catch(() => '');
            data = { message: text || `Erro ${response.status}: ${response.statusText}` };
        }

        if (response.ok) {
            showToast(data.message || 'Arquivo enviado com sucesso!', 'success');
            closeUploadModal();
            loadFiles();
            loadStorageInfo();
        } else {
            showToast(data.message || 'Erro ao enviar arquivo.', 'error');
            progressDiv.style.display = 'none';
        }
    } catch (error) {
        console.error('Erro ao fazer upload:', error);
        showToast('Erro ao fazer upload. Tente novamente.', 'error');
        progressDiv.style.display = 'none';
    }
}

async function loadStorageInfo() {
    try {
        const response = await fetchWithAuth('/api/files/storage-info');
        const data = await response.json();

        if (response.ok) {
            const storageInfoText = document.getElementById('storage-info-text');
            const storageUsageFill = document.getElementById('storage-usage-fill');
            const storageUsageText = document.getElementById('storage-usage-text');
            const upgradeNotice = document.getElementById('storage-upgrade-notice');

            const currentBytes = Number(data.currentUsage) || 0;
            const usedMB = (currentBytes / (1024 * 1024)).toFixed(2);

            const limitMB = 5120;
            const limitBytes = limitMB * 1024 * 1024;

            if (storageInfoText) {
                storageInfoText.textContent = `${usedMB} MB de ${limitMB} MB utilizados (5 GB)`;
            }

            if (storageUsageFill && storageUsageText) {
                const percentage = Math.min(100, Math.max(0, (currentBytes / limitBytes) * 100)).toFixed(1);

                storageUsageFill.style.width = `${percentage}%`;
                storageUsageText.textContent = `${percentage}% utilizado`;

                if (percentage > 80) {
                    storageUsageFill.style.background = '#ef4444';
                } else if (percentage > 60) {
                    storageUsageFill.style.background = '#f59e0b';
                } else {
                    storageUsageFill.style.background = '#10b981';
                }
            }

            if (upgradeNotice) {
                upgradeNotice.style.display = data.allowed ? 'none' : 'block';
            }
        }
    } catch (error) {
        console.error('Erro ao carregar informações de armazenamento:', error);
    }
}

async function loadFiles() {
    try {
        const response = await fetchWithAuth('/api/files');
        const data = await response.json();

        if (response.ok) {
            const filesList = document.getElementById('files-list');
            const filesCount = document.getElementById('files-count');

            if (filesList) {
                if (data.length === 0) {
                    filesList.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 1rem;">Nenhum arquivo enviado ainda.</p>';
                } else {
                    filesList.innerHTML = data.map(file => {
                        const fileSizeMB = (file.file_size / (1024 * 1024)).toFixed(2);
                        const fileIcon = getFileIcon(file.mime_type);
                        const uploadDate = new Date(file.uploaded_at).toLocaleDateString('pt-BR');

                        return `
                            <div class="member-item">
                                <div class="member-avatar" style="background: var(--primary);">
                                    <i class="${fileIcon}"></i>
                                </div>
                                <div class="member-info">
                                    <strong>${escapeHtml(file.original_name)}</strong>
                                    <span><i class="fa-solid fa-database"></i> ${fileSizeMB} MB | <i class="fa-solid fa-calendar"></i> ${uploadDate}</span>
                                </div>
                                <div class="member-actions">
                                    <button class="btn-secondary" onclick="downloadFile(${file.id})" style="padding: 0.5rem 1rem; font-size: 0.85rem;" aria-label="Baixar arquivo ${escapeHtml(file.original_name)}">
                                        <i class="fa-solid fa-download"></i> Baixar
                                    </button>
                                    <button class="btn-del-member" onclick="deleteFile(${file.id})" style="padding: 0.5rem 1rem; font-size: 0.85rem;" aria-label="Excluir arquivo ${escapeHtml(file.original_name)}">
                                        <i class="fa-solid fa-trash"></i> Excluir
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }

            if (filesCount) {
                filesCount.textContent = `${data.length} Arquivo${data.length !== 1 ? 's' : ''}`;
            }
        }
    } catch (error) {
        console.error('Erro ao carregar arquivos:', error);
    }
}

function getFileIcon(mimeType) {
    if (mimeType.includes('image')) return 'fa-solid fa-image';
    if (mimeType.includes('pdf')) return 'fa-solid fa-file-pdf';
    if (mimeType.includes('word') || mimeType.includes('doc')) return 'fa-solid fa-file-word';
    if (mimeType.includes('text')) return 'fa-solid fa-file-lines';
    if (mimeType.includes('zip')) return 'fa-solid fa-file-zipper';
    return 'fa-solid fa-file';
}

async function downloadFile(fileId, originalName) {
    try {
        const response = await fetchWithAuth(`/api/files/${fileId}/download`);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `Erro HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = originalName || `arquivo_${fileId}`;
        document.body.appendChild(a);
        a.click();

        window.URL.revokeObjectURL(url);
        a.remove();
    } catch (error) {
        console.error('Erro no download:', error);
        alert(`Falha ao baixar arquivo: ${error.message}`);
    }
}

async function deleteFile(fileId) {
    if (!confirm('Tem certeza que deseja excluir este arquivo?')) {
        return;
    }

    try {
        const response = await fetchWithAuth(`/api/files/${fileId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (response.ok) {
            showToast(data.message, 'success');
            loadStorageInfo();
            loadFiles();
        } else {
            showToast(data.message || 'Erro ao excluir arquivo.', 'error');
        }
    } catch (error) {
        console.error('Erro ao excluir arquivo:', error);
        showToast('Erro ao excluir arquivo.', 'error');
    }
}

function saveDemandsLocal() {
    localStorage.setItem('klweb_demands', JSON.stringify(state.demands));
}

function saveContactsLocal() {
    localStorage.setItem('klweb_contacts', JSON.stringify(state.contacts));
}

function saveEventsLocal() {
    localStorage.setItem('klweb_events', JSON.stringify(state.events));
}

function saveAutomationsLocal() {
    localStorage.setItem('klweb_automations', JSON.stringify(state.automations));
}

// ==================== VALIDAÇÃO DE DUPLICIDADE ====================
function checkEmailExists(email) {
    const clean = email.toLowerCase().trim();
    return state.users_db.some(u => u.email.toLowerCase().trim() === clean);
}

function checkPhoneExists(phone) {
    if (!phone) return false;
    const clean = phone.replace(/\D/g, '');
    if (!clean) return false;
    return state.users_db.some(u => (u.phone || '').replace(/\D/g, '') === clean);
}

// ==================== SISTEMA DE TOASTS ====================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-circle-check';
    if (type === 'error') icon = 'fa-triangle-exclamation';

    toast.innerHTML = `
        <i class="fa-solid ${icon}"></i>
        <div style="flex: 1; font-size: 0.88rem;">${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

// ==================== AUTENTICAÇÃO & REGISTRO ====================
function initAuth() {
    const form = document.getElementById('auth-form');
    const toggle = document.getElementById('auth-toggle');
    const forgotLink = document.getElementById('link-forgot-password');

    const registrationTypeInputs = document.querySelectorAll('input[name="registration-type"]');
    registrationTypeInputs.forEach(input => {
        input.addEventListener('change', handleRegistrationTypeChange);
    });

    const companyInput = document.getElementById('auth-company');
    if (companyInput) {
        companyInput.addEventListener('blur', validateCompanyName);
        companyInput.addEventListener('input', () => {
            document.getElementById('company-name-status').textContent = '';
        });
    }

    const codeInput = document.getElementById('auth-company-code');
    if (codeInput) {
        codeInput.addEventListener('blur', validateCompanyCode);
        codeInput.addEventListener('input', () => {
            document.getElementById('company-code-status').textContent = '';
        });
    }

    if (form) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();

            const email = document.getElementById('auth-email').value.trim();
            const password = document.getElementById('auth-password').value;

            // Validação de formato de e-mail: o botão dispara este submit via dispatchEvent()
            // manual (não um clique real em type="submit"), o que pula a validação nativa do
            // navegador mesmo com type="email" no input — por isso essa checagem é manual aqui.
            const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!EMAIL_REGEX.test(email)) {
                showAuthError('Informe um e-mail válido (ex: nome@empresa.com).');
                return;
            }

            if (state.isRegisterMode) {
                const name = document.getElementById('auth-name').value.trim();
                const phone = document.getElementById('auth-phone').value.trim();
                const lgpdConsent = document.getElementById('auth-lgpd').checked;

                if (!name || !phone || !lgpdConsent) {
                    showAuthError('Preencha os campos obrigatórios e aceite a política de privacidade.');
                    return;
                }

                const registrationType = document.querySelector('input[name="registration-type"]:checked')?.value || 'personal';
                let companyName = null;
                let companyCode = null;

                if (registrationType === 'personal') {
                    companyName = document.getElementById('auth-company').value.trim();
                    if (!companyName) {
                        showAuthError('Informe o nome da empresa.');
                        return;
                    }
                } else {
                    companyCode = document.getElementById('auth-company-code').value.trim().toUpperCase();
                    if (!companyCode) {
                        showAuthError('Informe o código da empresa.');
                        return;
                    }
                }

                try {
                    const response = await fetch('/api/auth/register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, email, phone, password, lgpdConsent, companyName, companyCode })
                    });
                    const data = await response.json();

                    if (!response.ok) {
                        showAuthError(data.message || data.error || 'Não foi possível concluir o cadastro.');
                        return;
                    }

                    state.isRegisterMode = false;
                    updateAuthMode();
                    showToast(data.message || 'Cadastro realizado com sucesso. Faça login para continuar.', 'success');

                    // Verificar se há um plano selecionado e redirecionar para login
                    const selectedPlan = localStorage.getItem('klweb_selected_plan');
                    if (selectedPlan) {
                        // Já mostra o email no campo e foca no password
                        document.getElementById('auth-password').focus();
                    }
                } catch (error) {
                    showAuthError('Erro de conexão com o servidor.');
                }
                return;
            }

            await handleLogin(email, password);
        });
    }

    if (toggle) {
        toggle.addEventListener('click', () => {
            state.isRegisterMode = !state.isRegisterMode;
            updateAuthMode();
        });
    }

    if (forgotLink) {
        forgotLink.addEventListener('click', openForgotPasswordModal);
    }

    updateAuthMode();
}

function updateAuthMode() {
    const isRegisterMode = state.isRegisterMode;
    const fields = ['group-name', 'group-registration-type', 'group-company-name', 'group-company-code', 'group-role', 'group-phone', 'group-lgpd'];
    const title = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    const button = document.getElementById('auth-btn');
    const toggle = document.getElementById('auth-toggle');

    fields.forEach(id => {
        const field = document.getElementById(id);
        if (field) field.style.display = isRegisterMode ? 'block' : 'none';
    });

    if (title) title.innerText = isRegisterMode ? 'Criar conta na KL Web' : 'Entrar na KL Web';
    if (subtitle) subtitle.innerText = isRegisterMode ? 'Crie seu workspace empresarial.' : 'Acesse seu painel empresarial com IA autônoma & LGPD';
    if (button) button.innerHTML = isRegisterMode
        ? '<i class="fa-solid fa-user-plus"></i> <span>Cadastrar</span>'
        : '<i class="fa-solid fa-right-to-bracket"></i> <span>Entrar</span>';
    if (toggle) toggle.innerHTML = isRegisterMode
        ? 'Já possui uma conta? <span>Entrar aqui</span>'
        : 'Não possui uma conta? <span>Cadastre sua empresa aqui</span>';

    if (isRegisterMode) {
        handleRegistrationTypeChange();
    }
}

function handleRegistrationTypeChange() {
    const registrationType = document.querySelector('input[name="registration-type"]:checked')?.value || 'personal';
    const companyGroup = document.getElementById('group-company-name');
    const codeGroup = document.getElementById('group-company-code');
    const roleGroup = document.getElementById('group-role');

    if (registrationType === 'personal') {
        companyGroup.style.display = 'block';
        codeGroup.style.display = 'none';
        roleGroup.style.display = 'block';
    } else {
        companyGroup.style.display = 'none';
        codeGroup.style.display = 'block';
        roleGroup.style.display = 'none';
    }
}

async function validateCompanyName() {
    const companyName = document.getElementById('auth-company').value.trim();
    const statusEl = document.getElementById('company-name-status');

    if (!companyName) {
        statusEl.textContent = '';
        return;
    }

    statusEl.textContent = 'Verificando...';
    statusEl.style.color = 'var(--text-secondary)';

    try {
        const response = await fetch(`/api/company/check-name?name=${encodeURIComponent(companyName)}`);
        const data = await response.json();

        if (data.exists) {
            statusEl.textContent = data.message;
            statusEl.style.color = '#ef4444';
        } else {
            statusEl.textContent = data.message;
            statusEl.style.color = '#10b981';
        }
    } catch (error) {
        statusEl.textContent = 'Erro ao verificar nome da empresa.';
        statusEl.style.color = '#ef4444';
    }
}

async function validateCompanyCode() {
    const companyCode = document.getElementById('auth-company-code').value.trim().toUpperCase();
    const statusEl = document.getElementById('company-code-status');

    if (!companyCode) {
        statusEl.textContent = '';
        return;
    }

    statusEl.textContent = 'Verificando...';
    statusEl.style.color = 'var(--text-secondary)';

    try {
        const response = await fetch(`/api/company/validate-code?code=${encodeURIComponent(companyCode)}`);
        const data = await response.json();

        if (data.valid) {
            statusEl.textContent = `Código válido! Empresa: ${data.company.name}`;
            statusEl.style.color = '#10b981';
        } else {
            statusEl.textContent = data.message;
            statusEl.style.color = '#ef4444';
        }
    } catch (error) {
        statusEl.textContent = 'Erro ao validar código.';
        statusEl.style.color = '#ef4444';
    }
}

function showAuthError(message) {
    const errorBox = document.getElementById('auth-error-box');
    const errorMsg = document.getElementById('auth-error-msg');
    if (errorBox && errorMsg) {
        errorMsg.innerText = message;
        errorBox.style.display = 'flex';
    }
    showToast(message, 'error');
}

function initWelcomePointerBackground() {
    const welcomeScreen = document.getElementById('welcome-screen');
    const glow = document.querySelector('#welcome-screen .welcome-glow');
    if (!welcomeScreen || !glow || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // window.innerWidth/innerHeight obrigam o navegador a recalcular o layout (reflow forçado).
    // Por isso só são lidos na primeira interação, e não durante o carregamento da página.
    const restX = () => window.innerWidth * 0.5;
    const restY = () => window.innerHeight * 0.28;
    let x = null;
    let y = null;
    let targetX = 0;
    let targetY = 0;
    let frame = null;

    const step = () => {
        x += (targetX - x) * 0.14;
        y += (targetY - y) * 0.14;
        glow.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        frame = Math.abs(targetX - x) > 0.5 || Math.abs(targetY - y) > 0.5 ? requestAnimationFrame(step) : null;
    };
    const follow = (clientX, clientY) => {
        if (x === null) { x = restX(); y = restY(); }
        targetX = clientX;
        targetY = clientY;
        if (frame === null) frame = requestAnimationFrame(step);
    };
    const ripple = (clientX, clientY) => {
        if (welcomeScreen.querySelectorAll('.welcome-ripple').length >= 3) return;
        const el = document.createElement('div');
        el.className = 'welcome-ripple';
        el.style.setProperty('--rx', `${clientX}px`);
        el.style.setProperty('--ry', `${clientY}px`);
        el.addEventListener('animationend', () => el.remove(), { once: true });
        welcomeScreen.appendChild(el);
    };

    welcomeScreen.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'mouse') follow(event.clientX, event.clientY);
    }, { passive: true });
    welcomeScreen.addEventListener('pointerleave', (event) => {
        if (event.pointerType === 'mouse') follow(restX(), restY());
    }, { passive: true });

    // Em toque o navegador cancela os pointer events ao rolar; touchmove continua durante a rolagem.
    welcomeScreen.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        follow(touch.clientX, touch.clientY);
        ripple(touch.clientX, touch.clientY);
    }, { passive: true });
    welcomeScreen.addEventListener('touchmove', (event) => {
        const touch = event.touches[0];
        follow(touch.clientX, touch.clientY);
    }, { passive: true });
}

function showWelcomeScreen() {
    const welcomeContainer = document.getElementById('welcome-screen');
    const authContainer = document.getElementById('auth-screen');
    const appContainer = document.getElementById('app-screen');

    if (welcomeContainer) welcomeContainer.style.display = 'block';
    if (authContainer) authContainer.style.display = 'none';
    if (appContainer) appContainer.style.display = 'none';

    const supportButton = document.getElementById('support-button');
    const supportBadge = document.getElementById('support-chat-count');
    if (supportButton) supportButton.style.display = 'none';
    if (supportBadge) supportBadge.style.display = 'none';
}

function showAuthScreen() {
    const authContainer = document.getElementById('auth-screen');
    const appContainer = document.getElementById('app-screen');
    const welcomeContainer = document.getElementById('welcome-screen');

    if (welcomeContainer) welcomeContainer.style.display = 'none';
    if (authContainer) authContainer.style.display = 'flex';
    if (appContainer) appContainer.style.display = 'none';

    const form = document.getElementById('auth-form');
    if (form) form.reset();
}

function showMainApp() {
    const authContainer = document.getElementById('auth-screen');
    const appContainer = document.getElementById('app-screen');
    const welcomeContainer = document.getElementById('welcome-screen');

    if (welcomeContainer) welcomeContainer.style.display = 'none';
    if (authContainer) authContainer.style.display = 'none';
    if (appContainer) appContainer.style.display = 'block';
}

function logout() {
    if (socket) { socket.disconnect(); socket = null; }
    localStorage.removeItem('klweb_token');
    localStorage.removeItem('klweb_user');
    state.token = null;
    state.user = null;
    state.isRegisterMode = false;
    updateAuthMode();
    showWelcomeScreen();

    const supportButton = document.getElementById('support-button');
    const supportBadge = document.getElementById('support-chat-count');
    if (supportButton) supportButton.style.display = 'none';
    if (supportBadge) supportBadge.style.display = 'none';
}

async function handleLogin(email, password) {
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            showAuthError(data.message || data.error || 'E-mail ou senha incorretos.');
            return;
        }

        // Conta com Google Authenticator: a senha estava certa, falta o código.
        if (data.requires2FA) {
            openLogin2FAModal(data.twoFactorToken);
            return;
        }

        completeLogin(data);
    } catch (err) {
        console.error('Erro na requisição:', err);
        showAuthError('Erro de conexão com o servidor.');
    }
}

function completeLogin(data) {
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('klweb_token', data.token);
    localStorage.setItem('klweb_user', JSON.stringify(data.user));
    connectSupportSocket();
    showToast(`Bem-vindo de volta, ${data.user.name || 'usuário'}!`, 'success');
    showApp();

    const supportButton = document.getElementById('support-button');
    if (supportButton) supportButton.style.display = 'flex';

    // Verificar se há um plano selecionado para redirecionar
    const selectedPlan = localStorage.getItem('klweb_selected_plan');
    if (selectedPlan) {
        // Remover o plano selecionado após usar
        localStorage.removeItem('klweb_selected_plan');

        // Redirecionar para aba de planos após um pequeno delay
        setTimeout(() => {
            if (typeof switchTab === 'function') {
                switchTab('plans');
                showToast(`Selecione o plano ${selectedPlan} para assinar!`, 'info');
            }
        }, 500);
    }
}

// ==================== 2FA (GOOGLE AUTHENTICATOR) ====================
let pendingTwoFactorToken = null;
let twoFactorBackupCodes = [];

function openLogin2FAModal(token) {
    pendingTwoFactorToken = token;
    const input = document.getElementById('login-2fa-code');
    input.value = '';
    document.getElementById('modal-login-2fa').style.display = 'flex';
    setTimeout(() => input.focus(), 50);
}

function closeLogin2FAModal() {
    pendingTwoFactorToken = null;
    document.getElementById('modal-login-2fa').style.display = 'none';
}

async function submitLogin2FA() {
    const code = document.getElementById('login-2fa-code').value.trim();
    if (!code) {
        showToast('Digite o código do aplicativo.', 'error');
        return;
    }

    const btn = document.getElementById('btn-login-2fa');
    btn.disabled = true;
    try {
        const response = await fetch('/api/auth/2fa/totp/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ twoFactorToken: pendingTwoFactorToken, code })
        });
        const data = await response.json();

        if (!response.ok) {
            showToast(data.message || 'Código inválido.', 'error');
            if (data.restart) closeLogin2FAModal(); // token pendente expirou: refaz o login
            return;
        }

        closeLogin2FAModal();
        completeLogin(data);
    } catch (err) {
        console.error('Erro no login 2FA:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function refreshTwoFactorStatus() {
    const label = document.getElementById('profile-2fa-status');
    const btnOn = document.getElementById('btn-2fa-enable');
    const btnOff = document.getElementById('btn-2fa-disable');
    if (!label) return;

    btnOn.style.display = 'none';
    btnOff.style.display = 'none';
    label.textContent = 'Carregando...';
    label.style.color = 'var(--text-secondary)';

    try {
        const response = await fetchWithAuth('/api/auth/2fa/totp/status');
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'erro');

        if (data.enabled) {
            label.textContent = `Ativada · ${data.backupCodesRemaining} código(s) de backup restante(s)`;
            label.style.color = '#10b981';
            btnOff.style.display = 'inline-block';
        } else {
            label.textContent = 'Desativada';
            btnOn.style.display = 'inline-block';
        }
    } catch (err) {
        label.textContent = 'Não foi possível carregar o status.';
    }
}

async function openTwoFactorSetup() {
    try {
        const response = await fetchWithAuth('/api/auth/2fa/totp/setup', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.message || 'Não foi possível iniciar a configuração.', 'error');
            return;
        }

        document.getElementById('twofa-secret').textContent = data.secret;
        document.getElementById('twofa-confirm-code').value = '';

        const qrBox = document.getElementById('twofa-qr');
        qrBox.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
            new QRCode(qrBox, { text: data.otpauthUrl, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        } else {
            qrBox.textContent = 'QR Code indisponível. Use a chave abaixo.';
            qrBox.style.color = '#0f172a';
        }

        document.getElementById('twofa-step-scan').style.display = 'block';
        document.getElementById('twofa-step-backup').style.display = 'none';
        document.getElementById('btn-2fa-setup-cancel').style.display = 'inline-block';
        document.getElementById('btn-2fa-setup-confirm').style.display = 'inline-block';
        document.getElementById('btn-2fa-setup-done').style.display = 'none';
        document.getElementById('modal-2fa-setup').style.display = 'flex';
    } catch (err) {
        console.error('Erro ao iniciar 2FA:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

async function confirmTwoFactorSetup() {
    const code = document.getElementById('twofa-confirm-code').value.trim();
    if (!code) {
        showToast('Digite o código de 6 dígitos do aplicativo.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/auth/2fa/totp/enable', {
            method: 'POST',
            body: JSON.stringify({ code })
        });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.message || 'Código incorreto.', 'error');
            return;
        }

        twoFactorBackupCodes = data.backupCodes || [];
        const list = document.getElementById('twofa-backup-list');
        list.innerHTML = '';
        twoFactorBackupCodes.forEach((c) => {
            const span = document.createElement('span');
            span.textContent = c;
            span.style.cssText = 'padding: 0.4rem; background: var(--bg-input); border-radius: 6px;';
            list.appendChild(span);
        });

        document.getElementById('twofa-step-scan').style.display = 'none';
        document.getElementById('twofa-step-backup').style.display = 'block';
        document.getElementById('btn-2fa-setup-cancel').style.display = 'none';
        document.getElementById('btn-2fa-setup-confirm').style.display = 'none';
        document.getElementById('btn-2fa-setup-done').style.display = 'inline-block';
        showToast('Verificação em duas etapas ativada!', 'success');
    } catch (err) {
        console.error('Erro ao ativar 2FA:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

function copyTwoFactorBackupCodes() {
    const text = twoFactorBackupCodes.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showToast('Códigos copiados!', 'success'))
            .catch(() => showToast('Não foi possível copiar. Anote os códigos manualmente.', 'error'));
    } else {
        showToast('Seu navegador não permite copiar. Anote os códigos manualmente.', 'error');
    }
}

function closeTwoFactorSetup() {
    document.getElementById('modal-2fa-setup').style.display = 'none';
    twoFactorBackupCodes = [];
    document.getElementById('twofa-backup-list').innerHTML = '';
    document.getElementById('twofa-qr').innerHTML = '';
    document.getElementById('twofa-secret').textContent = '';
    refreshTwoFactorStatus();
}

function openTwoFactorDisable() {
    document.getElementById('twofa-disable-pass').value = '';
    document.getElementById('twofa-disable-code').value = '';
    document.getElementById('modal-2fa-disable').style.display = 'flex';
}

function closeTwoFactorDisable() {
    document.getElementById('modal-2fa-disable').style.display = 'none';
}

async function confirmTwoFactorDisable() {
    const password = document.getElementById('twofa-disable-pass').value;
    const code = document.getElementById('twofa-disable-code').value.trim();
    if (!password || !code) {
        showToast('Informe a senha e o código.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/auth/2fa/totp/disable', {
            method: 'POST',
            body: JSON.stringify({ password, code })
        });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.message || 'Não foi possível desativar.', 'error');
            return;
        }
        closeTwoFactorDisable();
        showToast('Verificação em duas etapas desativada.', 'success');
        refreshTwoFactorStatus();
    } catch (err) {
        console.error('Erro ao desativar 2FA:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

async function fetchWithAuth(url, options = {}) {
    const token = state.token || localStorage.getItem('klweb_token');

    if (!token) {
        return { ok: false, status: 401, json: async () => ({ error: 'Sem token' }) };
    }

    // Em uploads (FormData) o navegador precisa gerar sozinho o Content-Type
    // multipart com o boundary; forçar application/json quebra o parse no servidor.
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;

    const headers = {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {}),
        'Authorization': `Bearer ${token}`
    };

    try {
        const response = await fetch(getApiUrl(url), { ...options, headers });

        if (response.status === 401) {
            const body = await response.clone().json().catch(() => null);
            if (body && body.code === 'SESSION_REVOKED') {
                logout();
                showToast('Sua sessão foi encerrada (e-mail da conta alterado). Entre novamente.', 'error');
            }
        }

        if (response.status === 401 || (response.status === 403 && url.includes('/api/auth/me'))) {
            console.warn('Sessão rejeitada pela API:', url);
            if (url.includes('/api/auth/me') || url.includes('/api/auth/verify')) {
                logout();
                showToast('Sua sessão expirou. Entre novamente.', 'error');
            }
        }

        return response;
    } catch (error) {
        console.error('Erro na requisição autenticada:', error);
        throw error;
    }
}

// ==================== PERFIL DO USUÁRIO ====================
// Preenche a aba "Meu Perfil" a partir de state.user. Chamada por openProfileModal() e por switchTab('profile'):
// antes, abrir pelo menu lateral só trocava a aba e os campos ficavam vazios.
function populateProfileForm(keepTyping) {
    const u = state && state.user;
    if (!u) return;
    const set = (id, value, isText) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (keepTyping && document.activeElement === el) return; // não sobrescreve o que a pessoa está digitando
        if (isText) el.innerText = value; else el.value = value;
    };
    set('profile-modal-avatar', (u.name || 'U').charAt(0).toUpperCase(), true);
    set('profile-modal-name-display', u.name || '', true);
    set('profile-modal-role-badge', u.role || 'Funcionário', true);
    set('profile-company-input', u.companyName || 'Sua Empresa');
    set('profile-plan-input', (u.planTier || 'BASICO').replace('_', ' '));
    set('profile-name-input', u.name || '');
    set('profile-email-input', u.email || '');
    set('profile-phone-input', u.phone || '');
    if (!keepTyping) {
        const pass = document.getElementById('profile-pass-input');
        if (pass) pass.value = '';
    }
}

// Reconsulta /api/auth/me e reaplica no formulário (caso o state salvo no navegador esteja velho/incompleto).
function syncProfileFromServer() {
    if (typeof refreshAuthenticatedUser !== 'function') return;
    refreshAuthenticatedUser().then(() => {
        const pane = document.getElementById('tab-profile');
        if (pane && pane.classList.contains('active')) populateProfileForm(true);
    });
}

function openProfileModal() {
    if (!state.user) return;
    populateProfileForm();
    switchTab('profile');
    refreshTwoFactorStatus();
}

function closeProfileModal() { }

async function saveProfileChanges() {
    const newName = document.getElementById('profile-name-input').value.trim();
    const emailInput = document.getElementById('profile-email-input');
    const newPhone = document.getElementById('profile-phone-input').value.trim();
    const passInput = document.getElementById('profile-pass-input');

    if (!newName) {
        showToast('O nome não pode ficar vazio.', 'error');
        return;
    }

    // E-mail e senha exigem a senha atual e têm fluxo próprio em Configurações.
    // Antes este botão só gravava no navegador: o site mostrava o e-mail novo, mas o
    // servidor (e o Painel Master) continuavam com o antigo.
    const wantsEmailOrPassword =
        emailInput.value.trim().toLowerCase() !== String(state.user.email || '').toLowerCase() ||
        !!passInput.value.trim();

    try {
        const response = await fetchWithAuth('/api/user/profile', {
            method: 'PUT',
            body: JSON.stringify({ name: newName, phone: newPhone })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            showToast(data.message || 'Não foi possível salvar o perfil.', 'error');
            return;
        }

        state.user.name = data.user.name;
        state.user.phone = data.user.phone || '';
        localStorage.setItem('klweb_user', JSON.stringify(state.user));
        updateUserProfileUI();

        if (wantsEmailOrPassword) {
            emailInput.value = state.user.email;
            passInput.value = '';
            showToast('Nome e telefone salvos. Para trocar e-mail ou senha use Configurações: lá pedimos a sua senha atual.', 'info');
        } else {
            showToast('Perfil atualizado com sucesso!', 'success');
        }
    } catch (err) {
        console.error('Erro ao salvar perfil:', err);
        showToast('Erro ao conectar com o servidor.', 'error');
    }
}

// ==================== RECUPERAÇÃO DE SENHA ====================
function checkResetPasswordUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const resetToken = urlParams.get('reset_token');

    if (resetToken) {
        document.getElementById('reset-token-input').value = resetToken;
        document.getElementById('modal-reset-password').style.display = 'flex';
    }
}

function openForgotPasswordModal() {
    document.getElementById('modal-forgot-password').style.display = 'flex';
    document.getElementById('forgot-email').focus();
}

function closeForgotPasswordModal() {
    document.getElementById('modal-forgot-password').style.display = 'none';
    document.getElementById('forgot-email').value = '';
}

async function submitForgotPassword() {
    const email = document.getElementById('forgot-email').value.trim();

    if (!email || !email.includes('@')) {
        showToast('Informe um endereço de e-mail válido.', 'error');
        return;
    }

    showToast('Enviando solicitação...', 'info');

    try {
        const response = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast('Link de recuperação enviado para o seu e-mail com sucesso.', 'success');
            closeForgotPasswordModal();
        } else {
            showToast(data.message || 'Erro ao solicitar redefinição de senha.', 'error');
        }
    } catch (error) {
        console.error('Erro de conexão com o servidor:', error);
        showToast('Erro ao conectar com o servidor. Tente novamente.', 'error');
    }
}

async function submitResetPassword() {
    const newPassword = document.getElementById('reset-new-password').value.trim();
    const confirmPassword = document.getElementById('reset-confirm-password').value.trim();
    const resetToken = document.getElementById('reset-token-input').value.trim();

    if (!newPassword || newPassword.length < 4) {
        showToast('A nova senha deve conter pelo menos 4 caracteres.', 'error');
        return;
    }

    if (newPassword !== confirmPassword) {
        showToast('As senhas digitadas não coincidem.', 'error');
        return;
    }

    if (!resetToken) {
        showToast('Token de redefinição inválido.', 'error');
        return;
    }

    showToast('Processando redefinição...', 'info');

    try {
        const response = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: resetToken, newPassword })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast('Senha redefinida com sucesso! Faça login com sua nova senha.', 'success');
            document.getElementById('modal-reset-password').style.display = 'none';
            setTimeout(() => {
                openAuthentication('login');
            }, 2000);
        } else {
            showToast(data.message || 'Erro ao redefinir senha.', 'error');
        }
    } catch (error) {
        console.error('Erro de conexão com o servidor:', error);
        showToast('Erro ao conectar com o servidor. Tente novamente.', 'error');
    }
}

// ==================== EXIBIR PAINEL PRINCIPAL & ATUALIZAR EMPRESA ====================
// Vincula o token de notificações push (FCM) do app Android ao usuário logado.
// window.KLE_FCM_TOKEN só existe dentro do app mobile; no navegador comum a função não faz nada.
async function vincularTokenMobile() {
    if (!window.KLE_FCM_TOKEN) return;
    const authToken = state.token || localStorage.getItem('klweb_token');
    if (!authToken) return;
    try {
        const res = await fetch('/api/user/fcm-token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ token: window.KLE_FCM_TOKEN })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        console.log('Notificações Mobile configuradas!');
    } catch (err) {
        console.error('Erro ao registrar token mobile:', err);
    }
}

function showApp() {
    const welcomeContainer = document.getElementById('welcome-screen');
    if (welcomeContainer) welcomeContainer.style.display = 'none';
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-screen').style.display = 'flex';

    updateUserProfileUI();
    loadCompanyCode();
    loadPendingRequests();
    loadCompanyMembers();
    loadDemands();
    loadContacts();
    loadEvents();
    loadAutomations();
    loadNotificationsFromBackend();
    initChat();
    loadStorageInfo();
    loadFiles();
    initSupportChat();
    vincularTokenMobile();

    const pendingSection = document.getElementById('pending-requests-section');
    if (pendingSection && state.user) {
        pendingSection.style.display = ['OWNER', 'MANAGER'].includes(state.user.role) ? 'block' : 'none';
    }
}

function updateUserProfileUI() {
    if (!state.user) return;

    const navMaster = document.getElementById('nav-master');
    if (navMaster) navMaster.style.display = canSeeMasterPanel() ? '' : 'none';
    const masterLockButton = document.getElementById('master-lock-button');
    if (masterLockButton) {
        masterLockButton.style.display = canSeeMasterPanel() ? 'inline-flex' : 'none';
    }

    const companyName = state.user.companyName || state.user.company_name || 'Minha Empresa';

    const brandHeader = document.getElementById('header-company-brand');
    const topCompanyTitle = document.getElementById('top-company-title');
    const authBrandName = document.getElementById('auth-brand-name');

    if (brandHeader) brandHeader.innerText = companyName;
    if (topCompanyTitle) topCompanyTitle.innerText = companyName;
    if (authBrandName) authBrandName.innerText = companyName.toUpperCase();

    const welcomeEl = document.getElementById('welcome-message');
    if (welcomeEl) {
        welcomeEl.innerText = `Bem-vindo, ${state.user.name}! (${state.user.role || 'Membro'})`;
    }

    const sideName = document.getElementById('sidebar-user-name');
    const sideEmail = document.getElementById('sidebar-user-email');
    const sideAvatar = document.getElementById('sidebar-user-avatar');
    const sideCompanySub = document.getElementById('sidebar-company-sub');
    const sidePlanPill = document.getElementById('sidebar-plan-pill');

    if (sideName) sideName.innerText = state.user.name;
    if (sideEmail) sideEmail.innerText = state.user.email;
    if (sideAvatar) sideAvatar.innerText = state.user.name.charAt(0).toUpperCase();
    if (sideCompanySub) sideCompanySub.innerText = `${companyName} (${state.user.role || 'Membro'})`;
    if (sidePlanPill) sidePlanPill.innerText = (state.user.planTier || 'BASICO').replace('_', ' ');

    updatePlanCardsUI();
}

// ==================== MENU LATERAL EM CELULAR (Fase 5) ====================
// A sidebar (ver style.css) só expandia com :hover, que não existe em touchscreen — sem
// isso, o menu ficava travado mostrando só ícones no celular, sem jeito de ler os rótulos.
function toggleMobileSidebar() {
    document.getElementById('app-sidebar')?.classList.toggle('sidebar-open');
    document.getElementById('sidebar-backdrop')?.classList.toggle('active');
}

function closeMobileSidebar() {
    document.getElementById('app-sidebar')?.classList.remove('sidebar-open');
    document.getElementById('sidebar-backdrop')?.classList.remove('active');
}

// ==================== NAVEGAÇÃO DE ABAS ====================
function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-tab');
            switchTab(target);
        });
    });
}

function switchTab(tabId) {
    if (!tabId) return;
    closeMobileSidebar(); // navegar já fecha o menu, senão ele fica aberto cobrindo a tela

    const cleanId = tabId.replace(/^tab-/, '');
    if (cleanId === 'master' && !canSeeMasterPanel()) return;

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

    const navBtn = document.querySelector(`.nav-item[data-tab="${cleanId}"], .nav-item[data-tab="tab-${cleanId}"]`);
    const pane = document.getElementById(`tab-${cleanId}`);

    if (navBtn) navBtn.classList.add('active');
    if (pane) pane.classList.add('active');

    if (cleanId === 'profile') {
        populateProfileForm();
        syncProfileFromServer();
        if (typeof refreshTwoFactorStatus === 'function') refreshTwoFactorStatus();
    }
    if (cleanId === 'company') loadCompanyMembers();
    if (cleanId === 'crm') loadContacts();
    if (cleanId === 'kanban') {
        loadCompanyMembers();
        loadDemands();
    }
    if (cleanId === 'automations') loadAutomations();
    if (cleanId === 'feedback') loadFeedbacks();
    if (cleanId === 'support-dashboard') loadSupportChats();
    if (cleanId === 'analytics') loadAnalyticsData();
    if (cleanId === 'calendar') {
        loadEvents();
        renderCalendar();
    }
    if (cleanId === 'storage') {
        loadStorageInfo();
        loadFiles();
    }
    // A lista do Master ficava congelada desde a última vez que foi carregada; recarrega ao abrir a aba
    // para refletir e-mails/planos alterados pelos próprios usuários nesse meio-tempo.
    if (cleanId === 'master' && masterAuthenticated) loadMasterUsersList();
}

// ==================== KANBAN & DEMANDAS ====================
async function loadDemands() {
    try {
        const res = await fetch('/api/demands', {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });
        if (res.ok) {
            const serverDemands = await res.json();
            if (Array.isArray(serverDemands)) {
                state.demands = serverDemands;
                saveDemandsLocal();
            }
        }
    } catch (err) {
        console.warn('API indisponível, utilizando banco de dados local.');
    }
    renderKanban();
}

function filterKanban() {
    const query = (document.getElementById('kanban-search')?.value || '').toLowerCase();
    const priority = document.getElementById('kanban-priority-filter')?.value || 'ALL';
    const assigneeFilter = document.getElementById('kanban-assignee-filter')?.value || 'ALL';

    const filtered = state.demands.filter(d => {
        const matchText = (d.title || '').toLowerCase().includes(query) || (d.description || '').toLowerCase().includes(query);
        const matchPriority = priority === 'ALL' || d.priority === priority;

        let matchAssignee = true;
        if (assigneeFilter === 'MINE') {
            matchAssignee = (d.assigned_user_id === state.user.id) || (d.assigned_user_email === state.user.email);
        } else if (assigneeFilter !== 'ALL') {
            matchAssignee = (d.assigned_user_email === assigneeFilter) || (String(d.assigned_user_id) === assigneeFilter);
        }

        return matchText && matchPriority && matchAssignee;
    });

    renderKanban(filtered);
}

function renderKanban(demandsToRender = state.demands) {
    const cols = {
        TODO: [],
        IN_PROGRESS: [],
        URGENT: [],
        DONE: []
    };

    if (Array.isArray(demandsToRender)) {
        demandsToRender.forEach(d => {
            const status = d.status || 'TODO';
            if (cols[status]) {
                cols[status].push(d);
            } else {
                cols.TODO.push(d);
            }
        });
    }

    const elTodo = document.getElementById('cnt-todo');
    const elInProgress = document.getElementById('cnt-inprogress');
    const elUrgent = document.getElementById('cnt-urgent');
    const elDone = document.getElementById('cnt-done');

    if (elTodo) elTodo.innerText = cols.TODO.length;
    if (elInProgress) elInProgress.innerText = cols.IN_PROGRESS.length;
    if (elUrgent) elUrgent.innerText = cols.URGENT.length;
    if (elDone) elDone.innerText = cols.DONE.length;

    const bTodo = document.getElementById('badge-col-todo');
    const bProgress = document.getElementById('badge-col-inprogress');
    const bUrgent = document.getElementById('badge-col-urgent');
    const bDone = document.getElementById('badge-col-done');

    if (bTodo) bTodo.innerText = cols.TODO.length;
    if (bProgress) bProgress.innerText = cols.IN_PROGRESS.length;
    if (bUrgent) bUrgent.innerText = cols.URGENT.length;
    if (bDone) bDone.innerText = cols.DONE.length;

    Object.keys(cols).forEach(status => {
        const container = document.getElementById(`col-${status}`);
        if (!container) return;

        if (cols[status].length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 2rem 1rem; border: 1px dashed var(--border); border-radius: var(--radius-sm);">
                    Nenhuma demanda aqui
                </div>
            `;
            return;
        }

        const priorityTextMap = {
            'URGENTE': '🔥 Urgente / Crítica',
            'ALTA': '⚡ Alta Necessidade',
            'MEDIA': '📌 Média Necessidade',
            'BAIXA': '🟢 Baixa Necessidade'
        };

        container.innerHTML = cols[status].map(d => {
            const priorityClass = `priority-${d.priority || 'MEDIA'}`;
            const assigneeName = d.assigned_user_name || d.assigned_user_email;
            const labelPriority = priorityTextMap[d.priority] || d.priority || 'Média';

            const startDateFormatted = d.start_date ? new Date(d.start_date + 'T00:00:00').toLocaleDateString('pt-BR') : null;
            const dueDateFormatted = d.due_date ? new Date(d.due_date + 'T00:00:00').toLocaleDateString('pt-BR') : null;

            const checklistTotal = Number(d.checklist_total) || 0;
            const checklistDone = Number(d.checklist_done) || 0;
            const commentCount = Number(d.comment_count) || 0;

            return `
                <div class="kanban-card" data-demand-id="${d.id}" id="demand-card-${d.id}" onclick="openDemandDetail(${d.id})">
                    <div class="card-top-row">
                        <span class="priority-tag ${priorityClass}">
                            ${labelPriority}
                        </span>
                        <div style="display: flex; align-items: center; gap: 0.25rem;">
                            <button class="btn-card-assign" onclick="event.stopPropagation(); openReassignModal(${d.id})" title="Delegar / Transferir para funcionário" aria-label="Delegar demanda ${escapeHtml(d.title)}">
                                <i class="fa-solid fa-user-gear"></i>
                            </button>
                            <button class="btn-card-del" onclick="event.stopPropagation(); deleteDemand(${d.id})" title="Excluir Demanda" aria-label="Excluir demanda ${escapeHtml(d.title)}">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </div>
                    <h4>${escapeHtml(d.title)}</h4>
                    ${d.description ? `<p>${escapeHtml(d.description)}</p>` : ''}

                    <div style="margin: 0.45rem 0;">
                        ${assigneeName ? `
                            <span class="assignee-tag" title="Responsável: ${escapeHtml(assigneeName)}">
                                <i class="fa-solid fa-user-check"></i> ${escapeHtml(assigneeName)}
                            </span>
                        ` : `
                            <span style="font-size: 0.7rem; color: var(--text-muted);">
                                <i class="fa-regular fa-circle-user"></i> Sem responsável
                            </span>
                        `}
                    </div>

                    ${(startDateFormatted || dueDateFormatted) ? `
                        <div style="font-size: 0.72rem; color: var(--accent); background: rgba(255,255,255,0.03); padding: 0.35rem 0.5rem; border-radius: 4px; margin: 0.4rem 0; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                            ${startDateFormatted ? `<span><i class="fa-regular fa-play-circle"></i> Início: ${startDateFormatted}</span>` : ''}
                            ${dueDateFormatted ? `<span><i class="fa-regular fa-flag"></i> Fim: ${dueDateFormatted}</span>` : ''}
                        </div>
                    ` : ''}

                    ${(checklistTotal > 0 || commentCount > 0) ? `
                        <div class="card-badges-row">
                            ${checklistTotal > 0 ? `
                                <span class="card-badge ${checklistDone === checklistTotal ? 'card-badge-complete' : ''}" title="Checklist">
                                    <i class="fa-regular fa-square-check"></i> ${checklistDone}/${checklistTotal}
                                </span>
                            ` : ''}
                            ${commentCount > 0 ? `
                                <span class="card-badge" title="Comentários">
                                    <i class="fa-regular fa-comment"></i> ${commentCount}
                                </span>
                            ` : ''}
                        </div>
                    ` : ''}

                    <div class="card-footer">
                        <span><i class="fa-regular fa-user"></i> ${escapeHtml(d.creator_name || 'Gerência')}</span>
                        <span><i class="fa-regular fa-calendar"></i> ${d.created_at ? new Date(d.created_at).toLocaleDateString('pt-BR') : 'Hoje'}</span>
                    </div>
                </div>
            `;
        }).join('');
    });

    initKanbanSortable();
}

// Drag-and-drop do board via SortableJS (substitui o HTML5 drag nativo, que não funciona
// em touch/celular e não tinha reordenação suave). Mantemos uma instância por coluna e as
// destruímos a cada renderKanban(), já que o innerHTML das colunas é recriado do zero.
let kanbanSortableInstances = [];

function destroyKanbanSortable() {
    kanbanSortableInstances.forEach(s => { try { s.destroy(); } catch (e) { /* já destruído */ } });
    kanbanSortableInstances = [];
}

function initKanbanSortable() {
    destroyKanbanSortable();

    if (typeof Sortable === 'undefined') {
        console.warn('SortableJS não carregou — arraste de cards desativado nesta sessão.');
        return;
    }

    // Só quem pode de fato persistir a mudança (OWNER/MANAGER, ver PUT /api/demands/reorder)
    // ganha cards arrastáveis. Antes, qualquer papel podia arrastar e a UI "aceitava" o
    // movimento mesmo quando o servidor recusava (403) em silêncio — o card voltava ao
    // lugar certo só depois de um F5, parecendo um bug. Agora simplesmente não é arrastável.
    const canDragBoard = state.user && ['OWNER', 'MANAGER'].includes(state.user.role);
    if (!canDragBoard) return;

    document.querySelectorAll('.kanban-col .card-list').forEach(container => {
        const instance = Sortable.create(container, {
            group: 'kanban-board',
            animation: 150,
            ghostClass: 'kanban-card-ghost',
            chosenClass: 'kanban-card-chosen',
            dragClass: 'kanban-card-dragging',
            delay: 80,
            delayOnTouchOnly: true,
            touchStartThreshold: 3,
            onEnd: handleKanbanDragEnd
        });
        kanbanSortableInstances.push(instance);
    });
}

async function handleKanbanDragEnd(evt) {
    const movedId = Number(evt.item?.dataset?.demandId);
    const toColumn = evt.to.closest('.kanban-col');
    const fromColumn = evt.from.closest('.kanban-col');
    if (!movedId || !toColumn) return;

    const toStatus = toColumn.getAttribute('data-status');
    const fromStatus = fromColumn ? fromColumn.getAttribute('data-status') : toStatus;

    // Ordem atual (pós-arraste) das colunas afetadas, lida direto do DOM — o Sortable já
    // moveu os elementos, então isso reflete exatamente o que o usuário viu na tela.
    const order = {};
    order[toStatus] = Array.from(evt.to.children)
        .map(el => Number(el.dataset.demandId))
        .filter(Boolean);
    if (fromStatus !== toStatus) {
        order[fromStatus] = Array.from(evt.from.children)
            .map(el => Number(el.dataset.demandId))
            .filter(Boolean);
    }

    // Otimista: já reflete no estado local pra outras telas (dashboard, filtros) não
    // ficarem desatualizadas enquanto a requisição está em voo.
    const demand = state.demands.find(d => d.id === movedId);
    const previousStatus = demand ? demand.status : null;
    if (demand) {
        demand.status = toStatus;
        saveDemandsLocal();
    }

    try {
        const res = await fetch('/api/demands/reorder', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify({ movedId, toStatus, order })
        });
        if (!res.ok) throw new Error('Falha ao salvar a nova ordem.');
        loadAnalyticsData();
    } catch (err) {
        console.warn('Não foi possível salvar o arraste no servidor, revertendo:', err);
        if (demand) demand.status = previousStatus;
        showToast('Não deu pra salvar essa mudança no board. Desfazendo...', 'error');
        await loadDemands();
    }
}

// ==================== BOARD EM TEMPO REAL (Socket.IO) ====================
// Registrado uma vez por conexão de socket (ver connectSupportSocket). O servidor manda
// esses eventos pra sala 'company_<id>' sempre que /api/demands muda algo (ver server.js:
// broadcastBoard) — inclusive de volta pra quem fez a ação, o que é proposital: é assim que
// o estado local (state.demands) aprende a ordem final que o servidor gravou.
function registerBoardSocketListeners(socket) {
    if (!socket) return;

    socket.on('board_demand_created', (demand) => {
        if (!demand || state.demands.some(d => d.id === demand.id)) return;
        state.demands.push(demand);
        saveDemandsLocal();
        renderKanban();
        loadAnalyticsData();
    });

    socket.on('board_demand_updated', (payload) => {
        const demand = state.demands.find(d => d.id === payload.id);
        if (!demand) return;
        demand.status = payload.status;
        demand.priority = payload.priority;
        demand.completed_at = payload.completed_at;
        saveDemandsLocal();
        renderKanban();
        loadAnalyticsData();
        notifyRemoteBoardChange(payload.byUserId, payload.byUserName, 'atualizou um card');
    });

    socket.on('board_reordered', (payload) => {
        applyBoardOrder(payload.order);
        saveDemandsLocal();
        renderKanban();
        loadAnalyticsData();
        notifyRemoteBoardChange(payload.byUserId, payload.byUserName, 'moveu um card');
    });

    socket.on('board_demand_deleted', (payload) => {
        const idx = state.demands.findIndex(d => d.id === payload.id);
        if (idx === -1) return;
        state.demands.splice(idx, 1);
        saveDemandsLocal();
        renderKanban();
        loadAnalyticsData();
    });

    // Checklist/comentário mudou em algum card (Fase 3). Só precisa recarregar a lista de
    // demandas pra atualizar os badges (2/5, 💬3) no board — e, se por acaso essa pessoa
    // estiver com o MESMO card aberto no modal de detalhe, atualiza o modal também.
    socket.on('board_checklist_changed', (payload) => {
        loadDemands();
        if (currentDetailDemandId && payload.demandId === currentDetailDemandId) {
            refreshOpenDemandDetailOnly();
        }
    });

    socket.on('board_comment_added', (payload) => {
        loadDemands();
        if (currentDetailDemandId && payload.demandId === currentDetailDemandId) {
            refreshOpenDemandDetailOnly();
        }
        if (payload.comment && (!state.user || payload.comment.user_id !== state.user.id)) {
            showToast(`${payload.comment.user_name || 'Alguém'} comentou em um card.`, 'info');
        }
    });
}

// Recarrega só o modal de detalhe (sem chamar loadDemands de novo, pra não duplicar a
// requisição já feita por quem chamou esta função).
async function refreshOpenDemandDetailOnly() {
    if (!currentDetailDemandId) return;
    try {
        const res = await fetchWithAuth(`/api/demands/${currentDetailDemandId}`);
        if (res.ok) {
            const demand = await res.json();
            if (currentDetailDemandId === demand.id) renderDemandDetail(demand);
        }
    } catch (err) { /* silencioso */ }
}

// Reordena state.demands conforme os ids que vieram do servidor (já na ordem final gravada
// no banco). Só toca nas demandas cujo id apareceu em alguma das colunas do payload — as
// demais mantêm a posição relativa entre si (Array.sort é estável no JS moderno).
function applyBoardOrder(order) {
    if (!order || typeof order !== 'object') return;
    const posMap = new Map();
    Object.keys(order).forEach(status => {
        (order[status] || []).forEach((id, index) => {
            const numericId = Number(id);
            posMap.set(numericId, index);
            const demand = state.demands.find(d => d.id === numericId);
            if (demand) demand.status = status;
        });
    });
    state.demands.sort((a, b) => {
        const pa = posMap.has(a.id) ? posMap.get(a.id) : -1;
        const pb = posMap.has(b.id) ? posMap.get(b.id) : -1;
        return pa - pb;
    });
}

// Evita notificar a própria pessoa sobre a própria ação — o evento sempre volta pra quem
// disparou também (de propósito, ver comentário acima), só não precisa virar toast pra ela.
function notifyRemoteBoardChange(byUserId, byUserName, actionLabel) {
    if (!byUserId || (state.user && byUserId === state.user.id)) return;
    showToast(`${byUserName || 'Alguém'} ${actionLabel} no board.`, 'info');
}

// ==================== DETALHE DO CARTÃO: CHECKLIST + COMENTÁRIOS (Fase 3) ====================
const statusLabelsMap = { TODO: 'Para Fazer', IN_PROGRESS: 'Em Andamento', URGENT: 'Urgente', DONE: 'Concluído' };
let currentDetailDemandId = null;

async function openDemandDetail(id) {
    currentDetailDemandId = Number(id);
    document.getElementById('detail-demand-id').value = id;
    document.getElementById('modal-demand-detail').style.display = 'flex';
    document.getElementById('detail-demand-title').innerText = 'Carregando...';
    document.getElementById('detail-checklist-list').innerHTML = '';
    document.getElementById('detail-comments-list').innerHTML = '';

    try {
        const res = await fetchWithAuth(`/api/demands/${id}`);
        if (!res.ok) throw new Error('Não foi possível carregar a demanda.');
        const demand = await res.json();
        renderDemandDetail(demand);
    } catch (err) {
        console.error('Erro ao abrir detalhe da demanda:', err);
        showToast('Não foi possível carregar essa demanda.', 'error');
        closeDemandDetail();
    }
}

function closeDemandDetail() {
    document.getElementById('modal-demand-detail').style.display = 'none';
    currentDetailDemandId = null;
}

function renderDemandDetail(demand) {
    document.getElementById('detail-demand-title').innerText = demand.title || 'Demanda';
    document.getElementById('detail-demand-description').innerText = demand.description || 'Sem descrição.';

    const priorityLabels = { URGENTE: '🔥 Urgente', ALTA: '⚡ Alta', MEDIA: '📌 Média', BAIXA: '🟢 Baixa' };
    const meta = document.getElementById('detail-demand-meta');

    // Mesma permissão de quem já pode arrastar os cards no Kanban (ver initKanbanSortable):
    // só Dono/Gerente mudam status aqui também. Funcionário continua vendo só o texto.
    const canChangeStatus = state.user && ['OWNER', 'MANAGER'].includes(state.user.role);
    const statusHtml = canChangeStatus
        ? `<select class="detail-status-select" onchange="changeDemandStatusFromDetail(${demand.id}, this.value)">
            ${Object.entries(statusLabelsMap).map(([value, label]) =>
            `<option value="${value}" ${value === demand.status ? 'selected' : ''}>${label}</option>`
        ).join('')}
        </select>`
        : `<span>${statusLabelsMap[demand.status] || demand.status}</span>`;

    meta.innerHTML = `
        <span class="detail-status-field"><i class="fa-solid fa-bars-staggered"></i> ${statusHtml}</span>
        <span><i class="fa-solid fa-flag"></i> ${priorityLabels[demand.priority] || demand.priority}</span>
        ${demand.assigned_user_name || demand.assigned_user_email ? `
            <span><i class="fa-solid fa-user-check"></i> ${escapeHtml(demand.assigned_user_name || demand.assigned_user_email)}</span>
        ` : ''}
        ${demand.created_at ? `<span><i class="fa-regular fa-calendar"></i> ${new Date(demand.created_at).toLocaleDateString('pt-BR')}</span>` : ''}
    `;

    renderChecklist(demand.checklist || []);
    renderComments(demand.comments || []);
}

// Chamado pelo <select> de status dentro do modal de detalhe da demanda. Reaproveita o MESMO
// endpoint que o arrastar-e-soltar do Kanban já usa (PUT /api/demands/:id/status), então o
// board, as automações (DEMAND_COMPLETED/DEMAND_URGENT) e o broadcast em tempo real pros
// colegas continuam funcionando exatamente como já funcionam ao arrastar um card.
async function changeDemandStatusFromDetail(demandId, newStatus) {
    try {
        const res = await fetchWithAuth(`/api/demands/${demandId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status: newStatus })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(data.message || 'Não foi possível mudar o status.', 'error');
            await refreshDemandDetailAndBoard(); // desfaz a seleção visual, voltando ao status real
            return;
        }
        showToast('Status atualizado!', 'success');
        await refreshDemandDetailAndBoard();
    } catch (err) {
        console.error('Erro ao mudar status pela ficha da demanda:', err);
        showToast('Erro de conexão ao mudar status.', 'error');
        await refreshDemandDetailAndBoard();
    }
}

function renderChecklist(items) {
    const total = items.length;
    const done = items.filter(i => i.done).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    document.getElementById('detail-checklist-progress-label').innerText = `${done}/${total}`;
    document.getElementById('detail-checklist-progress-fill').style.width = `${pct}%`;

    const list = document.getElementById('detail-checklist-list');
    if (items.length === 0) {
        list.innerHTML = '<p class="detail-empty-hint">Nenhum item ainda. Adicione o primeiro passo abaixo.</p>';
        return;
    }

    list.innerHTML = items.map(item => `
        <div class="checklist-item ${item.done ? 'checklist-item-done' : ''}">
            <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleChecklistItem(${item.id}, this.checked)">
            <span>${escapeHtml(item.text)}</span>
            <button class="btn-checklist-del" onclick="deleteChecklistItem(${item.id})" title="Remover item">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `).join('');
}

// Realça @email@dominio.com dentro do comentário já escapado — a busca roda sobre o texto
// original (não escapado) só pra achar as posições do padrão, o que é enviado ao DOM é
// sempre o resultado de escapeHtml, nunca o texto cru do usuário.
function formatCommentMessage(rawMessage) {
    const escaped = escapeHtml(rawMessage);
    return escaped.replace(/@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '<span class="mention-tag">@$1</span>');
}

function renderComments(comments) {
    const list = document.getElementById('detail-comments-list');
    if (comments.length === 0) {
        list.innerHTML = '<p class="detail-empty-hint">Nenhum comentário ainda.</p>';
        return;
    }
    list.innerHTML = comments.map(c => `
        <div class="comment-item">
            <div class="comment-item-header">
                <span class="comment-item-author">${escapeHtml(c.user_name || 'Usuário')}</span>
                <span class="comment-item-time">${c.created_at ? new Date(c.created_at).toLocaleString('pt-BR') : ''}</span>
            </div>
            <div class="comment-item-message">${formatCommentMessage(c.message)}</div>
        </div>
    `).join('');
    list.scrollTop = list.scrollHeight;
}

async function submitChecklistItem() {
    const input = document.getElementById('detail-checklist-input');
    const text = input.value.trim();
    if (!text || !currentDetailDemandId) return;

    try {
        const res = await fetchWithAuth(`/api/demands/${currentDetailDemandId}/checklist`, {
            method: 'POST',
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Erro ao adicionar item.');
        input.value = '';
        await refreshDemandDetailAndBoard();
    } catch (err) {
        showToast(err.message || 'Não foi possível adicionar o item.', 'error');
    }
}

async function toggleChecklistItem(itemId, done) {
    if (!currentDetailDemandId) return;
    try {
        const res = await fetchWithAuth(`/api/demands/${currentDetailDemandId}/checklist/${itemId}`, {
            method: 'PUT',
            body: JSON.stringify({ done })
        });
        if (!res.ok) throw new Error('Erro ao atualizar item.');
        await refreshDemandDetailAndBoard();
    } catch (err) {
        showToast('Não foi possível atualizar o item.', 'error');
    }
}

async function deleteChecklistItem(itemId) {
    if (!currentDetailDemandId) return;
    try {
        const res = await fetchWithAuth(`/api/demands/${currentDetailDemandId}/checklist/${itemId}`, {
            method: 'DELETE'
        });
        if (!res.ok) throw new Error('Erro ao remover item.');
        await refreshDemandDetailAndBoard();
    } catch (err) {
        showToast('Não foi possível remover o item.', 'error');
    }
}

async function submitComment() {
    const input = document.getElementById('detail-comment-input');
    const message = input.value.trim();
    if (!message || !currentDetailDemandId) return;

    try {
        const res = await fetchWithAuth(`/api/demands/${currentDetailDemandId}/comments`, {
            method: 'POST',
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Erro ao publicar comentário.');
        input.value = '';
        await refreshDemandDetailAndBoard();
    } catch (err) {
        showToast(err.message || 'Não foi possível publicar o comentário.', 'error');
    }
}

// Depois de qualquer mudança de checklist/comentário: recarrega o detalhe aberto (se ainda
// for o mesmo modal) e recarrega a lista de demandas, pra os badges do card (2/5, 💬3) no
// board ficarem certos sem precisar de F5.
async function refreshDemandDetailAndBoard() {
    const id = currentDetailDemandId;
    if (!id) return;
    try {
        const res = await fetchWithAuth(`/api/demands/${id}`);
        if (res.ok) {
            const demand = await res.json();
            if (currentDetailDemandId === id) renderDemandDetail(demand);
        }
    } catch (err) { /* silencioso: o board ainda vai atualizar os badges abaixo */ }
    await loadDemands();
}

function openNewDemandModal() {
    updateAssigneeDropdowns();
    document.getElementById('modal-demand').style.display = 'flex';
    document.getElementById('demand-title').focus();

    const todayStr = new Date().toISOString().split('T')[0];
    const startDateInput = document.getElementById('demand-start-date');
    if (startDateInput) startDateInput.value = todayStr;
}

function closeNewDemandModal() {
    document.getElementById('modal-demand').style.display = 'none';
    document.getElementById('demand-title').value = '';
    document.getElementById('demand-desc').value = '';
    if (document.getElementById('demand-start-date')) document.getElementById('demand-start-date').value = '';
    if (document.getElementById('demand-due-date')) document.getElementById('demand-due-date').value = '';
}

async function submitNewDemand() {
    const title = document.getElementById('demand-title').value.trim();
    const description = document.getElementById('demand-desc').value.trim();
    const assignedUserEmail = document.getElementById('demand-assignee').value;
    const startDate = document.getElementById('demand-start-date')?.value || new Date().toISOString().split('T')[0];
    const dueDate = document.getElementById('demand-due-date')?.value || null;
    const priority = document.getElementById('demand-priority').value;
    const status = document.getElementById('demand-status').value;

    if (!title) {
        showToast('Por favor, informe o título da demanda.', 'error');
        return;
    }

    const targetEmail = assignedUserEmail || state.user.email;
    const assignedMember = state.members.find(m => m.email === assignedUserEmail);

    const newDemand = {
        id: Date.now(),
        title,
        description,
        priority,
        status,
        start_date: startDate,
        due_date: dueDate,
        assigned_user_email: assignedUserEmail,
        assigned_user_name: assignedMember ? assignedMember.name : (assignedUserEmail || ''),
        creator_name: state.user.name,
        created_at: new Date().toISOString()
    };

    state.demands.unshift(newDemand);
    saveDemandsLocal();
    renderKanban();

    syncDemandToCalendar(newDemand);

    // DISPARO DE NOTIFICAÇÃO DUPLA (PAINEL + E-MAIL)
    const notifTitle = `Nova Demanda: "${title}"`;
    const notifMsg = `A demanda "${title}" foi criada por ${state.user.name} e atribuída a ${assignedUserEmail || 'equipe geral'}. Prioridade: ${priority}.`;

    await notifyUserDualChannel(targetEmail, notifTitle, notifMsg, 'assignment');
    if (assignedUserEmail && assignedUserEmail !== state.user.email) {
        // Envia também uma cópia de notificação para o gestor/criador
        await notifyUserDualChannel(state.user.email, `Confirmação: Demanda Criada`, `Você atribuiu a demanda "${title}" para ${assignedUserEmail}.`, 'info');
    }

    closeNewDemandModal();
    showToast(`Demanda criada e notificação enviada por e-mail para ${targetEmail}!`, 'success');

    try {
        await fetch('/api/demands', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify(newDemand)
        });
    } catch (err) {
        console.warn('Salvo localmente.');
    }
}

function syncDemandToCalendar(demand) {
    if (!demand.start_date) return;

    const start = new Date(demand.start_date + 'T00:00:00');
    const end = demand.due_date ? new Date(demand.due_date + 'T00:00:00') : new Date(demand.start_date + 'T00:00:00');

    let current = new Date(start);

    while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];

        let labelType = 'TAREFA';
        let prefixStr = '📌 Em andamento:';

        if (dateStr === demand.start_date) {
            prefixStr = '🚀 Início:';
        }
        if (demand.due_date && dateStr === demand.due_date) {
            prefixStr = '🏁 Término:';
            labelType = 'URGENTE';
        }

        const exists = state.events.some(e => e.event_date === dateStr && e.title.includes(demand.title));

        if (!exists) {
            state.events.push({
                id: Date.now() + Math.floor(Math.random() * 100000),
                title: `${prefixStr} ${demand.title}`,
                event_date: dateStr,
                event_time: '09:00',
                auto: true,
                type: labelType,
                description: `Demanda atribuída a ${demand.assigned_user_email || 'equipe'}. Status: ${demand.status}`
            });
        }

        current.setDate(current.getDate() + 1);
    }

    saveEventsLocal();
    renderCalendar();
    renderEventsList();
}

function openReassignModal(demandId) {
    const demand = state.demands.find(d => d.id === demandId);
    if (!demand) return;

    document.getElementById('reassign-demand-id').value = demandId;
    document.getElementById('reassign-demand-title').innerText = `Demanda: "${demand.title}"`;

    const select = document.getElementById('reassign-assignee-select');
    select.innerHTML = state.members.map(m => `
        <option value="${m.email}" ${demand.assigned_user_email === m.email ? 'selected' : ''}>
            ${m.name} (${m.email})
        </option>
    `).join('');

    document.getElementById('modal-reassign').style.display = 'flex';
}

function closeReassignModal() {
    document.getElementById('modal-reassign').style.display = 'none';
}

async function submitReassignDemand() {
    const demandId = Number(document.getElementById('reassign-demand-id').value);
    const assignedUserEmail = document.getElementById('reassign-assignee-select').value;

    if (!assignedUserEmail) {
        showToast('Selecione o funcionário responsável.', 'error');
        return;
    }

    const demand = state.demands.find(d => d.id === demandId);
    const member = state.members.find(m => m.email === assignedUserEmail);

    if (demand) {
        demand.assigned_user_email = assignedUserEmail;
        demand.assigned_user_name = member ? member.name : assignedUserEmail;
        saveDemandsLocal();
        renderKanban();
    }

    showToast(`Demanda reatribuída para ${assignedUserEmail}!`, 'success');
    closeReassignModal();

    try {
        await fetch(`/api/demands/${demandId}/assign`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify({ assignedUserEmail })
        });
    } catch (err) {
        console.warn('Atribuição salva em modo resiliente.');
    }
}

async function deleteDemand(id) {
    if (!confirm('Deseja realmente remover esta demanda?')) return;

    state.demands = state.demands.filter(d => d.id !== id);
    saveDemandsLocal();
    renderKanban();
    showToast('Demanda removida.', 'info');

    try {
        await fetch(`/api/demands/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${state.token}` }
        });
    } catch (err) {
        console.warn('Removido localmente.');
    }
}

function exportDemandsCSV() {
    if (state.demands.length === 0) {
        showToast('Nenhuma demanda para exportar.', 'info');
        return;
    }

    const statusPt = { TODO: 'Para Fazer', IN_PROGRESS: 'Em Andamento', URGENT: 'Urgente', DONE: 'Concluído' };
    const priorityPt = { URGENTE: 'Urgente', ALTA: 'Alta', MEDIA: 'Média', BAIXA: 'Baixa' };
    const fmtDate = (v) => {
        if (!v) return '';
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
        if (m) return `//`;
        const dt = new Date(v);
        return isNaN(dt) ? String(v) : dt.toLocaleDateString('pt-BR');
    };
    const fmtDateTime = (v) => {
        if (!v) return '';
        const dt = new Date(v);
        return isNaN(dt) ? String(v) : dt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    };
    const cell = (v) => {
        let s = String(v ?? '').replace(/\r?\n/g, ' ');
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
    };

    const rows = [['ID', 'Título', 'Descrição', 'Prioridade', 'Status', 'Início', 'Prazo', 'Responsável', 'Criado em']];
    state.demands.forEach(d => {
        rows.push([
            d.id,
            d.title,
            d.description,
            priorityPt[d.priority] || d.priority,
            statusPt[d.status] || d.status,
            fmtDate(d.start_date),
            fmtDate(d.due_date),
            d.assigned_user_name || d.assigned_user_email || 'Não atribuído',
            fmtDateTime(d.created_at)
        ]);
    });
    const csvContent = rows.map(r => r.map(cell).join(';')).join('\r\n');

    const encodedUri = URL.createObjectURL(new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `demandas_${state.user.companyName || 'empresa'}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(encodedUri), 1000);

    showToast('Planilha CSV exportada com sucesso!', 'success');
}

// ==================== AUTOMAÇÕES & WORKFLOW ====================
async function loadAutomations() {
    try {
        const res = await fetch('/api/automations', {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });
        if (res.ok) {
            state.automations = await res.json();
            saveAutomationsLocal();
        }
    } catch (err) {
        console.warn('Usando automações locais.');
    }
    renderAutomations();
}

function renderAutomations() {
    const container = document.getElementById('automations-list-container');
    const countTag = document.getElementById('automations-count-tag');
    if (!container) return;

    if (countTag) countTag.innerText = `${state.automations.length} Regras Ativas`;

    if (state.automations.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-muted); padding: 2rem;">
                Nenhuma regra de automação configurada no momento. Use o construtor visual acima.
            </div>
        `;
        return;
    }

    const triggerLabels = {
        DEMAND_CREATED: '⚡ Ao Criar Demanda',
        DEMAND_ASSIGNED: '👤 Ao Atribuir a Funcionário',
        DEMAND_URGENT: '🚨 Ao Marcar como Urgente',
        DEMAND_COMPLETED: '✅ Ao Finalizar Demanda (DONE)',
        EVENT_CREATED: '📅 Ao Criar Evento',
        CONTACT_ADDED: '📇 Ao Adicionar Contato',
        SYSTEM_LOGIN: '🔐 Ao Fazer Login'
    };
    const actionLabels = {
        EMAIL_NOTIFICATION: 'Notificar por E-mail',
        CREATE_EVENT: 'Criar Lembrete no Calendário',
        CREATE_DEMAND: 'Criar Demanda de Acompanhamento'
    };

    container.innerHTML = state.automations.map(a => `
        <div class="member-item" style="border-left: 3px solid var(--primary);">
            <div class="member-avatar" style="background: var(--primary-gradient);"><i class="fa-solid fa-bolt"></i></div>
            <div class="member-info">
                <strong>${escapeHtml(a.name)}</strong>
                <span style="color: var(--accent); font-size: 0.78rem;">
                    ${triggerLabels[a.trigger_event] || a.trigger_event} &rarr; ${actionLabels[a.action_type] || a.action_type}
                </span>
            </div>
            <div>
                <button class="btn-del-member" onclick="deleteAutomation(${a.id})" title="Excluir regra">
                    <i class="fa-solid fa-trash-can"></i> Remover
                </button>
            </div>
        </div>
    `).join('');
}

// Ajusta o rótulo/placeholder do campo "Destino" conforme a ação escolhida, já que o mesmo
// campo vira e-mail (EMAIL_NOTIFICATION) ou título de uma nova demanda (CREATE_DEMAND).
function updateAutomationTargetHint() {
    const actionType = document.getElementById('manual-auto-action').value;
    const label = document.getElementById('manual-auto-target-label');
    const input = document.getElementById('manual-auto-target');
    if (actionType === 'CREATE_DEMAND') {
        label.innerText = 'Título da nova demanda';
        input.placeholder = 'Ex: Revisar resultado da tarefa concluída';
    } else if (actionType === 'CREATE_EVENT') {
        label.innerText = 'Destino (não se aplica a este tipo de ação)';
        input.placeholder = 'Sem campos extras para esta ação';
    } else {
        label.innerText = 'E-mail de destino (opcional)';
        input.placeholder = 'Deixe vazio para notificar o responsável da demanda';
    }
}

async function submitManualAutomation() {
    const name = document.getElementById('manual-auto-name').value.trim();
    const triggerEvent = document.getElementById('manual-auto-trigger').value;
    const actionType = document.getElementById('manual-auto-action').value;
    const targetValue = document.getElementById('manual-auto-target').value.trim();

    if (!name) {
        showToast('Informe um nome para a regra de automação.', 'error');
        return;
    }

    // O mesmo campo de texto vira coisas diferentes dependendo da ação: para
    // CREATE_DEMAND é o título da nova demanda (actionPayload); para as outras ações,
    // um e-mail específico (actionTarget) — se vazio, cai no padrão ASSIGNED_USER.
    const actionTarget = actionType === 'CREATE_DEMAND' ? '' : (targetValue || 'ASSIGNED_USER');
    const actionPayload = actionType === 'CREATE_DEMAND' ? (targetValue || name) : '';

    try {
        const response = await fetchWithAuth('/api/automations', {
            method: 'POST',
            body: JSON.stringify({ name, triggerEvent, actionType, actionTarget, actionPayload })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Não foi possível salvar a automação.');

        state.automations.unshift(data);
        saveAutomationsLocal();
        renderAutomations();
        showToast('Regra de automação ativada com sucesso!', 'success');
        document.getElementById('manual-auto-name').value = '';
        document.getElementById('manual-auto-target').value = '';
    } catch (err) {
        console.error('Erro ao criar automação:', err);
        showToast(err.message || 'Não foi possível salvar a automação.', 'error');
    }
}

async function generateAutomationWithAI() {
    const input = document.getElementById('ai-automation-prompt');
    const prompt = input.value.trim();
    if (prompt.length < 5) {
        showToast('Descreva a automação com um pouco mais de detalhe.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/automations/generate-ai', {
            method: 'POST',
            body: JSON.stringify({ prompt })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Não foi possível gerar a automação.');

        state.automations.unshift(data.automation);
        saveAutomationsLocal();
        renderAutomations();
        appendChatMessage('Cláudia', data.message, true);
        showToast('Regra de automação criada!', 'success');
        input.value = '';
    } catch (err) {
        console.error('Erro ao gerar automação com IA:', err);
        showToast(err.message || 'Não foi possível gerar a automação.', 'error');
    }
}

async function deleteAutomation(id) {
    if (!confirm('Deseja realmente remover esta automação?')) return;

    try {
        const response = await fetchWithAuth(`/api/automations/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Não foi possível remover a automação.');

        state.automations = state.automations.filter(a => a.id !== id);
        saveAutomationsLocal();
        renderAutomations();
        showToast('Automação removida.', 'info');
    } catch (err) {
        console.error('Erro ao remover automação:', err);
        showToast(err.message || 'Não foi possível remover a automação.', 'error');
    }
}

// ==================== ESTATÍSTICAS & ANALYTICS (CHART.JS) ====================
function loadAnalyticsData() {
    const totalDemands = state.demands.length;
    const completedDemands = state.demands.filter(d => d.status === 'DONE').length;
    const completionRate = totalDemands > 0 ? Math.round((completedDemands / totalDemands) * 100) : 0;

    const priorityCounts = { URGENTE: 0, ALTA: 0, MEDIA: 0, BAIXA: 0 };
    state.demands.forEach(d => {
        const p = d.priority || 'MEDIA';
        if (priorityCounts[p] !== undefined) priorityCounts[p]++;
    });

    const elTotal = document.getElementById('stat-total-demands');
    const elRate = document.getElementById('stat-completion-rate');
    const elAi = document.getElementById('stat-ai-count');
    const elUrgent = document.getElementById('stat-urgent-count');

    if (elTotal) elTotal.innerText = totalDemands;
    if (elRate) elRate.innerText = `${completionRate}%`;
    if (elAi) elAi.innerText = state.user ? (state.user.aiUsageCount || 0) : 0;
    if (elUrgent) elUrgent.innerText = priorityCounts.URGENTE || 0;

    const dailyStats = Array.from({ length: 14 }).map((_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (13 - i));
        const dateStr = d.toISOString().split('T')[0];
        const label = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

        const created = state.demands.filter(demand => {
            const demandDate = new Date(demand.created_at).toISOString().split('T')[0];
            return demandDate === dateStr;
        }).length;

        const completed = state.demands.filter(demand => {
            if (demand.status !== 'DONE' || !demand.completed_at) return false;
            const completedDate = new Date(demand.completed_at).toISOString().split('T')[0];
            return completedDate === dateStr;
        }).length;

        return { label, created, completed };
    });

    renderLineChart(dailyStats);
    renderDoughnutChart(priorityCounts);
}

function renderLineChart(dailyStats) {
    const ctx = document.getElementById('demandsLineChart')?.getContext('2d');
    if (!ctx) return;

    if (state.lineChartInstance) {
        state.lineChartInstance.destroy();
    }

    const labels = dailyStats.map(s => s.label);
    const createdData = dailyStats.map(s => s.created);
    const completedData = dailyStats.map(s => s.completed);

    const isColorblind = document.body.classList.contains('colorblind-mode');
    const isDarkTheme = document.body.classList.contains('dark-theme');

    let colorCreated, colorCompleted;

    if (isColorblind) {
        if (isDarkTheme) {
            colorCreated = '#f59e0b';
            colorCompleted = '#10b981';
        } else {
            colorCreated = '#00e5ff';
            colorCompleted = '#00e676';
        }
    } else {
        colorCreated = '#6366f1';
        colorCompleted = '#10b981';
    }

    state.lineChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Demandas Criadas',
                    data: createdData,
                    borderColor: colorCreated,
                    backgroundColor: isColorblind ? 'rgba(0, 229, 255, 0.15)' : 'rgba(99, 102, 241, 0.15)',
                    tension: 0.35,
                    fill: true,
                    borderWidth: 3,
                    pointBackgroundColor: colorCreated,
                    pointRadius: 4
                },
                {
                    label: 'Demandas Finalizadas',
                    data: completedData,
                    borderColor: colorCompleted,
                    backgroundColor: isColorblind ? 'rgba(0, 230, 118, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                    tension: 0.35,
                    fill: true,
                    borderWidth: 3,
                    pointBackgroundColor: colorCompleted,
                    pointRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#cbd5e1', font: { family: 'Plus Jakarta Sans', size: 12 } }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8', stepSize: 1 },
                    beginAtZero: true
                }
            }
        }
    });
}

function renderDoughnutChart(priorityCounts) {
    const ctx = document.getElementById('priorityDoughnutChart')?.getContext('2d');
    if (!ctx) return;

    if (state.doughnutChartInstance) {
        state.doughnutChartInstance.destroy();
    }

    const isColorblind = document.body.classList.contains('colorblind-mode');
    const isDarkTheme = document.body.classList.contains('dark-theme');

    let backgroundColors;

    if (isColorblind) {
        if (isDarkTheme) {
            backgroundColors = ['#dc2626', '#f59e0b', '#3b82f6', '#10b981'];
        } else {
            backgroundColors = ['#dc2626', '#d97706', '#0891b2', '#059669'];
        }
    } else {
        backgroundColors = ['#ef4444', '#f59e0b', '#3b82f6', '#10b981'];
    }

    state.doughnutChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Urgente', 'Alta', 'Média', 'Baixa'],
            datasets: [{
                data: [
                    priorityCounts.URGENTE || 0,
                    priorityCounts.ALTA || 0,
                    priorityCounts.MEDIA || 0,
                    priorityCounts.BAIXA || 0
                ],
                backgroundColor: backgroundColors,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#cbd5e1', font: { family: 'Plus Jakarta Sans', size: 11 }, padding: 15 }
                }
            }
        }
    });
}

// ==================== CALENDÁRIO EMPRESARIAL ====================
// O servidor pode devolver a data como "2026-10-12T00:00:00.000Z" (coluna DATE) ou "12/10/2026".
// O calendário compara sempre "AAAA-MM-DD", então normaliza aqui.
function normalizeEvent(e) {
    if (!e) return e;
    let d = String(e.event_date || e.eventDate || '');
    let m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) d = `${m[1]}-${m[2]}-${m[3]}`;
    else if ((m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) d = `${m[3]}-${m[2]}-${m[1]}`;
    const t = String(e.event_time || e.eventTime || '');
    return { ...e, event_date: d, event_time: t ? t.slice(0, 5) : t };
}

async function loadEvents() {
    loadPlanFeatures();
    try {
        const res = await fetch('/api/events', {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });
        if (res.ok) {
            state.events = (await res.json()).map(normalizeEvent);
            saveEventsLocal();
        }
    } catch (err) {
        console.warn('Usando calendário local.');
    }
    renderCalendar();
    renderEventsList();
}

function prevMonth() {
    state.currentDate.setMonth(state.currentDate.getMonth() - 1);
    renderCalendar();
}

function nextMonth() {
    state.currentDate.setMonth(state.currentDate.getMonth() + 1);
    renderCalendar();
}

function renderCalendar() {
    const year = state.currentDate.getFullYear();
    const month = state.currentDate.getMonth();

    const monthNames = [
        'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];

    const label = document.getElementById('calendar-month-year');
    if (label) label.innerText = `${monthNames[month]} ${year}`;

    const firstDayIndex = new Date(year, month, 1).getDay();
    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
    const lastDayPrevMonth = new Date(year, month, 0).getDate();

    const grid = document.getElementById('calendar-days-grid');
    if (!grid) return;

    let cellsHtml = '';

    for (let i = firstDayIndex; i > 0; i--) {
        const prevDay = lastDayPrevMonth - i + 1;
        cellsHtml += `<div class="calendar-day-cell other-month"><span class="day-number">${prevDay}</span></div>`;
    }

    const todayStr = new Date().toISOString().split('T')[0];

    for (let day = 1; day <= lastDayOfMonth; day++) {
        const monthStr = String(month + 1).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        const fullDateStr = `${year}-${monthStr}-${dayStr}`;

        const isToday = fullDateStr === todayStr;
        const isSelected = state.selectedCalendarDate === fullDateStr;

        const dayEvents = state.events.filter(e => (e.event_date || e.eventDate) === fullDateStr);

        const dotsHtml = dayEvents.slice(0, 4).map(e => `
            <div class="event-dot dot-${e.type || 'REUNIAO'}" title="${escapeHtml(e.title)}"></div>
        `).join('');

        cellsHtml += `
            <div class="calendar-day-cell ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''} ${dayEvents.length ? 'has-events' : ''}" onclick="selectCalendarDate('${fullDateStr}')">
                <span class="day-number">${day}</span>
                <div class="day-events-dots">${dotsHtml}</div>
            </div>
        `;
    }

    grid.innerHTML = cellsHtml;
}

function selectCalendarDate(dateStr) {
    state.selectedCalendarDate = dateStr;
    renderCalendar();
    renderEventsList(dateStr);
}

function renderEventsList(filterDate = null) {
    updateCalendarQuotaUI();
    const list = document.getElementById('calendar-events-list');
    const label = document.getElementById('cal-selected-day-label');
    if (!list) return;

    let displayEvents = state.events;

    if (filterDate) {
        displayEvents = state.events.filter(e => (e.event_date || e.eventDate) === filterDate);
        const formattedDate = new Date(`${filterDate}T00:00:00`).toLocaleDateString('pt-BR');
        if (label) label.innerText = `Dia ${formattedDate}`;
    } else {
        if (label) label.innerText = 'Todos os Compromissos';
    }

    if (displayEvents.length === 0) {
        list.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 2rem 0;">Nenhum evento agendado para esta data.</p>';
        return;
    }

    list.innerHTML = displayEvents.map(e => `
        <div class="event-item-card event-${e.type || 'REUNIAO'}">
            <div class="event-top-row">
                <span class="event-time-badge"><i class="fa-regular fa-clock"></i> ${e.event_time || e.eventTime || '09:00'}</span>
                <button class="btn-del-event" onclick="deleteEvent(${e.id})" title="Excluir Evento">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
            <h4>${escapeHtml(e.title)}</h4>
            ${e.client_name ? `<p><i class="fa-solid fa-user"></i> ${escapeHtml(e.client_name)}${e.client_phone ? ' · ' + escapeHtml(e.client_phone) : ''}</p>` : ''}
            ${e.description ? `<p>${escapeHtml(e.description)}</p>` : ''}
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.35rem;">
                <i class="fa-regular fa-calendar"></i> ${e.event_date || e.eventDate}
            </div>
        </div>
    `).join('');
}

// ==================== LIMITES DO PLANO GRATUITO (CALENDÁRIO / E-MAIL) ====================
const FREE_EVENT_LIMIT = 5;

// Limites reais vêm do servidor (/api/plan/features), que olha o plano da EMPRESA; o valor
// acima só é usado enquanto a resposta não chega.
function getEventLimit() {
    return (state.planFeatures && state.planFeatures.eventsLimit) || FREE_EVENT_LIMIT;
}

async function loadPlanFeatures() {
    try {
        const res = await fetchWithAuth('/api/plan/features');
        if (res.ok) state.planFeatures = await res.json();
    } catch (err) {
        console.warn('Não foi possível carregar os recursos do plano.');
    }
    updateCalendarQuotaUI();
}

function isFreePlan() {
    const tier = (state.planFeatures && state.planFeatures.tier) || (state.user && state.user.planTier);
    return !['STARTER', 'PRO_IA', 'OWNER'].includes(tier);
}

function countCalendarEventsForLimit() {
    // Eventos gerados automaticamente a partir de demandas (auto: true) não entram na cota.
    return (state.events || []).filter(e => !e.auto).length;
}

function hasReachedFreeEventLimit() {
    return isFreePlan() && countCalendarEventsForLimit() >= getEventLimit();
}

function showEventLimitReached() {
    showToast(`Você usou os ${getEventLimit()} eventos do plano gratuito. Assine o Starter para ter calendário ilimitado.`, 'error');
    switchTab('plans');
}

function updateCalendarQuotaUI() {
    const badge = document.getElementById('calendar-quota-badge');
    if (!badge) return;
    if (!isFreePlan()) { badge.style.display = 'none'; return; }
    const used = Math.min(countCalendarEventsForLimit(), getEventLimit());
    badge.innerHTML = `<i class="fa-solid fa-calendar-check"></i> ${used}/${getEventLimit()} eventos no plano gratuito`;
    badge.style.display = '';
    badge.style.color = used >= getEventLimit() ? '#ef4444' : '';
}

function openNewEventModal(date = null) {
    if (hasReachedFreeEventLimit()) { showEventLimitReached(); return; }
    document.getElementById('modal-event').style.display = 'flex';
    document.getElementById('event-date').value = date || new Date().toISOString().split('T')[0];
    document.getElementById('event-title').focus();
}

function toggleEventClientField() {
    const group = document.getElementById('event-client-group');
    if (!group) return;
    group.style.display = document.getElementById('event-type').value === 'HORARIO_MARCADO' ? '' : 'none';
}

function closeNewEventModal() {
    document.getElementById('modal-event').style.display = 'none';
    document.getElementById('event-title').value = '';
    document.getElementById('event-desc').value = '';
    const clientInput = document.getElementById('event-client');
    if (clientInput) clientInput.value = '';
    const phoneInput = document.getElementById('event-client-phone');
    if (phoneInput) phoneInput.value = '';
    toggleEventClientField();
}

async function submitNewEvent() {
    const title = document.getElementById('event-title').value.trim();
    const eventDate = document.getElementById('event-date').value;
    const eventTime = document.getElementById('event-time').value;
    const type = document.getElementById('event-type').value;
    const description = document.getElementById('event-desc').value.trim();
    const clientName = type === 'HORARIO_MARCADO' ? (document.getElementById('event-client')?.value.trim() || '') : '';
    const clientPhone = type === 'HORARIO_MARCADO' ? (document.getElementById('event-client-phone')?.value.trim() || '') : '';
    if (type === 'HORARIO_MARCADO' && !clientName) {
        showToast('Informe o nome do(a) cliente para o Horário Marcado.', 'error');
        return;
    }

    if (!title || !eventDate) {
        showToast('Título e Data são obrigatórios para o evento.', 'error');
        return;
    }

    if (hasReachedFreeEventLimit()) {
        closeNewEventModal();
        showEventLimitReached();
        return;
    }

    try {
        const response = await fetchWithAuth('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, eventDate, event_date: eventDate, eventTime, event_time: eventTime, type, description, clientName, clientPhone })
        });

        // O servidor é quem manda: limite do plano gratuito atingido (403 com code EVENT_LIMIT)
        if (response.status === 403 || response.status === 402) {
            const errBody = await response.clone().json().catch(() => ({}));
            if (errBody.code === 'EVENT_LIMIT') {
                closeNewEventModal();
                showEventLimitReached();
                return;
            }
        }

        const savedEvent = response.ok ? await response.json() : {
            id: Date.now(), title, event_date: eventDate, event_time: eventTime, type, description, client_name: clientName, client_phone: clientPhone
        };

        state.events.push(normalizeEvent(savedEvent));
        saveEventsLocal();

        // DISPARO DE NOTIFICAÇÃO DUPLA (PAINEL + E-MAIL)
        const notifTitle = `Novo Evento Agendado: "${title}"`;
        const notifMsg = `Um novo evento foi agendado para o dia ${eventDate} às ${eventTime}. Descrição: ${description || 'Sem descrição.'}`;

        await notifyUserDualChannel(state.user.email, notifTitle, notifMsg, 'calendar');

        closeNewEventModal();
        renderCalendar();
        renderEventsList();
        showToast(isFreePlan() ? 'Evento agendado!' : 'Evento agendado e e-mail de notificação enviado!', 'success');

    } catch (error) {
        console.error('Erro ao salvar evento:', error);
        showToast(error.message || 'Erro ao conectar com o servidor.', 'error');
    }
}

async function deleteEvent(id) {
    if (!confirm('Deseja realmente remover este evento?')) return;

    // Some da tela na hora; a exclusão é confirmada no servidor logo em seguida.
    // Se o servidor recusar (ou cair a conexão), o evento volta e o usuário é avisado.
    const previousEvents = state.events;
    state.events = state.events.filter(e => String(e.id) !== String(id));
    saveEventsLocal();
    renderCalendar();
    renderEventsList();

    try {
        const res = await fetchWithAuth(`/api/events/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast('Evento removido.', 'info');
    } catch (err) {
        console.error('Erro ao remover evento:', err);
        state.events = previousEvents;
        saveEventsLocal();
        renderCalendar();
        renderEventsList();
        showToast('Não foi possível remover o evento. Tente novamente.', 'error');
    }
}

// ==================== IA AUTÔNOMO & CHAT INTELIGENTE ====================
function hasPlanAccessToAI() {
    if (!state.user) return false;
    const userTier = state.user.planTier || 'BASICO';
    return userTier === 'STARTER' || userTier === 'PRO_IA';
}

function initChat() {
    const sendBtn = document.getElementById('ai-send-btn');
    const input = document.getElementById('ai-input');

    if (!sendBtn || !input) return;

    const sendMessage = async () => {
        const text = input.value.trim();
        if (!text) return;

        if (!hasPlanAccessToAI()) {
            appendChatMessage('Sistema', '⚠️ O Assistente de IA está disponível nos planos Starter e Pro AI. Faça o upgrade na aba **Planos & Assinatura**.', true);
            showToast('Assine o plano Starter ou Pro AI para liberar a IA!', 'error');
            return;
        }

        appendChatMessage('Você', text, false);
        input.value = '';

        const typingBubble = appendTypingIndicator();

        setTimeout(async () => {
            typingBubble.remove();
            const lowerText = text.toLowerCase();

            // =========================================================
            // 0. FLUXO CONVERSACIONAL ATIVO DA IA (SENHA E E-MAIL EM ETAPAS)
            // =========================================================
            if (state.aiCredentialFlow) {
                if (['cancelar', 'sair', 'abortar', 'stop', 'cancel'].includes(lowerText)) {
                    state.aiCredentialFlow = null;
                    appendChatMessage('Cláudia', '❌ Operação cancelada com sucesso. Em que mais posso te ajudar agora?', true);
                    return;
                }
                await handleAiCredentialConversationStep(text);
                return;
            }

            // =========================================================
            // 1. COMANDOS DE INTERFACE (TEMA, DALTÔNICO, ZOOM)
            // =========================================================
            const isThemeCommand = lowerText.includes('tema') || lowerText.includes('modo escuro') || lowerText.includes('modo claro') || lowerText.includes('dark') || lowerText.includes('light');
            const isDaltonicCommand = lowerText.includes('daltônico') || lowerText.includes('daltonico') || lowerText.includes('colorblind');
            const isZoomCommand = lowerText.includes('zoom');

            if (isThemeCommand) {
                if (lowerText.includes('escuro') || lowerText.includes('dark')) {
                    document.body.classList.add('dark-mode', 'dark-theme');
                    document.body.classList.remove('light-theme');
                    localStorage.setItem('klweb_theme', 'dark');
                    appendChatMessage('Cláudia', '🌙 Tema escuro ativado com sucesso!', true);
                } else if (lowerText.includes('claro') || lowerText.includes('light')) {
                    document.body.classList.remove('dark-mode', 'dark-theme');
                    document.body.classList.add('light-theme');
                    localStorage.setItem('klweb_theme', 'light');
                    appendChatMessage('Cláudia', '☀️ Tema claro ativado com sucesso!', true);
                } else {
                    appendChatMessage('Cláudia', 'Você deseja mudar para o **tema claro** ou **tema escuro**?', true);
                }
                return;
            }

            if (isDaltonicCommand) {
                const isCurrentlyActive = document.body.classList.contains('daltonic-mode') || document.body.classList.contains('colorblind-mode');
                const wantsOff = lowerText.includes('desativar') || lowerText.includes('remover') || lowerText.includes('desligar') || lowerText.includes('normal') || lowerText.includes('tirar') || lowerText.includes('sair');
                const wantsOn = lowerText.includes('ativar') || lowerText.includes('ligar') || lowerText.includes('colocar');

                let turnOn = wantsOff ? false : (wantsOn ? true : !isCurrentlyActive);

                if (turnOn) {
                    document.body.classList.add('daltonic-mode', 'colorblind-mode');
                    localStorage.setItem('klweb_colorblind', 'true');
                    appendChatMessage('Cláudia', '👁️ Modo daltônico **ativado** com sucesso!', true);
                } else {
                    document.body.classList.remove('daltonic-mode', 'colorblind-mode');
                    localStorage.setItem('klweb_colorblind', 'false');
                    appendChatMessage('Cláudia', '👁️ Modo daltônico **desativado**. Padrão restaurado!', true);
                }
                return;
            }

            if (isZoomCommand) {
                const numberMatch = text.match(/\d+/);
                if (numberMatch) {
                    let zoomVal = parseInt(numberMatch[0]);
                    if (zoomVal < 50) zoomVal = 50;
                    if (zoomVal > 150) zoomVal = 150;

                    document.documentElement.style.fontSize = `${(zoomVal / 100) * 16}px`;
                    localStorage.setItem('klweb_zoom', zoomVal);

                    const zoomRange = document.getElementById('zoom-range');
                    const zoomValue = document.getElementById('zoom-value');
                    if (zoomRange) zoomRange.value = zoomVal;
                    if (zoomValue) zoomValue.textContent = `${zoomVal}%`;

                    appendChatMessage('Cláudia', `🔍 Zoom ajustado para **${zoomVal}%**!`, true);
                } else if (lowerText.includes('reset') || lowerText.includes('padrao') || lowerText.includes('padrão')) {
                    document.documentElement.style.fontSize = '16px';
                    localStorage.setItem('klweb_zoom', 100);

                    const zoomRange = document.getElementById('zoom-range');
                    const zoomValue = document.getElementById('zoom-value');
                    if (zoomRange) zoomRange.value = 100;
                    if (zoomValue) zoomValue.textContent = '100%';

                    appendChatMessage('Cláudia', '🔍 Zoom restaurado para o padrão (100%).', true);
                } else {
                    appendChatMessage('Cláudia', 'Informe a porcentagem do zoom desejada. Exemplo: **"Mudar zoom para 120%"**', true);
                }
                return;
            }

            // =========================================================
            // 2. ACEITAR SOLICITAÇÕES / CONEXÕES DE FUNCIONÁRIOS
            // =========================================================
            const isApproveRequests = (lowerText.includes('aceit') || lowerText.includes('aprova')) &&
                (lowerText.includes('solicita') || lowerText.includes('conexã') || lowerText.includes('conexao') || lowerText.includes('funcionário') || lowerText.includes('funcionario') || lowerText.includes('membro'));

            if (isApproveRequests) {
                const userRole = (state.user?.role || '').toUpperCase();
                const isManagerOrOwner = ['OWNER', 'MANAGER', 'DONO', 'GERENTE', 'ADMIN'].includes(userRole);

                if (!isManagerOrOwner) {
                    appendChatMessage('Cláudia', '🚫 **Acesso Negado**: Apenas **Gerentes** ou **Donos** da empresa têm permissão para aprovar novas solicitações de membros.', true);
                    return;
                }

                try {
                    const res = await fetchWithAuth('/api/workspace/approve-all-requests', { method: 'POST' });

                    if (res.ok) {
                        const data = await res.json();
                        const count = data.approvedCount || 'todos os';
                        appendChatMessage('Cláudia', `✅ Solicitações processadas! **${count} funcionário(s)** foram aceitos e conectados ao workspace da empresa.`, true);
                    } else {
                        // Trativa de Estado Local para Resiliência
                        const pendingCount = (state.pendingRequests || []).length;
                        if (pendingCount > 0) {
                            state.members = state.members || [];
                            state.members.push(...state.pendingRequests);
                            state.pendingRequests = [];
                            appendChatMessage('Cláudia', `✅ **${pendingCount} solicitação(ões)** de novos funcionários foram aprovadas e adicionadas aos membros da empresa!`, true);
                        } else {
                            appendChatMessage('Cláudia', '⚡ **Todas as solicitações de conexão já estão em dia!** Não há novos funcionários pendentes na fila de aprovação.', true);
                        }
                    }
                } catch (e) {
                    appendChatMessage('Cláudia', '✅ **Conexões atualizadas!** Todos os funcionários com solicitações pendentes foram aceitos no workspace.', true);
                }
                return;
            }

            // =========================================================
            // 3. CRIAR E GERENCIAR AUTOMAÇÕES VIA IA (CORRIGIDO)
            // =========================================================
            const isAutomationCommand = lowerText.includes('automação') || lowerText.includes('automacao') || lowerText.includes('automatiz') || lowerText.includes('fluxo de trabalho') || lowerText.includes('quando ');

            if (isAutomationCommand) {
                let triggerEvent = 'DEMAND_CREATED';
                let actionType = 'EMAIL_NOTIFICATION';

                if (lowerText.includes('contato') || lowerText.includes('cliente')) triggerEvent = 'CONTACT_ADDED';
                if (lowerText.includes('evento') || lowerText.includes('reunião') || lowerText.includes('reuniao')) triggerEvent = 'EVENT_CREATED';
                if (lowerText.includes('tarefa') || lowerText.includes('demanda')) actionType = 'CREATE_DEMAND';
                if (lowerText.includes('lembrete') || lowerText.includes('calendário')) actionType = 'CREATE_EVENT';

                const newAutomation = {
                    name: `Automação: ${text.slice(0, 30)}...`,
                    triggerEvent: triggerEvent,
                    actionType: actionType,
                    actionTarget: 'ASSIGNED_USER',
                    actionPayload: text,
                    active: true
                };

                try {
                    const response = await fetchWithAuth('/api/automations', {
                        method: 'POST',
                        body: JSON.stringify(newAutomation)
                    });

                    if (response.ok) {
                        const data = await response.json();
                        state.automations = state.automations || [];
                        state.automations.unshift(data);
                        saveAutomationsLocal();
                        renderAutomations();

                        appendChatMessage('Cláudia', `⚙️ **Automação Criada com Sucesso!**\n\n• **Gatilho:** \`${triggerEvent}\`\n• **Ação:** \`${actionType}\`\n\n📌 *A regra foi registada e está ativa no sistema.*`, true);
                    } else {
                        showToast('Não foi possível guardar a automação no servidor.', 'error');
                    }
                } catch (e) {
                    console.error('Erro ao guardar automação:', e);
                    showToast('Erro de conexão ao guardar automação.', 'error');
                }
                return;
            }

            // =========================================================
            // 4. ALTERAÇÃO DE SENHA E E-MAIL (PRÓPRIO E DE FUNCIONÁRIOS)
            // =========================================================
            const isPasswordChange = lowerText.includes('mudar senha') || lowerText.includes('alterar senha') || lowerText.includes('trocar senha') || lowerText.includes('redefinir senha');
            const isEmailChange = lowerText.includes('mudar email') || lowerText.includes('mudar e-mail') || lowerText.includes('alterar email') || lowerText.includes('alterar e-mail') || lowerText.includes('trocar email') || lowerText.includes('trocar e-mail');

            if (isPasswordChange || isEmailChange) {
                const userRole = (state.user?.role || '').toUpperCase();
                const isManagerOrOwner = ['OWNER', 'MANAGER', 'DONO', 'GERENTE', 'ADMIN'].includes(userRole);

                const emailsInText = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
                let targetEmployee = null;
                let isSelf = false;

                if (lowerText.includes('minha senha') || lowerText.includes('meu email') || lowerText.includes('meu e-mail') || lowerText.includes('minha conta') || lowerText.includes('meu perfil')) {
                    isSelf = true;
                    targetEmployee = state.user;
                } else if (emailsInText.length > 0) {
                    const targetEmail = emailsInText[0].toLowerCase();
                    if (targetEmail === (state.user?.email || '').toLowerCase()) {
                        isSelf = true;
                        targetEmployee = state.user;
                    } else {
                        targetEmployee = (state.members || []).find(m => m.email.toLowerCase() === targetEmail) || { email: targetEmail, name: targetEmail };
                    }
                } else {
                    // Tenta identificar por nome de membro cadastrado na equipe
                    const foundMember = (state.members || []).find(m => m.name && lowerText.includes(m.name.toLowerCase()));
                    if (foundMember) {
                        targetEmployee = foundMember;
                    }
                }

                // Se não foi identificado nenhum funcionário ou se o usuário disse "mudar senha para tal funcionário"
                if (!targetEmployee) {
                    state.aiCredentialFlow = {
                        type: isPasswordChange ? 'PASSWORD' : 'EMAIL',
                        step: 'WAITING_TARGET'
                    };
                    appendChatMessage('Cláudia', `🤔 **Para qual funcionário deseja fazer a alteração?**\n\nPor favor, digite o **nome** ou **e-mail** do colaborador (ou digite *cancelar*).`, true);
                    return;
                }

                if (!isSelf && !isManagerOrOwner) {
                    appendChatMessage('Cláudia', '🚫 **Acesso Negado**\n\nApenas gerentes ou donos do workspace possuem permissão para alterar credenciais de outros membros da equipe.', true);
                    return;
                }

                const targetEmail = targetEmployee.email;
                const targetName = targetEmployee.name || targetEmail;

                if (isPasswordChange) {
                    state.aiCredentialFlow = {
                        type: 'PASSWORD',
                        step: 'WAITING_OLD_PASSWORD',
                        targetEmail,
                        targetName,
                        isSelf
                    };
                    appendChatMessage('Cláudia', `🔐 **Alteração de Senha**\n\n• **Colaborador:** ${targetName}\n• **E-mail:** ${targetEmail}\n\nPara iniciar, por favor informe a **senha antiga (atual)** do colaborador (ou digite *cancelar*):`, true);
                    return;
                }

                if (isEmailChange) {
                    state.aiCredentialFlow = {
                        type: 'EMAIL',
                        step: 'WAITING_PASSWORD_FOR_EMAIL',
                        targetEmail,
                        targetName,
                        isSelf
                    };
                    appendChatMessage('Cláudia', `📧 **Alteração de E-mail**\n\n• **Colaborador:** ${targetName}\n• **E-mail atual:** ${targetEmail}\n\nPor segurança, informe a **senha atual** para autorizar a alteração (ou digite *cancelar*):`, true);
                    return;
                }
            }

            // =========================================================
            // 5. CONSULTA DE MEMBROS DA EMPRESA (EVITA DADOS MOCK/FALSOS)
            // =========================================================
            const isTeamQuery = lowerText.includes('quem está') ||
                lowerText.includes('membros') ||
                lowerText.includes('equipe') ||
                lowerText.includes('minha empresa') ||
                lowerText.includes('quem trabalha');

            if (isTeamQuery) {
                const companyName = state.user?.companyName || 'Sua Empresa';
                const members = state.members && state.members.length > 0 ? state.members : [
                    { name: state.user?.name || 'Você', role: state.user?.role || 'OWNER', email: state.user?.email || '-' }
                ];

                let tableRows = members.map(m => `| ${m.name || 'Membro'} | ${m.role || 'Membro'} | ${m.email || '-'} | ${m.phone || '-'} |`).join('\n');

                const responseMsg = `A sua empresa, **${companyName}**, conta com os seguintes membros reais cadastrados:\n\n| Nome | Cargo | E-mail | Telefone |\n|------|-------|--------|----------|\n${tableRows}`;

                appendChatMessage('Cláudia', responseMsg, true);
                return;
            }

            // =========================================================
            // 6. COMANDOS DE CRM, CALENDÁRIO E DEMANDAS
            // =========================================================
            const isContactCommand = lowerText.includes('contato') ||
                lowerText.includes('cliente') ||
                lowerText.includes('pessoa') ||
                (lowerText.includes('nome') && lowerText.includes('telefone'));

            const isEventCommand = lowerText.includes('evento') ||
                lowerText.includes('agendar') ||
                lowerText.includes('compromisso') ||
                lowerText.includes('reunião') ||
                lowerText.includes('reuniao') ||
                lowerText.includes('calendário') ||
                lowerText.includes('calendario');

            const isDemandCommand = lowerText.includes('crie') ||
                lowerText.includes('criar') ||
                lowerText.includes('nova demanda') ||
                lowerText.includes('nova tarefa') ||
                lowerText.includes('tarefa') ||
                lowerText.includes('demanda') ||
                lowerText.includes('projeto') ||
                lowerText.includes('atividade');

            const isEditCommand = lowerText.includes('edite') ||
                lowerText.includes('editar') ||
                lowerText.includes('altere') ||
                lowerText.includes('alterar') ||
                lowerText.includes('atualize') ||
                lowerText.includes('atualizar') ||
                lowerText.includes('mude') ||
                lowerText.includes('mudar');

            // CRIAR CONTATO
            if (isContactCommand && !isEditCommand) {
                let name = '';
                let phone = '';
                let email = '';

                const nameMatch = text.match(/(?:nome|cliente|pessoa)\s+(?:["'”‘]?)([^"'\n]+)(?:["'”‘]?)/i) ||
                    text.match(/["'”‘]([^"'\n]+)["'”‘]\s+com\s+número/i) ||
                    text.match(/["'”‘]([^"'\n]+)["'”‘]\s+com\s+telefone/i);

                if (nameMatch) {
                    name = nameMatch[1].trim();
                } else {
                    const words = text.split(/\s+/);
                    for (let i = 0; i < words.length; i++) {
                        if (words[i].length > 2 && !/^\d+$/.test(words[i]) &&
                            !['contato', 'crie', 'criar', 'com', 'para', 'telefone', 'numero', 'número'].includes(words[i].toLowerCase())) {
                            name = words[i];
                            break;
                        }
                    }
                }

                const phoneMatch = text.match(/(\d{8,11})/);
                if (phoneMatch) phone = phoneMatch[1];

                const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailMatch) email = emailMatch[0];

                if (!name) name = 'Novo Contato IA';
                if (!phone) phone = '00000000000';

                const newContact = {
                    id: Date.now(),
                    name,
                    phone,
                    email: email || '',
                    company_name: state.user?.companyName || 'Empresa',
                    role: 'Cliente',
                    notes: 'Cadastrado via Cláudia IA'
                };

                state.contacts.push(newContact);
                saveContactsLocal();
                renderContacts();

                try {
                    await fetchWithAuth('/api/contacts', {
                        method: 'POST',
                        body: JSON.stringify(newContact)
                    });
                } catch (e) {
                    console.warn('Contato salvo em cache local.');
                }

                appendChatMessage('Cláudia', `✅ Contato **${name}** adicionado com sucesso ao CRM!\n📱 Telefone: ${phone}${email ? `\n📧 E-mail: ${email}` : ''}`, true);
                return;
            }

            // CRIAR EVENTO NO CALENDÁRIO
            if (isEventCommand && !isEditCommand) {
                let title = '';
                let eventDate = '';
                let eventTime = '09:00';

                const quoteMatch = text.match(/["'”‘](.*?)["'”‘]/);
                if (quoteMatch && quoteMatch[1]) {
                    title = quoteMatch[1].trim();
                } else {
                    title = text
                        .replace(/^crie\s+(um\s+)?(evento|compromisso|reunião|reuniao)\s+/gi, '')
                        .replace(/^agendar?\s+(um\s+)?(evento|compromisso|reunião|reuniao)\s+/gi, '')
                        .replace(/no\s+calendário/gi, '')
                        .replace(/para\s+o\s+dia\s+\d{2}[\/\-]\d{2}[\/\-]\d{4}/gi, '')
                        .replace(/com\s+o\s+nome/gi, '')
                        .replace(/dia\s+\d{2}[\/\-]\d{2}[\/\-]\d{4}/gi, '')
                        .trim();
                }

                if (!title) title = 'Compromisso Agendado';

                const dateMatch = text.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
                if (dateMatch) {
                    eventDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
                } else {
                    eventDate = new Date().toISOString().split('T')[0];
                }

                const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
                if (timeMatch) eventTime = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;

                const newEvent = {
                    id: Date.now(),
                    title: title,
                    event_date: eventDate,
                    eventDate: eventDate,
                    event_time: eventTime,
                    eventTime: eventTime,
                    type: lowerText.includes('reunião') || lowerText.includes('reuniao') ? 'REUNIAO' : 'TAREFA',
                    description: 'Agendado automaticamente via IA Cláudia'
                };

                state.events.push(newEvent);
                saveEventsLocal();
                if (typeof renderCalendar === 'function') renderCalendar();
                if (typeof renderEventsList === 'function') renderEventsList();

                try {
                    await fetchWithAuth('/api/events', {
                        method: 'POST',
                        body: JSON.stringify(newEvent)
                    });
                } catch (err) {
                    console.warn('Evento agendado em modo resiliente.');
                }

                const dateFormatted = eventDate.split('-').reverse().join('/');
                appendChatMessage('Cláudia', `✅ Evento **"${title}"** criado e agendado no Calendário para **${dateFormatted}** às **${eventTime}**!`, true);
                return;
            }

            // EDITAR DEMANDA
            if (isEditCommand && !isDemandCommand) {
                let targetDemand = null;

                const quoteMatch = text.match(/["'”‘](.*?)["'”‘]/);
                if (quoteMatch && quoteMatch[1]) {
                    const searchTitle = quoteMatch[1].toLowerCase().trim();
                    targetDemand = state.demands.find(d => d.title.toLowerCase().includes(searchTitle));
                } else {
                    targetDemand = state.demands.find(d => lowerText.includes(d.title.toLowerCase()));
                }

                if (!targetDemand) {
                    appendChatMessage('Cláudia', 'Não encontrei nenhuma demanda correspondente para editar. Por favor, coloque o nome exato entre aspas. Exemplo: **Mude a tarefa "Revisar Contrato" para concluído**', true);
                    return;
                }

                let changes = [];

                if (lowerText.includes('concluí') || lowerText.includes('finaliz') || lowerText.includes('pronto') || lowerText.includes('done')) {
                    targetDemand.status = 'DONE';
                    changes.push('Status: **Concluído**');
                } else if (lowerText.includes('em andamento') || lowerText.includes('in progress')) {
                    targetDemand.status = 'IN_PROGRESS';
                    changes.push('Status: **Em Andamento**');
                } else if (lowerText.includes('para fazer') || lowerText.includes('todo')) {
                    targetDemand.status = 'TODO';
                    changes.push('Status: **Para Fazer**');
                }

                if (lowerText.includes('urgente') || lowerText.includes('crítica')) {
                    targetDemand.priority = 'URGENTE';
                    changes.push('Prioridade: **🔥 Urgente**');
                }

                saveDemandsLocal();
                renderKanban();
                syncDemandToCalendar(targetDemand);

                try {
                    await fetchWithAuth(`/api/demands/${targetDemand.id}/status`, {
                        method: 'PUT',
                        body: JSON.stringify({ status: targetDemand.status, priority: targetDemand.priority })
                    });
                } catch (e) { }

                appendChatMessage('Cláudia', `Demanda **"${targetDemand.title}"** atualizada!\n• ${changes.join('\n• ')}`, true);
                return;
            }

            // CRIAR DEMANDA
            if (isDemandCommand && !isContactCommand && !isEventCommand) {
                const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                const extractedEmail = emailMatch ? emailMatch[0] : '';

                let extractedTitle = text;
                const quoteMatch = text.match(/["'”‘](.*?)["'”‘]/);

                if (quoteMatch && quoteMatch[1]) {
                    extractedTitle = quoteMatch[1].trim();
                } else {
                    extractedTitle = text
                        .replace(/^crie\s+(uma\s+)?(tarefa|demanda)\s+/i, '')
                        .replace(/^criar\s+(uma\s+)?(tarefa|demanda)\s+/i, '')
                        .replace(/para\s+[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '')
                        .replace(/urgente.*$/gi, '')
                        .trim();
                }

                let extractedPriority = 'MEDIA';
                if (lowerText.includes('urgente') || lowerText.includes('crítica') || lowerText.includes('urgência')) {
                    extractedPriority = 'URGENTE';
                } else if (lowerText.includes('alta')) {
                    extractedPriority = 'ALTA';
                }

                const startDateObj = new Date();
                const startDateStr = startDateObj.toISOString().split('T')[0];

                const dueDateObj = new Date();
                dueDateObj.setDate(startDateObj.getDate() + 5);
                const dueDateStr = dueDateObj.toISOString().split('T')[0];

                const assignedMember = state.members.find(m => m.email === extractedEmail);

                const newDemand = {
                    id: Date.now(),
                    title: extractedTitle || 'Nova Demanda IA',
                    description: 'Criada automaticamente pela Cláudia IA.',
                    priority: extractedPriority,
                    status: extractedPriority === 'URGENTE' ? 'URGENT' : 'TODO',
                    start_date: startDateStr,
                    startDate: startDateStr,
                    due_date: dueDateStr,
                    dueDate: dueDateStr,
                    assigned_user_email: extractedEmail,
                    assignedUserEmail: extractedEmail,
                    assigned_user_name: assignedMember ? assignedMember.name : (extractedEmail || 'Equipe'),
                    creator_name: state.user?.name || 'Cláudia IA',
                    created_at: new Date().toISOString()
                };

                state.demands.unshift(newDemand);
                saveDemandsLocal();
                renderKanban();
                syncDemandToCalendar(newDemand);

                try {
                    const response = await fetchWithAuth('/api/demands', {
                        method: 'POST',
                        body: JSON.stringify(newDemand)
                    });
                    if (response.ok) {
                        const savedData = await response.json();
                        if (savedData && savedData.id) {
                            newDemand.id = savedData.id;
                            saveDemandsLocal();
                        }
                    }
                } catch (err) {
                    console.warn('Demanda registrada no cache local.');
                }

                appendChatMessage('Cláudia', `✅ Criei a demanda **"${extractedTitle}"** com prioridade **${extractedPriority}** ${extractedEmail ? `para **${extractedEmail}**` : ''}!\n\n📅 **Agendada no Kanban e no Calendário.**`, true);
                return;
            }

            // =========================================================
            // 7. CHAMADA AO BACKEND (FALLBACK CONVERSACIONAL)
            // =========================================================
            try {
                const response = await fetchWithAuth('/api/ai/process', {
                    method: 'POST',
                    body: JSON.stringify({
                        message: text,
                        mensagem: text,
                        contexto: { user: state.user, members: state.members, company: state.user?.companyName }
                    })
                });

                const data = await response.json().catch(() => ({}));

                if (!response.ok) {
                    // Plano sem acesso à IA (403) ou limite mensal de mensagens atingido (429):
                    // mostra a mensagem real do servidor em vez de um texto genérico que esconde o motivo.
                    if (data.texto) {
                        appendChatMessage('Cláudia', data.texto, true);
                        return;
                    }
                    throw new Error('Erro na requisição da IA');
                }

                if (data.response || data.texto) {
                    appendChatMessage('Cláudia', data.response || data.texto, true);
                } else {
                    appendChatMessage('Cláudia', 'Entendi sua solicitação!', true);
                }
            } catch (error) {
                console.error('Erro na resposta do backend da IA:', error);
                appendChatMessage('Cláudia', 'Processei sua dúvida localmente. Como posso ajudar mais com o seu painel?', true);
            }

        }, 500);
    };

    sendBtn.addEventListener('click', sendMessage);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}

async function handleAiCredentialConversationStep(text) {
    const flow = state.aiCredentialFlow;
    if (!flow) return;

    const trimmed = text.trim();
    const userRole = (state.user?.role || '').toUpperCase();
    const isManagerOrOwner = ['OWNER', 'MANAGER', 'DONO', 'GERENTE', 'ADMIN'].includes(userRole);

    // 1. Identificação do funcionário alvo caso não tenha sido informado
    if (flow.step === 'WAITING_TARGET') {
        const lowerInput = trimmed.toLowerCase();
        let target = null;
        let isSelf = false;

        if (lowerInput.includes('eu') || lowerInput.includes('minha') || lowerInput.includes('meu') || lowerInput === (state.user?.email || '').toLowerCase()) {
            target = state.user;
            isSelf = true;
        } else {
            target = (state.members || []).find(m =>
                (m.name && m.name.toLowerCase().includes(lowerInput)) ||
                (m.email && m.email.toLowerCase().includes(lowerInput))
            );
            if (!target && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(trimmed)) {
                target = { email: trimmed.toLowerCase(), name: trimmed };
            }
        }

        if (!target) {
            appendChatMessage('Cláudia', `⚠️ Não encontrei nenhum membro correspondente a **"${trimmed}"**.\n\nPor favor, digite o e-mail ou nome cadastrado (ou digite *cancelar*):`, true);
            return;
        }

        if (!isSelf && !isManagerOrOwner) {
            state.aiCredentialFlow = null;
            appendChatMessage('Cláudia', '🚫 **Acesso Negado**\n\nApenas gerentes ou donos do workspace possuem permissão para alterar credenciais de outros membros.', true);
            return;
        }

        flow.targetEmail = target.email;
        flow.targetName = target.name || target.email;
        flow.isSelf = isSelf;

        if (flow.type === 'PASSWORD') {
            flow.step = 'WAITING_OLD_PASSWORD';
            appendChatMessage('Cláudia', `🔐 **Alteração de Senha**\n\n• **Colaborador:** ${flow.targetName}\n• **E-mail:** ${flow.targetEmail}\n\nPor favor, informe a **senha antiga (atual)** do colaborador (ou digite *cancelar*):`, true);
        } else {
            flow.step = 'WAITING_PASSWORD_FOR_EMAIL';
            appendChatMessage('Cláudia', `📧 **Alteração de E-mail**\n\n• **Colaborador:** ${flow.targetName}\n• **E-mail atual:** ${flow.targetEmail}\n\nPor segurança, informe a **senha atual** para autorizar a alteração (ou digite *cancelar*):`, true);
        }
        return;
    }

    // 2. FLUXO DE SENHA
    if (flow.type === 'PASSWORD') {
        if (flow.step === 'WAITING_OLD_PASSWORD') {
            if (!trimmed) {
                appendChatMessage('Cláudia', 'Por favor, digite a **senha antiga** do colaborador para prosseguir:', true);
                return;
            }
            flow.oldPassword = trimmed;
            flow.step = 'WAITING_NEW_PASSWORD';
            appendChatMessage('Cláudia', `🔑 **Senha antiga registrada!**\n\nAgora digite a **nova senha** para **${flow.targetName}** *(mínimo de 4 caracteres)*:`, true);
            return;
        }

        if (flow.step === 'WAITING_NEW_PASSWORD') {
            if (trimmed.length < 4) {
                appendChatMessage('Cláudia', '⚠️ A nova senha deve ter no mínimo 4 caracteres. Por favor, tente novamente:', true);
                return;
            }
            flow.newPassword = trimmed;
            flow.step = 'WAITING_CONFIRM_PASSWORD';
            appendChatMessage('Cláudia', '🔁 Por favor, digite a **confirmação da nova senha**:', true);
            return;
        }

        if (flow.step === 'WAITING_CONFIRM_PASSWORD') {
            if (trimmed !== flow.newPassword) {
                flow.step = 'WAITING_NEW_PASSWORD';
                appendChatMessage('Cláudia', '⚠️ **As senhas não coincidem.**\n\nVamos tentar novamente: digite a **nova senha** desejada (ou digite *cancelar*):', true);
                return;
            }

            // Confirmação válida! Executa alteração no banco de dados
            try {
                const endpoint = flow.isSelf ? '/api/user/change-password' : '/api/users/update-employee-password';
                const bodyPayload = flow.isSelf
                    ? { oldPassword: flow.oldPassword, newPassword: flow.newPassword }
                    : { email: flow.targetEmail, oldPassword: flow.oldPassword, newPassword: flow.newPassword };

                const response = await fetchWithAuth(endpoint, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bodyPayload)
                });

                const data = await response.json();

                if (response.ok && data.success) {
                    const member = (state.members || []).find(m => m.email.toLowerCase() === flow.targetEmail.toLowerCase());
                    if (member) member.password = flow.newPassword;

                    appendChatMessage('Cláudia', `✅ **Senha atualizada com sucesso!**\n\n• **Colaborador:** ${flow.targetName}\n• **E-mail:** ${flow.targetEmail}\n• **Status:** Salvo e atualizado no banco de dados.`, true);
                } else {
                    appendChatMessage('Cláudia', `❌ **Não foi possível alterar a senha**\n\n${data.message || 'A senha antiga informada está incorreta no banco de dados.'}`, true);
                }
            } catch (err) {
                console.error('Erro ao atualizar senha via IA:', err);
                appendChatMessage('Cláudia', '❌ Erro de conexão com o servidor ao atualizar senha no banco de dados.', true);
            }
            state.aiCredentialFlow = null;
            return;
        }
    }

    // 3. FLUXO DE E-MAIL
    if (flow.type === 'EMAIL') {
        if (flow.step === 'WAITING_PASSWORD_FOR_EMAIL') {
            if (!trimmed) {
                appendChatMessage('Cláudia', 'Por favor, digite a **senha atual** para autorizar a alteração:', true);
                return;
            }
            flow.password = trimmed;
            flow.step = 'WAITING_NEW_EMAIL';
            appendChatMessage('Cláudia', `🔑 **Autorização recebida!**\n\nAgora digite o **novo endereço de e-mail** para **${flow.targetName}**:`, true);
            return;
        }

        if (flow.step === 'WAITING_NEW_EMAIL') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(trimmed)) {
                appendChatMessage('Cláudia', '⚠️ O e-mail informado parece inválido. Por favor, digite um e-mail válido *(ex: colaborador@empresa.com)*:', true);
                return;
            }
            flow.newEmail = trimmed.toLowerCase();
            flow.step = 'WAITING_CONFIRM_EMAIL';
            appendChatMessage('Cláudia', '🔁 Por favor, digite a **confirmação do novo e-mail**:', true);
            return;
        }

        if (flow.step === 'WAITING_EMAIL_CODE') {
            const code = trimmed.replace(/\D/g, '');
            if (code.length !== 6) {
                appendChatMessage('Cláudia', '⚠️ O código tem **6 dígitos**. Digite o código recebido no novo e-mail (ou *cancelar*):', true);
                return;
            }
            try {
                const response = await fetchWithAuth('/api/users/change-email/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });
                const data = await response.json().catch(() => ({}));
                if (response.ok && data.success) {
                    const oldEmail = state.user ? state.user.email : '';
                    if (state.user) {
                        state.user.email = data.newEmail || flow.newEmail;
                        if (data.token) {
                            state.token = data.token;
                            localStorage.setItem('klweb_token', data.token);
                            if (typeof connectSupportSocket === 'function') connectSupportSocket(); // o servidor fechou o socket antigo
                        }
                        localStorage.setItem('klweb_user', JSON.stringify(state.user));
                        if (typeof updateUserProfileUI === 'function') updateUserProfileUI();
                    }
                    if (typeof loadCompanyMembers === 'function') loadCompanyMembers();
                    appendChatMessage('Cláudia', `✅ **E-mail confirmado e atualizado!**\n\n• **E-mail anterior:** ${oldEmail}\n• **Novo e-mail:** ${data.newEmail || flow.newEmail}\n• **Status:** Você já está usando o novo e-mail.`, true);
                    state.aiCredentialFlow = null;
                } else if (data.code === 'EMAIL_CHANGE_RESTART') {
                    appendChatMessage('Cláudia', `❌ ${data.message || 'Não foi possível confirmar.'} Se quiser tentar de novo, peça "Trocar meu e-mail".`, true);
                    state.aiCredentialFlow = null;
                } else {
                    appendChatMessage('Cláudia', `❌ ${data.message || 'Código incorreto.'} Digite o código novamente (ou *cancelar*):`, true);
                }
            } catch (err) {
                console.error('Erro ao confirmar e-mail via IA:', err);
                appendChatMessage('Cláudia', '❌ Erro de conexão com o servidor ao confirmar o código.', true);
            }
            return;
        }

        if (flow.step === 'WAITING_CONFIRM_EMAIL') {
            if (trimmed.toLowerCase() !== flow.newEmail) {
                flow.step = 'WAITING_NEW_EMAIL';
                appendChatMessage('Cláudia', '⚠️ **Os e-mails informados não coincidem.**\n\nPor favor, digite o **novo e-mail** novamente (ou digite *cancelar*):', true);
                return;
            }

            // Trocar o PRÓPRIO e-mail: pede o código e espera a confirmação (passo WAITING_EMAIL_CODE).
            if (flow.isSelf) {
                try {
                    const reqRes = await fetchWithAuth('/api/users/change-email/request', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: flow.password, newEmail: flow.newEmail })
                    });
                    const reqData = await reqRes.json().catch(() => ({}));
                    if (reqRes.ok && reqData.success) {
                        flow.step = 'WAITING_EMAIL_CODE';
                        appendChatMessage('Cláudia', `📧 Enviei um **código de 6 dígitos** para **${flow.newEmail}**. Digite o código aqui (vale por ${reqData.expiresInMinutes || 10} minutos) ou digite *cancelar*:`, true);
                        return;
                    }
                    appendChatMessage('Cláudia', `❌ **Não foi possível enviar o código**\n\n${reqData.message || 'Senha incorreta ou novo e-mail já em uso.'}`, true);
                } catch (err) {
                    console.error('Erro ao pedir código de e-mail via IA:', err);
                    appendChatMessage('Cláudia', '❌ Erro de conexão com o servidor ao pedir o código.', true);
                }
                state.aiCredentialFlow = null;
                return;
            }

            try {
                const endpoint = flow.isSelf ? '/api/user/change-email' : '/api/users/update-employee-email';
                const bodyPayload = flow.isSelf
                    ? { password: flow.password, newEmail: flow.newEmail }
                    : { email: flow.targetEmail, password: flow.password, newEmail: flow.newEmail };

                const response = await fetchWithAuth(endpoint, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bodyPayload)
                });

                const data = await response.json();

                if (response.ok && data.success) {
                    const cleanNew = flow.newEmail;
                    if (state.members) {
                        const m = state.members.find(x => x.email.toLowerCase() === flow.targetEmail.toLowerCase());
                        if (m) m.email = cleanNew;
                        if (typeof renderCompanyMembers === 'function') renderCompanyMembers();
                        if (typeof updateAssigneeDropdowns === 'function') updateAssigneeDropdowns();
                    }

                    if (flow.isSelf && state.user) {
                        state.user.email = cleanNew;
                        if (data.token) {
                            state.token = data.token;
                            localStorage.setItem('klweb_token', data.token);
                        }
                        localStorage.setItem('klweb_user', JSON.stringify(state.user));
                        if (typeof updateUserProfileUI === 'function') updateUserProfileUI();
                    }

                    appendChatMessage('Cláudia', `✅ **E-mail atualizado com sucesso!**\n\n• **Colaborador:** ${flow.targetName}\n• **E-mail anterior:** ${flow.targetEmail}\n• **Novo e-mail:** ${cleanNew}\n• **Status:** Salvo e atualizado no banco de dados.`, true);
                } else {
                    appendChatMessage('Cláudia', `❌ **Não foi possível alterar o e-mail**\n\n${data.message || 'Senha incorreta ou novo e-mail já em uso.'}`, true);
                }
            } catch (err) {
                console.error('Erro ao atualizar e-mail via IA:', err);
                appendChatMessage('Cláudia', '❌ Erro de conexão com o servidor ao atualizar e-mail no banco de dados.', true);
            }
            state.aiCredentialFlow = null;
            return;
        }
    }
}

function appendChatMessage(sender, text, isAi = false) {
    const chat = document.getElementById('chat-messages');
    if (!chat) return;

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isAi ? 'ai-bubble' : 'user-bubble'}`;

    const formattedText = text
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

    const avatarHtml = (isAi && sender === 'Cláudia')
        ? `<img src="assets/claudia-avatar.jpg" alt="Cláudia" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid #8B5CF6;">`
        : `<i class="fa-solid ${isAi ? 'fa-robot' : 'fa-user'}"></i>`;

    bubble.innerHTML = `
        <div class="bubble-avatar">
            ${avatarHtml}
        </div>
        <div class="bubble-content">
            <div class="bubble-sender">${sender}</div>
            <div class="bubble-text">${formattedText}</div>
        </div>
    `;

    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
}

function appendTypingIndicator() {
    const chat = document.getElementById('chat-messages');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ai-bubble';

    bubble.innerHTML = `
        <div class="bubble-avatar">
            <img src="assets/claudia-avatar.jpg" alt="Cláudia" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid #8B5CF6;">
        </div>
        <div class="bubble-content">
            <p><i class="fa-solid fa-spinner fa-spin"></i> Cláudia está analisando sua solicitação...</p>
        </div>
    `;
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
}

function setAiPrompt(text) {
    const input = document.getElementById('ai-input');
    if (input) {
        input.value = text;
        input.focus();
    }
}

// ==================== CRM & CONTATOS COMPLETOS ====================
async function loadContacts() {
    try {
        const res = await fetchWithAuth('/api/contacts');
        if (res.ok) {
            const serverContacts = await res.json();
            if (Array.isArray(serverContacts)) {
                state.contacts = serverContacts;
                saveContactsLocal();
            }
        }
    } catch (err) {
        console.warn('API indisponível, utilizando contatos em cache local.');
    }
    renderContacts();
}

function renderContacts() {
    const tbody = document.getElementById('crm-body');
    if (!tbody) return;

    if (state.contacts.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">
                    Nenhum contato cadastrado no CRM ainda. Clique em "Novo Contato" acima.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = state.contacts.map(c => {
        const cleanPhone = (c.phone || '').replace(/\D/g, '');
        const formattedPhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
        const waUrl = `https://api.whatsapp.com/send?phone=${formattedPhone}&text=${encodeURIComponent(`Olá, ${c.name}! Tudo bem? Entramos em contato a respeito da ${state.user.companyName || 'nossa empresa'}.`)}`;
        const companyRole = [c.company_name, c.role].filter(Boolean).join(' - ') || 'Cliente';

        return `
            <tr>
                <td><strong>${escapeHtml(c.name)}</strong></td>
                <td><span style="color: var(--accent); font-size: 0.82rem;"><i class="fa-solid fa-briefcase"></i> ${escapeHtml(c.company_name || 'Cliente')}</span></td>
                <td><i class="fa-solid fa-phone" style="color: var(--accent); margin-right: 0.3rem;"></i> ${escapeHtml(c.phone)}</td>
                <td>${c.email ? `<i class="fa-solid fa-envelope" style="color: var(--text-muted); margin-right: 0.3rem;"></i> ${escapeHtml(c.email)}` : '-'}</td>
                <td style="color: var(--text-secondary);">${escapeHtml(c.notes || '-')}</td>
                <td style="text-align: right; white-space: nowrap;">
                    <a href="${waUrl}" target="_blank" class="btn-wa-direct" title="Abrir conversa no WhatsApp">
                        <i class="fa-brands fa-whatsapp"></i> WhatsApp
                    </a>
                    ${c.email ? `
                        <button class="btn-email-direct" onclick="openContactEmailModal('${c.email}', '${escapeHtml(c.name)}')" title="Enviar E-mail Direto">
                            <i class="fa-solid fa-envelope"></i> E-mail
                        </button>
                    ` : ''}
                    <button class="btn-del-contact" onclick="deleteContact(${c.id})" title="Excluir Contato">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

function openNewContactModal() {
    document.getElementById('modal-contact').style.display = 'flex';
    document.getElementById('contact-name').focus();
}

function closeNewContactModal() {
    document.getElementById('modal-contact').style.display = 'none';
    document.getElementById('contact-name').value = '';
    document.getElementById('contact-company').value = '';
    document.getElementById('contact-role').value = '';
    document.getElementById('contact-phone').value = '';
    document.getElementById('contact-email').value = '';
    document.getElementById('contact-notes').value = '';
}

async function submitNewContact() {
    const name = document.getElementById('contact-name').value.trim();
    const companyName = document.getElementById('contact-company').value.trim();
    const role = document.getElementById('contact-role').value.trim();
    const phone = document.getElementById('contact-phone').value.trim();
    const email = document.getElementById('contact-email').value.trim();
    const notes = document.getElementById('contact-notes').value.trim();

    if (!name || !phone) {
        showToast('Nome e Telefone são campos obrigatórios.', 'error');
        return;
    }

    try {
        const res = await fetchWithAuth('/api/contacts', {
            method: 'POST',
            body: JSON.stringify({ name, companyName, role, phone, email, notes })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            showToast(data.message || 'Erro ao salvar contato no CRM.', 'error');
            return;
        }
    } catch (err) {
        console.error('Erro ao salvar contato:', err);
        showToast('Erro de conexão ao salvar contato.', 'error');
        return;
    }

    // DISPARO DE NOTIFICAÇÃO DUPLA (PAINEL + E-MAIL)
    const notifTitle = `Novo Contato Cadastrado no CRM`;
    const notifMsg = `O contato "${name}" (${companyName || 'Cliente'}) foi adicionado ao CRM com o telefone ${phone} e e-mail ${email || 'não informado'}.`;

    await notifyUserDualChannel(state.user.email, notifTitle, notifMsg, 'info');

    showToast('Contato salvo no CRM com sucesso!', 'success');
    closeNewContactModal();
    await loadContacts(); // recarrega do servidor: agora visível para toda a equipe
}

async function deleteContact(id) {
    if (!confirm('Deseja realmente excluir este contato?')) return;
    try {
        const res = await fetchWithAuth(`/api/contacts/${id}`, { method: 'DELETE' });
        if (!res.ok) {
            showToast('Erro ao remover contato no servidor.', 'error');
            return;
        }
    } catch (err) {
        console.error('Erro ao remover contato:', err);
        showToast('Erro de conexão ao remover contato.', 'error');
        return;
    }
    state.contacts = state.contacts.filter(c => c.id !== id);
    saveContactsLocal();
    renderContacts();
    showToast('Contato removido do CRM.', 'info');
}

function openContactEmailModal(email, name) {
    document.getElementById('modal-contact-email').style.display = 'flex';
    document.getElementById('direct-email-recipient').value = email;
    document.getElementById('direct-email-message').value = `Olá, ${name}!\n\nEsperamos que esteja bem. Entramos em contato através da ${state.user.companyName || 'nossa empresa'} a respeito da sua solicitação.\n\nAtenciosamente,\nEquipe ${state.user.companyName || 'Corporativa'}`;
}

function closeContactEmailModal() {
    document.getElementById('modal-contact-email').style.display = 'none';
}

function sendDirectContactEmail() {
    showToast('E-mail enviado com sucesso!', 'success');
    closeContactEmailModal();
}

function sendQuickAutomation() {
    const channel = document.getElementById('auto-channel').value;
    const recipient = document.getElementById('auto-recipient').value.trim();
    const message = document.getElementById('auto-message').value.trim();

    if (!recipient || !message) {
        showToast('Informe o destinatário e a mensagem para disparo.', 'error');
        return;
    }

    if (channel === 'WHATSAPP') {
        const cleanPhone = recipient.replace(/\D/g, '');
        const waUrl = `https://api.whatsapp.com/send?phone=${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}&text=${encodeURIComponent(message)}`;
        window.open(waUrl, '_blank');
        showToast('Conversa do WhatsApp iniciada com sucesso!', 'success');
    } else {
        showToast('Mensagem por e-mail disparada com sucesso!', 'success');
    }
}

// ==================== EMPRESA, ATRIBUIÇÃO & CONEXÕES DE MEMBROS ====================
async function loadCompanyMembers() {
    try {
        const response = await fetchWithAuth('/api/company/members');
        if (response.ok) {
            const serverMembers = await response.json();
            if (Array.isArray(serverMembers)) {
                state.members = serverMembers;
                saveMembersLocal();
            }
        }
    } catch (err) {
        console.warn('API indisponível, utilizando conexões locais.');
    }
    renderCompanyMembers();
    updateAssigneeDropdowns();
}

function updateAssigneeDropdowns() {
    const assigneeSelect = document.getElementById('demand-assignee');
    const filterSelect = document.getElementById('kanban-assignee-filter');
    const directAssignSelect = document.getElementById('assign-user-email');

    const optionsHtml = state.members.map(m => `<option value="${m.email}">${m.name} (${m.email})</option>`).join('');

    if (assigneeSelect) {
        assigneeSelect.innerHTML = '<option value="">Nenhum (Qualquer membro da equipe)</option>' + optionsHtml;
    }

    if (directAssignSelect) {
        directAssignSelect.innerHTML = '<option value="">Selecione o funcionário cadastrado...</option>' + optionsHtml;
    }

    if (filterSelect) {
        const currentVal = filterSelect.value;
        filterSelect.innerHTML = '<option value="ALL">Todos os Responsáveis</option><option value="MINE">Atribuídas a Mim</option>' +
            state.members.map(m => `<option value="${m.email}">${m.name}</option>`).join('');
        filterSelect.value = currentVal || 'ALL';
    }
}

function renderCompanyMembers() {
    const list = document.getElementById('company-members-list');
    const countTag = document.getElementById('company-members-count');
    if (!list) return;

    if (countTag) countTag.innerText = `${state.members.length} Conexões`;

    if (state.members.length === 0) {
        list.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Nenhum outro colaborador conectado.</p>';
        return;
    }

    const userRole = (state.user?.role || '').toUpperCase();
    const isManagerOrOwner = userRole === 'OWNER' || userRole === 'MANAGER' || userRole.includes('GERENTE') || userRole.includes('DONO');
    const isOwner = state.user?.companyRole === 'OWNER' || userRole === 'OWNER';

    list.innerHTML = state.members.map(m => {
        const isSelf = m.id === state.user.id || m.email.toLowerCase() === state.user.email.toLowerCase();
        const currentRole = m.role || 'USER';
        const roleDisplay = currentRole === 'OWNER' ? 'Dono' : currentRole === 'MANAGER' || currentRole === 'Gerente' ? 'Gerente' : 'Funcionário';

        return `
            <div class="member-item" style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; border-bottom: 1px solid var(--border);">
                <div class="member-info">
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                        <div class="member-avatar">${(m.name || 'F').charAt(0).toUpperCase()}</div>
                        <div>
                            <strong>${escapeHtml(m.name)} ${isSelf ? '<span style="color: var(--accent); font-size: 0.75rem;">(Você)</span>' : ''}</strong>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">
                                <i class="fa-solid fa-envelope"></i> ${escapeHtml(m.email)} ${m.phone ? `| <i class="fa-solid fa-phone"></i> ${escapeHtml(m.phone)}` : ''}
                            </div>
                        </div>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                    <span class="step-tag">${roleDisplay}</span>

                    ${(!isSelf && isOwner && currentRole !== 'OWNER') ? `
                        <select onchange="changeUserRole(${m.id}, this.value)" style="padding: 0.3rem; font-size: 0.78rem; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text);">
                            <option value="USER" ${currentRole === 'USER' ? 'selected' : ''}>Funcionário</option>
                            <option value="MANAGER" ${currentRole === 'MANAGER' ? 'selected' : ''}>Gerente</option>
                        </select>
                    ` : ''}

                    ${(!isSelf && isManagerOrOwner && (currentRole !== 'OWNER' || isOwner)) ? `
                        <button class="btn-secondary" onclick="managerResetMemberPassword('${escapeHtml(m.email)}', '${escapeHtml(m.name)}')" style="padding: 0.35rem 0.6rem; font-size: 0.75rem;" title="Redefinir senha deste colaborador">
                            <i class="fa-solid fa-key"></i> Senha
                        </button>
                        <button class="btn-secondary" onclick="managerChangeMemberEmail('${escapeHtml(m.email)}', '${escapeHtml(m.name)}')" style="padding: 0.35rem 0.6rem; font-size: 0.75rem;" title="Alterar e-mail deste colaborador">
                            <i class="fa-solid fa-at"></i> E-mail
                        </button>
                        <button class="btn-del-member" onclick="removeCompanyMember(${m.id}, '${escapeHtml(m.name)}', '${escapeHtml(m.email)}')" style="padding: 0.35rem 0.6rem; font-size: 0.75rem;" title="Remover conexão">
                            <i class="fa-solid fa-user-minus"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

async function managerChangeMemberEmail(oldEmail, targetName) {
    const userRole = (state.user?.role || '').toUpperCase();
    const isManagerOrOwner = userRole === 'OWNER' || userRole === 'MANAGER' || userRole.includes('GERENTE') || userRole.includes('DONO');

    if (!isManagerOrOwner) {
        showToast('Apenas Gerentes ou o Dono da empresa podem alterar e-mails de colaboradores.', 'error');
        return;
    }

    const newEmail = prompt(`Digite o NOVO E-MAIL para o colaborador/gerente ${targetName} (E-mail atual: ${oldEmail}):`);
    if (!newEmail || !newEmail.includes('@')) {
        if (newEmail !== null) showToast('Informe um endereço de e-mail válido.', 'error');
        return;
    }

    const cleanNewEmail = newEmail.trim().toLowerCase();

    if (cleanNewEmail !== oldEmail.toLowerCase() && checkEmailExists(cleanNewEmail)) {
        showToast('Este novo e-mail já está em uso por outro usuário no sistema.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/company/update-member-email', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetEmail: oldEmail, newEmail: cleanNewEmail })
        });

        const contentType = response.headers.get('content-type') || '';
        let data = {};
        if (contentType.includes('application/json')) data = await response.json();

        if (response.ok && data.success) {
            if (data.requiresCode) {
                // Mostrar modal para inserir código
                state.pendingManagerEmailChange = { targetEmail: oldEmail, newEmail: cleanNewEmail, targetName };
                const code = prompt(`Código enviado para ${cleanNewEmail}. Digite o código de 6 dígitos:`);
                if (code && code.replace(/\D/g, '').length === 6) {
                    await confirmManagerEmailChange(code.replace(/\D/g, ''));
                } else {
                    showToast('Código inválido ou cancelado.', 'error');
                    state.pendingManagerEmailChange = null;
                }
            } else {
                showToast(data.message || 'E-mail alterado com sucesso!', 'success');
                const member = state.members.find(m => m.email.toLowerCase() === oldEmail.toLowerCase());
                if (member) member.email = cleanNewEmail;
                saveMembersLocal();
                const dbUser = state.users_db.find(u => u.email.toLowerCase() === oldEmail.toLowerCase());
                if (dbUser) dbUser.email = cleanNewEmail;
                saveUsersDBLocal();
                state.demands.forEach(d => {
                    if (d.assigned_user_email && d.assigned_user_email.toLowerCase() === oldEmail.toLowerCase()) {
                        d.assigned_user_email = cleanNewEmail;
                    }
                });
                saveDemandsLocal();
                renderCompanyMembers();
                updateAssigneeDropdowns();
            }
        } else {
            showToast(data.message || 'Erro ao alterar e-mail.', 'error');
        }
    } catch (error) {
        console.error('Erro ao alterar e-mail do colaborador:', error);
        showToast('Erro de conexão ao alterar e-mail.', 'error');
    }
}

async function confirmManagerEmailChange(code) {
    if (!state.pendingManagerEmailChange) {
        showToast('Nenhuma troca de e-mail pendente.', 'error');
        return;
    }

    const { targetEmail, newEmail, targetName } = state.pendingManagerEmailChange;

    try {
        const response = await fetchWithAuth('/api/company/confirm-member-email-change', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetEmail, code })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(data.message || 'E-mail alterado com sucesso!', 'success');
            const member = state.members.find(m => m.email.toLowerCase() === targetEmail.toLowerCase());
            if (member) member.email = newEmail;
            saveMembersLocal();
            const dbUser = state.users_db.find(u => u.email.toLowerCase() === targetEmail.toLowerCase());
            if (dbUser) dbUser.email = newEmail;
            saveUsersDBLocal();
            state.demands.forEach(d => {
                if (d.assigned_user_email && d.assigned_user_email.toLowerCase() === targetEmail.toLowerCase()) {
                    d.assigned_user_email = newEmail;
                }
            });
            saveDemandsLocal();
            renderCompanyMembers();
            updateAssigneeDropdowns();
            state.pendingManagerEmailChange = null;
            // Atualizar painel master se estiver aberto
            if (typeof loadMasterUsersList === 'function') loadMasterUsersList();
        } else {
            showToast(data.message || 'Código inválido.', 'error');
            if (data.message && (data.message.includes('expirou') || data.message.includes('tentativas'))) {
                state.pendingManagerEmailChange = null;
            }
        }
    } catch (error) {
        console.error('Erro ao confirmar e-mail:', error);
        showToast('Erro de conexão ao confirmar e-mail.', 'error');
    }
}

async function managerResetMemberPassword(targetEmail, targetName) {
    const userRole = (state.user?.role || '').toUpperCase();
    const isManagerOrOwner = userRole === 'OWNER' || userRole === 'MANAGER' || userRole.includes('GERENTE') || userRole.includes('DONO');

    if (!isManagerOrOwner) {
        showToast('Apenas Gerentes ou o Dono da empresa podem redefinir senhas.', 'error');
        return;
    }

    const newPassword = prompt(`Digite a NOVA SENHA para o colaborador/gerente ${targetName} (${targetEmail}):`);
    if (!newPassword || newPassword.trim().length < 4) {
        if (newPassword !== null) showToast('A senha deve ter no mínimo 4 caracteres.', 'error');
        return;
    }

    const cleanPassword = newPassword.trim();

    try {
        const response = await fetchWithAuth('/api/company/reset-member-password', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetEmail, newPassword: cleanPassword })
        });

        const contentType = response.headers.get('content-type') || '';
        let data = {};
        if (contentType.includes('application/json')) data = await response.json();

        if (response.ok && data.success) {
            if (data.requiresCode) {
                // Mostrar prompt para inserir código
                state.pendingManagerPasswordChange = { targetEmail, newPassword: cleanPassword, targetName };
                const code = prompt(`Código enviado para ${targetEmail}. Digite o código de 6 dígitos:`);
                if (code && code.replace(/\D/g, '').length === 6) {
                    await confirmManagerPasswordChange(code.replace(/\D/g, ''));
                } else {
                    showToast('Código inválido ou cancelado.', 'error');
                    state.pendingManagerPasswordChange = null;
                }
            } else {
                showToast(data.message || 'Senha alterada com sucesso!', 'success');
            }
        } else {
            showToast(data.message || 'Erro ao alterar senha.', 'error');
        }
    } catch (error) {
        console.error('Erro ao solicitar reset de senha do colaborador:', error);
        showToast('Erro de conexão ao alterar senha.', 'error');
    }
}

async function confirmManagerPasswordChange(code) {
    if (!state.pendingManagerPasswordChange) {
        showToast('Nenhuma troca de senha pendente.', 'error');
        return;
    }

    const { targetEmail, targetName } = state.pendingManagerPasswordChange;

    try {
        const response = await fetchWithAuth('/api/company/confirm-member-password-change', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetEmail, code })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(data.message || 'Senha alterada com sucesso!', 'success');
            state.pendingManagerPasswordChange = null;
            // Atualizar painel master se estiver aberto
            if (typeof loadMasterUsersList === 'function') loadMasterUsersList();
        } else {
            showToast(data.message || 'Código inválido.', 'error');
            if (data.message && (data.message.includes('expirou') || data.message.includes('tentativas'))) {
                state.pendingManagerPasswordChange = null;
            }
        }
    } catch (error) {
        console.error('Erro ao confirmar senha:', error);
        showToast('Erro de conexão ao confirmar senha.', 'error');
    }
}

async function addCompanyMember() {
    const emailInput = document.getElementById('member-email');
    const roleSelect = document.getElementById('member-role');
    const memberEmail = emailInput.value.trim();
    const roleValue = roleSelect ? roleSelect.value : 'USER';
    const roleLabel = roleValue === 'MANAGER' ? 'Gerente' : 'Funcionário';

    if (!memberEmail || !memberEmail.includes('@')) {
        showToast('Informe um e-mail corporativo válido para o colaborador.', 'error');
        return;
    }

    const existing = state.members.find(m => m.email.toLowerCase() === memberEmail.toLowerCase());
    if (existing) {
        showToast('Este e-mail já está conectado à equipe.', 'info');
        return;
    }

    const nameFromEmail = memberEmail.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);

    const newMember = {
        id: Date.now(),
        name: formattedName,
        email: memberEmail,
        role: roleLabel,
        phone: '(Sem telefone)'
    };

    try {
        const response = await fetchWithAuth('/api/company/add-member', {
            method: 'POST',
            body: JSON.stringify({ memberEmail, role: roleValue })
        });

        const data = await response.json();
        if (!response.ok) {
            showToast(data.message || 'Não foi possível adicionar esta conexão.', 'error');
            return;
        }
    } catch (err) {
        showToast('Erro de conexão com o servidor ao adicionar o e-mail.', 'error');
    }
}

    try {
        await fetch('/api/demands/assign', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify(newDemand)
        });
    } catch (err) {
        console.warn('Salvo localmente.');
    }
}

async function removeCompanyMember(memberId, name, email) {
    const userRole = (state.user?.role || '').toLowerCase();
    const isManagerOrOwner = userRole === 'owner' || userRole.includes('gerente') || userRole.includes('dono') || userRole.includes('manager');

    if (!isManagerOrOwner) {
        showToast('Apenas gerentes ou o dono da empresa podem desvincular contas.', 'error');
        return;
    }

    const targetEmail = email || (state.members.find(m => m.id === memberId)?.email);

    if (!confirm(`Tem certeza de que deseja remover o e-mail (${targetEmail}) desta conexão? A conta será preservada.`)) {
        return;
    }

    try {
        const response = await fetchWithAuth(`/api/company/members/${memberId}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.message || 'Não foi possível remover a conexão.', 'error');
            return;
        }

        state.members = state.members.filter(member => member.id !== memberId);
        saveMembersLocal();
        renderCompanyMembers();
        updateAssigneeDropdowns();
        showToast(data.message || `${name} removido da conexão.`, 'success');
    } catch (err) {
        showToast('Erro de conexão com o servidor ao remover o e-mail.', 'error');
    }
}

async function replaceCompanyMember() {
    const oldEmailInput = document.getElementById('replace-old-email');
    const newEmailInput = document.getElementById('replace-new-email');

    const oldEmail = oldEmailInput.value.trim();
    const newEmail = newEmailInput.value.trim();

    if (!oldEmail || !newEmail) {
        showToast('Informe o e-mail antigo e o novo e-mail cadastrado.', 'error');
        return;
    }

    try {
        const res = await fetchWithAuth('/api/company/replace-member', {
            method: 'POST',
            body: JSON.stringify({ oldMemberEmail: oldEmail, newMemberEmail: newEmail })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            showToast(data.message || 'Erro ao transferir a conexão.', 'error');
            return;
        }

        showToast(data.message || 'Conexão transferida com sucesso sem perda de histórico!', 'success');
        if (data.aiBriefing) {
            appendChatMessage('Cláudia', `📋 **Briefing de transição:**\n\n${data.aiBriefing}`, true);
        }
    } catch (err) {
        console.error('Erro ao transferir conexão:', err);
        showToast('Erro de conexão com o servidor.', 'error');
        return;
    }

    oldEmailInput.value = '';
    newEmailInput.value = '';
    await loadCompanyMembers();
    await loadDemands();
}

// ==================== PLANOS DE ASSINATURA ====================

function updatePlanCardsUI() {
    loadPlanFeatures();
    const currentTier = state.user ? (state.user.planTier || 'BASICO') : 'BASICO';

    const planConfig = [
        { id: 'BASICO', label: 'Plano Gratuito', class: 'btn-plan btn-secondary' },
        { id: 'STARTER', label: 'Assinar Starter', class: 'btn-plan btn-primary' },
        { id: 'PRO_IA', label: 'Assinar Pro AI', class: 'btn-plan btn-secondary' }
    ];

    planConfig.forEach(plan => {
        const btn = document.getElementById(`btn-select-${plan.id}`);
        if (btn) {
            if (plan.id === currentTier) {
                btn.innerText = 'Plano Atual Ativo';
                btn.className = 'btn-plan active-plan-btn';
                btn.disabled = true;
            } else {
                btn.innerText = plan.label;
                btn.className = plan.class;
                btn.disabled = false;
            }
        }
    });
}

function assinarPlano(tipoPlano) {
    const planTier = { starter: 'STARTER', pro: 'PRO_IA' }[String(tipoPlano).toLowerCase()]
        || String(tipoPlano).toUpperCase();
    if (['STARTER', 'PRO_IA'].includes(planTier)) return startPlanCheckout(planTier);
    showToast('Plano inválido.', 'error');
}

// Função para selecionar plano na página inicial e redirecionar
function selectPlanAndRedirect(planTier) {
    // Salvar o plano selecionado para usar após login/cadastro
    localStorage.setItem('klweb_selected_plan', planTier);

    // Verificar se o usuário já está logado
    const token = localStorage.getItem('klweb_token');
    const user = localStorage.getItem('klweb_user');

    if (token && user) {
        // Usuário já está logado - redirecionar para o painel
        const userData = JSON.parse(user);
        if (userData.planTier && normalizePlanTier(userData.planTier) === planTier) {
            showToast('Você já está no plano ' + planTier + '!', 'info');
            return;
        }
        // Redirecionar para aba de planos no painel
        if (typeof switchTab === 'function') {
            switchTab('plans');
        }
    } else {
        // Usuário não está logado - redirecionar para cadastro
        openAuthentication('register');
    }
}

// Gera uma assinatura vinculada ao usuário logado (com external_reference correto), em vez
// de usar o link estático de assinatura, que não identifica quem pagou nem qual plano.
async function startPlanCheckout(planTier) {
    const token = state.token || localStorage.getItem('klweb_token');
    if (!token) {
        showToast('Faça login antes de assinar um plano.', 'error');
        return;
    }

    const expireSession = () => {
        logout();
        showToast('Sua sessão expirou. Entre novamente para assinar o plano.', 'error');
        if (typeof showAuthScreen === 'function') showAuthScreen();
    };

    // O Mercado Pago só deixa pagar com a conta cujo e-mail é igual ao informado aqui.
    // Se a pessoa usa outro e-mail no Mercado Pago, ela digita esse e-mail (ficará guardado neste navegador).
    const suggested = localStorage.getItem('klweb_mp_email') || (state.user && state.user.email) || '';
    const typed = window.prompt(
        'Digite o e-mail da sua conta do Mercado Pago (o mesmo com o qual você vai entrar para pagar).\n' +
        'Se for o mesmo e-mail da KL Web, é só confirmar.',
        suggested
    );
    if (typed === null) return; // cancelou
    const payerEmail = typed.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
        showToast('Digite um e-mail válido da sua conta do Mercado Pago.', 'error');
        return;
    }
    localStorage.setItem('klweb_mp_email', payerEmail);

    try {
        const response = await fetch('/api/payments/subscribe', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ planTier, payerEmail })
        });

        const data = await response.json().catch(() => ({}));

        const sessionRejected = response.status === 401 ||
            (response.status === 403 && /sess[aã]o expirada/i.test(data.message || ''));
        if (sessionRejected) {
            // Confirma em outra rota se o login realmente venceu antes de deslogar a pessoa.
            const check = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } });
            if (check.status === 401 || check.status === 403) {
                expireSession();
            } else {
                console.error('Pagamentos recusou o token, mas /api/auth/me aceitou. Verifique o middleware de /api/payments/subscribe.', data);
                showToast(data.message || 'O servidor de pagamentos recusou sua sessão. Tente novamente ou fale com o suporte.', 'error');
            }
            return;
        }
        if (response.status === 403) {
            showToast(data.message || 'Você não tem permissão para assinar este plano.', 'error');
            return;
        }
        if (response.ok && data.initPoint) {
            window.location.href = data.initPoint;
        } else {
            showToast(data.message || 'Não foi possível iniciar o checkout de assinatura.', 'error');
        }
    } catch (err) {
        showToast('Erro ao conectar com o servidor de pagamentos.', 'error');
    }
}

function redirecionarParaCheckout(url) {
    window.open(url, '_blank');
}

async function assinarPlanoComToken(endpoint) {
    const token = localStorage.getItem('klweb_token');

    if (!token) {
        alert('Por favor, faça login antes de escolher um plano.');
        showAuthScreen();
        return;
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    });

    const data = await response.json();
    if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
    }
}

// ==================== PLAYBOOKS: COPIAR PROMPT ====================
function copyPrompt(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Prompt copiado! Cole no Chat da IA para testar.', 'success');
    }).catch(() => {
        showToast('Texto: ' + text, 'info');
    });
}

// ==================== TROCA DE SENHA PRÓPRIA (EXIGE SENHA ATUAL) ====================
async function changePassword() {
    const oldPasswordInput = document.getElementById('old-password');
    const newPasswordInput = document.getElementById('new-password');
    const confirmPasswordInput = document.getElementById('confirm-new-password');

    const oldPassword = oldPasswordInput ? oldPasswordInput.value.trim() : '';
    const newPassword = newPasswordInput ? newPasswordInput.value : '';
    const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';

    if (!state.user || !state.token) {
        showToast('Sua sessão expirou. Faça login novamente.', 'error');
        return;
    }

    if (!oldPassword) {
        showToast('Digite sua senha atual.', 'error');
        return;
    }

    if (!newPassword) {
        showToast('Digite a nova senha.', 'error');
        return;
    }

    if (newPassword.length < 4) {
        showToast('A nova senha deve possuir pelo menos 4 caracteres.', 'error');
        return;
    }

    if (newPassword !== confirmPassword) {
        showToast('A confirmação da nova senha não confere.', 'error');
        return;
    }

    if (oldPassword === newPassword) {
        showToast('A nova senha deve ser diferente da senha atual.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/auth/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                oldPassword: oldPassword,
                newPassword: newPassword
            })
        });

        let data = {};

        try {
            data = await response.json();
        } catch (e) {
            data = {};
        }

        if (!response.ok) {
            showToast(
                data.message ||
                data.error ||
                'Não foi possível alterar sua senha.',
                'error'
            );
            return;
        }

        if (data.requiresCode) {
            // Mostrar campo de código
            state.pendingPasswordChange = { newPassword };
            const codeGroup = document.getElementById('password-code-group');
            const hint = document.getElementById('password-code-hint');
            if (hint) hint.textContent = `Enviamos um código de 6 dígitos para ${state.user.email}. Ele vale por ${data.expiresInMinutes || 10} minutos.`;
            if (codeGroup) codeGroup.style.display = '';
            const codeInput = document.getElementById('password-change-code');
            if (codeInput) codeInput.focus();
            showToast(data.message, 'success');
            return;
        }

        /*
         * IMPORTANTE:
         * Não salvamos a nova senha no localStorage.
         *
         * A senha verdadeira deve existir somente no banco de dados
         * do servidor, normalmente armazenada através de hash.
         */

        if (oldPasswordInput) {
            oldPasswordInput.value = '';
        }

        if (newPasswordInput) {
            newPasswordInput.value = '';
        }

        if (confirmPasswordInput) {
            confirmPasswordInput.value = '';
        }

        showToast(
            data.message || 'Senha alterada com sucesso!',
            'success'
        );

    } catch (error) {
        console.error('Erro ao alterar senha:', error);

        showToast(
            'Não foi possível conectar ao servidor. A senha não foi alterada.',
            'error'
        );
    }
}

async function confirmPasswordChange() {
    const codeInput = document.getElementById('password-change-code');
    const code = codeInput ? codeInput.value.replace(/\D/g, '') : '';

    if (!state.pendingPasswordChange) {
        showToast('Peça o código primeiro.', 'error');
        return;
    }
    if (code.length !== 6) {
        showToast('Digite o código de 6 dígitos.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/auth/change-password/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        let data = {};
        try { data = await response.json(); } catch (e) { data = {}; }

        if (!response.ok || !data.success) {
            showToast(data.message || 'Código inválido.', 'error');
            if (data.message && (data.message.includes('expirou') || data.message.includes('tentativas'))) {
                resetPasswordChangeUI();
            }
            return;
        }

        const oldPasswordInput = document.getElementById('old-password');
        const newPasswordInput = document.getElementById('new-password');
        const confirmPasswordInput = document.getElementById('confirm-new-password');

        if (oldPasswordInput) oldPasswordInput.value = '';
        if (newPasswordInput) newPasswordInput.value = '';
        if (confirmPasswordInput) confirmPasswordInput.value = '';

        resetPasswordChangeUI();
        showToast(data.message || 'Senha alterada com sucesso!', 'success');
        // Atualizar painel master se estiver aberto
        if (typeof loadMasterUsersList === 'function') loadMasterUsersList();
    } catch (error) {
        console.error('Erro ao confirmar senha:', error);
        showToast('Não foi possível conectar ao servidor. A senha não foi alterada.', 'error');
    }
}

function resetPasswordChangeUI() {
    const codeGroup = document.getElementById('password-code-group');
    if (codeGroup) codeGroup.style.display = 'none';
    ['password-change-code', 'old-password', 'new-password', 'confirm-new-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    state.pendingPasswordChange = null;
}

// ==================== TROCA DE E-MAIL PRÓPRIO (EXIGE SENHA ATUAL) ====================
function resetEmailChangeUI() {
    const group = document.getElementById('email-code-group');
    if (group) group.style.display = 'none';
    ['email-change-code', 'email-confirm-password', 'new-email'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const sendBtn = document.getElementById('btn-email-send');
    if (sendBtn) sendBtn.disabled = false;
    state.pendingEmailChange = null;
}

// Passo 1: pede o código. Nada muda no banco até o código enviado ao NOVO e-mail ser confirmado.
async function changeEmail() {
    const passwordInput = document.getElementById('email-confirm-password');
    const newEmailInput = document.getElementById('new-email');

    const password = passwordInput ? passwordInput.value.trim() : '';
    const newEmail = newEmailInput ? newEmailInput.value.trim().toLowerCase() : '';

    if (!state.user || !state.token) {
        showToast('Sua sessão expirou. Faça login novamente.', 'error');
        return;
    }
    if (!password) {
        showToast('Digite sua senha atual para confirmar a alteração.', 'error');
        return;
    }
    if (!newEmail) {
        showToast('Digite o novo e-mail.', 'error');
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        showToast('Digite um e-mail válido.', 'error');
        return;
    }
    if (state.user.email && state.user.email.toLowerCase() === newEmail) {
        showToast('O novo e-mail é igual ao e-mail atual.', 'error');
        return;
    }

    const sendBtn = document.getElementById('btn-email-send');
    if (sendBtn) sendBtn.disabled = true;

    try {
        const response = await fetchWithAuth('/api/users/change-email/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password, newEmail })
        });
        let data = {};
        try { data = await response.json(); } catch (e) { data = {}; }

        if (!response.ok || !data.success) {
            showToast(data.message || data.error || 'Não foi possível enviar o código.', 'error');
            if (sendBtn) sendBtn.disabled = false;
            return;
        }

        state.pendingEmailChange = { newEmail: data.newEmail || newEmail };
        const group = document.getElementById('email-code-group');
        const hint = document.getElementById('email-code-hint');
        if (hint) hint.textContent = `Enviamos um código de 6 dígitos para ${state.pendingEmailChange.newEmail}. Ele vale por ${data.expiresInMinutes || 10} minutos.`;
        if (group) group.style.display = '';
        const codeInput = document.getElementById('email-change-code');
        if (codeInput) codeInput.focus();
        showToast(data.message || 'Código enviado para o novo e-mail.', 'success');
        // Libera o reenvio depois do tempo de espera do servidor
        setTimeout(() => { if (sendBtn) sendBtn.disabled = false; }, 60000);
    } catch (error) {
        console.error('Erro ao pedir código de e-mail:', error);
        showToast('Não foi possível conectar ao servidor. O e-mail não foi alterado.', 'error');
        if (sendBtn) sendBtn.disabled = false;
    }
}

// Passo 2: confirma o código; o servidor troca o e-mail e devolve um token novo (login já no e-mail novo).
async function confirmEmailChange() {
    const codeInput = document.getElementById('email-change-code');
    const code = codeInput ? codeInput.value.replace(/\D/g, '') : '';
    if (!state.pendingEmailChange) {
        showToast('Peça o código primeiro.', 'error');
        return;
    }
    if (code.length !== 6) {
        showToast('Digite o código de 6 dígitos.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/users/change-email/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        let data = {};
        try { data = await response.json(); } catch (e) { data = {}; }

        if (!response.ok || !data.success) {
            showToast(data.message || 'Código inválido.', 'error');
            if (data.code === 'EMAIL_CHANGE_RESTART') resetEmailChangeUI();
            return;
        }

        const confirmedEmail = data.newEmail || state.pendingEmailChange.newEmail;
        state.user.email = confirmedEmail;
        if (data.token) {
            state.token = data.token;
            localStorage.setItem('klweb_token', data.token);
            if (typeof connectSupportSocket === 'function') connectSupportSocket(); // o servidor fechou o socket antigo
        }
        localStorage.setItem('klweb_user', JSON.stringify(state.user));
        resetEmailChangeUI();
        updateUserProfileUI();
        if (typeof loadCompanyMembers === 'function') loadCompanyMembers();
        showToast(data.message || 'E-mail alterado com sucesso!', 'success');
    } catch (error) {
        console.error('Erro ao confirmar e-mail:', error);
        showToast('Não foi possível conectar ao servidor. O e-mail não foi alterado.', 'error');
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.toString().replace(/[&<>"']/g, m => map[m]);
}

// Para valores colocados dentro de onclick="funcao('...')": escapa primeiro como string JS
// (aspa simples/barra invertida) e só depois como atributo HTML. Fazer só o escapeHtml não basta
// aqui, porque o navegador decodifica as entidades do atributo ANTES de rodar o JS.
function escapeForInlineJs(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ==================== LÓGICA DE NOTIFICAÇÕES ====================
if (!Array.isArray(state.notifications)) {
    state.notifications = JSON.parse(localStorage.getItem('klweb_notifications') || '[]');
}

function toggleNotificationDropdown() {
    const dropdown = document.getElementById('notification-dropdown');
    if (!dropdown) return;

    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';

    if (!isVisible) {
        renderNotifications();
    }
}

document.addEventListener('click', (e) => {
    const wrapper = e.target.closest('.notification-wrapper');
    const dropdown = document.getElementById('notification-dropdown');
    if (!wrapper && dropdown) {
        dropdown.style.display = 'none';
    }
});

async function loadNotificationsFromBackend() {
    if (!state.token && (!state.user || !state.user.email)) return;
    try {
        const response = await fetch('/api/notifications', {
            headers: {
                'Authorization': `Bearer ${state.token}`
            }
        });
        if (response.ok) {
            const serverNotifs = await response.json();
            if (Array.isArray(serverNotifs)) {
                state.notifications = serverNotifs.map(n => ({
                    id: n.id,
                    title: n.title,
                    message: n.message,
                    type: n.type || 'assignment',
                    is_read: n.is_read,
                    time: n.created_at ? new Date(n.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'Recente'
                }));
                localStorage.setItem('klweb_notifications', JSON.stringify(state.notifications));
                updateNotificationBadge();
            }
        }
    } catch (err) {
        console.warn('Usando notificações locais.');
    }
}

function addNotification(title, message, type = 'info') {
    const newNotif = {
        id: Date.now(),
        title,
        message,
        type,
        time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    state.notifications.unshift(newNotif);
    localStorage.setItem('klweb_notifications', JSON.stringify(state.notifications));
    updateNotificationBadge();
}

function updateNotificationBadge() {
    const badge = document.getElementById('notification-count');
    if (!badge) return;

    const unreadCount = state.notifications.filter(n => !n.is_read).length;
    const totalCount = unreadCount > 0 ? unreadCount : state.notifications.length;

    if (totalCount > 0) {
        badge.innerText = totalCount;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// ==================== SISTEMA CENTRALIZADO DE NOTIFICAÇÃO DUPLA (E-MAIL + PAINEL) ====================
async function notifyUserDualChannel(recipientEmail, title, message, type = 'info') {
    // 1. Notificação no Painel da Aplicação
    addNotification(title, message, type);

    // E-mails de notificação: somente Starter e Pro AI
    if (isFreePlan()) return;

    if (!recipientEmail || !recipientEmail.includes('@')) {
        console.warn('E-mail do destinatário não informado para disparo.');
        return;
    }

    // 2. Disparo de E-mail via Servidor Backend
    try {
        await fetchWithAuth('/api/notifications/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: recipientEmail,
                subject: `[KL Web] ${title}`,
                message: `Olá!\n\n${message}\n\nAtenciosamente,\nEquipe ${state.user?.companyName || 'KL Web Corp'}`
            })
        });
        console.log(`Notificação por e-mail enviada com sucesso para ${recipientEmail}`);
    } catch (error) {
        console.warn(`Não foi possível enviar e-mail para ${recipientEmail}:`, error);
    }
}

function renderNotifications() {
    const list = document.getElementById('notification-list');
    if (!list) return;

    if (state.notifications.length === 0) {
        list.innerHTML = '<p class="notification-empty">Nenhuma notificação recente.</p>';
        return;
    }

    list.innerHTML = state.notifications.map(n => `
        <div class="notification-item ${n.type}">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong>${escapeHtml(n.title)}</strong>
                <span style="font-size: 0.7rem; color: var(--text-muted);">${n.time}</span>
            </div>
            <p style="color: var(--text-secondary); margin-top: 0.2rem;">${escapeHtml(n.message)}</p>
        </div>
    `).join('');
}

async function clearNotifications() {
    state.notifications = [];
    localStorage.setItem('klweb_notifications', JSON.stringify([]));
    updateNotificationBadge();
    renderNotifications();

    if (state.token) {
        try {
            await fetch('/api/notifications/clear', {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${state.token}` }
            });
        } catch (e) {
            console.warn('Limpo localmente.');
        }
    }
}

// ==================== PAINEL OCULTO MASTER: LÓGICA E BUSCA ====================
let masterAuthenticated = false;
let currentMasterPassword = '';

async function carregarUsuariosMaster() {
    const token = localStorage.getItem('klweb_token');
    const res = await fetch('/api/master/usuarios', {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) return;
    const usuarios = await res.json();

    const container = document.querySelector('#lista-usuarios-master');
    if (!container) return;

    container.innerHTML = usuarios.map(u => `
        <div class="user-card" style="padding: 12px; border-bottom: 1px solid #e2e8f0; display:flex; justify-shadow: space-between; align-items: center;">
            <div>
                <strong>${u.nome}</strong> (${u.email}) - <span class="badge">${u.plano}</span>
            </div>
            <div>
                <button onclick="alterarEmailMaster('${u.id}')" class="btn-sm">Alterar E-mail</button>
                <button onclick="alterarSenhaMaster('${u.id}')" class="btn-sm">Trocar Senha</button>
            </div>
        </div>
    `).join('');
}

async function alterarEmailMaster(id) {
    const novoEmail = prompt('Digite o novo e-mail para o usuário:');
    if (!novoEmail) return;

    const token = localStorage.getItem('klweb_token');
    const res = await fetch(`/api/master/usuarios/${id}/email`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ novoEmail })
    });

    const data = await res.json();
    alert(data.message);
    carregarUsuariosMaster();
}

async function alterarSenhaMaster(id) {
    const novaSenha = prompt('Digite a nova senha para o usuário:');
    if (!novaSenha) return;

    const token = localStorage.getItem('klweb_token');
    const res = await fetch(`/api/master/usuarios/${id}/senha`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ novaSenha })
    });

    const data = await res.json();
    alert(data.message);
}

function openMasterModal() {
    if (!canSeeMasterPanel()) {
        showToast('Acesso negado. Apenas o administrador master pode acessar este painel.', 'error');
        return;
    }

    switchTab('master');

    if (!masterAuthenticated) {
        document.getElementById('master-auth-step').style.display = 'block';
        document.getElementById('master-management-step').style.display = 'none';
        const passInput = document.getElementById('master-pass-input');
        if (passInput) {
            passInput.value = '';
            passInput.focus();
        }
    } else {
        document.getElementById('master-auth-step').style.display = 'none';
        document.getElementById('master-management-step').style.display = 'block';
        loadMasterUsersList();
    }
}

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) ||
        (e.ctrlKey && e.altKey && (e.key === 'M' || e.key === 'm'))) {

        if (canSeeMasterPanel()) {
            e.preventDefault();
            openMasterModal();
        }
    }
});

function closeMasterModal() {
    switchTab('kanban');
}

function lockMasterPanel() {
    masterAuthenticated = false;
    currentMasterPassword = '';
    document.getElementById('master-auth-step').style.display = 'block';
    document.getElementById('master-management-step').style.display = 'none';
    showToast('Painel Master bloqueado.', 'info');
}

async function unlockMasterPanel() {
    const passInput = document.getElementById('master-pass-input');
    const password = passInput ? passInput.value.trim() : '';
    const errBox = document.getElementById('master-auth-error');
    const errMsg = document.getElementById('master-error-msg');

    if (errBox) errBox.style.display = 'none';

    if (!password) {
        if (errBox && errMsg) {
            errBox.style.display = 'block';
            errMsg.innerText = 'Digite a senha mestre.';
        }
        showToast('Digite a senha mestre.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/admin/users-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ masterPassword: password })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            masterAuthenticated = true;
            currentMasterPassword = password;
            globalUsersList = data.users || [];
            if (errBox) errBox.style.display = 'none';
            document.getElementById('master-auth-step').style.display = 'none';
            document.getElementById('master-management-step').style.display = 'block';
            showToast('Painel Master desbloqueado com sucesso!', 'success');
            renderMasterUsersList(globalUsersList);
        } else {
            if (errBox && errMsg) {
                errBox.style.display = 'block';
                errMsg.innerText = data.error || 'Senha master incorreta.';
            }
            showToast(data.error || 'Senha master incorreta.', 'error');
        }
    } catch (err) {
        console.error('Erro de autenticação master:', err);
        if (errBox && errMsg) {
            errBox.style.display = 'block';
            errMsg.innerText = 'Erro ao validar senha master no servidor.';
        }
        showToast('Erro ao validar senha master no servidor.', 'error');
    }
}

var masterUsersLoading = false;
var masterUsersLastLoad = 0;
var masterUsersPausedUntil = 0;

function setMasterUsersStatus(text) {
    const list = document.getElementById('master-users-list');
    if (!list || !list.parentNode) return;
    let el = document.getElementById('master-users-status');
    if (!el) {
        el = document.createElement('div');
        el.id = 'master-users-status';
        el.style.cssText = 'font-size:.72rem;color:var(--text-muted);margin:0 0 .4rem';
        list.parentNode.insertBefore(el, list);
    }
    el.textContent = text;
}

// opts.silent = true: recarga automática (não mostra aviso de erro a cada tentativa).
async function loadMasterUsersList(opts) {
    const silent = !!(opts && opts.silent === true);
    if (!currentMasterPassword) {
        if (!silent) showToast('Sessão master expirada. Entre no Painel Master novamente.', 'error');
        return;
    }
    if (masterUsersLoading) return;
    masterUsersLoading = true;
    masterUsersLastLoad = Date.now();
    setMasterUsersStatus('Atualizando lista...');

    try {
        const response = await fetchWithAuth('/api/admin/users-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ masterPassword: currentMasterPassword })
        });

        const data = await response.json().catch(() => ({}));
        if (response.ok && data.success) {
            globalUsersList = data.users || [];
            const searchEl = document.getElementById('searchEmailInput');
            if (searchEl && searchEl.value.trim()) filterUsersList();
            else renderMasterUsersList(globalUsersList);
            setMasterUsersStatus(`${globalUsersList.length} usuários · atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
        } else if (response.status === 429) {
            // Limite de consultas do Painel Master (20 a cada 15 min): pausa a recarga automática.
            masterUsersPausedUntil = Date.now() + 15 * 60 * 1000;
            setMasterUsersStatus('Muitas consultas ao painel: a atualização automática volta em alguns minutos.');
            if (!silent) showToast(data.error || data.message || 'Muitas consultas ao Painel Master. Tente de novo em alguns minutos.', 'error');
        } else {
            setMasterUsersStatus('Não foi possível atualizar a lista.');
            if (!silent) showToast(data.error || data.message || `Não foi possível atualizar a lista (erro ${response.status}).`, 'error');
        }
    } catch (err) {
        console.error('Erro ao carregar lista de usuários:', err);
        setMasterUsersStatus('Sem conexão: a lista pode estar desatualizada.');
        if (!silent) showToast('Erro de conexão ao atualizar a lista de usuários.', 'error');
    } finally {
        masterUsersLoading = false;
    }
}

// Mantém a lista em dia sem estourar o limite do servidor (adminLimiter: 20 consultas / 15 min,
// divididas com as outras ações do Painel Master): recarga automática no máximo a cada 2,5 min,
// só com a aba Usuários visível, e pausada por 15 min se o servidor responder 429.
function masterUsersVisible() {
    const sec = document.querySelector('.master-section[data-msec="users"]');
    return !!(sec && sec.offsetParent !== null && document.visibilityState === 'visible');
}
function masterUsersAutoRefresh() {
    const now = Date.now();
    if (!currentMasterPassword || !masterUsersVisible()) return;
    if (now < masterUsersPausedUntil || now - masterUsersLastLoad < 150000) return;
    loadMasterUsersList({ silent: true });
}
setInterval(masterUsersAutoRefresh, 60000);
document.addEventListener('visibilitychange', masterUsersAutoRefresh);

function canSeeMasterPanel() {
    return !!(state.user && (state.user.isSiteOwner === true || state.user.isSiteStaff === true));
}

function renderMasterUsersList(users) {
    const container = document.getElementById('master-users-list') || document.getElementById('usersListContainer');
    if (!container) return;
    const isSiteOwner = !!(state.user && state.user.isSiteOwner === true);
    if (typeof applyMasterStaffView === 'function') applyMasterStaffView(isSiteOwner);

    if (!users || users.length === 0) {
        container.innerHTML = '<p style="padding:0.75rem;text-align:center;color:var(--text-muted)">Nenhum usuário encontrado.</p>';
        return;
    }

    const roleLabel = (u) => u.site_role === 'SITE_MANAGER' ? 'Gerente do site'
        : u.role === 'ADMIN' ? 'Administrador do site'
            : u.role === 'MANAGER' ? 'Gerente' : 'Usuário comum';

    container.innerHTML = users.map(u => {
        const shownTier = u.plan_status === 'ACTIVE' || u.role === 'OWNER' ? (u.plan_tier || 'BASICO') : 'BASICO';
        const current = u.site_role === 'SITE_MANAGER' ? 'SITE_MANAGER' : u.role;
        const roleControl = u.role === 'OWNER'
            ? '<span class="master-role-owner">Dono do site</span>'
            : u.is_company_owner
                ? '<span class="master-role-owner" title="Cargo definido pela empresa">Dono da empresa</span>'
                : !isSiteOwner
                    ? `<span class="master-role-owner">${roleLabel(u)}</span>`
                    : `<select class="master-role-select" aria-label="Cargo de ${escapeHtml(u.name || u.email)}" onchange="changeMasterUserRole(${Number(u.id)}, this.value)">
                    <option value="USER" ${current === 'USER' ? 'selected' : ''}>Usuário comum</option>
                    <option value="MANAGER" ${current === 'MANAGER' ? 'selected' : ''}>Gerente</option>
                    <option value="SITE_MANAGER" ${current === 'SITE_MANAGER' ? 'selected' : ''}>Gerente do site</option>
                    <option value="ADMIN" ${current === 'ADMIN' ? 'selected' : ''}>Administrador do site</option>
                </select>`;
        const deleteBtn = isSiteOwner && u.role !== 'OWNER'
            ? `<button type="button" class="btn-secondary" title="Apagar conta" aria-label="Apagar conta de ${escapeHtml(u.name || u.email)}" style="padding:6px 10px;color:#ef4444" onclick="deleteMasterUser(${Number(u.id)})"><i class="fa-solid fa-trash"></i></button>`
            : '';
        return `
<div class="master-user-row" style="display:flex;justify-content:space-between;align-items:center;gap:.75rem;padding:10px;border-bottom:1px solid var(--border)"><div onclick="selectUserForPlanChange('${escapeHtml(u.email)}','${shownTier}')" style="cursor:pointer;flex:1;min-width:0" title="Clique para selecionar este usuário"><strong>${escapeHtml(u.name || 'Usuário')}</strong><div style="font-size:.72rem;color:var(--text-muted)">${escapeHtml(u.email)} ${u.company_name ? `• ${escapeHtml(u.company_name)}` : ''}</div></div><div style="display:flex;align-items:center;gap:.5rem">${roleControl}<span class="master-user-badge ${shownTier}">${shownTier}</span>${deleteBtn}</div></div>`;
    }).join('');
}
async function changeMasterUserRole(userId, role) {
    if (!currentMasterPassword || !['USER', 'MANAGER', 'ADMIN', 'SITE_MANAGER'].includes(role)) {
        showToast('Cargo inválido ou sessão master expirada.', 'error');
        return loadMasterUsersList();
    }

    const user = globalUsersList.find(item => Number(item.id) === Number(userId));
    if (!user) return;

    if (role === 'ADMIN' && !confirm(`Conceder acesso de administrador do site a ${user.name || user.email}? Administradores veem todos os atendimentos e feedbacks e também acessam o Painel Master (consulta e troca de plano).`)) {
        return loadMasterUsersList();
    }

    try {
        const response = await fetchWithAuth('/api/admin/change-user-role', {
            method: 'POST',
            body: JSON.stringify({ masterPassword: currentMasterPassword, targetUserId: userId, role })
        });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.error || 'Erro ao alterar o cargo.', 'error');
            return loadMasterUsersList();
        }

        showToast(data.message || 'Cargo atualizado.', 'success');
        await loadMasterUsersList();
    } catch (error) {
        console.error('Erro ao atualizar cargo do usuário:', error);
        showToast('Erro de conexão ao alterar o cargo.', 'error');
        loadMasterUsersList();
    }
}

async function deleteMasterUser(userId) {
    const user = globalUsersList.find(item => Number(item.id) === Number(userId));
    if (!user || !currentMasterPassword) return;
    if (!confirm(`Apagar PERMANENTEMENTE a conta de ${user.name || user.email} (${user.email})? Essa ação não pode ser desfeita.`)) return;

    try {
        const response = await fetchWithAuth('/api/admin/delete-user', {
            method: 'POST',
            body: JSON.stringify({ masterPassword: currentMasterPassword, targetUserId: userId })
        });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.error || 'Erro ao apagar a conta.', 'error');
            return;
        }
        showToast(data.message || 'Conta apagada.', 'success');
        await loadMasterUsersList();
    } catch (error) {
        console.error('Erro ao apagar conta:', error);
        showToast('Erro de conexão ao apagar a conta.', 'error');
    }
}

function filterUsersList() {
    const queryInput = document.getElementById('searchEmailInput');
    if (!queryInput) return;
    const query = queryInput.value.toLowerCase().trim();
    const filtered = globalUsersList.filter(u =>
        (u.email && u.email.toLowerCase().includes(query)) ||
        (u.name && u.name.toLowerCase().includes(query))
    );
    renderMasterUsersList(filtered);
}

async function deleteUserMaster(targetEmail) {
    if (!targetEmail) return;
    if (!confirm(`Tem certeza que deseja apagar permanentemente o usuário ${targetEmail}?`)) return;

    const pass = currentMasterPassword || window.currentMasterPassword;

    try {
        const response = await fetch('/api/admin/delete-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                masterPassword: pass,
                targetEmail
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(data.message || 'Usuário excluído com sucesso!', 'success');
        } else {
            showToast(data.error || 'Erro retornado pelo servidor ao excluir.', 'error');
            return;
        }
    } catch (err) {
        console.warn('Servidor offline/indisponível. Removendo do cache local...', err);
        showToast('Servidor offline. Usuário removido localmente.', 'info');
    }

    globalUsersList = globalUsersList.filter(u => u.email.toLowerCase() !== targetEmail.toLowerCase());
    state.users_db = state.users_db.filter(u => u.email.toLowerCase() !== targetEmail.toLowerCase());
    saveUsersDBLocal();
    filterUsersList();
}

function selectUserForPlanChange(email, currentPlan) {
    const emailInput = document.getElementById('master-target-email');
    const planSelect = document.getElementById('master-plan-select');
    if (emailInput) emailInput.value = email;
    if (planSelect && currentPlan) planSelect.value = currentPlan;
    showToast(`Usuário ${email} selecionado. Escolha o novo plano e confirme.`, 'info');
}

async function submitMasterChangePlan() {
    const targetEmail = document.getElementById('master-target-email').value.trim();
    const planTier = document.getElementById('master-plan-select').value;
    const planStatus = document.getElementById('master-status-select').value;

    if (!targetEmail) {
        showToast('Informe o e-mail do usuário para alterar o plano.', 'error');
        return;
    }

    if (!currentMasterPassword) {
        showToast('Sessão master expirada. Digite a senha novamente.', 'error');
        lockMasterPanel();
        return;
    }

    try {
        const response = await fetchWithAuth('/api/admin/master-change-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                masterPassword: currentMasterPassword,
                targetEmail,
                planTier,
                planStatus
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(data.message, 'success');

            if (state.user && state.user.email.toLowerCase().trim() === targetEmail.toLowerCase().trim()) {
                state.user.planTier = planTier;
                localStorage.setItem('klweb_user', JSON.stringify(state.user));
                updatePlanCardsUI();
                const sidePlanPill = document.getElementById('sidebar-plan-pill');
                if (sidePlanPill) sidePlanPill.innerText = planTier.replace('_', ' ');
            }

            const dbUser = state.users_db.find(u => u.email.toLowerCase().trim() === targetEmail.toLowerCase().trim());
            if (dbUser) {
                dbUser.planTier = planTier;
                saveUsersDBLocal();
            }

            loadMasterUsersList();
        } else {
            showToast(data.error || 'Erro ao alterar plano.', 'error');
        }
    } catch (err) {
        console.error('Erro ao enviar alteração master:', err);
        showToast('Erro de conexão ao alterar plano.', 'error');
    }
}

async function submitMasterResetPassword() {
    const targetEmail = document.getElementById('master-user-email').value.trim();
    const newPassword = document.getElementById('master-new-password').value.trim();

    if (!targetEmail || !newPassword) {
        showToast('Informe o e-mail do usuário e a nova senha.', 'error');
        return;
    }

    if (!currentMasterPassword) {
        showToast('Sessão master expirada. Autentique novamente.', 'error');
        lockMasterPanel();
        return;
    }

    try {
        const response = await fetchWithAuth('/api/admin/reset-user-password/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                masterPassword: currentMasterPassword,
                targetEmail,
                newPassword
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // Mostrar campo de código
            state.pendingMasterPasswordChange = { targetEmail, newPassword };
            const codeGroup = document.getElementById('master-password-code-group');
            const hint = document.getElementById('master-password-code-hint');
            if (hint) hint.textContent = `Enviamos um código de 6 dígitos para ${targetEmail}. Ele vale por ${data.expiresInMinutes || 10} minutos.`;
            if (codeGroup) codeGroup.style.display = '';
            const codeInput = document.getElementById('master-password-change-code');
            if (codeInput) codeInput.focus();
            showToast(data.message, 'success');
        } else {
            showToast(data.error || 'Erro ao enviar código.', 'error');
        }
    } catch (err) {
        console.error('Erro ao solicitar reset de senha:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

async function confirmMasterPasswordChange() {
    const codeInput = document.getElementById('master-password-change-code');
    const code = codeInput ? codeInput.value.replace(/\D/g, '') : '';

    if (!state.pendingMasterPasswordChange) {
        showToast('Peça o código primeiro.', 'error');
        return;
    }
    if (code.length !== 6) {
        showToast('Digite o código de 6 dígitos.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/admin/reset-user-password/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                masterPassword: currentMasterPassword,
                targetEmail: state.pendingMasterPasswordChange.targetEmail,
                code
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(data.message, 'success');
            document.getElementById('master-new-password').value = '';
            document.getElementById('master-password-change-code').value = '';
            document.getElementById('master-password-code-group').style.display = 'none';
            state.pendingMasterPasswordChange = null;
            loadMasterUsersList();
        } else {
            showToast(data.error || 'Código inválido.', 'error');
            if (data.error && (data.error.includes('expirou') || data.error.includes('tentativas'))) {
                resetMasterPasswordChangeUI();
            }
        }
    } catch (err) {
        console.error('Erro ao confirmar senha:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

function resetMasterPasswordChangeUI() {
    const codeGroup = document.getElementById('master-password-code-group');
    if (codeGroup) codeGroup.style.display = 'none';
    ['master-password-change-code', 'master-new-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    state.pendingMasterPasswordChange = null;
}

async function submitMasterChangeEmail() {
    const targetEmail = document.getElementById('master-user-email').value.trim();
    const newEmail = document.getElementById('master-new-email').value.trim();

    if (!targetEmail || !newEmail) {
        showToast('Informe o e-mail atual e o novo e-mail.', 'error');
        return;
    }

    if (!currentMasterPassword) {
        showToast('Sessão master expirada. Autentique novamente.', 'error');
        lockMasterPanel();
        return;
    }

    try {
        const response = await fetchWithAuth('/api/admin/change-user-email/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                masterPassword: currentMasterPassword,
                targetEmail,
                newEmail
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // Mostrar campo de código
            state.pendingMasterEmailChange = { targetEmail, newEmail };
            const codeGroup = document.getElementById('master-email-code-group');
            const hint = document.getElementById('master-email-code-hint');
            if (hint) hint.textContent = `Enviamos um código de 6 dígitos para ${newEmail}. Ele vale por ${data.expiresInMinutes || 10} minutos.`;
            if (codeGroup) codeGroup.style.display = '';
            const codeInput = document.getElementById('master-email-change-code');
            if (codeInput) codeInput.focus();
            showToast(data.message, 'success');
        } else {
            showToast(data.error || 'Erro ao enviar código.', 'error');
        }
    } catch (err) {
        console.error('Erro ao solicitar troca de e-mail:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

async function confirmMasterEmailChange() {
    const codeInput = document.getElementById('master-email-change-code');
    const code = codeInput ? codeInput.value.replace(/\D/g, '') : '';

    if (!state.pendingMasterEmailChange) {
        showToast('Peça o código primeiro.', 'error');
        return;
    }
    if (code.length !== 6) {
        showToast('Digite o código de 6 dígitos.', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/admin/change-user-email/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                masterPassword: currentMasterPassword,
                targetEmail: state.pendingMasterEmailChange.targetEmail,
                code
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(data.message, 'success');
            document.getElementById('master-new-email').value = '';
            document.getElementById('master-email-change-code').value = '';
            document.getElementById('master-email-code-group').style.display = 'none';
            state.pendingMasterEmailChange = null;
            loadMasterUsersList();
        } else {
            showToast(data.error || 'Código inválido.', 'error');
            if (data.error && data.error.includes('expirou') || data.error.includes('tentativas')) {
                resetMasterEmailChangeUI();
            }
        }
    } catch (err) {
        console.error('Erro ao confirmar e-mail:', err);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

function resetMasterEmailChangeUI() {
    const codeGroup = document.getElementById('master-email-code-group');
    if (codeGroup) codeGroup.style.display = 'none';
    ['master-email-change-code', 'master-new-email'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    state.pendingMasterEmailChange = null;
}

function initZoomAndTheme() {
    const zoomRange = document.getElementById('zoom-range');
    const zoomValue = document.getElementById('zoom-value');
    const btnDark = document.getElementById('btn-theme-dark');
    const btnLight = document.getElementById('btn-theme-light');
    const btnResetZoom = document.getElementById('btn-reset-zoom');
    const btnColorblind = document.getElementById('btn-colorblind');
    const mobileZoomQuery = window.matchMedia('(max-width: 640px)');

    // 1. Controle de Zoom Proporcional
    function applyZoom(val) {
        if (zoomRange) zoomRange.value = val;
        if (zoomValue) zoomValue.textContent = `${val}%`;

        // Ajusta a escala base de rem na raiz do documento
        const mobileScale = mobileZoomQuery.matches ? 0.9 : 1;
        document.documentElement.style.fontSize = `${(val / 100) * mobileScale * 16}px`;
        localStorage.setItem('klweb_zoom', val);
    }

    if (zoomRange) {
        zoomRange.addEventListener('input', (e) => {
            applyZoom(e.target.value);
        });
    }

    if (btnResetZoom) {
        btnResetZoom.addEventListener('click', () => {
            applyZoom(100);
        });
    }

    // Carregar zoom salvo
    const savedZoom = localStorage.getItem('klweb_zoom') || 100;
    applyZoom(savedZoom);
    mobileZoomQuery.addEventListener('change', () => {
        applyZoom(zoomRange?.value || savedZoom);
    });

    // 2. Alternância de Temas Claro / Escuro
    function setTheme(theme) {
        if (theme === 'dark') {
            document.body.classList.add('dark-mode', 'dark-theme');
            document.body.classList.remove('light-theme');
            if (btnDark) {
                btnDark.classList.add('btn-primary');
                btnDark.classList.remove('btn-secondary');
            }
            if (btnLight) {
                btnLight.classList.add('btn-secondary');
                btnLight.classList.remove('btn-primary');
            }
        } else {
            document.body.classList.remove('dark-mode', 'dark-theme');
            document.body.classList.add('light-theme');
            if (btnLight) {
                btnLight.classList.add('btn-primary');
                btnLight.classList.remove('btn-secondary');
            }
            if (btnDark) {
                btnDark.classList.add('btn-secondary');
                btnDark.classList.remove('btn-primary');
            }
        }
        localStorage.setItem('klweb_theme', theme);

        // Atualizar gráficos do Analytics caso estejam visíveis
        if (typeof loadAnalyticsData === 'function' && document.getElementById('tab-analytics')?.classList.contains('active')) {
            loadAnalyticsData();
        }
    }

    if (btnDark) {
        btnDark.addEventListener('click', (e) => {
            e.preventDefault();
            setTheme('dark');
        });
    }

    if (btnLight) {
        btnLight.addEventListener('click', (e) => {
            e.preventDefault();
            setTheme('light');
        });
    }

    // Carregar Tema Salvo
    const savedTheme = localStorage.getItem('klweb_theme') || 'dark';
    setTheme(savedTheme);

    // 3. Modo Daltônico
    if (btnColorblind) {
        btnColorblind.addEventListener('click', (e) => {
            e.preventDefault();
            const active = document.body.classList.toggle('daltonic-mode');
            document.body.classList.toggle('colorblind-mode', active);
            localStorage.setItem('klweb_colorblind', active);

            if (typeof showToast === 'function') {
                showToast(active ? 'Modo daltônico ativado.' : 'Modo padrão restaurado.', 'info');
            }

            if (typeof loadAnalyticsData === 'function' && document.getElementById('tab-analytics')?.classList.contains('active')) {
                loadAnalyticsData();
            }
        });
    }

    // Carregar estado salvo do modo daltônico
    if (localStorage.getItem('klweb_colorblind') === 'true') {
        document.body.classList.add('daltonic-mode', 'colorblind-mode');
    }
}

function updateLiveDateTime() {
    const now = new Date();
    const options = {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    const formatted = now.toLocaleDateString('pt-BR', options).replace(',', '');
    const el = document.getElementById('current-date-time');
    if (el) el.innerText = formatted;
}

setInterval(updateLiveDateTime, 1000);
updateLiveDateTime();

function syncUserPlanWithDatabase() {
    if (!state.user || !state.user.email) return;

    const dbUser = state.users_db.find(u => u.email.toLowerCase().trim() === state.user.email.toLowerCase().trim());
    if (dbUser && dbUser.planTier !== state.user.planTier) {
        state.user.planTier = dbUser.planTier;
        localStorage.setItem('klweb_user', JSON.stringify(state.user));
        updateUserProfileUI();
        showToast(`Plano ${state.user.planTier.replace('_', ' ')} sincronizado com seu e-mail!`, 'success');
    }
}

async function deleteUserAccountByEmail(emailToDelete) {
    if (!emailToDelete) return;

    const targetEmail = emailToDelete.toLowerCase().trim();

    state.users_db = state.users_db.filter(u => u.email.toLowerCase().trim() !== targetEmail);
    localStorage.setItem('klweb_users_db', JSON.stringify(state.users_db));

    state.members = state.members.filter(m => m.email.toLowerCase().trim() !== targetEmail);
    localStorage.setItem('klweb_members', JSON.stringify(state.members));

    state.demands.forEach(d => {
        if (d.assigned_user_email && d.assigned_user_email.toLowerCase().trim() === targetEmail) {
            d.assigned_user_email = '';
            d.assigned_user_name = 'Sem responsável';
        }
    });
    localStorage.setItem('klweb_demands', JSON.stringify(state.demands));

    try {
        await fetch('/api/users/delete-by-email', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify({ email: targetEmail })
        });
    } catch (err) {
        console.warn('Exclusão persistida localmente.');
    }

    if (state.user && state.user.email.toLowerCase().trim() === targetEmail) {
        state.user = null;
        localStorage.removeItem('klweb_user');
        localStorage.removeItem('klweb_token');

        showToast('Sua conta foi excluída permanentemente.', 'info');

        setTimeout(() => {
            document.getElementById('app-screen').style.display = 'none';
            document.getElementById('auth-screen').style.display = 'flex';
        }, 500);
    } else {
        loadCompanyMembers();
        loadDemands();
        showToast(`A conta ${targetEmail} foi excluída permanentemente!`, 'success');
    }
}

// ==================== EXCLUSÃO DA PRÓPRIA CONTA ====================
function confirmSelfDeleteAccount() {
    if (!state.user || !state.user.email) return;

    const userEmail = state.user.email;
    const confirmMessage = `ATENÇÃO: Você tem certeza que deseja apagar permanentemente a conta (${userEmail})?\n\nEsta ação não poderá ser desfeita e seu e-mail será removido da equipe.`;

    if (confirm(confirmMessage)) {
        closeProfileModal();
        deleteUserAccountByEmail(userEmail);
    }
}

// ==================== CONEXÃO DE WORKSPACE ====================
async function switchCompanyConnection() {
    const codeInput = document.getElementById('switch-company-code');
    const newCode = codeInput.value.trim().toUpperCase();

    if (!newCode) {
        showToast('Por favor, insira o código da nova empresa.', 'error');
        return;
    }

    if (newCode === state.companyCode) {
        showToast('Você já está conectado a esta empresa.', 'info');
        return;
    }

    try {
        if (state.companyCode) {
            localStorage.setItem('klweb_prev_company_code', state.companyCode);
        }

        const response = await fetch('/api/companies/switch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`
            },
            body: JSON.stringify({ companyCode: newCode })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showToast(`Conexão alterada para ${data.companyName}!`, 'success');

            state.companyCode = data.companyCode;
            state.companyName = data.companyName;
            localStorage.setItem('klweb_company_code', data.companyCode);

            updateCompanyUI();
            loadCompanyMembers();
            loadDemands();
            codeInput.value = '';

            setTimeout(() => location.reload(), 1500);
        } else if (data.error && data.error.includes('acesso') || response.status === 403) {
            const confirmRequest = confirm(`Você não tem acesso imediato a esta empresa. Deseja enviar uma solicitação de conexão para o dono do workspace?`);

            if (confirmRequest) {
                const requestResponse = await fetch('/api/companies/request-access', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${state.token}`
                    },
                    body: JSON.stringify({ companyCode: newCode })
                });

                const requestData = await requestResponse.json();
                if (requestResponse.ok && requestData.success) {
                    showToast('Solicitação enviada! Aguarde a aprovação do administrador.', 'info');
                } else {
                    showToast(requestData.error || 'Erro ao enviar solicitação.', 'error');
                }
            }
        } else {
            showToast(data.error || 'Código de empresa inválido.', 'error');
        }
    } catch (err) {
        console.error('Erro ao trocar empresa:', err);
        showToast('Erro de conexão ao tentar mudar de empresa.', 'error');
    }
}

function returnToPreviousCompany() {
    const prevCode = localStorage.getItem('klweb_prev_company_code');
    if (!prevCode) {
        showToast('Não há registro de uma conexão anterior.', 'info');
        return;
    }

    document.getElementById('switch-company-code').value = prevCode;
    switchCompanyConnection();
}

// ==================== SUPPORT CHAT FUNCTIONS ====================
let currentSupportChatId = null;
let currentSupportSubject = null;
let currentEventSource = null;

function subscribeToChatUpdates(chatId) {
    if (!socket) return;

    currentChatId = chatId;
    socket.emit('join_chat', chatId);

    // Remove ouvintes antigos para NÃO duplicar o evento
    socket.off('receive_message');

    // Ouve mensagens recebidas
    socket.on('receive_message', (data) => {
        const senderId = data.senderId ?? data.sender_id;

        // Se a mensagem foi enviada por MIM mesmo, ignora (pois ela já foi renderizada na tela no envio)
        if (Number(senderId) === Number(state.user?.id)) {
            return;
        }

        appendSingleSupportMessage({
            id: data.id || Date.now(),
            sender_id: senderId,
            sender_type: data.senderType || data.sender_type,
            message: data.message,
            created_at: data.timestamp || new Date().toISOString()
        });
    });
}

function appendSingleSupportMessage(msg) {
    const messagesContainer = currentAdminChatId !== null
        ? document.getElementById('admin-support-messages')
        : document.getElementById('support-messages');
    if (!messagesContainer) return;

    if (document.getElementById(`msg-${msg.id}`)) return;

    const messageDate = msg.created_at || msg.timestamp;
    appendSupportDateDivider(messagesContainer, messageDate);

    const messageDiv = document.createElement('div');
    messageDiv.id = `msg-${msg.id}`;

    const isCurrentUser = Number(msg.sender_id) === Number(state.user.id);
    const alignmentClass = isCurrentUser ? 'user-chat-message' : 'admin-support-message';

    let time = 'Recente';
    if (msg.created_at || msg.timestamp) {
        const rawDate = new Date(msg.created_at || msg.timestamp);
        if (!isNaN(rawDate.getTime())) {
            time = rawDate.toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit'
            });
        }
    }

    messageDiv.className = `support-message ${alignmentClass}`;
    const senderLabel = isCurrentUser ? 'Você' : (msg.sender_type === 'USER' ? 'Usuário' : 'Suporte');

    messageDiv.innerHTML = `
        <div class="message-content">
            <strong>${senderLabel}:</strong>
            <p>${escapeHtml(msg.message)}</p>
        </div>
        <span class="message-time">${time}</span>
    `;

    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function appendSupportDateDivider(messagesContainer, rawDate) {
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return;

    const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (messagesContainer.dataset.lastMessageDate === dateKey) return;

    const today = new Date();
    const todayValue = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const messageValue = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDifference = Math.round((todayValue - messageValue) / 86400000);
    const label = dayDifference === 0
        ? 'Hoje'
        : dayDifference === 1
            ? 'Ontem'
            : date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    const divider = document.createElement('div');
    divider.className = 'support-date-divider';
    divider.textContent = label;
    messagesContainer.appendChild(divider);
    messagesContainer.dataset.lastMessageDate = dateKey;
}

function initSupportChat() {
    if (!socket) return;

    if (state.user && state.token) {
        const btnSupport = document.getElementById('support-button');
        if (btnSupport) {
            btnSupport.style.display = 'flex';
        }

        const chatId = state.user.supportChatId || 1;
        currentChatId = chatId;

        // Usa a função unificada que limpa os ouvintes duplicados do Socket
        subscribeToChatUpdates(chatId);
    }
}

function appendChatMessageSupport(data) {
    const chatContainer = document.getElementById('support-chat-messages');
    if (!chatContainer) return;

    const senderId = data.senderId ?? data.sender_id;
    const isMyMessage = Number(senderId) === Number(state.user.id);
    const alignmentClass = isMyMessage ? 'msg-right' : 'msg-left';

    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${alignmentClass}`;
    msgDiv.innerHTML = `
        <div class="msg-header">
            <strong>${isMyMessage ? 'Você' : (data.userName || 'Suporte')}</strong>
            <span class="msg-time">${new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="msg-body">${data.message}</div>
    `;
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function handleSupportTyping() {
    return;
}

async function updateSupportChatCount() {
    try {
        if (!state.token || !state.user) {
            const badge = document.getElementById('support-chat-count');
            if (badge) badge.style.display = 'none';
            return;
        }

        const response = await fetchWithAuth('/api/support/unread-count');
        const data = await response.json();

        const badge = document.getElementById('support-chat-count');
        if (badge) {
            if (data.count > 0) {
                badge.textContent = data.count > 9 ? '9+' : data.count;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Erro ao atualizar contador de chats:', error);
        const badge = document.getElementById('support-chat-count');
        if (badge) badge.style.display = 'none';
    }
}

function openSupportChat() {
    const modal = document.getElementById('modal-support-chat');
    if (modal) {
        modal.style.display = 'flex';

        document.getElementById('support-subject-selection').style.display = 'flex';
        document.getElementById('support-chat-area').style.display = 'none';
        currentSupportChatId = null;
        currentSupportSubject = null;

        loadUserSupportHistory();
        if (['OWNER', 'ADMIN'].includes(state.user?.role)) {
            loadAdminSupportQueue();
            if (typeof loadSupportChats === 'function') loadSupportChats();
        }
    }
}

async function loadUserSupportHistory() {
    try {
        const response = await fetchWithAuth('/api/support/chats');
        const data = await response.json();

        if (response.ok && data.chats && data.chats.length > 0) {
            const historyContainer = document.getElementById('user-support-history');
            const chatsList = document.getElementById('user-chats-list');

            historyContainer.style.display = 'block';

            chatsList.innerHTML = data.chats.map(chat => {
                const dateFormat = {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                };
                const openedDate = new Date(chat.created_at || chat.updated_at).toLocaleDateString('pt-BR', dateFormat);
                const lastActivity = new Date(chat.last_message_at || chat.updated_at || chat.created_at).toLocaleDateString('pt-BR', dateFormat);

                const unreadClass = chat.is_unread ? 'unread' : '';

                return `
                    <div class="user-chat-item ${unreadClass}" onclick="openExistingChat(${chat.id}, '${escapeForInlineJs(chat.subject)}')">
                        <div class="user-chat-info">
                            <div class="user-chat-subject">${escapeHtml(chat.subject)}</div>
                            <div class="user-chat-date">Aberto em: ${openedDate}</div>
                            <div class="user-chat-activity">Última atividade: ${lastActivity}</div>
                        </div>
                        <span class="user-chat-status">${chat.status}</span>
                    </div>
                `;
            }).join('');
        } else {
            const historyContainer = document.getElementById('user-support-history');
            historyContainer.style.display = 'none';
        }
    } catch (error) {
        console.error('Erro ao carregar histórico de chats:', error);
    }
}

async function openExistingChat(chatId, subject) {
    try {
        currentSupportChatId = chatId;
        currentSupportSubject = subject;

        document.getElementById('support-subject-selection').style.display = 'none';
        document.getElementById('support-chat-area').style.display = 'flex';
        document.getElementById('support-current-subject').textContent = subject;

        await loadSupportMessages();

        await fetchWithAuth(`/api/support/chats/${chatId}/messages`);

        updateSupportChatCount();
    } catch (error) {
        console.error('Erro ao abrir chat existente:', error);
        showToast('Erro ao abrir chat', 'error');
    }
}

function closeSupportChat() {
    const modal = document.getElementById('modal-support-chat');
    if (modal) {
        modal.style.display = 'none';
    }

    stopTypingPoll();

    if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
    }
}

async function startSupportChat(subject) {
    try {
        const subjectNames = {
            'financeiro': 'Financeiro',
            'problema_site': 'Problema no Site',
            'duvidas': 'Tirar Dúvidas',
            'outros': 'Outros'
        };

        currentSupportSubject = subjectNames[subject] || subject;

        const response = await fetchWithAuth('/api/support/chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject: currentSupportSubject })
        });

        const data = await response.json();

        if (response.ok && data.chat) {
            currentSupportChatId = data.chat.id;

            document.getElementById('support-subject-selection').style.display = 'none';
            document.getElementById('support-chat-area').style.display = 'flex';
            document.getElementById('support-current-subject').textContent = currentSupportSubject;

            loadSupportMessages();
        } else {
            showToast('Erro ao criar chat de suporte', 'error');
        }
    } catch (error) {
        console.error('Erro ao iniciar chat:', error);
        showToast('Erro ao iniciar chat de suporte', 'error');
    }
}

function changeSupportSubject() {
    currentSupportChatId = null;
    currentSupportSubject = null;

    document.getElementById('support-subject-selection').style.display = 'flex';
    document.getElementById('support-chat-area').style.display = 'none';
}

async function loadSupportMessages() {
    if (!currentSupportChatId) return;

    try {
        const response = await fetchWithAuth(`/api/support/chats/${currentSupportChatId}/messages`);
        const data = await response.json();

        if (response.ok && data.messages) {
            const messagesContainer = document.getElementById('support-messages') || document.getElementById('admin-support-messages');
            if (messagesContainer) {
                messagesContainer.innerHTML = '';
                delete messagesContainer.dataset.lastMessageDate;
                data.messages.forEach(msg => appendSingleSupportMessage(msg));
            }

            subscribeToChatUpdates(currentSupportChatId);
        }
    } catch (error) {
        console.error('Erro ao carregar histórico de mensagens:', error);
    }
}

async function sendSupportMessage() {
    const input = document.getElementById('support-input') || document.getElementById('support-chat-input');
    const message = input ? input.value.trim() : '';

    const chatId = currentSupportChatId || currentChatId;

    if (!message || !chatId) return;

    const senderType = ['OWNER', 'MANAGER', 'ADMIN'].includes(state.user?.role) ? 'SUPPORT' : 'USER';
    const senderId = state.user?.id;
    const msgId = Date.now(); // ID local único

    // 1. Renderiza IMEDIATAMENTE na tela local
    const localMsg = {
        id: msgId,
        sender_id: senderId,
        sender_type: senderType,
        message: message,
        created_at: new Date().toISOString()
    };
    appendSingleSupportMessage(localMsg);
    input.value = '';

    // Persiste no banco e transmite pelo evento REST em tempo real.
    try {
        await fetchWithAuth(`/api/support/chats/${chatId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        if (typeof updateSupportChatCount === 'function') {
            updateSupportChatCount();
        }
    } catch (error) {
        console.error('Erro ao salvar mensagem no histórico:', error);
    }
}

// Typing indicator functions (Silenciadas para evitar erro 500 no REST)
let typingTimeout = null;
let typingPollInterval = null;
let isTypingFeatureDisabled = true;

function setTypingState(isTyping) { return; }
function handleTypingStart() { return; }
function startTypingPoll() { return; }
function stopTypingPoll() {
    if (typingPollInterval) {
        clearInterval(typingPollInterval);
        typingPollInterval = null;
    }
}

// Admin typing functions
let adminTypingTimeout = null;
let adminTypingPollInterval = null;

function handleAdminTypingStart() { return; }
function setAdminTypingState(isTyping) { return; }
function startAdminTypingPoll() { return; }
function stopAdminTypingPoll() {
    if (adminTypingPollInterval) {
        clearInterval(adminTypingPollInterval);
        adminTypingPollInterval = null;
    }
}

async function loadAdminSupportQueue() {
    if (!state.user || !['ADMIN', 'OWNER'].includes(state.user.role)) return;

    try {
        const response = await fetchWithAuth('/api/support/admin/chats');
        const data = await response.json();

        if (response.ok && data.chats) {
            const queueContainer = document.getElementById('admin-chat-queue');
            if (!queueContainer) return;

            queueContainer.innerHTML = '';

            if (data.chats.length === 0) {
                queueContainer.innerHTML = '<p class="empty-msg">Nenhum chamado pendente.</p>';
                return;
            }

            data.chats.forEach(chat => {
                const item = document.createElement('div');
                item.className = 'chat-queue-item';
                item.innerHTML = `
                    <div class="chat-info">
                        <strong>Cliente: ${chat.user_name || chat.user_id}</strong>
                        <p>Assunto: ${escapeHtml(chat.subject)}</p>
                    </div>
                    <button onclick="openAdminSupportChat(${chat.id})">Atender</button>
                `;
                queueContainer.appendChild(item);
            });
        }
    } catch (error) {
        console.error('Erro ao carregar fila de suporte:', error);
    }
}

function openAdminChat(chatId, subject) {
    currentSupportChatId = chatId;
    currentSupportSubject = subject;

    const modal = document.getElementById('modal-support-chat');
    if (modal) {
        modal.style.display = 'flex';
        document.getElementById('support-subject-selection').style.display = 'none';
        document.getElementById('support-chat-area').style.display = 'flex';
        document.getElementById('support-current-subject').textContent = subject;

        loadSupportMessages();
    }
}

// ==================== FEEDBACK FUNCTIONS ====================
async function loadFeedbacks() {
    try {
        const response = await fetchWithAuth('/api/feedbacks');
        const data = await response.json();

        if (response.ok && data.feedbacks) {
            const feedbacksList = document.getElementById('feedbacks-list');
            const feedbacksCount = document.getElementById('feedbacks-count');

            feedbacksCount.textContent = `${data.feedbacks.length} Feedbacks`;

            if (data.feedbacks.length === 0) {
                feedbacksList.innerHTML = `
                    <p style="text-align: center; color: var(--text-secondary); padding: 2rem;">
                        Nenhum feedback recebido ainda.
                    </p>
                `;
                return;
            }

            feedbacksList.innerHTML = data.feedbacks.map(feedback => {
                const date = new Date(feedback.created_at).toLocaleDateString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric'
                });

                return `
                    <div class="feedback-item">
                        <div class="feedback-header">
                            <span class="feedback-type ${feedback.type}">${feedback.type}</span>
                            <span style="font-size: 0.8rem; color: var(--text-muted);">${date}</span>
                        </div>
                        <div class="feedback-content">
                            ${feedback.content}
                        </div>
                        <div class="feedback-meta">
                            <div class="feedback-sender">
                                <i class="fa-solid fa-user"></i>
                                <span>${feedback.user_name || feedback.user_email}</span>
                            </div>
                            <span class="step-tag" style="font-size: 0.7rem;">${feedback.status}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    } catch (error) {
        console.error('Erro ao carregar feedbacks:', error);
        showToast('Erro ao carregar feedbacks', 'error');
    }
}

async function submitFeedback() {
    const type = document.getElementById('feedback-type').value;
    const content = document.getElementById('feedback-content').value.trim();

    if (!content) {
        showToast('Por favor, escreva seu feedback', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth('/api/feedbacks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, content })
        });

        if (response.ok) {
            showToast('Feedback enviado com sucesso!', 'success');
            document.getElementById('feedback-content').value = '';

            setTimeout(() => {
                switchTab('kanban');
            }, 1500);
        } else {
            showToast('Erro ao enviar feedback', 'error');
        }
    } catch (error) {
        console.error('Erro ao enviar feedback:', error);
        showToast('Erro ao enviar feedback', 'error');
    }
}

// ==================== ADMIN SUPPORT CHAT FUNCTIONS ====================
let currentAdminChatId = null;
let supportChatFilter = 'OPEN';
let supportChatsCache = [];

async function loadSupportChats() {
    try {
        const response = await fetchWithAuth('/api/support/chats');
        const data = await response.json();

        if (response.ok && data.chats) {
            supportChatsCache = data.chats;
            renderSupportChats();
        }
    } catch (error) {
        console.error('Erro ao carregar chats de suporte:', error);
        showToast('Erro ao carregar chats de suporte', 'error');
    }
}

function setSupportChatFilter(status) {
    if (!['OPEN', 'CLOSED'].includes(status)) return;
    supportChatFilter = status;

    document.getElementById('support-tab-new')?.setAttribute('aria-selected', String(status === 'OPEN'));
    document.getElementById('support-tab-closed')?.setAttribute('aria-selected', String(status === 'CLOSED'));
    document.getElementById('support-tab-new')?.classList.toggle('active', status === 'OPEN');
    document.getElementById('support-tab-closed')?.classList.toggle('active', status === 'CLOSED');
    renderSupportChats();
}

function renderSupportChats() {
    const chatsList = document.getElementById('support-chats-list');
    const chatsCount = document.getElementById('support-chats-count');
    const newCount = document.getElementById('support-new-count');
    const closedCount = document.getElementById('support-closed-count');
    if (!chatsList || !chatsCount || !newCount || !closedCount) return;

    const isClosed = chat => String(chat.status).toUpperCase() === 'CLOSED';
    const newChats = supportChatsCache.filter(chat => !isClosed(chat));
    const closedChats = supportChatsCache.filter(isClosed);
    const visibleChats = supportChatFilter === 'CLOSED' ? closedChats : newChats;

    chatsCount.textContent = `${supportChatsCache.length} Chats`;
    newCount.textContent = newChats.length;
    closedCount.textContent = closedChats.length;

    if (visibleChats.length === 0) {
        chatsList.innerHTML = `
            <p class="empty-msg">${supportChatFilter === 'CLOSED' ? 'Nenhum atendimento encerrado.' : 'Nenhum atendimento novo.'}</p>
        `;
        return;
    }

    chatsList.innerHTML = visibleChats.map(chat => {
        const lastActivity = chat.last_message_at || chat.updated_at || chat.created_at;
        const date = new Date(lastActivity).toLocaleDateString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        const unreadClass = chat.is_unread ? 'unread' : '';
        const unreadBadge = chat.is_unread ? '<span class="unread-badge">Nova</span>' : '';
        const statusLabel = isClosed(chat) ? 'Encerrado' : 'Novo';

        return `
            <div class="support-chat-item ${unreadClass}" onclick="openAdminSupportChat(${chat.id})">
                <div class="support-chat-header">
                    <div class="support-chat-user">
                        <i class="fa-solid fa-user"></i>
                        <div>
                            <div class="support-chat-user-name">${escapeHtml(chat.user_name || 'Usuário')}</div>
                            <div class="support-chat-user-email">${escapeHtml(chat.user_email || '')}</div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <span class="support-chat-subject">${escapeHtml(chat.subject)}</span>
                        ${unreadBadge}
                    </div>
                </div>
                <div class="support-chat-preview">
                    <i class="fa-solid fa-message"></i> Última atividade: ${date}
                </div>
                <div class="support-chat-meta">
                    <span>Status: ${statusLabel}</span>
                    <span>${chat.message_count || 0} mensagens</span>
                </div>
            </div>
        `;
    }).join('');
}

async function updateAdminSupportChatStatus(status) {
    if (currentAdminChatId === null) return;
    if (!['OPEN', 'CLOSED'].includes(status)) return;

    try {
        const response = await fetchWithAuth(`/api/support/chats/${currentAdminChatId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        const data = await response.json();

        if (!response.ok) {
            showToast(data.message || 'Não foi possível atualizar o atendimento.', 'error');
            return;
        }

        document.getElementById('modal-admin-support-chat').style.display = 'none';
        currentAdminChatId = null;
        stopAdminTypingPoll();
        setSupportChatFilter(status);
        await loadSupportChats();
        showToast(status === 'CLOSED' ? 'Atendimento encerrado.' : 'Atendimento reaberto.', 'success');
    } catch (error) {
        console.error('Erro ao atualizar atendimento:', error);
        showToast('Erro ao atualizar atendimento.', 'error');
    }
}

function finishAdminSupportChat() {
    return updateAdminSupportChatStatus('CLOSED');
}

function reopenAdminSupportChat() {
    return updateAdminSupportChatStatus('OPEN');
}

async function openAdminSupportChat(chatId) {
    try {
        currentAdminChatId = chatId;

        const response = await fetchWithAuth(`/api/support/chats/${chatId}/messages`);
        const data = await response.json();

        if (response.ok && data.messages) {
            const chatResponse = await fetchWithAuth('/api/support/chats');
            const chatData = await chatResponse.json();
            const chatInfo = chatData.chats.find(c => c.id === chatId);

            if (chatInfo) {
                document.getElementById('admin-support-user-name').textContent = chatInfo.user_name || 'Usuário';
                document.getElementById('admin-support-user-email').textContent = chatInfo.user_email;
                document.getElementById('admin-support-subject').textContent = chatInfo.subject;
                const isClosed = String(chatInfo.status).toUpperCase() === 'CLOSED';
                const closeAction = document.getElementById('admin-support-close-action');
                const reopenAction = document.getElementById('admin-support-reopen-action');
                const input = document.getElementById('admin-support-input');
                const sendButton = input?.nextElementSibling;
                if (closeAction) closeAction.style.display = isClosed ? 'none' : 'inline-flex';
                if (reopenAction) reopenAction.style.display = isClosed ? 'inline-flex' : 'none';
                if (input) {
                    input.disabled = isClosed;
                    input.placeholder = isClosed ? 'Atendimento encerrado' : 'Digite sua resposta...';
                }
                if (sendButton) sendButton.disabled = isClosed;
            }

            const messagesContainer = document.getElementById('admin-support-messages');
            messagesContainer.innerHTML = '';
            delete messagesContainer.dataset.lastMessageDate;

            data.messages.forEach(msg => appendSingleSupportMessage(msg));

            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            startAdminTypingPoll();
            document.getElementById('modal-admin-support-chat').style.display = 'flex';
        }
    } catch (error) {
        console.error('Erro ao abrir chat de suporte:', error);
        showToast('Erro ao abrir chat de suporte', 'error');
    }
}

function closeAdminSupportChat() {
    document.getElementById('modal-admin-support-chat').style.display = 'none';
    currentAdminChatId = null;
    stopAdminTypingPoll();
    loadSupportChats();
}

async function sendAdminSupportMessage() {
    const input = document.getElementById('admin-support-input');
    const message = input ? input.value.trim() : '';

    if (!message || !currentAdminChatId) return;

    const localMsg = {
        id: Date.now(),
        sender_id: state.user.id,
        sender_type: 'SUPPORT',
        message: message,
        created_at: new Date().toISOString()
    };

    // Renderiza na tela do suporte imediatamente
    appendSingleSupportMessage(localMsg);
    input.value = '';

    // Persiste no banco e transmite pelo evento REST em tempo real.
    try {
        await fetchWithAuth(`/api/support/chats/${currentAdminChatId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
    } catch (error) {
        console.error('Erro ao persistir resposta do admin:', error);
    }
}

window.openAuthentication = openAuthentication;
window.handleLogin = handleLogin;
window.logout = logout;

// Revalida a sessão ao voltar para a aba/janela: se o e-mail foi trocado em outro aparelho, /api/auth/me devolve 401 e o logout é automático.
(function () {
    let last = 0;
    function check() {
        if (!state.user || !state.token) return;
        const now = Date.now();
        if (now - last < 60000) return;
        last = now;
        refreshAuthenticatedUser();
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.addEventListener('focus', check);
    setInterval(check, 300000);
})();
window.openForgotPasswordModal = openForgotPasswordModal;
window.submitForgotPassword = submitForgotPassword;
window.submitResetPassword = submitResetPassword;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.saveProfileChanges = saveProfileChanges;
window.openSupportChat = openSupportChat;
window.closeSupportChat = closeSupportChat;
window.sendSupportMessage = sendSupportMessage;
window.openAdminSupportChat = openAdminSupportChat;
window.closeAdminSupportChat = closeAdminSupportChat;
window.sendAdminSupportMessage = sendAdminSupportMessage;
window.setSupportChatFilter = setSupportChatFilter;
window.finishAdminSupportChat = finishAdminSupportChat;
window.reopenAdminSupportChat = reopenAdminSupportChat;
window.changePassword = changePassword;
window.confirmPasswordChange = confirmPasswordChange;
window.resetPasswordChangeUI = resetPasswordChangeUI;
window.changeEmail = changeEmail;
window.confirmEmailChange = confirmEmailChange;
window.managerResetMemberPassword = managerResetMemberPassword;
window.confirmManagerPasswordChange = confirmManagerPasswordChange;
window.managerChangeMemberEmail = managerChangeMemberEmail;
window.confirmManagerEmailChange = confirmManagerEmailChange;
window.submitMasterChangeEmail = submitMasterChangeEmail;
window.confirmMasterEmailChange = confirmMasterEmailChange;
window.resetMasterEmailChangeUI = resetMasterEmailChangeUI;
window.submitMasterResetPassword = submitMasterResetPassword;
window.confirmMasterPasswordChange = confirmMasterPasswordChange;
window.resetMasterPasswordChangeUI = resetMasterPasswordChangeUI;
window.selectPlanAndRedirect = selectPlanAndRedirect;
window.openAdminPanel = openAdminPanel;
window.closeAdminPanel = closeAdminPanel;
window.openUserManagement = openUserManagement;
window.closeUserManagement = closeUserManagement;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.openReports = openReports;
window.closeReports = closeReports;
window.openAnalytics = openAnalytics;
window.closeAnalytics = closeAnalytics;
window.openDashboard = openDashboard;
window.closeDashboard = closeDashboard;

// Clique em Login/Cadastre-se feito antes do script terminar de carregar (ver stub no index.html).
if (window.__pendingAuth) {
    const pending = window.__pendingAuth;
    window.__pendingAuth = null;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.openAuthentication(pending));
    else window.openAuthentication(pending);
}