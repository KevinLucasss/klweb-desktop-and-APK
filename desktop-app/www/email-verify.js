/* Confirmação de e-mail no cadastro: tela para digitar o código enviado ao e-mail.
   Usa funções do core.min.js (state, updateAuthMode, showToast, showAuthError) e é carregado depois dele. */
(function () {
    var RESEND_SECONDS = 60;
    var current = { email: '' };
    var timer = null;

    function $(id) { return document.getElementById(id); }

    function ensurePanel() {
        var panel = $('email-verify-panel');
        if (panel) return panel;
        var form = $('auth-form');
        if (!form || !form.parentNode) return null;
        panel = document.createElement('div');
        panel.id = 'email-verify-panel';
        panel.style.display = 'none';
        panel.innerHTML =
            '<p id="email-verify-hint" style="color: var(--text-secondary); font-size: 0.9rem; margin: 0 0 1rem;"></p>' +
            '<div class="form-group">' +
            '<label for="email-verify-code"><i class="fa-solid fa-shield-halved"></i> Código de confirmação</label>' +
            '<input type="text" id="email-verify-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" ' +
            'style="letter-spacing: 0.5rem; text-align: center; font-size: 1.4rem;">' +
            '</div>' +
            '<button type="button" class="btn-primary btn-submit" id="email-verify-btn"><i class="fa-solid fa-circle-check"></i> <span>Confirmar e-mail</span></button>' +
            '<div style="display: flex; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; font-size: 0.85rem;">' +
            '<button type="button" id="email-verify-resend" class="link-btn" style="background: none; border: 0; color: var(--accent); cursor: pointer; text-decoration: underline; padding: 0;">Reenviar código</button>' +
            '<button type="button" id="email-verify-back" class="link-btn" style="background: none; border: 0; color: var(--text-secondary); cursor: pointer; text-decoration: underline; padding: 0;">Voltar</button>' +
            '</div>';
        form.parentNode.insertBefore(panel, form);
        $('email-verify-btn').addEventListener('click', confirmEmailVerification);
        $('email-verify-resend').addEventListener('click', function () { resendEmailVerification(false); });
        $('email-verify-back').addEventListener('click', closeEmailVerification);
        $('email-verify-code').addEventListener('input', function (e) { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
        $('email-verify-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); confirmEmailVerification(); } });
        return panel;
    }

    function setBusy(busy) {
        var b = $('email-verify-btn');
        if (b) b.disabled = busy;
    }

    function startCooldown(seconds) {
        var btn = $('email-verify-resend');
        if (!btn) return;
        clearInterval(timer);
        var left = seconds;
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.textContent = 'Reenviar código (' + left + 's)';
        timer = setInterval(function () {
            left--;
            if (left <= 0) {
                clearInterval(timer);
                btn.disabled = false;
                btn.style.opacity = '';
                btn.textContent = 'Reenviar código';
            } else {
                btn.textContent = 'Reenviar código (' + left + 's)';
            }
        }, 1000);
    }

    // emailSent=false: o cadastro foi criado, mas o envio falhou; libera o reenvio na hora.
    window.openEmailVerification = function (email, message, emailSent, fromLogin) {
        var panel = ensurePanel();
        if (!panel) return;
        current.email = String(email || '').trim().toLowerCase();

        // Volta para o modo "entrar" (esconde os campos do cadastro e o guia de permissões)
        if (typeof state !== 'undefined') state.isRegisterMode = false;
        if (typeof updateAuthMode === 'function') updateAuthMode();

        var errorBox = $('auth-error-box'); if (errorBox) errorBox.style.display = 'none';
        var form = $('auth-form'); if (form) form.style.display = 'none';
        var toggle = $('auth-toggle'); if (toggle) toggle.style.display = 'none';
        var title = $('auth-title'); if (title) title.innerText = 'Confirme seu e-mail';
        var subtitle = $('auth-subtitle'); if (subtitle) subtitle.innerText = 'Falta só um passo para ativar sua conta.';

        $('email-verify-hint').textContent = message ||
            ('Enviamos um código de 6 dígitos para ' + current.email + '. Digite-o abaixo.');
        $('email-verify-code').value = '';
        panel.style.display = 'block';
        setTimeout(function () { $('email-verify-code').focus(); }, 50);

        if (fromLogin) {
            // Veio do login: manda um código novo, caso o anterior tenha se perdido.
            resendEmailVerification(true);
        } else if (emailSent === false) {
            var btn = $('email-verify-resend');
            clearInterval(timer);
            if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'Reenviar código'; }
        } else {
            startCooldown(RESEND_SECONDS);
        }
    };

    window.closeEmailVerification = function () {
        clearInterval(timer);
        var panel = $('email-verify-panel'); if (panel) panel.style.display = 'none';
        var form = $('auth-form'); if (form) form.style.display = '';
        var toggle = $('auth-toggle'); if (toggle) toggle.style.display = '';
        if (typeof state !== 'undefined') state.isRegisterMode = false;
        if (typeof updateAuthMode === 'function') updateAuthMode();
    };

    window.confirmEmailVerification = async function () {
        var code = ($('email-verify-code').value || '').replace(/\D/g, '');
        if (code.length !== 6) {
            if (typeof showToast === 'function') showToast('Digite o código de 6 dígitos.', 'error');
            return;
        }
        setBusy(true);
        try {
            var res = await fetch('/api/auth/verify-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: current.email, code: code })
            });
            var data = {};
            try { data = await res.json(); } catch (e) { data = {}; }
            if (!res.ok || !data.success) {
                if (typeof showToast === 'function') showToast(data.message || 'Código inválido.', 'error');
                if (data.code === 'VERIFY_RESTART') {
                    var btn = $('email-verify-resend');
                    clearInterval(timer);
                    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'Reenviar código'; }
                }
                return;
            }
            var email = current.email;
            window.closeEmailVerification();
            var emailInput = $('auth-email'); if (emailInput) emailInput.value = email;
            var passInput = $('auth-password'); if (passInput) { passInput.value = ''; passInput.focus(); }
            if (typeof showToast === 'function') showToast(data.message || 'E-mail confirmado! Faça login.', 'success');
        } catch (err) {
            if (typeof showToast === 'function') showToast('Erro de conexão com o servidor.', 'error');
        } finally {
            setBusy(false);
        }
    };

    window.resendEmailVerification = async function (silent) {
        if (!current.email) return;
        var btn = $('email-verify-resend');
        if (btn) btn.disabled = true;
        try {
            var res = await fetch('/api/auth/resend-verification', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: current.email })
            });
            var data = {};
            try { data = await res.json(); } catch (e) { data = {}; }
            if (res.ok && data.success) {
                if (!silent && typeof showToast === 'function') showToast('Enviamos um novo código para ' + current.email + '.', 'success');
                startCooldown(RESEND_SECONDS);
            } else {
                if (typeof showToast === 'function' && !(silent && res.status === 429)) showToast(data.message || 'Não foi possível reenviar o código.', 'error');
                if (res.status === 429) startCooldown(RESEND_SECONDS); else if (btn) btn.disabled = false;
            }
        } catch (err) {
            if (btn) btn.disabled = false;
            if (typeof showToast === 'function') showToast('Erro de conexão com o servidor.', 'error');
        }
    };
})();

/* Gatilho: abre a tela do código quando o servidor pede confirmação de e-mail.
   Não depende de alterar o core.min.js: observa só as respostas de cadastro e login. */
(function () {
    if (window.__emailVerifyHooked || typeof window.fetch !== 'function') return;
    window.__emailVerifyHooked = true;
    var originalFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
        return originalFetch(input, init).then(function (response) {
            try {
                var url = String(typeof input === 'string' ? input : (input && input.url) || '').split('?')[0];
                var isRegister = /\/api\/auth\/register$/.test(url);
                var isLogin = /\/api\/auth\/login$/.test(url);
                if (isRegister || isLogin) {
                    response.clone().json().then(function (data) {
                        if (!data || !data.email) return;
                        if (isRegister && data.requiresVerification) {
                            // setTimeout: deixa o core.min.js terminar a rotina dele (aviso e volta ao modo "entrar") primeiro
                            setTimeout(function () { window.openEmailVerification(data.email, null, data.emailSent, false); }, 0);
                        } else if (isLogin && data.code === 'EMAIL_NOT_VERIFIED') {
                            setTimeout(function () { window.openEmailVerification(data.email, data.message, true, true); }, 0);
                        }
                    }).catch(function () { });
                }
            } catch (e) { }
            return response;
        });
    };
})();