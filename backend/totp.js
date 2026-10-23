// backend/totp.js
// Autenticação em dois fatores (TOTP, RFC 6238) compatível com Google Authenticator,
// Microsoft Authenticator, Authy, 1Password etc. Usa apenas o módulo `crypto` do Node.

const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

// ---------- Base32 (RFC 4648) ----------
function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const ch of clean) {
        value = (value << 5) | B32_ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

// ---------- HOTP / TOTP ----------
function generateSecret(bytes = 20) {
    return base32Encode(crypto.randomBytes(bytes)); // 20 bytes = 160 bits (recomendado pela RFC 4226)
}

function hotp(secretBase32, counter, digits = DIGITS) {
    const key = base32Decode(secretBase32);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(msg).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin =
        ((hmac[offset] & 0x7f) << 24) |
        (hmac[offset + 1] << 16) |
        (hmac[offset + 2] << 8) |
        hmac[offset + 3];
    return String(bin % 10 ** digits).padStart(digits, '0');
}

function currentStep(now = Date.now()) {
    return Math.floor(now / 1000 / STEP_SECONDS);
}

function safeEqual(a, b) {
    const A = Buffer.from(String(a));
    const B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/**
 * Verifica um código de 6 dígitos. Aceita ±`window` janelas de 30s (tolerância de relógio).
 * Retorna o "step" (número da janela) que bateu, ou null se inválido.
 * Se `lastStep` for informado, rejeita códigos de janelas já usadas (anti-replay).
 */
function verifyTotp(secretBase32, code, { now = Date.now(), window = 1, lastStep = null } = {}) {
    const clean = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) return null;

    const step = currentStep(now);
    let matched = null;
    for (let w = -window; w <= window; w++) {
        if (safeEqual(hotp(secretBase32, step + w), clean)) matched = step + w;
    }
    if (matched === null) return null;
    if (lastStep !== null && lastStep !== undefined && matched <= Number(lastStep)) return null;
    return matched;
}

function buildOtpAuthUrl({ secret, account, issuer = 'KL Web' }) {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS)
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------- Criptografia do segredo em repouso (AES-256-GCM) ----------
function getKey() {
    const raw = process.env.TOTP_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!raw) {
        throw new Error('Defina TOTP_ENCRYPTION_KEY (ou JWT_SECRET) no ambiente para usar o 2FA.');
    }
    return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, enc].map((b) => b.toString('base64')).join(':');
}

function decryptSecret(payload) {
    const [iv, tag, enc] = String(payload).split(':').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---------- Códigos de backup (uso único) ----------
function generateBackupCodes(count = 8) {
    return Array.from({ length: count }, () => {
        const h = crypto.randomBytes(5).toString('hex'); // 10 caracteres hex
        return `${h.slice(0, 5)}-${h.slice(5)}`;
    });
}

function normalizeBackupCode(code) {
    return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashBackupCode(code) {
    return crypto.createHash('sha256').update(normalizeBackupCode(code)).digest('hex');
}

/** Retorna a lista de hashes sem o código usado, ou null se o código não existir. */
function consumeBackupCode(hashes, code) {
    if (!/^[a-f0-9]{10}$/.test(normalizeBackupCode(code))) return null;
    const target = hashBackupCode(code);
    const idx = hashes.findIndex((h) => safeEqual(h, target));
    if (idx === -1) return null;
    return hashes.filter((_, i) => i !== idx);
}

module.exports = {
    generateSecret,
    hotp,
    verifyTotp,
    currentStep,
    buildOtpAuthUrl,
    encryptSecret,
    decryptSecret,
    generateBackupCodes,
    hashBackupCode,
    consumeBackupCode,
    base32Encode,
    base32Decode
};
