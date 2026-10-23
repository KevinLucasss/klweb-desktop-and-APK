const test = require('node:test');
const assert = require('node:assert/strict');

// Configura chave para os testes
process.env.JWT_SECRET = 'test_jwt_secret_for_unit_tests_1234567890';

const {
    encryptData,
    decryptData,
    isEncrypted,
    decryptUser,
    decryptUsers,
    decryptContact,
    decryptContacts
} = require('./cryptoUtils');

test('Criptografia AES-256-GCM - Dados Pessoais', async (t) => {
    await t.test('criptografa e descriptografa string simples com sucesso', () => {
        const original = '11988887777';
        const encrypted = encryptData(original);

        assert.notEqual(encrypted, original);
        assert.ok(isEncrypted(encrypted));
        assert.ok(encrypted.startsWith('enc:v1:'));

        const decrypted = decryptData(encrypted);
        assert.equal(decrypted, original);
    });

    await t.test('gera IVs aleatórios para o mesmo texto plano (evita padrões)', () => {
        const original = '123.456.789-00';
        const enc1 = encryptData(original);
        const enc2 = encryptData(original);

        assert.notEqual(enc1, enc2);
        assert.equal(decryptData(enc1), original);
        assert.equal(decryptData(enc2), original);
    });

    await t.test('trata valores vazios, nulos ou indefinidos sem erro', () => {
        assert.equal(encryptData(''), '');
        assert.equal(encryptData(null), null);
        assert.equal(encryptData(undefined), undefined);

        assert.equal(decryptData(''), '');
        assert.equal(decryptData(null), null);
        assert.equal(decryptData(undefined), undefined);
    });

    await t.test('não duplica criptografia se o dado já estiver criptografado', () => {
        const original = 'Carlos Alberto';
        const enc1 = encryptData(original);
        const enc2 = encryptData(enc1);

        assert.equal(enc1, enc2);
        assert.equal(decryptData(enc2), original);
    });

    await t.test('devolve texto legado não criptografado sem falhar', () => {
        const legacy = 'Texto puro antigo';
        assert.equal(decryptData(legacy), legacy);
    });

    await t.test('decryptUser descriptografa name, phone e cpf', () => {
        const user = {
            id: 1,
            name: encryptData('Maria Silva'),
            email: 'maria@empresa.com',
            phone: encryptData('11999990000'),
            cpf: encryptData('11122233344'),
            role: 'MANAGER'
        };

        const decrypted = decryptUser(user);
        assert.equal(decrypted.name, 'Maria Silva');
        assert.equal(decrypted.email, 'maria@empresa.com');
        assert.equal(decrypted.phone, '11999990000');
        assert.equal(decrypted.cpf, '11122233344');
        assert.equal(decrypted.role, 'MANAGER');
    });

    await t.test('decryptContact descriptografa campos de CRM', () => {
        const contact = {
            id: 10,
            name: encryptData('João Contato'),
            phone: encryptData('21988887777'),
            email: encryptData('joao@cliente.com'),
            notes: encryptData('Cliente VIP'),
            company_id: 1
        };

        const decrypted = decryptContact(contact);
        assert.equal(decrypted.name, 'João Contato');
        assert.equal(decrypted.phone, '21988887777');
        assert.equal(decrypted.email, 'joao@cliente.com');
        assert.equal(decrypted.notes, 'Cliente VIP');
        assert.equal(decrypted.company_id, 1);
    });

    await t.test('detecta adulteração no ciphertext (Auth Tag do GCM)', () => {
        const original = 'Dado seguro confidencial';
        const encrypted = encryptData(original);
        const parts = encrypted.slice(7).split(':');
        // Altera um caractere do ciphertext
        const tamperedCipher = parts[2].slice(0, -1) + (parts[2].endsWith('a') ? 'b' : 'a');
        const tampered = `enc:v1:${parts[0]}:${parts[1]}:${tamperedCipher}`;

        // Deve retornar o fallback seguro sem lançar exceção não capturada
        const result = decryptData(tampered);
        assert.equal(result, tampered);
    });
});
