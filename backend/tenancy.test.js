const test = require('node:test');
const assert = require('node:assert/strict');

// Testes unitários do isolamento de multi-tenancy e middleware requireCompany
test('Isolamento Multi-Tenant - requireCompany Middleware', async (t) => {
    // Simula a lógica da função requireCompany
    function requireCompany(req, res, next) {
        const companyId = req.user?.companyId || req.user?.company_id;
        if (!companyId) {
            return res.status(403).json({
                success: false,
                message: 'Acesso negado: você precisa estar vinculado a uma organização ativa.',
                code: 'COMPANY_REQUIRED'
            });
        }
        req.user.companyId = Number(companyId);
        req.user.company_id = Number(companyId);
        next();
    }

    await t.test('bloqueia requisição se o usuário não tiver companyId', () => {
        let statusCalled = null;
        let jsonPayload = null;
        let nextCalled = false;

        const req = { user: { id: 10, email: 'user@semempresa.com', companyId: null } };
        const res = {
            status: (code) => {
                statusCalled = code;
                return {
                    json: (data) => {
                        jsonPayload = data;
                    }
                };
            }
        };

        requireCompany(req, res, () => { nextCalled = true; });

        assert.equal(statusCalled, 403);
        assert.equal(jsonPayload.code, 'COMPANY_REQUIRED');
        assert.equal(nextCalled, false);
    });

    await t.test('permite requisição quando companyId está presente e normaliza para Number', () => {
        let nextCalled = false;
        const req = { user: { id: 10, email: 'user@empresa.com', companyId: '42' } };
        const res = {};

        requireCompany(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, true);
        assert.equal(req.user.companyId, 42);
        assert.equal(req.user.company_id, 42);
    });
});

test('Isolamento de Arquivos e Playbooks', async (t) => {
    await t.test('acesso a arquivos corporativos exige mesma empresa', () => {
        const file = { id: 1, company_id: 100, user_id: 5 };
        const requestingUserSameCompany = { id: 8, companyId: 100, isSiteOwner: false };
        const requestingUserDifferentCompany = { id: 5, companyId: 200, isSiteOwner: false }; // mesmo criador, mas mudou de empresa
        const requestingPlatformOwner = { id: 99, companyId: null, isSiteOwner: true };

        function checkAccess(user, targetFile) {
            const userCompanyId = user.companyId || user.company_id;
            const sameCompany = targetFile.company_id && userCompanyId && Number(targetFile.company_id) === Number(userCompanyId);
            const isPlatformOwner = user.isSiteOwner;
            return !!(sameCompany || isPlatformOwner);
        }

        assert.equal(checkAccess(requestingUserSameCompany, file), true);
        assert.equal(checkAccess(requestingUserDifferentCompany, file), false, 'Usuário de outra empresa não deve acessar arquivo corporativo');
        assert.equal(checkAccess(requestingPlatformOwner, file), true, 'Dono da plataforma tem acesso administrativo');
    });

    await t.test('playbooks são filtrados apenas pela empresa do usuário ou modelos de sistema', () => {
        const playbooks = [
            { id: 1, company_id: 1, is_system: true, title: 'Tutorial' },
            { id: 2, company_id: 1, is_system: false, title: 'Playbook Privado Empresa 1' },
            { id: 3, company_id: 2, is_system: false, title: 'Playbook Privado Empresa 2' },
        ];

        function filterPlaybooks(userCompanyId, list) {
            return list.filter(p => Number(p.company_id) === Number(userCompanyId) || p.is_system === true);
        }

        const userCompany2Playbooks = filterPlaybooks(2, playbooks);
        const titles = userCompany2Playbooks.map(p => p.title);

        assert.ok(titles.includes('Tutorial'));
        assert.ok(titles.includes('Playbook Privado Empresa 2'));
        assert.ok(!titles.includes('Playbook Privado Empresa 1'), 'Empresa 2 NÃO pode ver o playbook privado da Empresa 1');
    });
});
