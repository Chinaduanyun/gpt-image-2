const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./constants');
const { normalizeEmail, nowIso } = require('./common');

function getDataDir() {
  return process.env.DATA_DIR || path.join(ROOT, '.data');
}

function getDataFilePath() {
  return path.join(getDataDir(), 'app-data.json');
}

function getImageStoreDir() {
  return path.join(getDataDir(), 'images');
}

function emptyStore() {
  return { version: 1, users: {}, sessions: {}, spendLogs: [] };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStore(data) {
  if (!isRecord(data)) throw new Error('root must be an object');
  if (data.version !== 1) throw new Error('version must be 1');
  if (!isRecord(data.users)) throw new Error('users must be an object');
  if (!isRecord(data.sessions)) throw new Error('sessions must be an object');
  if (!Array.isArray(data.spendLogs)) throw new Error('spendLogs must be an array');
  return data;
}

function parseStore(contents, dataFile) {
  let data;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid data store JSON at ${dataFile}: ${error.message}`, { cause: error });
  }

  try {
    return validateStore(data);
  } catch (error) {
    throw new Error(`Invalid data store at ${dataFile}: ${error.message}`, { cause: error });
  }
}

function normalizeStore(data) {
  return {
    version: 1,
    users: data?.users && typeof data.users === 'object' ? data.users : {},
    sessions: data?.sessions && typeof data.sessions === 'object' ? data.sessions : {},
    spendLogs: Array.isArray(data?.spendLogs) ? data.spendLogs : []
  };
}

function ensureDataStore() {
  const dataDir = getDataDir();
  const dataFile = getDataFilePath();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(emptyStore(), null, 2), { mode: 0o600 });
  }
}

function pruneExpiredSessions(data) {
  const now = Date.now();
  for (const [token, session] of Object.entries(data.sessions)) {
    if (!session?.expiresAt || Date.parse(session.expiresAt) <= now) {
      delete data.sessions[token];
    }
  }
}

function ensureAdminUser(data) {
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  if (!adminEmail) return false;

  const existing = data.users[adminEmail];
  const timestamp = nowIso();
  if (existing) {
    const changed = existing.isAdmin !== true || existing.active !== true;
    existing.isAdmin = true;
    existing.active = true;
    existing.updatedAt = changed ? timestamp : existing.updatedAt;
    return changed;
  }

  data.users[adminEmail] = {
    email: adminEmail,
    name: '管理员',
    active: true,
    isAdmin: true,
    balanceMicros: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  return true;
}

function loadDataStore() {
  ensureDataStore();
  const dataFile = getDataFilePath();
  const data = parseStore(fs.readFileSync(dataFile, 'utf8'), dataFile);
  pruneExpiredSessions(data);
  ensureAdminUser(data);
  return data;
}

function saveDataStore(data) {
  const dataFile = getDataFilePath();
  const backupFile = `${dataFile}.bak`;
  const suffix = `${process.pid}.${Date.now()}`;
  const tmpFile = `${dataFile}.${suffix}.tmp`;
  const backupTmpFile = `${backupFile}.${suffix}.tmp`;
  fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });

  try {
    const serialized = JSON.stringify(normalizeStore(data), null, 2);
    if (fs.existsSync(dataFile)) {
      const currentContents = fs.readFileSync(dataFile, 'utf8');
      try {
        parseStore(currentContents, dataFile);
      } catch (error) {
        throw new Error(`Refusing to overwrite invalid data store: ${error.message}`, { cause: error });
      }
      fs.writeFileSync(backupTmpFile, currentContents, { mode: 0o600 });
      fs.renameSync(backupTmpFile, backupFile);
    }
    fs.writeFileSync(tmpFile, serialized, { mode: 0o600 });
    fs.renameSync(tmpFile, dataFile);
  } catch (error) {
    for (const file of [tmpFile, backupTmpFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Preserve the original save error.
      }
    }
    throw error;
  }
}

let dataStoreMutationQueue = Promise.resolve();

function withDataStoreMutation(fn) {
  if (typeof fn !== 'function') return Promise.reject(new TypeError('Data store mutation must be a function'));

  const mutation = dataStoreMutationQueue.then(async () => {
    const data = loadDataStore();
    pruneExpiredSessions(data);
    ensureAdminUser(data);
    const result = await fn(data);
    saveDataStore(data);
    return result;
  });
  dataStoreMutationQueue = mutation.catch(() => {});
  return mutation;
}

function initializeDataStore() {
  return withDataStoreMutation(() => {});
}

module.exports = {
  getDataDir,
  getDataFilePath,
  getImageStoreDir,
  emptyStore,
  normalizeStore,
  ensureDataStore,
  pruneExpiredSessions,
  ensureAdminUser,
  loadDataStore,
  saveDataStore,
  withDataStoreMutation,
  initializeDataStore
};
