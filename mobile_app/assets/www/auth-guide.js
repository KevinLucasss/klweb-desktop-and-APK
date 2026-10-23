(() => {
    const updateAuthMode = window.updateAuthMode;
    if (typeof updateAuthMode !== 'function') {
        throw new Error('Não foi possível inicializar as informações de permissões do cadastro.');
    }

    window.updateAuthMode = function (...args) {
        const result = updateAuthMode.apply(this, args);
        const authScreen = document.getElementById('auth-screen');
        const registrationType = document.getElementById('group-registration-type');

        if (authScreen && registrationType) {
            authScreen.classList.toggle('is-register-mode', registrationType.style.display !== 'none');
        }

        return result;
    };
})();
