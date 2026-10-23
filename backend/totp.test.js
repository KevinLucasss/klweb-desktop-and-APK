// backend/totp.test.js
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const totp = require('./totp');

// Segredo de teste das RFCs: ASCII "12345678901234567890"
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

before(() => {
    process.env.TOTP_ENCRYPTION_KEY = 'chave-de-teste';
});

describe('HOTP (RFC 4226, Apêndice D)', () => {
    it('gera os 10 códigos oficiais de teste', () => {
        const expected = ['755224', '287082', '359152', '969429', '338314',
            '254676', '287922', '162583', '399871', '520489'];
        expected.forEach((code, counter) => assert.equal(totp.hotp(RFC_SECRET, counter), code));
    });
});

describe('TOTP (RFC 6238)', () => {
    it('bate com o vetor oficial (t=59s -> 287082 em 6 dígitos)', () => {
        assert.equal(totp.verifyTotp(RFC_SECRET, '287082', { now: 59 * 1000, window: 0 }), 1);
    });

    it('aceita ±1 janela de tolerância e rejeita além disso', () => {
        const now = 1_700_000_000_000;
        const step = totp.currentStep(now);
        assert.equal(totp.verifyTotp(RFC_SECRET, totp.hotp(RFC_SECRET, step - 1), { now }), step - 1);
        assert.equal(totp.verifyTotp(RFC_SECRET, totp.hotp(RFC_SECRET, step + 1), { now }), step + 1);
        assert.equal(totp.verifyTotp(RFC_SECRET, totp.hotp(RFC_SECRET, step - 2), { now }), null);
    });

    it('rejeita replay de uma janela já usada', () => {
        const now = 1_700_000_000_000;
        const step = totp.currentStep(now);
        const code = totp.hotp(RFC_SECRET, step);
        assert.equal(totp.verifyTotp(RFC_SECRET, code, { now, lastStep: step }), null);
        assert.equal(totp.verifyTotp(RFC_SECRET, code, { now, lastStep: step - 1 }), step);
    });

    it('rejeita formato inválido e aceita espaços no meio', () => {
        assert.equal(totp.verifyTotp(RFC_SECRET, 'abcdef'), null);
        assert.equal(totp.verifyTotp(RFC_SECRET, '12345'), null);
        assert.equal(totp.verifyTotp(RFC_SECRET, ''), null);
        const now = 1_700_000_000_000;
        const code = totp.hotp(RFC_SECRET, totp.currentStep(now));
        assert.notEqual(totp.verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { now }), null);
    });
});

describe('segredo e URL otpauth', () => {
    it('gera segredo base32 de 32 caracteres que faz round-trip', () => {
        const s = totp.generateSecret();
        assert.match(s, /^[A-Z2-7]{32}$/);
        assert.equal(totp.base32Encode(totp.base32Decode(s)), s);
    });

    it('monta a URL que o app autenticador entende', () => {
        const url = totp.buildOtpAuthUrl({ secret: 'ABC234', account: 'a@b.com', issuer: 'KL Web' });
        assert.ok(url.startsWith('otpauth://totp/KL%20Web:a%40b.com?'));
        assert.match(url, /secret=ABC234/);
        assert.match(url, /issuer=KL\+Web/);
    });
});

describe('criptografia do segredo', () => {
    it('cifra e decifra; texto cifrado não contém o segredo', () => {
        const s = totp.generateSecret();
        const enc = totp.encryptSecret(s);
        assert.ok(!enc.includes(s));
        assert.equal(totp.decryptSecret(enc), s);
    });

    it('detecta adulteração (GCM)', () => {
        const parts = totp.encryptSecret('SEGREDO').split(':');
        parts[2] = Buffer.from('lixo-lixo-lixo').toString('base64');
        assert.throws(() => totp.decryptSecret(parts.join(':')));
    });
});

describe('códigos de backup', () => {
    it('gera 8 códigos únicos no formato xxxxx-xxxxx', () => {
        const codes = totp.generateBackupCodes();
        assert.equal(codes.length, 8);
        assert.equal(new Set(codes).size, 8);
        codes.forEach((c) => assert.match(c, /^[a-f0-9]{5}-[a-f0-9]{5}$/));
    });

    it('consome um código uma única vez, ignorando maiúsculas e hífen', () => {
        const codes = totp.generateBackupCodes(3);
        const hashes = codes.map(totp.hashBackupCode);
        const after = totp.consumeBackupCode(hashes, codes[1].toUpperCase().replace('-', ''));
        assert.equal(after.length, 2);
        assert.equal(totp.consumeBackupCode(after, codes[1]), null); // já usado
        assert.equal(totp.consumeBackupCode(hashes, 'zzzzz-zzzzz'), null);
    });
});
