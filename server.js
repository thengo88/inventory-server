const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { Mutex } = require('async-mutex');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const http = require('http');
const { Server } = require("socket.io");
require('dotenv').config();

// Google APIs
const { google } = require('googleapis');
const sheets = google.sheets('v4');
const drive = google.drive('v3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 5000;

// ============================================================
// GOOGLE SHEETS & DRIVE AUTHENTICATION
// ============================================================
let auth;
try {
    // For local development with service account JSON file
    if (fs.existsSync(path.join(__dirname, 'service-account.json'))) {
        auth = new google.auth.GoogleAuth({
            keyFile: path.join(__dirname, 'service-account.json'),
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive.file',
            ],
        });
    }
    // For production deployment with environment variables
    else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive.file',
            ],
        });
    } else {
        console.warn('⚠️  Google credentials not found. Google Sheets sync will be disabled.');
    }
} catch (error) {
    console.error('❌ Error setting up Google Auth:', error.message);
}

const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// ============================================================
// CẤU HÌNH ĐƯỜNG DẪN
// ============================================================
const BASE_DIR = process.cwd();
const UPLOAD_DIR = path.join(BASE_DIR, 'uploads');
const DB_PATH = path.join(BASE_DIR, 'inventory.db');

// Tạo thư mục uploads nếu chưa có
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// --- UPLOAD ẢNH (Local fallback, sẽ upload lên Google Drive) ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, UPLOAD_DIR) },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + file.originalname) }
});
const upload = multer({ storage: storage });

// --- WEB & STATIC ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(session({
    secret: process.env.SESSION_SECRET || 'kho_secret_key_vip_123',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 * 24 }
}));

// --- GOOGLE SHEETS CONFIG ---
const SHEET_NAME = 'TonKho';
const HISTORY_SHEET_NAME = 'LichSu';
const EXCEL_HEADERS = ['SKU', 'TÊN SẢN PHẨM', 'VỊ TRÍ', 'SỐ LƯỢNG', 'HÌNH ẢNH'];
const HISTORY_HEADERS = ['THỜI GIAN', 'NGƯỜI DÙNG', 'HÀNH ĐỘNG', 'SKU', 'SỐ LƯỢNG', 'TỒN SAU KHI SỬA'];

const sheetsMutex = new Mutex();
app.use(bodyParser.json());

// KẾT NỐI DATABASE
const db = new sqlite3.Database(DB_PATH);

// ============================================================
// GOOGLE SHEETS FUNCTIONS
// ============================================================

/**
 * Upload file to Google Drive
 */
async function uploadToGoogleDrive(filePath, fileName) {
    console.log(`[DEBUG] Starting uploadToGoogleDrive: ${fileName}`);
    console.log(`[DEBUG] GOOGLE_DRIVE_FOLDER_ID: ${GOOGLE_DRIVE_FOLDER_ID}`);
    console.log(`[DEBUG] Auth initialized: ${!!auth}`);

    if (!auth || !GOOGLE_DRIVE_FOLDER_ID) {
        console.warn('⚠️  Google Drive not configured (Missing Auth or Folder ID)');
        return null;
    }

    try {
        const authClient = await auth.getClient();
        const fileMetadata = {
            name: fileName,
            parents: [GOOGLE_DRIVE_FOLDER_ID]
        };
        const media = {
            mimeType: 'image/jpeg',
            body: fs.createReadStream(filePath)
        };

        const response = await drive.files.create({
            auth: authClient,
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink, webContentLink'
        });

        // Make file publicly accessible
        await drive.permissions.create({
            auth: authClient,
            fileId: response.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });

        // Get direct link
        const file = await drive.files.get({
            auth: authClient,
            fileId: response.data.id,
            fields: 'webContentLink'
        });

        console.log('✅ Uploaded to Google Drive:', file.data.webContentLink);
        return file.data.webContentLink;
    } catch (error) {
        console.error('❌ Error uploading to Google Drive:', error.message);
        return null;
    }
}

/**
 * Read data from Google Sheets
 */
async function readFromGoogleSheets(sheetName) {
    if (!auth || !GOOGLE_SHEETS_ID) {
        console.warn('⚠️  Google Sheets not configured');
        return [];
    }

    try {
        const authClient = await auth.getClient();
        const response = await sheets.spreadsheets.values.get({
            auth: authClient,
            spreadsheetId: GOOGLE_SHEETS_ID,
            range: `${sheetName}!A2:Z1000`, // Skip header row
        });

        return response.data.values || [];
    } catch (error) {
        console.error(`❌ Error reading from Google Sheets (${sheetName}):`, error.message);
        return [];
    }
}

/**
 * Write data to Google Sheets
 */
async function writeToGoogleSheets(sheetName, headers, data) {
    if (!auth || !GOOGLE_SHEETS_ID) {
        console.warn('⚠️  Google Sheets not configured, skipping sync');
        return;
    }

    const release = await sheetsMutex.acquire();
    try {
        const authClient = await auth.getClient();

        // Clear existing data
        await sheets.spreadsheets.values.clear({
            auth: authClient,
            spreadsheetId: GOOGLE_SHEETS_ID,
            range: `${sheetName}!A1:Z1000`,
        });

        // Prepare data with headers
        const values = [headers, ...data];

        // Write new data
        await sheets.spreadsheets.values.update({
            auth: authClient,
            spreadsheetId: GOOGLE_SHEETS_ID,
            range: `${sheetName}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values },
        });

        console.log(`✅ Synced to Google Sheets: ${sheetName} (${data.length} rows)`);
        release();
    } catch (error) {
        console.error(`❌ Error writing to Google Sheets (${sheetName}):`, error.message);
        release();
    }
}

/**
 * Sync database to Google Sheets (background)
 */
async function syncDbToGoogleSheets() {
    try {
        // Get products
        const products = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM products", [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // Get logs
        const logs = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM logs ORDER BY id DESC LIMIT 1000", [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // Prepare products data
        const productData = products.map(p => [
            p.sku,
            p.name,
            p.location || '',
            p.quantity,
            p.image || ''
        ]);

        // Prepare logs data
        const logData = logs.map(l => [
            l.timestamp,
            l.user,
            l.action,
            l.sku,
            l.quantity,
            l.balance
        ]);

        // Write to Google Sheets
        await writeToGoogleSheets(SHEET_NAME, EXCEL_HEADERS, productData);
        await writeToGoogleSheets(HISTORY_SHEET_NAME, HISTORY_HEADERS, logData);

        // Notify web admin
        io.emit('data_updated');
    } catch (error) {
        console.error('❌ Error syncing to Google Sheets:', error.message);
    }
}

/**
 * Sync Google Sheets to Database on startup
 */
async function syncGoogleSheetsToDb() {
    try {
        const count = await new Promise((resolve, reject) => {
            db.get("SELECT count(*) as count FROM products", (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        // Only import if database is empty
        if (count === 0) {
            const data = await readFromGoogleSheets(SHEET_NAME);

            if (data.length > 0) {
                const stmt = db.prepare("INSERT OR REPLACE INTO products (sku, name, location, quantity, image) VALUES (?, ?, ?, ?, ?)");

                for (const row of data) {
                    if (row[0]) { // SKU exists
                        stmt.run(
                            String(row[0]),
                            row[1] || '',
                            row[2] || '',
                            parseInt(row[3]) || 0,
                            row[4] || ''
                        );
                    }
                }

                stmt.finalize();
                console.log(`✅ Imported ${data.length} products from Google Sheets`);
            }
        }
    } catch (error) {
        console.error('❌ Error syncing Google Sheets to DB:', error.message);
    }
}

// ============================================================
// DATABASE INIT
// ============================================================
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY, name TEXT, location TEXT, quantity INTEGER, image TEXT
    )`, (err) => {
        if (!err) {
            db.run("ALTER TABLE products ADD COLUMN location TEXT", () => { });
            db.run("ALTER TABLE products ADD COLUMN image TEXT", () => { });
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, user TEXT, action TEXT, sku TEXT, quantity INTEGER, balance INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT)`, (err) => {
        if (!err) createDefaultAdmin();
    });
});

// --- HÀM HỖ TRỢ ---
function createDefaultAdmin() {
    db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
        if (!row) {
            const hash = bcrypt.hashSync('admin123', 10);
            db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['admin', hash, 'admin']);
            console.log("✅ Đã tạo Admin: admin / admin123");
        }
    });
    syncGoogleSheetsToDb();
}

function logTransaction(user, action, sku, qty, newBalance) {
    const stmt = db.prepare("INSERT INTO logs (user, action, sku, quantity, balance) VALUES (?, ?, ?, ?, ?)");
    stmt.run(user || 'Ẩn danh', action, sku, qty, newBalance);
    stmt.finalize();
}

// ============================================================
// WEB ADMIN ROUTES
// ============================================================

app.get('/admin', (req, res) => {
    if (req.session.user) return res.redirect('/admin/dashboard');
    res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) {
            if (user.role === 'admin') {
                req.session.user = user;
                return res.redirect('/admin/dashboard');
            } else return res.render('login', { error: 'Không có quyền Admin' });
        }
        res.render('login', { error: 'Sai tài khoản hoặc mật khẩu' });
    });
});

app.get('/admin/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    db.all("SELECT username, role FROM users", [], (err, users) => {
        db.all("SELECT * FROM products", [], (err, products) => {
            res.render('dashboard', { users: users, products: products, user: req.session.user });
        });
    });
});

app.get('/admin/history', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    db.all("SELECT * FROM logs ORDER BY id DESC LIMIT 2000", [], (err, rows) => {
        if (err) return res.redirect('/admin/dashboard');
        res.render('history', { logs: rows, user: req.session.user });
    });
});

app.get('/admin/download', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    if (GOOGLE_SHEETS_ID) {
        res.redirect(`https://docs.google.com/spreadsheets/d/${GOOGLE_SHEETS_ID}/export?format=xlsx`);
    } else {
        res.send('Google Sheets chưa được cấu hình.');
    }
});

app.post('/admin/users/create', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    const { username, password, role } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, hash, role], () => res.redirect('/admin/dashboard'));
});

app.post('/admin/products/create', upload.single('productImage'), async (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    console.log('[DEBUG] POST /admin/products/create');
    console.log('[DEBUG] req.file:', req.file);

    const { sku, name, location, quantity } = req.body;

    let imagePath = '';
    if (req.file) {
        // Upload to Google Drive
        const driveLink = await uploadToGoogleDrive(req.file.path, req.file.filename);
        imagePath = driveLink || `/uploads/${req.file.filename}`;
        console.log(`[DEBUG] Final imagePath: ${imagePath}`);
    }

    const sql = "INSERT OR REPLACE INTO products (sku, name, location, quantity, image) VALUES (?, ?, ?, ?, ?)";
    db.run(sql, [sku, name, location, parseInt(quantity) || 0, imagePath], () => {
        syncDbToGoogleSheets();
        res.redirect('/admin/dashboard');
    });
});

app.get('/admin/products/edit/:sku', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    db.get("SELECT * FROM products WHERE sku = ?", [req.params.sku], (err, row) => {
        if (err || !row) return res.redirect('/admin/dashboard');
        res.render('edit_product', { product: row });
    });
});

app.post('/admin/products/edit/:sku', upload.single('productImage'), async (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    console.log(`[DEBUG] POST /admin/products/edit/${req.params.sku}`);
    console.log('[DEBUG] req.file:', req.file);

    const sku = req.params.sku;
    const { name, location, quantity } = req.body;

    db.get("SELECT image FROM products WHERE sku = ?", [sku], async (err, row) => {
        let newImage = row ? row.image : '';

        if (req.file) {
            const driveLink = await uploadToGoogleDrive(req.file.path, req.file.filename);
            newImage = driveLink || `/uploads/${req.file.filename}`;
            console.log(`[DEBUG] Final newImage: ${newImage}`);
        }

        db.run("UPDATE products SET name = ?, location = ?, quantity = ?, image = ? WHERE sku = ?", [name, location, parseInt(quantity) || 0, newImage, sku], () => {
            syncDbToGoogleSheets();
            res.redirect('/admin/dashboard');
        });
    });
});

app.get('/admin/users/edit/:username', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    db.get("SELECT * FROM users WHERE username = ?", [req.params.username], (err, row) => {
        if (err || !row) return res.redirect('/admin/dashboard');
        res.render('edit_user', { user_edit: row });
    });
});

app.post('/admin/users/edit/:username', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    const username = req.params.username;
    const { password, role } = req.body;
    if (password && password.trim() !== "") {
        const hash = bcrypt.hashSync(password, 10);
        db.run("UPDATE users SET password = ?, role = ? WHERE username = ?", [hash, role, username], () => res.redirect('/admin/dashboard'));
    } else {
        db.run("UPDATE users SET role = ? WHERE username = ?", [role, username], () => res.redirect('/admin/dashboard'));
    }
});

app.get('/admin/products/delete/:sku', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    db.run("DELETE FROM products WHERE sku = ?", [req.params.sku], () => {
        syncDbToGoogleSheets();
        res.redirect('/admin/dashboard');
    });
});

app.get('/admin/users/delete/:username', (req, res) => {
    if (!req.session.user) return res.redirect('/admin');
    if (req.params.username !== 'admin') db.run("DELETE FROM users WHERE username = ?", [req.params.username], () => res.redirect('/admin/dashboard'));
    else res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin'); });

// ============================================================
// API ROUTES (FLUTTER APP)
// ============================================================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (user && bcrypt.compareSync(password, user.password)) res.json({ status: 'success', message: 'OK', role: user.role });
        else res.status(401).json({ status: 'error', message: 'Sai thông tin' });
    });
});

app.get('/get_inventory', (req, res) => {
    db.all("SELECT * FROM products", [], (err, rows) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json({ status: 'success', inventory: rows });
    });
});

app.post('/update_inventory', (req, res) => {
    const { sku, quantity, is_inbound, name, user, location } = req.body;
    if (!sku) return res.status(400).json({ message: 'Thiếu SKU.' });
    const qty = parseInt(quantity) || 0;
    const sanitizedSku = String(sku).trim();

    db.get("SELECT * FROM products WHERE sku = ?", [sanitizedSku], (err, row) => {
        let newQty = 0;
        let currentQty = row ? row.quantity : 0;
        let currentName = row ? row.name : (name || `SP ${sanitizedSku}`);
        let currentLocation = location ? location : (row ? row.location : '');
        let currentImage = row ? row.image : '';

        if (is_inbound) newQty = currentQty + qty;
        else {
            if (currentQty < qty) return res.status(400).json({ message: `Không đủ hàng.` });
            newQty = currentQty - qty;
        }

        const sql = "INSERT OR REPLACE INTO products (sku, name, location, quantity, image) VALUES (?, ?, ?, ?, ?)";
        db.run(sql, [sanitizedSku, currentName, currentLocation, newQty, currentImage], function (err) {
            if (err) return res.status(500).json({ message: err.message });
            logTransaction(user, is_inbound ? 'NHẬP' : 'XUẤT', sanitizedSku, qty, newQty);
            syncDbToGoogleSheets();
            res.json({ status: 'success', message: `Thành công.` });
        });
    });
});

app.delete('/delete_inventory/:sku', (req, res) => {
    db.run("DELETE FROM products WHERE sku = ?", [req.params.sku], function (err) {
        logTransaction(req.query.user, 'XÓA SP', req.params.sku, 0, 0);
        syncDbToGoogleSheets();
        res.json({ status: 'success', message: `Đã xóa.` });
    });
});

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) return alias.address;
        }
    }
    return '0.0.0.0';
}

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log(`🚀 Server đang chạy tại: http://${ip}:${PORT}/admin`);
    console.log(`📊 Google Sheets ID: ${GOOGLE_SHEETS_ID || 'Chưa cấu hình'}`);
    console.log(`📁 Google Drive Folder: ${GOOGLE_DRIVE_FOLDER_ID || 'Chưa cấu hình'}`);
});
