const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: 'silent' }), // Mematikan log JSON yang berisik
                        browser: ["ShoesCare Web", "Chrome", "1.0.0"],
                        // printQRInTerminal: true <-- DIHAPUS agar tidak muncul warning
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('SCAN QR INI UNTUK KONEKSI WHATSAPP TOKO:');
            qrcode.generate(qr, { small: true });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('Koneksi terputus, mencoba hubungkan kembali...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WHATSAPP TOKO BERHASIL TERHUBUNG!');
        }
    });
}

async function sendWAMessage(to, message) {
    try {
        if (!sock) throw new Error("WhatsApp socket belum siap");

        // Format nomor agar sesuai standar internasional
        let formattedTo = to.replace(/\D/g, ''); // Hapus semua karakter non-angka
        if (formattedTo.startsWith('0')) {
            formattedTo = '62' + formattedTo.slice(1);
        }

        await sock.sendMessage(formattedTo + '@s.whatsapp.net', { text: message });
        console.log(`[WA SENT] Ke: ${formattedTo}`);
    } catch (error) {
        console.error("[WA ERROR] Gagal kirim pesan:", error.message);
    }
}

module.exports = { connectToWhatsApp, sendWAMessage };
