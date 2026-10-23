const crypto = require('crypto');

// Gerar JWT_SECRET seguro (32 bytes hexadecimais)
const jwtSecret = crypto.randomBytes(32).toString('hex');

// Gerar MASTER_PASSWORD forte
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*';
let masterPassword = '';
for (let i = 0; i < 16; i++) {
    masterPassword += chars.charAt(Math.floor(Math.random() * chars.length));
}

console.log('='.repeat(50));
console.log('🔐 CHAVES DE SEGURANÇA GERADAS');
console.log('='.repeat(50));
console.log('\nCole estas linhas no seu arquivo .env:\n');
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`MASTER_PASSWORD=${masterPassword}`);
console.log('\n' + '='.repeat(50));
console.log('⚠️  Salve estas chaves em lugar seguro!');
console.log('⚠️  Depois de atualizar o .env, reinicie o servidor.');
console.log('='.repeat(50));