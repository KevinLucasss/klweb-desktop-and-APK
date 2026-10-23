const admin = require('firebase-admin');

// Credencial do Firebase (conta de serviço). NÃO coloque esse arquivo no Git.
// No Render: crie a variável FIREBASE_SERVICE_ACCOUNT com o conteúdo do JSON (texto puro ou em base64).
// Local: pode usar o arquivo backend/firebase-service-account.json (adicione-o ao .gitignore!).
let ready = false;

function loadServiceAccount() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
        const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        return JSON.parse(text);
    }
    return require('./firebase-service-account.json');
}

try {
    admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
    ready = true;
    console.log('✅ Firebase Admin inicializado para Push Notifications');
} catch (e) {
    console.warn('⚠️ Firebase Admin não configurado. Notificações Push desativadas:', e.message);
}

async function sendPushNotification(fcmToken, title, body) {
    if (!ready || !fcmToken) return;

    const message = {
        notification: { title, body },
        token: fcmToken,
        android: { priority: 'high', notification: { channelId: 'high_importance_channel' } },
        apns: { payload: { aps: { contentAvailable: true } } },
    };

    try {
        await admin.messaging().send(message);
        console.log(`🚀 Push enviado para o token ${fcmToken.substring(0, 10)}...`);
    } catch (error) {
        console.error('❌ Erro ao enviar Push:', error.message);
    }
}

module.exports = { sendPushNotification };