/*!
 * clinica.js — KL Web: Anotações + ficha de paciente (contatos) + agendamento de pacientes (calendário)
 * Carregado depois do core.min.js (veja index.html). Não altera os arquivos minificados:
 * espera o pacote do workspace carregar (após o login) e então "encaixa" as novidades nas funções existentes.
 */
(function () {
    'use strict';
    if (window.__klClinicaLoaded) return;
    window.__klClinicaLoaded = true;

    // ------------------------------------------------------------------ utilitários
    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const attrJson = v => esc(JSON.stringify(v == null ? '' : String(v)));
    const toast = (msg, type) => (typeof showToast === 'function' ? showToast(msg, type || 'info') : alert(msg));
    const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const isShown = id => { const el = $(id); return !!el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none'; };

    function isValidCPF(v) {
        const d = String(v || '').replace(/\D/g, '');
        if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
        for (let t = 9; t < 11; t++) {
            let sum = 0;
            for (let i = 0; i < t; i++) sum += Number(d[i]) * (t + 1 - i);
            if (((sum * 10) % 11) % 10 !== Number(d[t])) return false;
        }
        return true;
    }
    const maskCPF = v => {
        const d = String(v || '').replace(/\D/g, '').slice(0, 11);
        return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
    };
    const hiddenCPF = v => (String(v || '').length >= 14 ? '•••.•••.•••-' + String(v).slice(-2) : '');
    const fmtDate = iso => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
    const fmtDateTime = iso => { try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return ''; } };
    const validEmail = e => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(String(e || '').trim());

    async function api(path, options) {
        const res = await fetchWithAuth(path, options);
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    }

    // ------------------------------------------------------------------ definição dos campos
    const SEXO = [['', 'Selecione'], ['FEMININO', 'Feminino'], ['MASCULINO', 'Masculino'], ['OUTRO', 'Outro'], ['NAO_INFORMADO', 'Prefere não informar']];
    const TIPO = [['', 'Selecione'], ['CONSULTA', 'Consulta'], ['EXAME', 'Exame'], ['TERAPIA', 'Terapia / sessão'], ['RETORNO', 'Retorno'], ['AVALIACAO', 'Avaliação'], ['PROCEDIMENTO', 'Procedimento'], ['OUTRO', 'Outro']];
    const MODAL = [['', 'Selecione'], ['PRESENCIAL', 'Presencial'], ['ONLINE', 'Online']];
    const PAGTO = [['', 'Selecione'], ['PARTICULAR', 'Particular'], ['CONVENIO', 'Convênio / plano']];
    const SITUACAO = [['', 'Selecione'], ['AGENDADO', 'Agendado'], ['CONFIRMADO', 'Confirmado'], ['COMPARECEU', 'Compareceu'], ['FALTOU', 'Faltou'], ['CANCELADO', 'Cancelado'], ['REMARCADO', 'Remarcado']];
    const label = (list, v) => (list.find(x => x[0] === v) || [, v || ''])[1];

    // [chave, rótulo, tipo (text|cpf|date|select|long|number|email), opções/placeholder]
    const CLINIC_GROUPS = [
        ['Identificação', [['cpf', 'CPF', 'cpf'], ['rg', 'RG', 'text'], ['nascimento', 'Data de nascimento', 'date'], ['sexo', 'Sexo', 'select', SEXO], ['estado_civil', 'Estado civil', 'text'], ['profissao', 'Profissão', 'text']]],
        ['Contato e endereço', [['telefone2', 'Telefone 2', 'text'], ['cep', 'CEP', 'text'], ['endereco', 'Endereço (rua, nº, bairro)', 'text'], ['cidade', 'Cidade', 'text'], ['estado', 'UF', 'text']]],
        ['Convênio / plano de saúde', [['convenio', 'Convênio', 'text'], ['carteirinha', 'Nº da carteirinha', 'text'], ['validade_carteirinha', 'Validade da carteirinha', 'date']]],
        ['Responsável e emergência', [['responsavel', 'Responsável (se menor de idade)', 'text'], ['cpf_responsavel', 'CPF do responsável', 'cpf'], ['contato_emergencia', 'Contato de emergência', 'text'], ['telefone_emergencia', 'Telefone de emergência', 'text']]],
        ['Saúde', [['queixa', 'Queixa / motivo principal', 'long'], ['historico', 'Histórico de saúde', 'long'], ['alergias', 'Alergias', 'long'], ['medicamentos', 'Medicamentos em uso', 'long'], ['encaminhado_por', 'Encaminhado por', 'text'], ['profissional_preferido', 'Profissional de preferência', 'text']]]
    ];
    const CLINIC_FIELDS = CLINIC_GROUPS.flatMap(g => g[1]);

    const PATIENT_FIELDS = [
        ['tipo_atendimento', 'Tipo de atendimento', 'select', TIPO], ['situacao', 'Situação', 'select', SITUACAO],
        ['procedimento', 'Exame / procedimento', 'text'], ['profissional', 'Profissional (médico, psicólogo…)', 'text'],
        ['especialidade', 'Especialidade', 'text'], ['local', 'Sala / unidade', 'text'],
        ['duracao', 'Duração (minutos)', 'number'], ['modalidade', 'Modalidade', 'select', MODAL],
        ['pagamento', 'Pagamento', 'select', PAGTO], ['valor', 'Valor (R$)', 'text'],
        ['convenio', 'Convênio', 'text'], ['carteirinha', 'Nº da carteirinha', 'text'],
        ['cpf', 'CPF do paciente', 'cpf'], ['nascimento', 'Nascimento', 'date'], ['email', 'E-mail do paciente', 'email']
    ];

    function fieldHtml(prefix, f) {
        const [key, lbl, type, opts] = f;
        const id = `${prefix}-${key}`;
        const L = `<label for="${id}">${esc(lbl)}</label>`;
        if (type === 'select') return `<div class="form-group">${L}<select id="${id}">${opts.map(o => `<option value="${o[0]}">${esc(o[1])}</option>`).join('')}</select></div>`;
        if (type === 'long') return `<div class="form-group kl-full">${L}<textarea id="${id}" rows="2" maxlength="2000"></textarea></div>`;
        const t = type === 'date' ? 'date' : type === 'number' ? 'number' : type === 'email' ? 'email' : 'text';
        const extra = type === 'cpf' ? ' inputmode="numeric" maxlength="14" placeholder="000.000.000-00"' : type === 'number' ? ' min="0" max="1000"' : ' maxlength="150"';
        return `<div class="form-group">${L}<input type="${t}" id="${id}"${extra} data-kl-type="${type}"></div>`;
    }
    function collect(prefix, fields, includeEmpty) {
        const out = {};
        fields.forEach(f => {
            const el = $(`${prefix}-${f[0]}`);
            if (!el) return;
            const v = String(el.value || '').trim();
            if (v !== '') out[f[0]] = f[2] === 'number' ? Number(v) : v;
            else if (includeEmpty) out[f[0]] = '';
        });
        return out;
    }
    function fill(prefix, fields, data) {
        fields.forEach(f => { const el = $(`${prefix}-${f[0]}`); if (el) el.value = data && data[f[0]] != null ? data[f[0]] : ''; });
    }
    function validate(prefix, fields) {
        for (const f of fields) {
            const el = $(`${prefix}-${f[0]}`);
            const v = el ? String(el.value || '').trim() : '';
            if (!v) continue;
            if (f[2] === 'cpf' && !isValidCPF(v)) return `${f[1]} inválido. Confira os 11 números.`;
            if (f[2] === 'email' && !validEmail(v)) return `${f[1]} inválido.`;
        }
        return '';
    }

    // ------------------------------------------------------------------ CSS
    function injectCss() {
        if ($('kl-clinica-css')) return;
        const st = document.createElement('style');
        st.id = 'kl-clinica-css';
        st.textContent = `
        #modal-contact .modal-card, #modal-event .modal-card { max-height: 92vh; overflow-y: auto; }
        .kl-details { margin: .6rem 0 .2rem; border: 1px solid rgba(127,127,127,.3); border-radius: 10px; padding: .1rem .8rem .6rem; }
        .kl-details > summary { cursor: pointer; font-weight: 600; padding: .6rem 0; list-style: none; }
        .kl-details > summary::-webkit-details-marker { display: none; }
        .kl-details > summary::after { content: '▾'; float: right; opacity: .6; }
        .kl-details[open] > summary::after { content: '▴'; }
        .kl-group-title { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; opacity: .65; margin: .9rem 0 .2rem; font-weight: 700; }
        .kl-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 .8rem; }
        .kl-grid .kl-full { grid-column: 1 / -1; }
        @media (max-width: 560px) { .kl-grid { grid-template-columns: 1fr; } }
        .kl-lgpd { font-size: .76rem; opacity: .75; margin: .4rem 0 0; }
        .kl-pill { display: inline-block; font-size: .7rem; padding: .08rem .5rem; border-radius: 99px; background: rgba(2,132,199,.14); color: var(--accent, #0284c7); margin: .15rem .25rem 0 0; white-space: nowrap; }
        .kl-pill.ok { background: rgba(34,197,94,.16); color: #15803d; } .kl-pill.warn { background: rgba(250,204,21,.22); color: #a16207; } .kl-pill.bad { background: rgba(239,68,68,.16); color: #b91c1c; }
        .kl-sub { font-size: .75rem; opacity: .75; margin-top: .15rem; }
        .kl-btn-icon { background: transparent; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; padding: .3rem .5rem; cursor: pointer; color: inherit; margin-left: .25rem; }
        .kl-btn-icon:hover { border-color: var(--accent, #0284c7); color: var(--accent, #0284c7); }

        /* ---- Agenda dos pacientes (lista abaixo do calendário) ---- */
        .kl-agenda { margin-top: 1.25rem; }
        .kl-agenda-head { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; justify-content: space-between; margin-bottom: .8rem; }
        .kl-agenda-head h3 { margin: 0; font-size: 1.05rem; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
        .kl-agenda-count { font-size: .75rem; font-weight: 500; padding: .1rem .6rem; border-radius: 99px; background: rgba(127,127,127,.18); }
        .kl-agenda-filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .9rem; align-items: center; }
        .kl-agenda-filters input, .kl-agenda-filters select { padding: .5rem .7rem; border-radius: 10px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; font-size: .85rem; }
        .kl-agenda-filters input { flex: 1 1 220px; }
        .kl-agenda-filters option { color: #111; background: #fff; }
        .kl-day-chip { display: none; align-items: center; gap: .35rem; font-size: .78rem; padding: .3rem .4rem .3rem .7rem; border-radius: 99px; background: rgba(2,132,199,.14); color: var(--accent, #0284c7); }
        .kl-day-chip button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: .9rem; line-height: 1; padding: 0 .25rem; }
        .kl-agenda-scroll { overflow-x: auto; }
        .kl-agenda-table { width: 100%; border-collapse: collapse; min-width: 780px; font-size: .85rem; }
        .kl-agenda-table th { text-align: left; font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; opacity: .65; padding: .4rem .6rem; border-bottom: 1px solid rgba(127,127,127,.3); white-space: nowrap; }
        .kl-agenda-table td { padding: .55rem .6rem; border-bottom: 1px solid rgba(127,127,127,.15); vertical-align: top; }
        .kl-agenda-table tr.kl-agenda-day td { background: rgba(127,127,127,.1); font-weight: 600; font-size: .8rem; padding: .4rem .6rem; }
        .kl-agenda-table tr.kl-agenda-day.hoje td { background: rgba(2,132,199,.16); color: var(--accent, #0284c7); }
        .kl-agenda-table tr.kl-off td:not(.kl-a-act) { opacity: .55; }
        .kl-agenda-table tr.kl-off .kl-a-name { text-decoration: line-through; }
        .kl-a-time { font-weight: 700; white-space: nowrap; color: var(--accent, #0284c7); }
        .kl-a-name { font-weight: 600; }
        .kl-a-sub { font-size: .75rem; opacity: .7; margin-top: .1rem; }
        .kl-a-act { white-space: nowrap; text-align: right; }
        .kl-sit { border-radius: 99px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; padding: .2rem .45rem; font-size: .78rem; cursor: pointer; }
        .kl-sit option { color: #111; background: #fff; }
        .kl-sit.ok { border-color: #22c55e; color: #15803d; } .kl-sit.warn { border-color: #eab308; color: #a16207; } .kl-sit.bad { border-color: #ef4444; color: #b91c1c; }
        /* ---- Anotações ---- */
        .kl-notes-bar { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; margin: 0 0 1rem; }
        .kl-notes-bar input { flex: 1 1 220px; padding: .6rem .8rem; border-radius: 10px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
        .kl-notes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1rem; }
        .kl-note { border: 1px solid rgba(127,127,127,.28); border-left: 5px solid rgba(127,127,127,.5); border-radius: 12px; padding: .8rem .9rem; background: rgba(127,127,127,.07); cursor: pointer; display: flex; flex-direction: column; gap: .35rem; min-height: 140px; }
        .kl-note:hover { box-shadow: 0 4px 14px rgba(0,0,0,.12); }
        .kl-note h4 { margin: 0; font-size: 1rem; word-break: break-word; }
        .kl-note .kl-body { white-space: pre-wrap; word-break: break-word; font-size: .87rem; opacity: .9; display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; flex: 1; }
        .kl-note .kl-foot { display: flex; justify-content: space-between; align-items: center; font-size: .72rem; opacity: .7; gap: .4rem; }
        .kl-note.c-yellow { background: rgba(250,204,21,.16); border-left-color: #eab308; } .kl-note.c-green { background: rgba(34,197,94,.14); border-left-color: #22c55e; }
        .kl-note.c-blue { background: rgba(59,130,246,.14); border-left-color: #3b82f6; } .kl-note.c-pink { background: rgba(236,72,153,.14); border-left-color: #ec4899; }
        .kl-note.c-purple { background: rgba(168,85,247,.14); border-left-color: #a855f7; }
        .kl-colors { display: flex; gap: .5rem; flex-wrap: wrap; }
        .kl-color { width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
        .kl-color.sel { border-color: var(--accent, #0284c7); box-shadow: 0 0 0 2px rgba(2,132,199,.25); }
        .kl-empty { text-align: center; opacity: .7; padding: 2.5rem 1rem; grid-column: 1 / -1; }
        /* ---- Status dos contatos ---- */
        .kl-stbar { display: flex; gap: .45rem; flex-wrap: wrap; margin: 0 0 1rem; }
        .kl-chip { border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; border-radius: 99px; padding: .3rem .8rem; font-size: .8rem; cursor: pointer; display: inline-flex; gap: .4rem; align-items: center; }
        .kl-chip:hover { border-color: var(--accent, #0284c7); }
        .kl-chip.on { border-color: var(--accent, #0284c7); background: rgba(2,132,199,.14); font-weight: 700; }
        .kl-dot { width: .55rem; height: .55rem; border-radius: 50%; display: inline-block; flex-shrink: 0; }
        .kl-stsel { border-radius: 99px; border: 1px solid; background: transparent; padding: .2rem .45rem; font-size: .78rem; cursor: pointer; font-weight: 600; max-width: 150px; }
        .kl-stsel option { color: #111; background: #fff; }
        .kl-stpanel { display: none; border: 1px dashed rgba(127,127,127,.45); border-radius: 12px; padding: .8rem; margin-top: .6rem; }
        .kl-stpanel.open { display: block; }
        .kl-stlist { display: flex; flex-direction: column; gap: .35rem; margin-top: .7rem; }
        .kl-stitem { display: flex; align-items: center; gap: .5rem; justify-content: space-between; font-size: .85rem; }
        .kl-stitem span { display: inline-flex; align-items: center; gap: .45rem; }
        .kl-swatches { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .5rem; }
        .kl-sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
        .kl-sw.sel { border-color: var(--accent, #0284c7); box-shadow: 0 0 0 2px rgba(2,132,199,.25); }
        `;
        document.head.appendChild(st);
    }

    // ------------------------------------------------------------------ cache local SEM dados de saúde
    function installSafeCache() {
        const strip = (list, key) => (Array.isArray(list) ? list.map(x => { if (x && x[key]) { const c = { ...x }; delete c[key]; return c; } return x; }) : list);
        window.saveContactsLocal = function () { try { localStorage.setItem('klweb_contacts', JSON.stringify(strip(state.contacts, 'clinic'))); } catch (e) { /* cheio */ } };
        window.saveEventsLocal = function () { try { localStorage.setItem('klweb_events', JSON.stringify(strip(state.events, 'patient'))); } catch (e) { /* cheio */ } };
        // remove o que versões anteriores possam ter deixado salvo
        try { saveContactsLocal(); saveEventsLocal(); } catch (e) { /* state ainda não pronto */ }
    }

    // ------------------------------------------------------------------ CONTATOS (ficha do paciente)
    let contactEditId = null;

    function injectContactFields() {
        const body = document.querySelector('#modal-contact .modal-body');
        if (!body || $('kl-contact-clinic')) return;
        const html = CLINIC_GROUPS.map(g => `<div class="kl-group-title">${esc(g[0])}</div><div class="kl-grid">${g[1].map(f => fieldHtml('cc', f)).join('')}</div>`).join('');
        const det = document.createElement('details');
        det.className = 'kl-details'; det.id = 'kl-contact-clinic';
        det.innerHTML = `<summary>🩺 Ficha do paciente (clínicas, consultórios, terapia…) — opcional</summary>${html}
            <p class="kl-lgpd">🔒 São dados pessoais sensíveis (LGPD). Ficam salvos criptografados e visíveis só para a sua empresa. Preencha apenas o necessário e com o consentimento do paciente.</p>`;
        body.appendChild(det);
        det.addEventListener('input', e => { if (e.target.dataset && e.target.dataset.klType === 'cpf') e.target.value = maskCPF(e.target.value); });
    }
    function setContactModalMode(editing) {
        const h = document.querySelector('#modal-contact .modal-header h3');
        const b = document.querySelector('#modal-contact .modal-footer .btn-primary');
        if (h) h.innerHTML = editing ? '<i class="fa-solid fa-user-pen"></i> Editar Contato / Ficha do Paciente' : '<i class="fa-solid fa-user-plus"></i> Novo Contato no CRM';
        if (b) b.innerHTML = editing ? '<i class="fa-solid fa-check"></i> Salvar alterações' : '<i class="fa-solid fa-check"></i> Salvar Contato';
    }
    function clearContactClinic() {
        fill('cc', CLINIC_FIELDS, {});
        const d = $('kl-contact-clinic'); if (d) d.open = false;
    }
    window.openEditContact = function (id) {
        const c = state.contacts.find(x => String(x.id) === String(id));
        if (!c) return;
        contactEditId = c.id;
        setContactModalMode(true);
        $('modal-contact').style.display = 'flex';
        $('contact-name').value = c.name || ''; $('contact-company').value = c.company_name || '';
        $('contact-role').value = c.role || ''; $('contact-phone').value = c.phone || '';
        $('contact-email').value = c.email || ''; $('contact-notes').value = c.notes || ''; setStatusSelect(c.status);
        fill('cc', CLINIC_FIELDS, c.clinic || {});
        const d = $('kl-contact-clinic'); if (d) d.open = Object.keys(c.clinic || {}).length > 0;
    };
    async function updateContact() {
        const name = $('contact-name').value.trim(), phone = $('contact-phone').value.trim(), email = $('contact-email').value.trim();
        if (!name || !phone) return toast('Nome e Telefone são campos obrigatórios.', 'error');
        if (email && !validEmail(email)) return toast('Digite um e-mail válido para o contato.', 'error');
        const bad = validate('cc', CLINIC_FIELDS); if (bad) return toast(bad, 'error');
        const body = {
            name, phone, email, company_name: $('contact-company').value.trim(), role: $('contact-role').value.trim(),
            notes: $('contact-notes').value.trim(), clinic: collect('cc', CLINIC_FIELDS, true), status: statusValue()
        };
        try {
            const r = await api(`/api/contacts/${contactEditId}`, { method: 'PUT', body: JSON.stringify(body) });
            if (!r.ok) return toast(r.data.message || 'Não foi possível salvar as alterações.', 'error');
            const i = state.contacts.findIndex(x => String(x.id) === String(contactEditId));
            if (i >= 0) state.contacts[i] = r.data; else state.contacts.push(r.data);
            saveContactsLocal(); closeNewContactModal(); renderContacts();
            toast('Contato atualizado!', 'success');
        } catch (e) { toast('Erro de conexão: as alterações não foram salvas.', 'error'); }
    }

    function renderContactsPlus() {
        const tb = $('crm-body');
        if (!tb) return;
        ensureStatusHeader(); renderStatusBar();
        const list = stFilter ? state.contacts.filter(ct => (ct.status || '') === stFilter) : state.contacts;
        if (!list.length) {
            tb.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:2rem;">${state.contacts.length ? 'Nenhum contato com esse status.' : 'Nenhum contato cadastrado no CRM ainda. Clique em "Novo Contato" acima.'}</td></tr>`;
            return;
        }
        tb.innerHTML = list.map(c => {
            const st = stOf(c.status), col = safeColor(st ? st.color : '#64748b');
            const stCell = `<select class="kl-stsel" style="border-color:${col};color:${col}" onchange="klSetContactStatus(${Number(c.id)}, this.value)" aria-label="Status de ${esc(c.name)}">${statusOptions(st ? c.status : '')}</select>`;
            const digits = (c.phone || '').replace(/\D/g, '');
            const wa = `https://api.whatsapp.com/send?phone=${digits.startsWith('55') ? digits : '55' + digits}&text=${encodeURIComponent(`Olá, ${c.name}! Tudo bem? Entramos em contato a respeito da ${state.user.companyName || 'nossa empresa'}.`)}`;
            const cl = c.clinic || {};
            const sub = [cl.cpf ? 'CPF ' + hiddenCPF(cl.cpf) : '', cl.nascimento ? 'Nasc. ' + fmtDate(cl.nascimento) : ''].filter(Boolean).join(' · ');
            const pills = [cl.convenio ? `<span class="kl-pill">${esc(cl.convenio)}</span>` : '', cl.alergias ? '<span class="kl-pill warn">⚠ alergias</span>' : '', cl.responsavel ? '<span class="kl-pill">menor / responsável</span>' : ''].join('');
            return `<tr>
                <td><strong>${esc(c.name)}</strong>${sub ? `<div class="kl-sub">${esc(sub)}</div>` : ''}${pills ? `<div>${pills}</div>` : ''}</td>
                <td>${stCell}</td>
                <td><span style="color:var(--accent);font-size:.82rem;"><i class="fa-solid fa-briefcase"></i> ${esc(c.company_name || 'Cliente')}</span></td>
                <td><i class="fa-solid fa-phone" style="color:var(--accent);margin-right:.3rem;"></i> ${esc(c.phone)}</td>
                <td>${c.email ? `<i class="fa-solid fa-envelope" style="color:var(--text-muted);margin-right:.3rem;"></i> ${esc(c.email)}` : '-'}</td>
                <td style="color:var(--text-secondary);">${esc(c.notes || '-')}</td>
                <td style="text-align:right;white-space:nowrap;">
                    <a href="${wa}" target="_blank" rel="noopener" class="btn-wa-direct" title="Abrir conversa no WhatsApp"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>
                    ${c.email ? `<button class="btn-email-direct" onclick="openContactEmailModal(${attrJson(c.email)}, ${attrJson(c.name)})" title="Enviar E-mail Direto"><i class="fa-solid fa-envelope"></i> E-mail</button>` : ''}
                    <button class="kl-btn-icon" onclick="openEditContact(${Number(c.id)})" title="Editar contato / ficha do paciente"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="btn-del-contact" onclick="deleteContact(${Number(c.id)})" title="Excluir Contato"><i class="fa-solid fa-trash-can"></i></button>
                </td></tr>`;
        }).join('');
    }

    // ------------------------------------------------------------------ STATUS DOS CONTATOS (Lead, Cliente ativo, personalizados...)
    // Os padrões espelham o servidor (DEFAULT_CONTACT_STATUSES); os personalizados vêm de /api/contact-statuses.
    const STATUS_DEFAULTS = [
        { key: 'LEAD', name: 'Lead', color: '#3b82f6' }, { key: 'NEGOCIACAO', name: 'Em negociação', color: '#f59e0b' },
        { key: 'ATIVO', name: 'Cliente ativo', color: '#10b981' }, { key: 'INATIVO', name: 'Cliente inativo', color: '#94a3b8' },
        { key: 'PACIENTE', name: 'Paciente', color: '#14b8a6' }, { key: 'PARCEIRO', name: 'Parceiro', color: '#8b5cf6' },
        { key: 'FORNECEDOR', name: 'Fornecedor', color: '#ec4899' }
    ];
    const SWATCHES = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
    let stCustom = [], stFilter = '', stNewColor = SWATCHES[0];
    const safeColor = v => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? v : '#64748b');
    const allStatuses = () => STATUS_DEFAULTS.concat(stCustom);
    const stOf = key => allStatuses().find(s => s.key === key) || null;
    const statusValue = () => (($('kl-contact-status') || {}).value || '');
    const statusOptions = sel => '<option value="">Sem status</option>' + allStatuses().map(s => `<option value="${esc(s.key)}"${s.key === sel ? ' selected' : ''}>${esc(s.name)}</option>`).join('');

    function setStatusSelect(key) {
        const el = $('kl-contact-status'); if (!el) return;
        el.innerHTML = statusOptions(stOf(key) ? key : '');
    }
    function resetStatusField() {
        setStatusSelect('');
        const p = $('kl-status-panel'); if (p) p.classList.remove('open');
        const n = $('kl-status-name'); if (n) n.value = '';
    }
    async function loadStatuses() {
        try {
            const r = await api('/api/contact-statuses');
            if (r.ok && r.data && Array.isArray(r.data.custom)) stCustom = r.data.custom;
        } catch (e) { /* segue só com os padrões */ }
        refreshStatusUi();
    }
    function refreshStatusUi() {
        setStatusSelect(statusValue());
        const list = $('kl-status-list');
        if (list) {
            list.innerHTML = stCustom.length
                ? '<div style="font-size:.78rem;opacity:.7">Seus status personalizados</div>' + stCustom.map(s => `<div class="kl-stitem"><span><i class="kl-dot" style="background:${safeColor(s.color)}"></i>${esc(s.name)}</span><button type="button" class="kl-btn-icon" data-del-status="${Number(s.id)}" title="Excluir este status"><i class="fa-solid fa-trash-can"></i></button></div>`).join('')
                : '<div style="font-size:.78rem;opacity:.7">Você ainda não criou status personalizados.</div>';
        }
        const sw = $('kl-status-swatches');
        if (sw) sw.innerHTML = SWATCHES.map(col => `<button type="button" class="kl-sw${col === stNewColor ? ' sel' : ''}" data-color="${col}" style="background:${col}" aria-label="Cor ${col}"></button>`).join('');
        if (typeof window.renderContacts === 'function') window.renderContacts();
    }
    function injectStatusField() {
        if ($('kl-status-group')) return;
        const notes = $('contact-notes'); if (!notes) return;
        const anchor = notes.closest('.form-group'); if (!anchor) return;
        const g = document.createElement('div');
        g.className = 'form-group'; g.id = 'kl-status-group';
        g.innerHTML = `<label for="kl-contact-status"><i class="fa-solid fa-tag"></i> Status do contato</label>
            <div style="display:flex;gap:.5rem;align-items:center">
                <select id="kl-contact-status" style="flex:1"></select>
                <button type="button" class="kl-btn-icon" id="kl-status-toggle" title="Criar ou gerenciar status" aria-expanded="false"><i class="fa-solid fa-plus"></i></button>
            </div>
            <div class="kl-stpanel" id="kl-status-panel">
                <div style="font-weight:700;font-size:.85rem;margin-bottom:.5rem">Criar novo status</div>
                <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
                    <input type="text" id="kl-status-name" maxlength="30" placeholder="Ex: Aguardando retorno" style="flex:1 1 180px">
                    <button type="button" class="btn-primary" id="kl-status-add" style="width:auto">Criar</button>
                </div>
                <div class="kl-swatches" id="kl-status-swatches"></div>
                <div class="kl-stlist" id="kl-status-list"></div>
            </div>`;
        anchor.parentNode.insertBefore(g, anchor);
        setStatusSelect('');
        g.addEventListener('click', async e => {
            const t = e.target.closest('button'); if (!t) return;
            if (t.id === 'kl-status-toggle') {
                const open = $('kl-status-panel').classList.toggle('open');
                t.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (open) { refreshStatusUi(); $('kl-status-name').focus(); }
            } else if (t.dataset.color) {
                stNewColor = t.dataset.color; refreshStatusUi();
            } else if (t.id === 'kl-status-add') {
                await createStatus();
            } else if (t.dataset.delStatus) {
                await deleteStatus(Number(t.dataset.delStatus));
            }
        });
        g.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'kl-status-name') { e.preventDefault(); createStatus(); } });
    }
    async function createStatus() {
        const name = ($('kl-status-name').value || '').trim();
        if (name.length < 2) return toast('Digite um nome com pelo menos 2 letras para o status.', 'error');
        try {
            const r = await api('/api/contact-statuses', { method: 'POST', body: JSON.stringify({ name, color: stNewColor }) });
            if (!r.ok) return toast(r.data.message || 'Não foi possível criar o status.', 'error');
            stCustom.push(r.data);
            $('kl-status-name').value = '';
            setStatusSelect(r.data.key); refreshStatusUi();
            $('kl-contact-status').value = r.data.key;
            toast(`Status "${r.data.name}" criado e selecionado.`, 'success');
        } catch (e) { toast('Erro de conexão: o status não foi criado.', 'error'); }
    }
    async function deleteStatus(id) {
        const s = stCustom.find(x => Number(x.id) === id); if (!s) return;
        if (!confirm(`Excluir o status "${s.name}"? Os contatos que usam esse status ficarão sem status.`)) return;
        try {
            const r = await api(`/api/contact-statuses/${id}`, { method: 'DELETE' });
            if (!r.ok) return toast(r.data.message || 'Não foi possível excluir o status.', 'error');
            const cur = statusValue();
            stCustom = stCustom.filter(x => Number(x.id) !== id);
            state.contacts.forEach(ct => { if (ct.status === s.key) ct.status = ''; });
            if (stFilter === s.key) stFilter = '';
            saveContactsLocal(); setStatusSelect(cur === s.key ? '' : cur); refreshStatusUi();
            toast('Status excluído.', 'info');
        } catch (e) { toast('Erro de conexão: o status não foi excluído.', 'error'); }
    }
    function ensureStatusHeader() {
        const tr = document.querySelector('.crm-table thead tr');
        if (!tr || tr.querySelector('[data-kl-status]')) return;
        const th = document.createElement('th'); th.textContent = 'Status'; th.setAttribute('data-kl-status', '1');
        tr.insertBefore(th, tr.children[1] || null);
    }
    function renderStatusBar() {
        const box = document.querySelector('#tab-crm .table-container'); if (!box) return;
        let bar = $('kl-stbar');
        if (!bar) {
            bar = document.createElement('div'); bar.id = 'kl-stbar'; bar.className = 'kl-stbar';
            box.parentNode.insertBefore(bar, box);
            bar.addEventListener('click', e => { const b = e.target.closest('[data-st]'); if (b) { stFilter = b.dataset.st === '*' ? '' : b.dataset.st; renderContactsPlus(); } });
        }
        const count = k => state.contacts.filter(ct => (ct.status || '') === k).length;
        const chip = (k, name, color, n) => `<button type="button" class="kl-chip${(stFilter || '*') === k ? ' on' : ''}" data-st="${esc(k)}">${color ? `<i class="kl-dot" style="background:${safeColor(color)}"></i>` : ''}${esc(name)} (${n})</button>`;
        const items = allStatuses().filter(s => count(s.key) > 0 || s.key === stFilter).map(s => chip(s.key, s.name, s.color, count(s.key)));
        const none = state.contacts.filter(ct => !stOf(ct.status)).length;
        bar.innerHTML = state.contacts.length ? chip('*', 'Todos', '', state.contacts.length) + items.join('') + (none ? chip('', 'Sem status', '', none) : '') : '';
    }
    window.klSetContactStatus = async function (id, val) {
        try {
            const r = await api(`/api/contacts/${Number(id)}`, { method: 'PUT', body: JSON.stringify({ status: val }) });
            if (!r.ok) { toast(r.data.message || 'Não foi possível alterar o status.', 'error'); return renderContactsPlus(); }
            const i = state.contacts.findIndex(x => String(x.id) === String(id));
            if (i >= 0) state.contacts[i] = r.data;
            saveContactsLocal(); renderContactsPlus();
            toast(val && stOf(val) ? `Status: ${stOf(val).name}.` : 'Status removido do contato.', 'success');
        } catch (e) { toast('Erro de conexão: o status não foi alterado.', 'error'); renderContactsPlus(); }
    };

    function installContacts() {
        injectContactFields();
        const origOpen = window.openNewContactModal, origClose = window.closeNewContactModal, origSubmit = window.submitNewContact;
        window.openNewContactModal = function () { contactEditId = null; setContactModalMode(false); clearContactClinic(); resetStatusField(); return origOpen.apply(this, arguments); };
        window.closeNewContactModal = function () { const r = origClose.apply(this, arguments); contactEditId = null; clearContactClinic(); resetStatusField(); setContactModalMode(false); return r; };
        window.submitNewContact = function () {
            if (contactEditId != null) return updateContact();
            const bad = validate('cc', CLINIC_FIELDS); if (bad) return toast(bad, 'error');
            return origSubmit.apply(this, arguments);
        };
        window.renderContacts = renderContactsPlus;
        injectStatusField(); ensureStatusHeader(); loadStatuses();
        renderContactsPlus();
    }

    // ------------------------------------------------------------------ EVENTOS (agendamento de pacientes)
    let eventEditId = null;

    function injectEventFields() {
        const grp = $('event-client-group');
        if (!grp || $('kl-event-patient')) return;
        const lbl = grp.querySelector('label[for="event-client"]');
        if (lbl) lbl.innerHTML = '<i class="fa-solid fa-user"></i> Nome do(a) paciente / cliente *';
        const lbl2 = grp.querySelector('label[for="event-client-phone"]');
        if (lbl2) lbl2.innerHTML = '<i class="fa-solid fa-phone"></i> Telefone/WhatsApp (opcional)';
        const opt = document.querySelector('#event-type option[value="HORARIO_MARCADO"]');
        if (opt) opt.textContent = '📆 Agendamento de paciente / cliente (consulta, exame, terapia…)';
        const box = document.createElement('div');
        box.id = 'kl-event-patient';
        box.innerHTML = `
            <div class="form-group" style="margin-top:.6rem;">
                <label for="ep-contact"><i class="fa-solid fa-address-book"></i> Paciente já cadastrado no CRM (preenche os dados sozinho)</label>
                <select id="ep-contact"><option value="">— Novo paciente / digitar manualmente —</option></select>
            </div>
            <div class="kl-group-title">Dados do atendimento</div>
            <div class="kl-grid">${PATIENT_FIELDS.map(f => fieldHtml('ep', f)).join('')}</div>
            <p class="kl-lgpd">🔒 Dados de saúde: salvos criptografados e visíveis só para a sua empresa.</p>`;
        grp.appendChild(box);
        box.addEventListener('input', e => { if (e.target.dataset && e.target.dataset.klType === 'cpf') e.target.value = maskCPF(e.target.value); });
        $('ep-contact').addEventListener('change', onPickContact);
    }
    function refreshContactSelect() {
        const sel = $('ep-contact'); if (!sel) return;
        const keep = sel.value;
        const list = (state.contacts || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        sel.innerHTML = '<option value="">— Novo paciente / digitar manualmente —</option>' + list.map(c => `<option value="${Number(c.id)}">${esc(c.name)}${c.phone ? ' — ' + esc(c.phone) : ''}</option>`).join('');
        sel.value = keep;
        if (!list.length && typeof loadContacts === 'function') loadContacts().then(() => { if ($('modal-event') && isShown('modal-event')) refreshContactSelect(); }).catch(() => { });
    }
    function onPickContact() {
        const c = (state.contacts || []).find(x => String(x.id) === String($('ep-contact').value));
        if (!c) return;
        const cl = c.clinic || {};
        $('event-client').value = c.name || '';
        $('event-client-phone').value = c.phone || '';
        const set = (k, v) => { const el = $(`ep-${k}`); if (el && v) el.value = v; };
        set('cpf', cl.cpf); set('nascimento', cl.nascimento); set('convenio', cl.convenio); set('carteirinha', cl.carteirinha); set('email', c.email);
        if (cl.convenio && $('ep-pagamento') && !$('ep-pagamento').value) $('ep-pagamento').value = 'CONVENIO';
        if (cl.profissional_preferido) set('profissional', cl.profissional_preferido);
    }
    function setEventModalMode(editing) {
        const h = document.querySelector('#modal-event .modal-header h3');
        const b = document.querySelector('#modal-event .modal-footer .btn-primary');
        if (h) h.innerHTML = editing ? '<i class="fa-solid fa-calendar-pen"></i> Editar / Remarcar Agendamento' : '<i class="fa-solid fa-calendar-plus"></i> Agendar Novo Evento';
        if (b) b.innerHTML = editing ? '<i class="fa-solid fa-check"></i> Salvar alterações' : '<i class="fa-solid fa-check"></i> Agendar Evento';
    }
    const TIPO_TITULO = { CONSULTA: 'Consulta', EXAME: 'Exame', TERAPIA: 'Sessão de terapia', RETORNO: 'Retorno', AVALIACAO: 'Avaliação', PROCEDIMENTO: 'Procedimento', OUTRO: 'Atendimento' };
    function autoTitle() {
        if ($('event-type').value !== 'HORARIO_MARCADO' || $('event-title').value.trim()) return;
        const nome = $('event-client').value.trim();
        if (!nome) return;
        $('event-title').value = `${TIPO_TITULO[$('ep-tipo_atendimento').value] || 'Atendimento'} - ${nome}`;
    }
    window.openEditEvent = function (id) {
        const ev = state.events.find(x => String(x.id) === String(id));
        if (!ev) return;
        eventEditId = ev.id;
        setEventModalMode(true);
        $('modal-event').style.display = 'flex';
        refreshContactSelect();
        $('event-title').value = ev.title || '';
        $('event-date').value = ev.event_date || ev.eventDate || '';
        $('event-time').value = String(ev.event_time || ev.eventTime || '09:00').slice(0, 5);
        $('event-type').value = ev.type || 'REUNIAO';
        $('event-desc').value = ev.description || '';
        $('event-client').value = ev.client_name || '';
        $('event-client-phone').value = ev.client_phone || '';
        const p = ev.patient || {};
        fill('ep', PATIENT_FIELDS, p);
        $('ep-contact').value = p.contact_id ? String(p.contact_id) : '';
        if (typeof toggleEventClientField === 'function') toggleEventClientField();
    };
    async function updateEvent() {
        const type = $('event-type').value;
        autoTitle();
        const title = $('event-title').value.trim(), date = $('event-date').value;
        const client = $('event-client').value.trim();
        if (!title || !date) return toast('Título e Data são obrigatórios para o evento.', 'error');
        if (type === 'HORARIO_MARCADO' && !client) return toast('Informe o nome do(a) paciente / cliente.', 'error');
        const bad = type === 'HORARIO_MARCADO' ? validate('ep', PATIENT_FIELDS) : ''; if (bad) return toast(bad, 'error');
        const body = {
            title, eventDate: date, event_date: date, eventTime: $('event-time').value, event_time: $('event-time').value, type,
            description: $('event-desc').value.trim()
        };
        if (type === 'HORARIO_MARCADO') {
            body.clientName = client; body.clientPhone = $('event-client-phone').value.trim();
            body.patient = collect('ep', PATIENT_FIELDS, true);
            const cid = $('ep-contact').value; if (cid) body.patient.contact_id = Number(cid);
        }
        try {
            const r = await api(`/api/events/${eventEditId}`, { method: 'PUT', body: JSON.stringify(body) });
            if (!r.ok) return toast(r.data.message || 'Não foi possível salvar as alterações.', 'error');
            const ev = typeof normalizeEvent === 'function' ? normalizeEvent(r.data) : r.data;
            const i = state.events.findIndex(x => String(x.id) === String(eventEditId));
            if (i >= 0) state.events[i] = ev; else state.events.push(ev);
            saveEventsLocal(); closeNewEventModal(); renderCalendar(); renderEventsList();
            toast('Agendamento atualizado!', 'success');
        } catch (e) { toast('Erro de conexão: as alterações não foram salvas.', 'error'); }
    }
    const SIT_CLASS = { CONFIRMADO: 'ok', COMPARECEU: 'ok', FALTOU: 'bad', CANCELADO: 'bad', REMARCADO: 'warn', AGENDADO: '' };


    // ------------------------------------------------------------------ AGENDA DOS PACIENTES (lista abaixo do calendário)
    const agenda = { q: '', periodo: 'proximos', situacao: '', tipo: 'pacientes', day: null };
    const PERIODOS = [['proximos', 'A partir de hoje'], ['hoje', 'Hoje'], ['semana', 'Próximos 7 dias'], ['mes', 'Este mês'], ['passados', 'Já passaram'], ['todos', 'Todos']];
    const pad2 = n => String(n).padStart(2, '0');
    const isoLocal = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const evDate = e => String(e.event_date || e.eventDate || '').slice(0, 10);
    const evTime = e => String(e.event_time || e.eventTime || '09:00').slice(0, 5);
    const evSit = e => (e.patient && e.patient.situacao) || 'AGENDADO';

    function dayLabel(iso, today) {
        const d = new Date(`${iso}T00:00:00`);
        if (isNaN(d)) return iso;
        const raw = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
        const txt = raw.charAt(0).toUpperCase() + raw.slice(1);
        const diff = Math.round((d - new Date(`${today}T00:00:00`)) / 864e5);
        const rel = diff === 0 ? 'Hoje · ' : diff === 1 ? 'Amanhã · ' : diff === -1 ? 'Ontem · ' : '';
        return rel + txt;
    }

    function ensureAgendaBox() {
        let box = $('kl-agenda');
        if (box) return box;
        const layout = document.querySelector('#tab-calendar .calendar-layout');
        if (!layout) return null;
        box = document.createElement('div');
        box.id = 'kl-agenda';
        box.className = 'calendar-main-card kl-agenda';
        box.innerHTML = `
            <div class="kl-agenda-head">
                <h3><i class="fa-solid fa-user-clock"></i> Agenda dos pacientes <span class="kl-agenda-count" id="kl-agenda-count"></span></h3>
                <span class="kl-day-chip" id="kl-agenda-day"><span id="kl-agenda-day-txt"></span><button type="button" id="kl-agenda-day-x" title="Limpar o dia selecionado">&times;</button></span>
            </div>
            <div class="kl-agenda-filters">
                <input type="search" id="kl-agenda-q" placeholder="Buscar paciente, procedimento ou profissional..." aria-label="Buscar na agenda">
                <select id="kl-agenda-periodo" aria-label="Período">${PERIODOS.map(p => `<option value="${p[0]}">${p[1]}</option>`).join('')}</select>
                <select id="kl-agenda-sit" aria-label="Situação"><option value="">Todas as situações</option>${SITUACAO.filter(s => s[0]).map(s => `<option value="${s[0]}">${s[1]}</option>`).join('')}</select>
                <select id="kl-agenda-tipo" aria-label="O que mostrar"><option value="pacientes">Só pacientes</option><option value="todos">Todos os compromissos</option></select>
            </div>
            <div id="kl-agenda-body"></div>`;
        layout.insertAdjacentElement('afterend', box);
        $('kl-agenda-q').addEventListener('input', e => { agenda.q = e.target.value; renderPatientAgenda(); });
        $('kl-agenda-periodo').addEventListener('change', e => { agenda.periodo = e.target.value; agenda.day = null; renderPatientAgenda(); });
        $('kl-agenda-sit').addEventListener('change', e => { agenda.situacao = e.target.value; renderPatientAgenda(); });
        $('kl-agenda-tipo').addEventListener('change', e => { agenda.tipo = e.target.value; renderPatientAgenda(); });
        $('kl-agenda-day-x').addEventListener('click', () => renderEventsListPlus());
        return box;
    }

    function agendaList() {
        const now = new Date();
        const today = isoLocal(now);
        const in7 = isoLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6));
        const q = norm(agenda.q);
        let list = (state.events || []).filter(e => evDate(e));
        if (agenda.tipo === 'pacientes') list = list.filter(e => e.type === 'HORARIO_MARCADO');
        if (agenda.day) list = list.filter(e => evDate(e) === agenda.day);
        else if (agenda.periodo === 'hoje') list = list.filter(e => evDate(e) === today);
        else if (agenda.periodo === 'proximos') list = list.filter(e => evDate(e) >= today);
        else if (agenda.periodo === 'semana') list = list.filter(e => evDate(e) >= today && evDate(e) <= in7);
        else if (agenda.periodo === 'mes') list = list.filter(e => evDate(e).slice(0, 7) === today.slice(0, 7));
        else if (agenda.periodo === 'passados') list = list.filter(e => evDate(e) < today);
        if (agenda.situacao) list = list.filter(e => e.type === 'HORARIO_MARCADO' && evSit(e) === agenda.situacao);
        if (q) {
            list = list.filter(e => {
                const p = e.patient || {};
                return [e.client_name, e.client_phone, e.title, p.procedimento, p.profissional, p.especialidade, p.local, p.convenio].some(v => norm(v).includes(q));
            });
        }
        const key = e => evDate(e) + ' ' + evTime(e);
        list.sort((a, b) => (agenda.periodo === 'passados' && !agenda.day ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b))));
        return { list, today };
    }

    function renderPatientAgenda() {
        const box = ensureAgendaBox(); if (!box) return;
        const { list, today } = agendaList();
        $('kl-agenda-count').textContent = `${list.length} ${list.length === 1 ? 'atendimento' : 'atendimentos'}`;
        const chip = $('kl-agenda-day');
        chip.style.display = agenda.day ? 'inline-flex' : 'none';
        if (agenda.day) $('kl-agenda-day-txt').textContent = `Dia ${fmtDate(agenda.day)}`;
        $('kl-agenda-periodo').disabled = !!agenda.day;
        const body = $('kl-agenda-body');
        if (!list.length) {
            body.innerHTML = `<div class="kl-empty">${agenda.tipo === 'pacientes' ? 'Nenhum atendimento de paciente' : 'Nenhum compromisso'} para esse filtro. Use <b>Novo Evento</b> &rarr; <i>Horário Marcado</i> para agendar.</div>`;
            return;
        }
        let html = '<div class="kl-agenda-scroll"><table class="kl-agenda-table"><thead><tr><th>Hora</th><th>Paciente</th><th>Atendimento</th><th>Profissional / local</th><th>Situação</th><th>Pagamento</th><th></th></tr></thead><tbody>';
        let last = null;
        for (const e of list) {
            const d = evDate(e);
            if (d !== last) { html += `<tr class="kl-agenda-day${d === today ? ' hoje' : ''}"><td colspan="7">${esc(dayLabel(d, today))}</td></tr>`; last = d; }
            const appt = e.type === 'HORARIO_MARCADO';
            const p = e.patient || {};
            const sit = evSit(e);
            const off = appt && (sit === 'CANCELADO' || sit === 'FALTOU');
            const nome = appt ? (e.client_name || e.title) : e.title;
            const sub = appt ? (e.client_phone || '') : 'Compromisso';
            const atend = appt ? [
                p.tipo_atendimento ? `<span class="kl-pill">${esc(label(TIPO, p.tipo_atendimento))}</span>` : '',
                p.modalidade === 'ONLINE' ? '<span class="kl-pill">Online</span>' : '',
                p.procedimento ? `<div class="kl-a-sub">${esc(p.procedimento)}</div>` : ''
            ].join('') : '—';
            const prof = [p.profissional, p.especialidade].filter(Boolean).join(' · ');
            const loc = [p.local, p.duracao ? p.duracao + ' min' : ''].filter(Boolean).join(' · ');
            const pag = appt && p.pagamento ? `<span class="kl-pill">${esc(p.pagamento === 'CONVENIO' && p.convenio ? p.convenio : label(PAGTO, p.pagamento))}</span>${p.valor ? `<div class="kl-a-sub">${esc(p.valor)}</div>` : ''}` : '—';
            const sitCell = appt
                ? `<select class="kl-sit ${SIT_CLASS[sit] || ''}" onchange="klSetSituacao(${Number(e.id)}, this.value)" aria-label="Situação do atendimento">${SITUACAO.filter(s => s[0]).map(s => `<option value="${s[0]}"${s[0] === sit ? ' selected' : ''}>${s[1]}</option>`).join('')}</select>`
                : '—';
            html += `<tr class="${off ? 'kl-off' : ''}">
                <td class="kl-a-time">${esc(evTime(e))}</td>
                <td><div class="kl-a-name">${esc(nome)}</div>${sub ? `<div class="kl-a-sub">${esc(sub)}</div>` : ''}</td>
                <td>${atend}</td>
                <td>${prof ? esc(prof) : ''}${loc ? `<div class="kl-a-sub">${esc(loc)}</div>` : (prof ? '' : '—')}</td>
                <td>${sitCell}</td>
                <td>${pag}</td>
                <td class="kl-a-act"><button class="kl-btn-icon" onclick="openEditEvent(${Number(e.id)})" title="Editar / remarcar"><i class="fa-solid fa-pen-to-square"></i></button><button class="btn-del-event" onclick="deleteEvent(${Number(e.id)})" title="Excluir"><i class="fa-solid fa-trash-can"></i></button></td>
            </tr>`;
        }
        body.innerHTML = html + '</tbody></table></div>';
    }

    // Troca rápida da situação (Confirmado, Compareceu, Faltou...) direto na lista, sem abrir o formulário.
    window.klSetSituacao = async function (id, sit) {
        try {
            const r = await api(`/api/events/${id}`, { method: 'PUT', body: JSON.stringify({ type: 'HORARIO_MARCADO', patient: { situacao: sit } }) });
            if (!r.ok) { toast(r.data.message || 'Não foi possível alterar a situação.', 'error'); return renderPatientAgenda(); }
            const ev = typeof normalizeEvent === 'function' ? normalizeEvent(r.data) : r.data;
            const i = state.events.findIndex(x => String(x.id) === String(id));
            if (i >= 0) state.events[i] = ev;
            saveEventsLocal(); renderEventsListPlus(agenda.day || undefined);
            toast(`Situação: ${label(SITUACAO, sit)}.`, 'success');
        } catch (e) { toast('Erro de conexão: a situação não foi alterada.', 'error'); renderPatientAgenda(); }
    };

    function renderEventsListPlus(day) {
        const box = $('calendar-events-list'), tag = $('cal-selected-day-label');
        if (!box) return;
        agenda.day = (day && typeof day === 'string') ? day : null;
        renderPatientAgenda();
        let list = state.events;
        if (day && typeof day === 'string') {
            list = state.events.filter(e => (e.event_date || e.eventDate) === day);
            if (tag) tag.innerText = `Dia ${new Date(`${day}T00:00:00`).toLocaleDateString('pt-BR')}`;
        } else if (tag) tag.innerText = 'Todos os Compromissos';
        if (!list.length) { box.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:2rem 0;">Nenhum evento agendado para esta data.</p>'; return; }
        box.innerHTML = list.map(n => {
            const p = n.patient || {};
            const pills = n.type === 'HORARIO_MARCADO' ? [
                p.tipo_atendimento ? `<span class="kl-pill">${esc(label(TIPO, p.tipo_atendimento))}</span>` : '',
                p.situacao ? `<span class="kl-pill ${SIT_CLASS[p.situacao] || ''}">${esc(label(SITUACAO, p.situacao))}</span>` : '',
                p.pagamento ? `<span class="kl-pill">${esc(p.pagamento === 'CONVENIO' && p.convenio ? p.convenio : label(PAGTO, p.pagamento))}</span>` : '',
                p.modalidade === 'ONLINE' ? '<span class="kl-pill">Online</span>' : ''
            ].join('') : '';
            const det = [p.procedimento, p.profissional ? 'Prof.: ' + p.profissional : '', p.local, p.duracao ? p.duracao + ' min' : ''].filter(Boolean).join(' · ');
            return `<div class="event-item-card event-${esc(n.type || 'REUNIAO')}">
                <div class="event-top-row">
                    <span class="event-time-badge"><i class="fa-regular fa-clock"></i> ${esc(n.event_time || n.eventTime || '09:00')}</span>
                    <span><button class="kl-btn-icon" onclick="openEditEvent(${Number(n.id)})" title="Editar / remarcar"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="btn-del-event" onclick="deleteEvent(${Number(n.id)})" title="Excluir Evento"><i class="fa-solid fa-trash-can"></i></button></span>
                </div>
                <h4>${esc(n.title)}</h4>
                ${n.client_name ? `<p><i class="fa-solid fa-user"></i> ${esc(n.client_name)}${n.client_phone ? ' · ' + esc(n.client_phone) : ''}</p>` : ''}
                ${pills ? `<div>${pills}</div>` : ''}
                ${det ? `<p class="kl-sub">${esc(det)}</p>` : ''}
                ${n.description ? `<p>${esc(n.description)}</p>` : ''}
                <div style="font-size:.72rem;color:var(--text-muted);margin-top:.35rem;"><i class="fa-regular fa-calendar"></i> ${esc(n.event_date || n.eventDate)}</div>
            </div>`;
        }).join('');
    }

    function installEvents() {
        injectEventFields();
        const origOpen = window.openNewEventModal, origClose = window.closeNewEventModal, origSubmit = window.submitNewEvent;
        window.openNewEventModal = function () {
            eventEditId = null; setEventModalMode(false); fill('ep', PATIENT_FIELDS, {});
            const r = origOpen.apply(this, arguments); refreshContactSelect(); return r;
        };
        window.closeNewEventModal = function () {
            const r = origClose.apply(this, arguments);
            eventEditId = null; fill('ep', PATIENT_FIELDS, {}); const s = $('ep-contact'); if (s) s.value = ''; setEventModalMode(false);
            return r;
        };
        window.submitNewEvent = function () {
            if (eventEditId != null) return updateEvent();
            if ($('event-type').value === 'HORARIO_MARCADO') {
                autoTitle();
                const bad = validate('ep', PATIENT_FIELDS); if (bad) return toast(bad, 'error');
            }
            return origSubmit.apply(this, arguments);
        };
        window.renderEventsList = renderEventsListPlus;
        renderEventsListPlus();
    }

    // Acrescenta a ficha (clinic / patient) nos POSTs que o código original já faz, sem reescrevê-lo.
    function installFetchHook() {
        const orig = window.fetchWithAuth;
        window.fetchWithAuth = function (url, opts) {
            try {
                if (opts && String(opts.method || 'GET').toUpperCase() === 'POST' && typeof opts.body === 'string') {
                    const u = String(url).split('?')[0];
                    if (/\/api\/contacts$/.test(u) && isShown('modal-contact') && contactEditId == null) {
                        const clinic = collect('cc', CLINIC_FIELDS, false), st = statusValue(), extra = {};
                        if (Object.keys(clinic).length) extra.clinic = clinic;
                        if (st) extra.status = st;
                        if (Object.keys(extra).length) opts = { ...opts, body: JSON.stringify({ ...JSON.parse(opts.body), ...extra }) };
                    } else if (/\/api\/events$/.test(u) && isShown('modal-event') && eventEditId == null) {
                        const b = JSON.parse(opts.body);
                        if (b.type === 'HORARIO_MARCADO') {
                            const patient = collect('ep', PATIENT_FIELDS, false);
                            const cid = $('ep-contact') && $('ep-contact').value; if (cid) patient.contact_id = Number(cid);
                            opts = { ...opts, body: JSON.stringify({ ...b, patient }) };
                        }
                    }
                }
            } catch (e) { /* segue sem a ficha */ }
            return orig.call(this, url, opts);
        };
    }

    // ------------------------------------------------------------------ ANOTAÇÕES
    let notes = [], notesLoaded = false, notesBlocked = false, noteEditId = null, noteColor = 'default', noteReadOnly = false, notesTimer = null;
    const COLORS = [['default', 'rgba(127,127,127,.45)'], ['yellow', '#eab308'], ['green', '#22c55e'], ['blue', '#3b82f6'], ['pink', '#ec4899'], ['purple', '#a855f7']];

    function renderColorPicker() {
        const box = $('note-colors'); if (!box) return;
        box.innerHTML = COLORS.map(c => `<button type="button" class="kl-color ${c[0] === noteColor ? 'sel' : ''}" data-color="${c[0]}" style="background:${c[1]}" title="Cor"></button>`).join('');
        box.querySelectorAll('.kl-color').forEach(b => b.addEventListener('click', () => { if (noteReadOnly) return; noteColor = b.dataset.color; renderColorPicker(); }));
    }
    window.loadNotes = async function (silent) {
        try {
            const r = await api('/api/notes');
            if (r.status === 403 && r.data && r.data.code === 'PLAN_NOTES_REQUIRED') { notes = []; notesLoaded = true; setNotesBlocked(true); }
            else if (r.ok && Array.isArray(r.data)) { notes = r.data; notesLoaded = true; setNotesBlocked(false); }
            else if (!silent) toast(r.data.message || 'Não foi possível carregar as anotações.', 'error');
        } catch (e) { if (!silent) toast('Erro de conexão ao carregar as anotações.', 'error'); }
        renderNotes();
    };
    // Plano sem Anotações (Gratuito/inativo): mostra o aviso de upgrade e esconde os controles.
    function setNotesBlocked(v) {
        notesBlocked = !!v;
        const pane = $('tab-notes'); if (!pane) return;
        const hide = notesBlocked ? 'none' : '';
        pane.querySelectorAll('.pane-controls, .kl-notes-bar').forEach(el => { el.style.display = hide; });
    }
    window.filterNotes = function () { renderNotes(); };
    function renderNotes() {
        const grid = $('notes-grid'); if (!grid) return;
        if (notesBlocked) {
            const cnt0 = $('notes-count'); if (cnt0) cnt0.textContent = '';
            grid.innerHTML = `<div class="kl-empty"><b>As Anotações são exclusivas dos planos Starter e Pro AI.</b><br>Faça upgrade para guardar lembretes, ideias e rascunhos com toda a equipe.<br><br><button type="button" class="btn-primary" onclick="switchTab('plans')"><i class="fa-solid fa-crown"></i> Ver planos</button></div>`;
            return;
        }
        const q = norm(($('notes-search') || {}).value || '');
        const list = notes.filter(n => !q || norm(n.title).includes(q) || norm(n.content).includes(q));
        const cnt = $('notes-count'); if (cnt) cnt.textContent = `${notes.length} anotaç${notes.length === 1 ? 'ão' : 'ões'}`;
        if (!list.length) {
            grid.innerHTML = `<div class="kl-empty">${notesLoaded ? (q ? 'Nenhuma anotação encontrada para essa busca.' : 'Nenhuma anotação ainda. Clique em <b>Nova Anotação</b> ou peça à Cláudia: <i>Anote: …</i>') : 'Carregando…'}</div>`;
            return;
        }
        grid.innerHTML = list.map(n => `
            <div class="kl-note c-${esc(n.color || 'default')}" onclick="openNoteModal(${Number(n.id)})">
                <h4>${n.pinned ? '📌 ' : ''}${esc(n.title)}</h4>
                <div class="kl-body">${esc(n.content)}</div>
                <div class="kl-foot"><span>${esc(n.author_name || '')} · ${esc(fmtDateTime(n.updated_at))}</span>
                    <span>${n.can_edit ? `<button class="kl-btn-icon" title="${n.pinned ? 'Desafixar' : 'Fixar no topo'}" onclick="event.stopPropagation();togglePinNote(${Number(n.id)})"><i class="fa-solid fa-thumbtack"></i></button>
                    <button class="kl-btn-icon" title="Apagar" onclick="event.stopPropagation();deleteNote(${Number(n.id)})"><i class="fa-solid fa-trash-can"></i></button>` : ''}</span></div>
            </div>`).join('');
    }
    window.openNoteModal = function (id) {
        const n = id != null ? notes.find(x => String(x.id) === String(id)) : null;
        noteEditId = n ? n.id : null;
        noteReadOnly = !!n && !n.can_edit;
        noteColor = n ? (n.color || 'default') : 'default';
        $('note-title').value = n ? n.title : '';
        $('note-content').value = n ? n.content : '';
        $('note-pinned').checked = !!(n && n.pinned);
        ['note-title', 'note-content', 'note-pinned'].forEach(i => { $(i).disabled = noteReadOnly; });
        $('note-modal-title').innerHTML = n ? (noteReadOnly ? `<i class="fa-solid fa-note-sticky"></i> Anotação de ${esc(n.author_name || 'colega')} (somente leitura)` : '<i class="fa-solid fa-pen"></i> Editar Anotação') : '<i class="fa-solid fa-note-sticky"></i> Nova Anotação';
        $('note-save-btn').style.display = noteReadOnly ? 'none' : '';
        $('note-delete-btn').style.display = n && !noteReadOnly ? '' : 'none';
        renderColorPicker();
        $('modal-note').style.display = 'flex';
        if (!noteReadOnly) $('note-title').focus();
    };
    window.closeNoteModal = function () { $('modal-note').style.display = 'none'; noteEditId = null; };
    window.saveNote = async function () {
        const title = $('note-title').value.trim(), content = $('note-content').value;
        if (!title) return toast('Dê um título para a anotação.', 'error');
        const body = JSON.stringify({ title, content, color: noteColor, pinned: $('note-pinned').checked });
        try {
            const r = noteEditId == null ? await api('/api/notes', { method: 'POST', body }) : await api(`/api/notes/${noteEditId}`, { method: 'PUT', body });
            if (r.status === 403 && r.data && r.data.code === 'PLAN_NOTES_REQUIRED') { closeNoteModal(); loadNotes(true); return toast(r.data.message, 'error'); }
            if (!r.ok) return toast(r.data.message || 'Não foi possível salvar a anotação.', 'error');
            closeNoteModal(); toast('Anotação salva no Workspace!', 'success'); loadNotes(true);
        } catch (e) { toast('Erro de conexão: a anotação não foi salva.', 'error'); }
    };
    async function removeNote(id) {
        try {
            const r = await api(`/api/notes/${id}`, { method: 'DELETE' });
            if (!r.ok) return toast(r.data.message || 'Não foi possível apagar a anotação.', 'error');
            toast('Anotação apagada.', 'info'); loadNotes(true);
        } catch (e) { toast('Erro de conexão ao apagar a anotação.', 'error'); }
    }
    window.deleteNote = function (id) {
        const n = notes.find(x => String(x.id) === String(id));
        if (!confirm(`Deseja realmente apagar a anotação "${n ? n.title : ''}"? Isso vale para toda a empresa e não dá para desfazer.`)) return;
        removeNote(id);
    };
    window.deleteNoteFromModal = function () { const id = noteEditId; closeNoteModal(); if (id != null) window.deleteNote(id); };
    window.togglePinNote = async function (id) {
        const n = notes.find(x => String(x.id) === String(id)); if (!n) return;
        const r = await api(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify({ pinned: !n.pinned }) });
        if (!r.ok) return toast(r.data.message || 'Não foi possível fixar.', 'error');
        loadNotes(true);
    };
    function notesTabActive() { const p = $('tab-notes'); return !!p && p.classList.contains('active'); }
    function startNotesAutoRefresh() {
        if (notesTimer) return;
        notesTimer = setInterval(() => { if (notesTabActive() && !document.hidden && !isShown('modal-note')) loadNotes(true); }, 30000);
    }

    // ------------------------------------------------------------------ CLÁUDIA (chat)
    const RX_NOTA = /\banota(?:r|cao|coes)?\b|\banote\b|\bbloco de notas\b|\b(?:nova|criar|crie|salve|salvar|apague|apagar|exclua|excluir|delete|deletar|edite|editar|altere|mude|liste|listar|mostre)\s+(?:a\s+|as\s+|uma\s+|minha\s+|minhas\s+|essa\s+|esta\s+)?(?:nota|notas)\b/;
    const RX_NAO_NOTA = /nota fiscal|notas fiscais|nota de|nota do|nota da|nota final|notas do|notas da/;
    const RX_CLINICA = /\b(paciente|pacientes|consulta|consultas|exame|exames|terapia|psicolog\w*|clinica|prontuario|cpf|convenio|carteirinha|sessao|retorno|horario marcado|fisioterapia|dentista|agendamento|agendamentos)\b/;
    const RX_GERENCIAR = /\b(edit\w*|alter\w*|mude|mudar|atualiz\w*|exclu\w*|apag\w*|remov\w*|delet\w*|cancel\w*|remarc\w*|remarqu\w*|desmarc\w*|desmarqu\w*)\b.*\b(contato|cliente|evento|agendamento|compromisso|reuniao|horario)\b/;
    const RX_DEMANDA = /\b(demanda|demandas|tarefa|tarefas)\b/;
    function isClinicRequest(text) {
        const t = norm(text);
        if (RX_NOTA.test(t) && !RX_NAO_NOTA.test(t)) return true;
        if (RX_DEMANDA.test(t)) return false;
        return RX_CLINICA.test(t) || RX_GERENCIAR.test(t);
    }
    let refreshTimer = null;
    function refreshAfterAi() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            try { if (typeof loadContacts === 'function') loadContacts(); } catch (e) { }
            try { if (typeof loadEvents === 'function') loadEvents(); } catch (e) { }
            loadNotes(true);
        }, 400);
    }
    async function handleChatSend(e) {
        const input = $('ai-input'); if (!input) return;
        const text = (input.value || '').trim();
        if (!text || (state && state.aiCredentialFlow)) return;           // fluxo de senha/e-mail em andamento
        if (!isClinicRequest(text)) return;                                // segue o fluxo normal da Cláudia
        if (typeof hasPlanAccessToAI === 'function' && !hasPlanAccessToAI()) return; // o fluxo original mostra o aviso de plano
        e.stopImmediatePropagation(); e.preventDefault();
        input.value = '';
        appendChatMessage('Você', text, false);
        const typing = typeof appendTypingIndicator === 'function' ? appendTypingIndicator() : null;
        try {
            const r = await api('/api/ai/process', { method: 'POST', body: JSON.stringify({ message: text, mensagem: text, contexto: { company: state.user && state.user.companyName } }) });
            if (typing) typing.remove();
            appendChatMessage('Cláudia', r.data.texto || r.data.response || (r.ok ? 'Pronto!' : 'Não consegui processar agora. Tente de novo.'), true);
            refreshAfterAi();
        } catch (err) {
            if (typing) typing.remove();
            appendChatMessage('Cláudia', 'Não consegui falar com o servidor agora. Tente de novo em instantes.', true);
        }
    }
    function installChatHook() {
        document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#ai-send-btn')) handleChatSend(e); }, true);
        document.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.id === 'ai-input') handleChatSend(e); }, true);
    }

    // ------------------------------------------------------------------ tempo real (socket já criado pelo app)
    function bindSocket() {
        setInterval(() => {
            try {
                if (typeof socket === 'undefined' || !socket || socket.__klClinica) return;
                socket.__klClinica = true;
                socket.on('note_changed', () => { if (notesTabActive()) loadNotes(true); else notesLoaded = false; });
                socket.on('crm_contact_updated', ev => {
                    const c = ev && ev.contact; if (!c) return;
                    const i = state.contacts.findIndex(x => String(x.id) === String(c.id));
                    if (i >= 0) state.contacts[i] = c; else state.contacts.push(c);
                    saveContactsLocal(); renderContacts();
                });
            } catch (e) { /* socket ainda não existe */ }
        }, 3000);
    }

    // ------------------------------------------------------------------ inicialização
    function installWorkspaceHooks() {
        injectCss();
        installContacts();
        installEvents();
        const origSwitch = window.switchTab;
        window.switchTab = function (t) {
            const r = origSwitch.apply(this, arguments);
            if (String(t || '').replace(/^tab-/, '') === 'notes') { renderNotes(); loadNotes(); }
            return r;
        };
        installChatHook(); startNotesAutoRefresh(); bindSocket();
    }
    function whenReady(cond, fn) {
        if (cond()) return fn();
        const t = setInterval(() => { if (cond()) { clearInterval(t); fn(); } }, 500);
    }
    injectCss();
    // 1) assim que o núcleo existe: cache local sem dados de saúde + gancho que anexa a ficha nos envios
    whenReady(() => typeof window.fetchWithAuth === 'function' && typeof window.saveContactsLocal === 'function' && typeof state !== 'undefined', () => { installSafeCache(); installFetchHook(); });
    // 2) quando o pacote do workspace carrega (após o login): encaixa contatos, calendário, anotações e chat
    whenReady(() => ['switchTab', 'submitNewContact', 'openNewContactModal', 'closeNewContactModal', 'renderContacts', 'submitNewEvent', 'openNewEventModal', 'closeNewEventModal', 'renderEventsList', 'appendChatMessage'].every(n => typeof window[n] === 'function'), installWorkspaceHooks);
})();