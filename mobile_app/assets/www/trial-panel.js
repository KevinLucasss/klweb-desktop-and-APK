// Aviso do trial de 7 dias DENTRO do painel (Quadro de Demandas, aba Planos e card do plano na lateral).
// O trial é ativado automaticamente ao confirmar o e-mail, sem precisar de cartão.
// Este script só mostra o CONTADOR DE DIAS RESTANTES quando o usuário está no trial ativo.
(function () {
    var lastSig = null;
    var refreshAskedFor = null;

    function currentUser() {
        return (typeof state !== 'undefined' && state && state.user) || null;
    }

    // active = está no trial | none = sem trial ativo
    function describe(u) {
        if (!u) return { kind: 'none' };
        var tier = u.planTier;
        if (u.trialEnd && tier === 'STARTER' && u.planStatus === 'ACTIVE') {
            var ms = new Date(u.trialEnd).getTime() - Date.now();
            if (ms > 0) return { kind: 'active', days: Math.ceil(ms / 86400000), hours: Math.ceil(ms / 3600000), end: new Date(u.trialEnd) };
        }
        return { kind: 'none' };
    }

    function banner(id, info) {
        var el = document.createElement('div');
        el.id = id;
        el.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;' +
            'background:linear-gradient(135deg,#7c3aed 0%,#6366f1 100%);color:#fff;padding:14px 18px;border-radius:12px;' +
            'margin:0 0 16px 0;box-shadow:0 4px 14px rgba(99,102,241,.35);';

        var when = info.days === 1 ? 'termina em 1 dia' : 'termina em ' + info.days + ' dias';
        var msg = document.createElement('div');
        msg.style.cssText = 'flex:1 1 280px;font-size:14px;line-height:1.5;';
        msg.innerHTML = '🎁 <strong>Seu trial grátis ' + when + '</strong> (' + info.end.toLocaleDateString('pt-BR') + '). ' +
            'Para continuar com todos os recursos, assine o plano Starter.';
        el.appendChild(msg);

        var actions = document.createElement('div');
        actions.style.cssText = 'display:flex;align-items:center;gap:8px;';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = 'background:#fff;color:#6d28d9;border:none;padding:9px 18px;border-radius:20px;font-weight:600;cursor:pointer;font-size:13px;';
        btn.textContent = 'Ver Planos';
        btn.addEventListener('click', function () {
            if (typeof switchTab === 'function') switchTab('plans');
        });
        actions.appendChild(btn);
        el.appendChild(actions);
        return el;
    }

    function put(paneId, bannerId, info) {
        var pane = document.getElementById(paneId);
        var old = document.getElementById(bannerId);
        if (old) old.remove();
        if (pane) pane.insertBefore(banner(bannerId, info), pane.firstChild);
    }

    // Updates the sidebar plan card to reflect the active trial:
    // - pill text -> "STARTER", purple gradient
    // - shows countdown bar with days remaining / 7
    // - button -> "Ver Planos"
    function updateSidebarPlanCard(info) {
        var pill = document.getElementById('sidebar-plan-pill');
        var card = document.querySelector('.sidebar-plan-card');
        var cardBody = card ? card.querySelector('.plan-card-body p') : null;
        var upgradeBtn = card ? card.querySelector('.btn-upgrade-mini') : null;

        // Remove any previously injected trial countdown
        var oldCountdown = document.getElementById('sidebar-trial-countdown');
        if (oldCountdown) oldCountdown.remove();

        if (info.kind === 'active') {
            if (pill) {
                pill.textContent = 'STARTER';
                pill.style.background = 'linear-gradient(135deg,#7c3aed,#6366f1)';
                pill.style.color = '#fff';
                pill.style.border = 'none';
            }
            if (cardBody) cardBody.textContent = 'Trial — IA & Demandas Ilimitadas';
            if (card) {
                card.style.background = 'linear-gradient(135deg,rgba(124,58,237,.15) 0%,rgba(99,102,241,.08) 100%)';
                card.style.borderColor = 'rgba(124,58,237,.35)';
            }

            var daysLeft = info.days;
            var displayText = daysLeft > 1
                ? daysLeft + ' dias restantes'
                : (daysLeft === 1 ? '1 dia restante' : info.hours + 'h restantes');
            var pct = Math.max(0, Math.min(100, Math.round((daysLeft / 7) * 100)));

            var countdown = document.createElement('div');
            countdown.id = 'sidebar-trial-countdown';
            countdown.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 4px;font-size:11px;color:var(--text-muted,#888);">' +
                    '<span>⏱ Trial expira em</span>' +
                    '<span style="font-weight:700;color:#7c3aed;">' + displayText + '</span>' +
                '</div>' +
                '<div style="height:4px;border-radius:4px;background:rgba(124,58,237,.15);overflow:hidden;margin-bottom:6px;">' +
                    '<div style="height:100%;width:' + pct + '%;border-radius:4px;background:linear-gradient(90deg,#7c3aed,#6366f1);transition:width .5s;"></div>' +
                '</div>';

            if (upgradeBtn && upgradeBtn.parentNode) {
                upgradeBtn.parentNode.insertBefore(countdown, upgradeBtn);
            } else if (card) {
                var body = card.querySelector('.plan-card-body');
                if (body) body.appendChild(countdown);
            }

            if (upgradeBtn) {
                upgradeBtn.textContent = 'Ver Planos';
                upgradeBtn.style.background = 'linear-gradient(135deg,#7c3aed,#6366f1)';
                upgradeBtn.style.color = '#fff';
                upgradeBtn.style.border = 'none';
                upgradeBtn.onclick = function () { if (typeof switchTab === 'function') switchTab('plans'); };
            }
        } else {
            // Restore defaults
            if (pill) { pill.textContent = 'BASICO'; pill.style.background = ''; pill.style.color = ''; pill.style.border = ''; }
            if (cardBody) cardBody.textContent = 'IA & Demandas Ativas';
            if (card) { card.style.background = ''; card.style.borderColor = ''; }
            if (upgradeBtn) {
                upgradeBtn.textContent = 'Ver Plano';
                upgradeBtn.style.background = '';
                upgradeBtn.style.color = '';
                upgradeBtn.style.border = '';
                upgradeBtn.onclick = function () { if (typeof switchTab === 'function') switchTab('plans'); };
            }
        }
    }

    function clearAll() {
        ['trial-panel-plans', 'trial-panel-kanban', 'sidebar-trial-countdown'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.remove();
        });
    }

    function render() {
        var u = currentUser();

        // O objeto do login pode não trazer os dados do trial: busca uma vez em /api/auth/me.
        if (u && typeof u.freeTrialUsed === 'undefined' && typeof refreshAuthenticatedUser === 'function') {
            var key = String(u.id || u.email || 'u');
            if (refreshAskedFor !== key) {
                refreshAskedFor = key;
                refreshAuthenticatedUser();
            }
            return;
        }

        var info = describe(u);
        var sig = info.kind + '|' + (info.days || '');
        var present = !!document.getElementById('trial-panel-plans');
        if (sig === lastSig && present === (info.kind !== 'none')) return;
        lastSig = sig;

        if (info.kind === 'none') { clearAll(); updateSidebarPlanCard({ kind: 'none' }); return; }

        // Show countdown banner in plans tab and kanban tab
        put('tab-plans', 'trial-panel-plans', info);
        put('tab-kanban', 'trial-panel-kanban', info);
        updateSidebarPlanCard(info);
    }

    window.refreshTrialPanel = render;
    document.addEventListener('DOMContentLoaded', function () {
        render();
        setInterval(render, 1500);
    });
})();
