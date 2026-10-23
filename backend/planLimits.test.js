// backend/planLimits.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    getPlanLimits,
    canUseWarehouse,
    canUseAI,
    canCreateDemand,
    canCreateEvent,
    canUseEmailNotifications,
    canUseNotes,
    canUsePushNotifications,
    canUseErp,
    canUseErpFiscal,
    normalizePlanTier,
    pickHighestTier,
    effectiveTier
} = require('./planLimits');

describe('normalização de planos', () => {
    it('mapeia aliases antigos e o plano gratuito', () => {
        assert.equal(normalizePlanTier('FREE'), 'BASICO');
        assert.equal(normalizePlanTier('PRO_PME'), 'STARTER');
        assert.equal(normalizePlanTier('CORPORATE'), 'PRO_IA');
        assert.equal(normalizePlanTier('starter'), 'STARTER');
    });
});

describe('desbloqueio por plano', () => {
    it('plano gratuito não libera Armazém nem IA', () => {
        assert.equal(canUseWarehouse('BASICO'), false);
        assert.equal(canUseAI('BASICO'), false);
        assert.equal(getPlanLimits('BASICO').demandsLimit, 15);
        assert.equal(getPlanLimits('BASICO').storageBytes, 0);
    });

    it('Starter libera Armazém, IA e demandas ilimitadas', () => {
        assert.equal(canUseWarehouse('STARTER'), true);
        assert.equal(canUseAI('STARTER'), true);
        assert.equal(getPlanLimits('STARTER').demandsLimit, 999999);
        assert.ok(getPlanLimits('STARTER').storageBytes > 0);
    });

    it('Pro AI mantém Armazém e IA liberados', () => {
        assert.equal(canUseWarehouse('PRO_IA'), true);
        assert.equal(canUseAI('PRO_IA'), true);
        assert.equal(canUseWarehouse('OWNER'), true);
    });

    it('plano inativo cai para o gratuito', () => {
        assert.equal(effectiveTier('STARTER', 'INACTIVE'), 'BASICO');
        assert.equal(canUseWarehouse('STARTER', 'INACTIVE'), false);
        assert.equal(canCreateDemand('STARTER', 15, 'INACTIVE').allowed, false);
    });
});

describe('quantidade de demandas', () => {
    it('bloqueia a 16ª demanda no plano gratuito', () => {
        assert.deepEqual(canCreateDemand('BASICO', 0), { allowed: true, limit: 15, current: 0 });
        assert.deepEqual(canCreateDemand('BASICO', 14), { allowed: true, limit: 15, current: 14 });
        assert.deepEqual(canCreateDemand('BASICO', 15), { allowed: false, limit: 15, current: 15 });
    });

    it('Starter e Pro AI aceitam volumes altos de demandas', () => {
        assert.equal(canCreateDemand('STARTER', 15).allowed, true);
        assert.equal(canCreateDemand('STARTER', 500).allowed, true);
        assert.equal(canCreateDemand('PRO_IA', 2000).allowed, true);
    });
});

describe('limite de membros por plano', () => {
    it('reflete o que é anunciado nos cards de planos do frontend', () => {
        assert.equal(getPlanLimits('BASICO').userLimit, 3);
        assert.equal(getPlanLimits('STARTER').userLimit, 15);
        assert.ok(getPlanLimits('PRO_IA').userLimit > 1000);
    });
});

describe('plano da empresa', () => {
    it('escolhe o maior plano ativo da equipe', () => {
        assert.equal(pickHighestTier(['BASICO', 'STARTER', 'BASICO']), 'STARTER');
        assert.equal(pickHighestTier(['BASICO', 'PRO_IA']), 'PRO_IA');
        assert.equal(pickHighestTier([]), 'BASICO');
    });
});

describe('eventos do calendário', () => {
    it('plano gratuito permite 5 eventos e bloqueia o 6º', () => {
        assert.deepEqual(canCreateEvent('BASICO', 0), { allowed: true, limit: 5, current: 0 });
        assert.deepEqual(canCreateEvent('BASICO', 4), { allowed: true, limit: 5, current: 4 });
        assert.deepEqual(canCreateEvent('BASICO', 5), { allowed: false, limit: 5, current: 5 });
    });

    it('Starter, Pro AI e Owner têm calendário ilimitado', () => {
        assert.equal(canCreateEvent('STARTER', 500).allowed, true);
        assert.equal(canCreateEvent('PRO_IA', 5000).allowed, true);
        assert.equal(canCreateEvent('OWNER', 5000).allowed, true);
    });

    it('plano inativo volta ao limite do gratuito', () => {
        assert.equal(canCreateEvent('STARTER', 5, 'INACTIVE').allowed, false);
    });
});

describe('notificações por e-mail', () => {
    it('só a partir do Starter', () => {
        assert.equal(canUseEmailNotifications('BASICO'), false);
        assert.equal(canUseEmailNotifications('STARTER'), true);
        assert.equal(canUseEmailNotifications('PRO_IA'), true);
        assert.equal(canUseEmailNotifications('OWNER'), true);
        assert.equal(canUseEmailNotifications('STARTER', 'INACTIVE'), false);
    });
});

describe('anotações', () => {
    it('só a partir do Starter (Starter, Pro IA e Owner)', () => {
        assert.equal(canUseNotes('BASICO'), false);
        assert.equal(canUseNotes('STARTER'), true);
        assert.equal(canUseNotes('PRO_IA'), true);
        assert.equal(canUseNotes('OWNER'), true);
    });

    it('plano inativo perde as anotações', () => {
        assert.equal(canUseNotes('STARTER', 'INACTIVE'), false);
        assert.equal(canUseNotes('PRO_IA', 'INACTIVE'), false);
    });
});

describe('notificações push (app)', () => {
    it('só a partir do Starter', () => {
        assert.equal(canUsePushNotifications('BASICO'), false);
        assert.equal(canUsePushNotifications('STARTER'), true);
        assert.equal(canUsePushNotifications('PRO_IA'), true);
        assert.equal(canUsePushNotifications('OWNER'), true);
        assert.equal(canUsePushNotifications('STARTER', 'INACTIVE'), false);
    });
});

describe('ERP', () => {
    it('só a partir do Starter (Starter, Pro IA e Owner)', () => {
        assert.equal(canUseErp('BASICO'), false);
        assert.equal(canUseErp('STARTER'), true);
        assert.equal(canUseErp('PRO_IA'), true);
        assert.equal(canUseErp('OWNER'), true);
    });

    it('plano inativo perde o ERP', () => {
        assert.equal(canUseErp('STARTER', 'INACTIVE'), false);
        assert.equal(canUseErp('PRO_IA', 'INACTIVE'), false);
    });
});

describe('nota fiscal (Focus NFe)', () => {
    it('só no Pro IA (e Owner); Starter tem ERP mas não emite nota', () => {
        assert.equal(canUseErpFiscal('BASICO'), false);
        assert.equal(canUseErpFiscal('STARTER'), false);
        assert.equal(canUseErpFiscal('PRO_IA'), true);
        assert.equal(canUseErpFiscal('OWNER'), true);
        assert.equal(canUseErp('STARTER'), true);
    });

    it('plano inativo perde a emissão de nota', () => {
        assert.equal(canUseErpFiscal('PRO_IA', 'INACTIVE'), false);
    });
});