(function () {
    let loaded = false;
    let renderedPaid = null;

    function isPaid() {
        const t = typeof state !== 'undefined' && state && state.user && state.user.planTier;
        return ['STARTER', 'PRO_IA'].includes(t);
    }

    function token() {
        return (typeof state !== 'undefined' && state && state.token) || localStorage.getItem('klweb_token');
    }

    function esc(v) {
        return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadNotificationSettings() {
        const box = document.getElementById('notif-settings-list');
        if (!box || !token()) return;
        try {
            const res = await fetch('/api/user/notification-settings', { headers: { Authorization: 'Bearer ' + token() } });
            if (!res.ok) throw new Error();
            const { kinds, prefs, emailAllowed } = await res.json();
            const paid = typeof emailAllowed === 'boolean' ? emailAllowed : isPaid();
            renderedPaid = paid;
            const lockTip = 'E-mails de notificação estão disponíveis a partir do plano Starter';
            box.innerHTML = '<table style="width:100%; border-collapse:collapse; font-size:0.9rem;">' +
                '<thead><tr style="text-align:left; color:var(--text-secondary);"><th style="padding:6px 0;">Aviso</th>' +
                '<th style="width:80px; text-align:center;">Painel</th><th style="width:120px; text-align:center;">E-mail' +
                (paid ? '<br><label style="font-weight:400; font-size:0.75rem; cursor:pointer;"><input type="checkbox" id="notif-email-all"> ativar todos</label>'
                      : ' <i class="fa-solid fa-lock" title="' + lockTip + '"></i>') + '</th></tr></thead><tbody>' +
                Object.keys(kinds).map(k =>
                    '<tr style="border-top:1px solid var(--border);"><td style="padding:10px 0;">' + esc(kinds[k]) + '</td>' +
                    '<td style="text-align:center;"><input type="checkbox" data-kind="' + esc(k) + '" data-channel="panel"' + (prefs[k].panel ? ' checked' : '') + '></td>' +
                    '<td style="text-align:center;"><input type="checkbox" data-kind="' + esc(k) + '" data-channel="email"' + (paid ? (prefs[k].email ? ' checked' : '') : ' disabled title="' + lockTip + '"') + '></td></tr>'
                ).join('') + '</tbody></table>';
            if (!paid) {
                box.insertAdjacentHTML('beforeend', '<p style="margin-top:0.75rem; font-size:0.85rem; color:var(--text-secondary);"><i class="fa-solid fa-lock"></i> Receber avisos por e-mail é um recurso do plano <strong>Starter</strong> ou superior. <a href="#" onclick="switchTab(\'plans\'); return false;">Ver planos</a></p>');
            }
            loaded = true;
        } catch (e) {
            box.textContent = 'Não foi possível carregar as preferências de notificação.';
        }
    }

    window.saveNotificationSettings = async function () {
        const boxes = document.querySelectorAll('#notif-settings-list input[type="checkbox"]');
        if (!boxes.length) return;
        const prefs = {};
        boxes.forEach(b => {
            prefs[b.dataset.kind] = prefs[b.dataset.kind] || {};
            if (b.disabled) return;
            prefs[b.dataset.kind][b.dataset.channel] = b.checked;
        });
        try {
            const res = await fetch('/api/user/notification-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
                body: JSON.stringify({ prefs })
            });
            if (!res.ok) throw new Error();
            if (typeof showToast === 'function') showToast('Preferências de notificação salvas.', 'success');
        } catch (e) {
            if (typeof showToast === 'function') showToast('Erro ao salvar notificações.', 'error');
        }
    };

    let saveTimer = null;
    document.addEventListener('change', function (ev) {
        if (ev.target && ev.target.id === 'notif-email-all') {
            document.querySelectorAll('#notif-settings-list input[data-channel="email"]:not(:disabled)').forEach(function (c) { c.checked = ev.target.checked; });
        }
        if (!ev.target.closest || !ev.target.closest('#notif-settings-list')) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () { window.saveNotificationSettings(); }, 300);
    });

    document.addEventListener('DOMContentLoaded', function () {
        const pane = document.getElementById('tab-settings');
        if (!pane) return;
        let wasActive = false;
        new MutationObserver(function () {
            const nowActive = pane.classList.contains('active');
            if (nowActive && !wasActive) loadNotificationSettings();
            wasActive = nowActive;
        }).observe(pane, { attributes: true, attributeFilter: ['class'] });
    });
})();