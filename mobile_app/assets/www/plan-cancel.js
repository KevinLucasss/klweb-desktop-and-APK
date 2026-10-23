(function () {
    function token() {
        return (typeof state !== 'undefined' && state && state.token) || localStorage.getItem('klweb_token');
    }

    function refreshVisibility() {
        const box = document.getElementById('plan-cancel-box');
        if (!box || typeof state === 'undefined' || !state.user) return;
        const paid = ['STARTER', 'PRO_IA'].includes(state.user.planTier) && state.user.planStatus === 'ACTIVE';
        // Também aparece durante o período de teste: o cartão já está autorizado e será cobrado no fim dele.
        const hasSubscription = !!state.user.hasSubscription;
        box.style.display = (paid || hasSubscription) ? '' : 'none';
    }

    window.cancelSubscription = async function () {
        if (!confirm('Cancelar sua assinatura? Você volta para o plano gratuito agora e não será cobrado novamente.')) return;
        try {
            const res = await fetch('/api/payments/cancel', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token() }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Erro ao cancelar.');
            if (typeof showToast === 'function') showToast(data.message, 'success');
            if (typeof refreshAuthenticatedUser === 'function') await refreshAuthenticatedUser();
            if (typeof updatePlanCardsUI === 'function') updatePlanCardsUI();
            refreshVisibility();
        } catch (e) {
            if (typeof showToast === 'function') showToast(e.message, 'error');
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        const pane = document.getElementById('tab-plans');
        if (!pane) return;
        new MutationObserver(refreshVisibility).observe(pane, { attributes: true, attributeFilter: ['class'] });
    });
})();