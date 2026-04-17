const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { connectToWhatsApp, sendWAMessage } = require('./whatsapp');

const app = express();
const PORT = 3000;

// Jalankan Koneksi WhatsApp
connectToWhatsApp();

// Setup EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'rahasia-sepatu-123',
    resave: false,
    saveUninitialized: true
}));

// Setup Database SQLite
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Error membuka database:", err.message);
    else console.log("Database SQLite siap.");
});

// ==========================================
// INISIALISASI TABEL DATABASE
// ==========================================
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS pelanggan (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, whatsapp TEXT NOT NULL, alamat TEXT, kota TEXT, status_member TEXT DEFAULT 'Non-Member', kode_id TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS layanan (id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, harga INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, pelanggan_id INTEGER, total_harga INTEGER NOT NULL, status TEXT DEFAULT 'Antrean', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (pelanggan_id) REFERENCES pelanggan(id))`);
    db.run(`CREATE TABLE IF NOT EXISTS order_details (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, layanan_id INTEGER, nama_layanan TEXT, nama_sepatu TEXT NOT NULL, harga_satuan INTEGER NOT NULL, FOREIGN KEY (order_id) REFERENCES orders(id))`);
});

// ==========================================
// ROUTING NOTA PUBLIK (Tanpa Login)
// ==========================================
app.get('/nota/:id', (req, res) => {
    const orderId = req.params.id;
    const query = `
    SELECT orders.*, pelanggan.nama, pelanggan.whatsapp, pelanggan.alamat, pelanggan.kota
    FROM orders
    JOIN pelanggan ON orders.pelanggan_id = pelanggan.id
    WHERE orders.id = ?`;

    db.get(query, [orderId], (err, order) => {
        if (!order) return res.send("Nota tidak ditemukan.");
        db.all("SELECT od.*, l.nama as nama_layanan_asli FROM order_details od LEFT JOIN layanan l ON od.layanan_id = l.id WHERE od.order_id = ?", [orderId], (err, details) => {
            res.render('nota-publik', { order, details });
        });
    });
});

// ==========================================
// ROUTING AUTHENTICATION
// ==========================================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'owner' && password === 'admin123') {
        req.session.user = { username: 'owner', role: 'owner' };
        res.redirect('/dashboard');
    } else if (username === 'karyawan' && password === 'kasir123') {
        req.session.user = { username: 'karyawan', role: 'karyawan' };
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Username atau Password salah!' });
    }
});
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});
app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('dashboard', { user: req.session.user });
});

// ==========================================
// ROUTING PELANGGAN & LAYANAN
// ==========================================
app.get('/pelanggan', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    db.all("SELECT * FROM pelanggan ORDER BY id DESC", [], (err, rows) => {
        res.render('pelanggan', { user: req.session.user, pelanggan: rows || [] });
    });
});
app.post('/pelanggan/tambah', (req, res) => {
    let { nama, whatsapp, alamat, kota, status_member, kode_id } = req.body;
    if (status_member === 'Non-Member') kode_id = null;
    db.run(`INSERT INTO pelanggan (nama, whatsapp, alamat, kota, status_member, kode_id) VALUES (?, ?, ?, ?, ?, ?)`,
           [nama, whatsapp, alamat, kota, status_member, kode_id], () => res.redirect('/pelanggan'));
});

app.get('/layanan', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'owner') return res.send("Akses Ditolak!");
    db.all("SELECT * FROM layanan ORDER BY nama ASC", [], (err, rows) => {
        res.render('layanan', { user: req.session.user, layanan: rows || [] });
    });
});
app.post('/layanan/tambah', (req, res) => {
    const { nama, harga } = req.body;
    db.run(`INSERT INTO layanan (nama, harga) VALUES (?, ?)`, [nama, harga], () => res.redirect('/layanan'));
});
app.get('/layanan/hapus/:id', (req, res) => {
    db.run(`DELETE FROM layanan WHERE id = ?`, [req.params.id], () => res.redirect('/layanan'));
});

// ==========================================
// ROUTING TRANSAKSI (ORDER BARU)
// ==========================================
app.get('/order', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    db.all("SELECT * FROM pelanggan ORDER BY nama ASC", [], (err, pRows) => {
        db.all("SELECT * FROM layanan ORDER BY nama ASC", [], (err, lRows) => {
            res.render('order', { user: req.session.user, pelanggan: pRows || [], layanan: lRows || [] });
        });
    });
});

app.post('/order/tambah', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { pelanggan_id, total_harga, services } = req.body;

    db.run(`INSERT INTO orders (pelanggan_id, total_harga, status) VALUES (?, ?, 'Antrean')`, [pelanggan_id, total_harga], function(err) {
        const orderId = this.lastID;
        const stmt = db.prepare(`INSERT INTO order_details (order_id, layanan_id, nama_layanan, nama_sepatu, harga_satuan) VALUES (?, ?, ?, ?, ?)`);

        // Loop ambil data layanan dari DB untuk nama_layanan yang akurat
        db.all("SELECT id, nama FROM layanan", [], (err, masterLayanan) => {
            for (const rk in services) {
                for (const sk in services[rk]) {
                    const item = services[rk][sk];
                    const namaLayanan = masterLayanan.find(l => l.id == item.layanan_id)?.nama || "Layanan Cuci";
                    stmt.run(orderId, item.layanan_id, namaLayanan, item.nama_sepatu, item.harga_satuan);
                }
            }
            stmt.finalize();

            // TRIGGER WA NOTA BARU
            db.get("SELECT nama, whatsapp FROM pelanggan WHERE id = ?", [pelanggan_id], (err, p) => {
                if (p) {
                    const msg = `*NOTA MASUK - ShoesCare*\nHalo Kak *${p.nama}*,\nSepatu Kakak sudah masuk antrean.\n\nCek nota digital:\nhttp://192.168.0.194:3000/nota/${orderId}\n\nTerima kasih!`;
                    sendWAMessage(p.whatsapp, msg);
                }
            });
            res.redirect('/dashboard');
        });
    });
});

// ==========================================
// ROUTING LIST ORDER & AUTO-WIPE
// ==========================================
app.get('/list-order', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    db.run(`DELETE FROM order_details WHERE order_id IN (SELECT id FROM orders WHERE status = 'Selesai' AND created_at <= datetime('now', '-30 days'))`, () => {
        db.run(`DELETE FROM orders WHERE status = 'Selesai' AND created_at <= datetime('now', '-30 days')`, () => {
            const query = `SELECT o.*, p.nama, p.whatsapp, p.kode_id FROM orders o JOIN pelanggan p ON o.pelanggan_id = p.id ORDER BY o.id DESC`;
            db.all(query, [], (err, oRows) => {
                db.all("SELECT * FROM order_details", [], (err, dRows) => {
                    res.render('list-order', { user: req.session.user, orders: oRows || [], details: dRows || [] });
                });
            });
        });
    });
});

app.get('/order/selesai/:id', (req, res) => {
    const orderId = req.params.id;
    db.run(`UPDATE orders SET status = 'Selesai' WHERE id = ?`, [orderId], () => {
        // TRIGGER WA SELESAI
        db.get(`SELECT o.id, p.nama, p.whatsapp FROM orders o JOIN pelanggan p ON o.pelanggan_id = p.id WHERE o.id = ?`, [orderId], (err, data) => {
            if (data) {
                const msg = `*SEPATU SELESAI - ShoesCare*\nHalo Kak *${data.nama}*,\nKabar gembira! Sepatu Kakak di nota *#ORD-${data.id}* sudah selesai dicuci dan siap diambil.\n\nSampai jumpa di toko!`;
                sendWAMessage(data.whatsapp, msg);
            }
        });
        res.redirect('/list-order');
    });
});

// ==========================================
// ROUTING LAPORAN
// ==========================================
app.get('/laporan', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'owner') return res.send("Akses Ditolak!");

    const qH = `SELECT SUM(total_harga) as total FROM orders WHERE status = 'Selesai' AND date(created_at, 'localtime') = date('now', 'localtime')`;
    const qB = `SELECT SUM(total_harga) as total FROM orders WHERE status = 'Selesai' AND strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')`;
    const qG = `SELECT date(created_at, 'localtime') as tanggal, SUM(total_harga) as pendapatan FROM orders WHERE status = 'Selesai' AND strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime') GROUP BY 1 ORDER BY 1 ASC`;
    const qT = `SELECT o.id, o.total_harga, o.created_at, p.nama, p.kode_id FROM orders o JOIN pelanggan p ON o.pelanggan_id = p.id WHERE o.status = 'Selesai' ORDER BY o.created_at DESC`;
    const qBr = `SELECT nama_layanan, COUNT(id) as jumlah FROM order_details WHERE order_id IN (SELECT id FROM orders WHERE status = 'Selesai' AND date(created_at, 'localtime') = date('now', 'localtime')) GROUP BY 1 ORDER BY 2 DESC`;

    db.get(qH, (err, rH) => {
        db.get(qB, (err, rB) => {
            db.all(qG, (err, rG) => {
                db.all(qT, (err, rT) => {
                    db.all(qBr, (err, rBr) => {
                        res.render('laporan', { user: req.session.user, hariIni: rH?.total || 0, bulanIni: rB?.total || 0, dataGrafik: JSON.stringify(rG || []), dataTabel: rT || [], layananHariIni: rBr || [] });
                    });
                });
            });
        });
    });
});

app.listen(PORT, () => console.log(`Server nyala di http://localhost:${PORT}`));
