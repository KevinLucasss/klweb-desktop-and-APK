const TIER_HIERARCHY = {
    BASICO: 0,
    STARTER: 1,
    PRO_IA: 2,
    OWNER: 3
};

const PLAN_CONFIGS = {
    BASICO: {
        demandsLimit: 15,
        userLimit: 3,
        storageBytes: 0,
        warehouseAllowed: false,
        aiAllowed: false,
        aiMonthlyLimit: 0,
        aiDailyLimit: 0,
        eventsLimit: 5,
        emailNotificationsAllowed: false,
        pushNotificationsAllowed: false, // Push no app: só Starter e Pro IA
        notesAllowed: false, // Anotações: só Starter e Pro IA
        erpAllowed: false, // ERP (cadastros, estoque, vendas, financeiro): só Starter e Pro IA
        erpFiscalAllowed: false // Emissão de nota fiscal (Focus NFe): só Pro IA
    },
    STARTER: {
        demandsLimit: 999999,
        userLimit: 15,
        storageBytes: 500 * 1024 * 1024, // 500 MB
        warehouseAllowed: true,
        aiAllowed: true,
        aiMonthlyLimit: 30,
        aiDailyLimit: 50,
        eventsLimit: 999999,
        emailNotificationsAllowed: true,
        pushNotificationsAllowed: true,
        notesAllowed: true,
        erpAllowed: true,
        erpFiscalAllowed: false
    },
    PRO_IA: {
        demandsLimit: 999999,
        userLimit: 999999,
        storageBytes: 5 * 1024 * 1024 * 1024, // 5 GB
        warehouseAllowed: true,
        aiAllowed: true,
        aiMonthlyLimit: 999999,
        aiDailyLimit: 300,
        eventsLimit: 999999,
        emailNotificationsAllowed: true,
        pushNotificationsAllowed: true,
        notesAllowed: true,
        erpAllowed: true,
        erpFiscalAllowed: true
    },
    OWNER: {
        demandsLimit: 999999,
        userLimit: 999999,
        storageBytes: 1000 * 1024 * 1024 * 1024,
        warehouseAllowed: true,
        aiAllowed: true,
        aiMonthlyLimit: 999999,
        aiDailyLimit: 999999,
        eventsLimit: 999999,
        emailNotificationsAllowed: true,
        pushNotificationsAllowed: true,
        notesAllowed: true,
        erpAllowed: true,
        erpFiscalAllowed: true
    }
};

function normalizePlanTier(plan) {
    if (!plan) return 'BASICO';
    const cleanPlan = plan.toString().toUpperCase().trim();

    const aliases = {
        'FREE': 'BASICO',
        'GRATUITO': 'BASICO',
        'PRO_PME': 'STARTER',
        'STARTER': 'STARTER',
        'CORPORATE': 'PRO_IA',
        'PRO_IA': 'PRO_IA',
        'PRO_AI': 'PRO_IA',
        'OWNER': 'OWNER'
    };

    return aliases[cleanPlan] || 'BASICO';
}

function effectiveTier(plan, status = 'ACTIVE') {
    if (status && status.toUpperCase() === 'INACTIVE') {
        return 'BASICO';
    }
    return normalizePlanTier(plan);
}

function getPlanLimits(plan, status = 'ACTIVE') {
    const tier = effectiveTier(plan, status);
    return PLAN_CONFIGS[tier] || PLAN_CONFIGS.BASICO;
}

function canUseWarehouse(plan, status = 'ACTIVE') {
    return getPlanLimits(plan, status).warehouseAllowed;
}

function canUseAI(plan, status = 'ACTIVE') {
    return getPlanLimits(plan, status).aiAllowed;
}

function canCreateDemand(plan, currentCount = 0, status = 'ACTIVE') {
    const limits = getPlanLimits(plan, status);
    const allowed = currentCount < limits.demandsLimit;
    return {
        allowed,
        limit: limits.demandsLimit,
        current: currentCount
    };
}

function canCreateEvent(plan, currentCount = 0, status = 'ACTIVE') {
    const limits = getPlanLimits(plan, status);
    return {
        allowed: currentCount < limits.eventsLimit,
        limit: limits.eventsLimit,
        current: currentCount
    };
}

function canUseEmailNotifications(plan, status = 'ACTIVE') {
    return getPlanLimits(plan, status).emailNotificationsAllowed;
}

// Anotações (bloco de notas do Workspace e da Cláudia): planos Starter e Pro IA (e Owner).
function canUseNotes(plan, status = 'ACTIVE') {
    return getPlanLimits(plan, status).notesAllowed;
}

// Push no celular (app Android): planos Starter e Pro IA (e Owner).
function canUsePushNotifications(plan, status = 'ACTIVE') {
    return getPlanLimits(plan, status).pushNotificationsAllowed;
}

// ERP (cadastros, produtos/estoque, vendas/compras e financeiro): planos Starter e Pro IA (e Owner).
// Para mudar quais planos liberam o ERP, basta editar `erpAllowed` em PLAN_CONFIGS acima.
function canUseErp(plan, status = 'ACTIVE') {
    return getPlanLimits(plan, status).erpAllowed;
}

// Emissão de nota fiscal de serviço (Focus NFe): plano Pro IA (e Owner). Exige também o ERP liberado.
function canUseErpFiscal(plan, status = 'ACTIVE') {
    return getPlanLimits(plan, status).erpFiscalAllowed;
}

function pickHighestTier(plansArray = []) {
    if (!Array.isArray(plansArray) || plansArray.length === 0) {
        return 'BASICO';
    }

    let highestTier = 'BASICO';
    let highestScore = -1;

    for (const p of plansArray) {
        const tier = normalizePlanTier(p);
        const score = TIER_HIERARCHY[tier] ?? 0;
        if (score > highestScore) {
            highestScore = score;
            highestTier = tier;
        }
    }

    return highestTier;
}

function isPlanActive(status, plan) {
    // Um plano é considerado ativo quando o status não é INACTIVE.
    // (Mantém a mesma regra usada em effectiveTier, para os dois ficarem sempre consistentes.)
    if (!status) return false;
    return status.toString().toUpperCase() === 'ACTIVE';
}

module.exports = {
    normalizePlanTier,
    effectiveTier,
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
    pickHighestTier,
    isPlanActive,
    PLAN_LIMITS: PLAN_CONFIGS,
    TIER_HIERARCHY: TIER_HIERARCHY
};