// backend/cryptoUtils.js
// Criptografia de dados em repouso (AES-256-GCM) para dados pessoais e sensíveis (LGPD).
// Suporta criptografia e descriptografia transparente com verificação de integridade (Auth Tag).

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function getEncryptionKey() {
    const raw = process.env.DATA_ENCRYPTION_KEY || process.env.TOTP_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!raw) {
        throw new Error('Chave de criptografia não configurada no ambiente (DATA_ENCRYPTION_KEY ou JWT_SECRET)');
    }
    return crypto.createHash('sha256').update(raw).digest();
}

function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Criptografa uma string usando AES-256-GCM com IV aleatório de 12 bytes.
 * Se o valor já estiver criptografado ou for nulo/vazio, retorna sem alterar.
 */
function encryptData(plainText) {
    if (plainText === null || plainText === undefined || plainText === '') {
        return plainText;
    }
    const str = String(plainText);
    if (isEncrypted(str)) {
        return str; // Evita dupla criptografia
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const enc = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Descriptografa uma string criptografada em formato enc:v1:<iv>:<tag>:<ciphertext>.
 * Se o valor não estiver criptografado (legado) ou for nulo/vazio, retorna o valor original.
 */
function decryptData(encryptedText) {
    if (encryptedText === null || encryptedText === undefined || encryptedText === '') {
        return encryptedText;
    }
    const str = String(encryptedText);
    if (!isEncrypted(str)) {
        return str; // Texto plano legado ou não criptografado
    }
    try {
        const payload = str.slice(PREFIX.length);
        const parts = payload.split(':');
        if (parts.length !== 3) return str;
        const [ivB64, tagB64, encB64] = parts;
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        const enc = Buffer.from(encB64, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch (err) {
        console.error('Erro ao descriptografar dado:', err.message);
        return str; // Fallback seguro
    }
}

/**
 * Descriptografa campos pessoais de um objeto de usuário.
 */
function decryptUser(user) {
    if (!user || typeof user !== 'object') return user;
    const cloned = { ...user };
    if ('name' in cloned && cloned.name) cloned.name = decryptData(cloned.name);
    if ('phone' in cloned && cloned.phone) cloned.phone = decryptData(cloned.phone);
    if ('cpf' in cloned && cloned.cpf) cloned.cpf = decryptData(cloned.cpf);
    return cloned;
}

function decryptUsers(usersList) {
    if (!Array.isArray(usersList)) return [];
    return usersList.map(decryptUser);
}

/**
 * Descriptografa campos de um contato do CRM.
 */
function decryptContact(contact) {
    if (!contact || typeof contact !== 'object') return contact;
    const cloned = { ...contact };
    if ('name' in cloned && cloned.name) cloned.name = decryptData(cloned.name);
    if ('phone' in cloned && cloned.phone) cloned.phone = decryptData(cloned.phone);
    if ('email' in cloned && cloned.email) cloned.email = decryptData(cloned.email);
    if ('notes' in cloned && cloned.notes) cloned.notes = decryptData(cloned.notes);
    return cloned;
}

function decryptContacts(contactsList) {
    if (!Array.isArray(contactsList)) return [];
    return contactsList.map(decryptContact);
}

module.exports = {
    encryptData,
    decryptData,
    isEncrypted,
    decryptUser,
    decryptUsers,
    decryptContact,
    decryptContacts
};
