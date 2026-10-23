// Módulo de Segurança - Proteção contra hackers e invasões
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// ========================================
// 1. VALIDAÇÃO E SANITIZAÇÃO DE INPUT
// ========================================

function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    
    // Remove caracteres perigosos
    return input
        .replace(/[<>]/g, '') // Remove < e >
        .replace(/javascript:/gi, '') // Remove javascript:
        .replace(/on\w+=/gi, '') // Remove event handlers (onclick=, etc)
        .replace(/--/g, '') // Remove comentários SQL
        .trim();
}

function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return false;
    }
    
    // Validação adicional de caracteres perigosos
    if (/[<>;'"\\]/.test(email)) {
        return false;
    }
    
    return true;
}

function validatePhone(phone) {
    // Remove caracteres não numéricos (mantém + para código país)
    const cleaned = phone.replace(/[^\d+]/g, '');
    
    // Valida tamanho mínimo (8 dígitos + código país)
    if (cleaned.length < 10) {
        return false;
    }
    
    return cleaned;
}

function validateText(input, maxLength = 255) {
    if (typeof input !== 'string') return input;
    
    // Limita tamanho
    if (input.length > maxLength) {
        input = input.substring(0, maxLength);
    }
    
    return sanitizeInput(input);
}

// ========================================
// 2. PROTEÇÃO CONTRA SQL INJECTION
// ========================================

// O pg já usa parâmetros, mas vamos adicionar validação extra
function escapeForLikePattern(input) {
    if (typeof input !== 'string') return input;
    
    // Remove caracteres especiais de LIKE que podem causar problemas
    return input
        .replace(/[%_]/g, '\\$&') // Escapa % e _
        .replace(/[\\]/g, '\\\\'); // Escapa backslash
}

// ========================================
// 3. DETECÇÃO DE ATIVIDADE SUSPEITA
// ========================================

class SecurityMonitor {
    constructor() {
        this.suspiciousIPs = new Map(); // IP -> { attempts, lastAttempt, blockedUntil }
        this.blockedIPs = new Set();
        this.attackPatterns = [
            /\bunion\b.*select\b/gi, // SQL Injection
            /\bselect\b.*\bfrom\b.*\bwhere\b.*\bor\b/gi, // SQL Injection
            /\bdrop\b.*\btable\b/gi, // SQL Injection
            /\bdelete\b.*\bfrom\b/gi, // SQL Injection
            /\binsert\b.*\binto\b/gi, // SQL Injection
            /\bupdate\b.*\bset\b/gi, // SQL Injection
            /<script\b[^>]*>.*<\/script\b>/gi, // XSS
            /javascript:/gi, // XSS
            /on\w+\s*=/gi, // Event injection
            /alert\s*\(/gi, // XSS
            /document\.cookie/gi, // Cookie theft
            /window\.location/gi, // Redirection
            /eval\s*\(/gi, // Code injection
            /exec\s*\(/gi, // Code injection
        ];
    }

    logSuspiciousActivity(ip, userAgent, pattern, endpoint) {
        console.warn(`🚨 ATIVIDADE SUSPEITA DETECTADA:`);
        console.warn(`IP: ${ip}`);
        console.warn(`Endpoint: ${endpoint}`);
        console.warn(`Pattern: ${pattern}`);
        console.warn(`User-Agent: ${userAgent}`);
        
        // Log no banco de dados
        this.logToDatabase(ip, userAgent, pattern, endpoint);
    }

    async logToDatabase(ip, userAgent, pattern, endpoint) {
        try {
            const { Pool } = require('pg');
            const pool = new Pool(require('pg-connection-string').parse(process.env.DATABASE_URL));
            
            await pool.query(`
                INSERT INTO security_logs (user_id, user_email, action, ip_address, user_agent, company_id)
                VALUES (NULL, NULL, $1, $2, $3, NULL)
            `, [`SUSPICIOUS_ACTIVITY: ${pattern}`, ip, userAgent]);
        } catch (err) {
            console.error('Erro ao logar atividade suspeita:', err.message);
        }
    }

    isIPBlocked(ip) {
        const blockInfo = this.suspiciousIPs.get(ip);
        if (!blockInfo) return false;
        
        if (blockInfo.blockedUntil && Date.now() < blockInfo.blockedUntil) {
            return true;
        }
        
        // Remove bloco se expirou
        if (blockInfo.blockedUntil && Date.now() >= blockInfo.blockedUntil) {
            this.suspiciousIPs.delete(ip);
            return false;
        }
        
        return false;
    }

    recordAttempt(ip) {
        const now = Date.now();
        let blockInfo = this.suspiciousIPs.get(ip);
        
        if (!blockInfo) {
            blockInfo = { attempts: 0, lastAttempt: now, blockedUntil: null };
            this.suspiciousIPs.set(ip, blockInfo);
        }
        
        blockInfo.attempts++;
        blockInfo.lastAttempt = now;
        
        // Bloquear após 10 tentativas em 1 minuto
        if (blockInfo.attempts >= 10 && (now - blockInfo.lastAttempt) < 60000) {
            blockInfo.blockedUntil = now + (15 * 60 * 1000); // Bloquear por 15 minutos
            console.warn(`🚨 IP ${ip} bloqueada por atividade suspeita`);
        }
        
        // Reset contador após 1 minuto sem atividade
        if ((now - blockInfo.lastAttempt) > 60000) {
            blockInfo.attempts = 0;
        }
    }

    checkForAttackPatterns(input) {
        if (typeof input !== 'string') return null;
        
        for (const pattern of this.attackPatterns) {
            const match = input.match(pattern);
            if (match) {
                return match[0];
            }
        }
        
        return null;
    }
}

const securityMonitor = new SecurityMonitor();

// ========================================
// 4. MIDDLEWARE DE SEGURANÇA
// ========================================

function securityCheck(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    
    // Verifica se IP está bloqueado
    if (securityMonitor.isIPBlocked(ip)) {
        return res.status(429).json({ 
            message: 'Muitas tentativas. Seu IP foi temporariamente bloqueado por segurança. Tente novamente em 15 minutos.' 
        });
    }
    
    // Verifica padrões de ataque em body e query
    const bodyString = JSON.stringify(req.body || {});
    const queryString = JSON.stringify(req.query || {});
    const fullInput = bodyString + queryString;
    
    const attackPattern = securityMonitor.checkForAttackPatterns(fullInput);
    if (attackPattern) {
        securityMonitor.logSuspiciousActivity(ip, userAgent, attackPattern, req.path);
        securityMonitor.recordAttempt(ip);
        
        return res.status(403).json({ 
            message: 'Requisição bloqueada por segurança. Se você acredita que isso é um erro, entre em contato com o suporte.' 
        });
    }
    
    // Sanitiza campos sensíveis
    if (req.body) {
        if (req.body.email) req.body.email = sanitizeInput(req.body.email);
        if (req.body.name) req.body.name = sanitizeInput(req.body.name);
        if (req.body.phone) req.body.phone = sanitizeInput(req.body.phone);
        if (req.body.message) req.body.message = sanitizeInput(req.body.message);
        if (req.body.title) req.body.title = sanitizeInput(req.body.title);
        if (req.body.description) req.body.description = sanitizeInput(req.body.description);
    }
    
    next();
}

// ========================================
// 5. VALIDAÇÃO DE DADOS SENSÍVEIS
// ========================================

function validateSensitiveData(req, res, next) {
    // Não expor informações sensíveis em erros
    const originalJson = res.json;
    res.json = function(data) {
        // Remove informações sensíveis do erro
        if (data.error && data.error.message) {
            // Remove stack traces em produção
            if (process.env.NODE_ENV === 'production') {
                delete data.error.stack;
            }
        }
        
        // Remove informações de ambiente
        if (data.config) {
            delete data.config;
        }
        
        return originalJson.call(this, data);
    };
    
    next();
}

// ========================================
// 6. PROTEÇÃO CONTRA CSRF
// ========================================

function generateCSRFToken() {
    return crypto.randomBytes(32).toString('hex');
}

function validateCSRFToken(req, res, next) {
    const token = req.headers['x-csrf-token'] || req.body._csrf;
    const sessionToken = req.session?.csrfToken;
    
    // Em produção, validar CSRF em métodos que modificam dados
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        if (!token || !sessionToken || token !== sessionToken) {
            return res.status(403).json({ 
                message: 'Token CSRF inválido. Recarregue a página e tente novamente.' 
            });
        }
    }
    
    next();
}

// ========================================
// 7. LOGGING DE SEGURANÇA
// ========================================

function logSecurityEvent(event, req, additionalInfo = {}) {
    const logData = {
        timestamp: new Date().toISOString(),
        event,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.headers['user-agent'],
        path: req.path,
        method: req.method,
        userId: req.user?.id,
        userEmail: req.user?.email,
        companyId: req.user?.companyId,
        ...additionalInfo
    };
    
    console.log(`🔒 [SECURITY] ${event}:`, JSON.stringify(logData, null, 2));
    
    // Em produção, enviar para serviço de logging (ex: Sentry, LogRocket)
    if (process.env.NODE_ENV === 'production') {
        // Implementar integração com serviço de logging
    }
}

// ========================================
// 8. PROTEÇÃO CONTRA BRUTE FORCE (Melhorado)
// ========================================

const advancedAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // Reduzido de 10 para 5
    message: { message: 'Muitas tentativas de autenticação. Tente novamente em 15 minutos.' },
    skip: (req) => {
        // Pula rate limit para IPs confiáveis (pode implementar whitelist)
        const trustedIPs = process.env.TRUSTED_IPS ? process.env.TRUSTED_IPS.split(',') : [];
        const ip = req.ip || req.connection.remoteAddress;
        return trustedIPs.includes(ip);
    },
    standardHeaders: true, // Adiciona headers de rate limit
    legacyHeaders: false,
});

// ========================================
// 9. VALIDAÇÃO DE FILE UPLOAD
// ========================================

function validateFileUpload(req, res, next) {
    const file = req.file;
    
    if (!file) return next();
    
    // Validação MIME type
    const allowedMimeTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain',
        'application/zip',
        'application/x-zip-compressed'
    ];
    
    if (!allowedMimeTypes.includes(file.mimetype)) {
        // Apaga o arquivo
        require('fs').unlinkSync(file.path);
        return res.status(400).json({ 
            message: 'Tipo de arquivo não permitido. Apenas imagens, PDFs, documentos e arquivos ZIP.' 
        });
    }
    
    // Validação de tamanho (já está no multer, mas vamos reforçar)
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
        require('fs').unlinkSync(file.path);
        return res.status(400).json({ 
            message: 'Arquivo muito grande. Tamanho máximo: 50MB.' 
        });
    }
    
    // Validação de nome do arquivo (evita path traversal)
    const filename = file.originalname;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        require('fs').unlinkSync(file.path);
        return res.status(400).json({ 
            message: 'Nome de arquivo inválido.' 
        });
    }
    
    next();
}

// ========================================
// 10. MÁSCARA DE DADOS SENSÍVEIS
// ========================================

function maskSensitiveData(data) {
    if (!data) return data;
    
    // Se for erro, remove stack trace em produção
    if (data instanceof Error) {
        if (process.env.NODE_ENV === 'production') {
            return {
                message: data.message,
                name: data.name
            };
        }
        return data;
    }
    
    // Se for objeto, mascara campos sensíveis
    if (typeof data === 'object') {
        const masked = { ...data };
        
        // Mascarar email
        if (masked.email) {
            const email = masked.email;
            const [name, domain] = email.split('@');
            masked.email = `${name.substring(0, 2)}***@${domain}`;
        }
        
        // Mascarar telefone
        if (masked.phone) {
            const phone = masked.phone;
            masked.phone = phone.substring(0, 2) + '****' + phone.substring(phone.length - 2);
        }
        
        // Mascarar token
        if (masked.token || masked.password) {
            delete masked.token;
            delete masked.password;
        }
        
        return masked;
    }
    
    return data;
}

// ========================================
// 11. PROTEÇÃO CONTRA XSS EM RESPOSTAS
// ========================================

function escapeXSS(str) {
    if (typeof str !== 'string') return str;
    
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ========================================
// 12. HEADERS DE SEGURANÇA ADICIONAIS
// ========================================

function setSecurityHeaders(req, res, next) {
    // Remove header X-Powered-By (expose versão do servidor)
    res.removeHeader('X-Powered-By');
    
    // Remove header Server (expose tecnologia)
    res.removeHeader('Server');
    
    // Adiciona headers personalizados
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Em produção, adiciona HSTS
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    
    next();
}

// ========================================
// 13. MONITORAMENTO DE LOGIN MÚLTIPLO
// ========================================

const loginAttempts = new Map(); // IP/email -> { attempts, lastAttempt, blockedUntil }

function trackLoginAttempt(identifier) {
    const now = Date.now();
    let attempts = loginAttempts.get(identifier);
    
    if (!attempts) {
        attempts = { count: 0, lastAttempt: now, blockedUntil: 0 };
        loginAttempts.set(identifier, attempts);
    }
    
    // Se ainda estiver bloqueado, mantém bloqueado
    if (attempts.blockedUntil && now < attempts.blockedUntil) {
        return {
            blocked: true,
            remainingTime: attempts.blockedUntil - now,
            reason: 'Exceeded maximum attempts'
        };
    }
    
    // Reset se já passou o tempo de bloqueio
    if (attempts.blockedUntil && now >= attempts.blockedUntil) {
        attempts.count = 0;
        attempts.blockedUntil = 0;
    }
    
    // Reset após 15 minutos sem tentativas
    if ((now - attempts.lastAttempt) > 900000) {
        attempts.count = 0;
    }
    
    attempts.count++;
    attempts.lastAttempt = now;
    
    // Bloquear após 5 tentativas em 15 minutos
    if (attempts.count >= 5) {
        // Backoff exponencial: 1ª vez 15min, 2ª vez 30min, 3ª vez 1hora
        const blockTime = 900000 * Math.pow(2, Math.min(attempts.count - 5, 2));
        attempts.blockedUntil = now + blockTime;
        
        return {
            blocked: true,
            remainingTime: blockTime,
            reason: 'Exceeded maximum attempts'
        };
    }
    
    return { blocked: false, attemptsRemaining: 5 - attempts.count };
}

function clearLoginAttempt(identifier) {
    loginAttempts.delete(identifier);
}

// ========================================
// 14. VERIFICAÇÃO DE ORIGEM DE REQUISIÇÃO
// ========================================

function verifyRequestOrigin(req, res, next) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    
    // Em produção, verificar origin
    if (process.env.NODE_ENV === 'production') {
        const allowedOrigins = [
            'https://klweb.com.br',
            'https://www.klweb.com.br',
            'https://kl-web.onrender.com'
        ];
        
        if (origin && !allowedOrigins.includes(origin)) {
            console.warn(`🚨 Origin não permitida: ${origin}`);
            return res.status(403).json({ 
                message: 'Origem não permitida.' 
            });
        }
    }
    
    next();
}

// ========================================
// 15. EXPORTAÇÕES
// ========================================

module.exports = {
    sanitizeInput,
    validateEmail,
    validatePhone,
    validateText,
    escapeForLikePattern,
    securityMonitor,
    securityCheck,
    validateSensitiveData,
    generateCSRFToken,
    validateCSRFToken,
    logSecurityEvent,
    advancedAuthLimiter,
    validateFileUpload,
    maskSensitiveData,
    escapeXSS,
    setSecurityHeaders,
    trackLoginAttempt,
    clearLoginAttempt,
    verifyRequestOrigin
};
