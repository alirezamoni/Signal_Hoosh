/**
 * settings-db.js — تنظیمات سیستم
 */
const path = require('path');
const fs   = require('fs');

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

function load() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'));
  } catch(e) {}
  return {};
}

function save(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

function get(key, defaultVal) {
  return load()[key] ?? defaultVal;
}

function set(key, value) {
  const data = load();
  data[key] = value;
  save(data);
}

function getAll() { return load(); }

module.exports = { get, set, getAll };
