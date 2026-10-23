function masterSubTab(name) {
    document.querySelectorAll('.master-subtab').forEach(b => b.classList.toggle('active', b.dataset.mtab === name));
    document.querySelectorAll('.master-section').forEach(s => { s.style.display = s.dataset.msec === name ? '' : 'none'; });
}

// Equipe do site (admin / gerente do site) só consulta usuários e troca planos.
function applyMasterStaffView(isSiteOwner) {
    const ownerOnly = ['account'];
    ownerOnly.forEach(name => {
        const tab = document.querySelector(`.master-subtab[data-mtab="${name}"]`);
        if (tab) tab.style.display = isSiteOwner ? '' : 'none';
        const sec = document.querySelector(`.master-section[data-msec="${name}"]`);
        if (sec && !isSiteOwner) sec.style.display = 'none';
    });
}