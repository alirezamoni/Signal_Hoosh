/**
 * db.js — مدیریت کاربران با فایل JSON
 * (بدون نیاز به نصب دیتابیس)
 */

const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'data', 'users.json');

// ── Bootstrap ────────────────────────────────────────────
function ensureDB() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

function readDB() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── User ops ─────────────────────────────────────────────
function getAllUsers() {
  return readDB().users.map(u => ({ ...u, password: undefined }));
}

function findByMobile(mobile) {
  return readDB().users.find(u => u.mobile === mobile) || null;
}

function findById(id) {
  const u = readDB().users.find(u => u.id === id);
  return u ? { ...u, password: undefined } : null;
}

function createUser({ mobile, password, name, role = 'user' }) {
  const db = readDB();
  if (db.users.find(u => u.mobile === mobile)) {
    throw new Error('این شماره موبایل قبلاً ثبت شده');
  }
  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id:        Date.now().toString(),
    mobile,
    password:  hash,
    name:      name || mobile,
    role,      // 'superadmin' | 'user'
    createdAt: new Date().toISOString(),
    active:    true,
  };
  db.users.push(user);
  writeDB(db);
  return { ...user, password: undefined };
}

function deleteUser(id) {
  const db = readDB();
  const idx = db.users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('کاربر یافت نشد');
  db.users.splice(idx, 1);
  writeDB(db);
}

function toggleActive(id, active) {
  const db = readDB();
  const u = db.users.find(u => u.id === id);
  if (!u) throw new Error('کاربر یافت نشد');
  u.active = active;
  writeDB(db);
  return { ...u, password: undefined };
}

function verifyPassword(mobile, password) {
  const user = findByMobile(mobile);
  if (!user || !user.active) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  return { ...user, password: undefined };
}

// ── Seed superadmin if no users exist ────────────────────
function seedSuperAdmin() {
  const db = readDB();
  if (db.users.length === 0) {
    const ADMIN_MOBILE = process.env.ADMIN_MOBILE;
    const ADMIN_PASS   = process.env.ADMIN_PASS || require('crypto').randomBytes(12).toString('base64');
    if (!ADMIN_MOBILE) {
      console.error('\n✗ ADMIN_MOBILE در .env ست نشده — سوپرادمین اولیه ساخته نشد.\n');
      return;
    }
    createUser({ mobile: ADMIN_MOBILE, password: ADMIN_PASS, name: 'سوپر ادمین', role: 'superadmin' });
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  سوپرادمین پیش‌فرض ایجاد شد         ║`);
    console.log(`║  موبایل: ${ADMIN_MOBILE}              ║`);
    console.log(`║  پسورد:  ${ADMIN_PASS}           ║`);
    console.log(`║  ⚠️  بلافاصله پسورد را تغییر دهید   ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
  }
}

module.exports = { getAllUsers, findByMobile, findById, createUser, deleteUser, toggleActive, verifyPassword, seedSuperAdmin };
