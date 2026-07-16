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

function serializeStore(data) {
  return JSON.stringify(normalizeStore(data), null, 2);
}

// 内存常驻的单一权威数据副本。启动时（或首次访问时）从磁盘读取一次，此后
// 内存对象就是唯一权威数据源；withDataStoreMutation 负责异步原子落盘。
// loadDataDir 记录 memoryStore 对应的 DATA_DIR，DATA_DIR 变化（如测试切换临时
// 目录）时会重新读盘。lastSerialized 是上一次成功序列化的字符串，落盘时直接
// 用它写 .bak，不再从磁盘读回校验。
let memoryStore = null;
let loadedDataDir = null;
let lastSerialized = null;

function readStoreFromDisk() {
  ensureDataStore();
  const dataFile = getDataFilePath();
  return parseStore(fs.readFileSync(dataFile, 'utf8'), dataFile);
}

function ensureLoaded() {
  const dataDir = getDataDir();
  if (memoryStore && loadedDataDir === dataDir) return memoryStore;
  const data = readStoreFromDisk();
  memoryStore = data;
  loadedDataDir = dataDir;
  lastSerialized = serializeStore(data);
  return memoryStore;
}

// 返回内存中的权威数据对象。调用方不得在 withDataStoreMutation 之外对返回对象
// 做需要持久化的修改——那样的改动不会落盘。读路径上的 pruneExpiredSessions /
// ensureAdminUser（以及 requireSession 里删过期会话）属于幂等无害修改，可保留：
// 它们只在内存上生效，会在下一次 mutation 落盘时被顺带持久化。
function loadDataStore() {
  const data = ensureLoaded();
  pruneExpiredSessions(data);
  ensureAdminUser(data);
  return data;
}

// 同步落盘原语（仅供测试与初始化便捷使用）。保留原子 rename、.bak 备份、
// mode 600/700，并在覆盖前拒绝破坏磁盘上无法解析的现有文件。序列化失败时
// 先抛出、不触碰任何文件。成功后把内存权威副本与 lastSerialized 一并提交。
function saveDataStore(data) {
  const serialized = serializeStore(data);
  const dataFile = getDataFilePath();
  const backupFile = `${dataFile}.bak`;
  const suffix = `${process.pid}.${Date.now()}`;
  const tmpFile = `${dataFile}.${suffix}.tmp`;
  const backupTmpFile = `${backupFile}.${suffix}.tmp`;
  fs.mkdirSync(path.dirname(dataFile), { recursive: true, mode: 0o700 });

  try {
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

  memoryStore = data;
  loadedDataDir = getDataDir();
  lastSerialized = serialized;
}

// 异步原子落盘：序列化内存对象，先用上一次成功序列化的字符串写 .bak（不再从
// 磁盘读回），再 tmp 写入 + rename 覆盖主文件。序列化失败时先抛出、不触碰文件；
// 写入失败时主文件保持不变。成功后才更新 lastSerialized。
async function persistDataStore(data) {
  const serialized = serializeStore(data);
  const dataFile = getDataFilePath();
  const backupFile = `${dataFile}.bak`;
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tmpFile = `${dataFile}.${suffix}.tmp`;
  const backupTmpFile = `${backupFile}.${suffix}.tmp`;
  await fs.promises.mkdir(path.dirname(dataFile), { recursive: true, mode: 0o700 });

  try {
    if (lastSerialized !== null) {
      await fs.promises.writeFile(backupTmpFile, lastSerialized, { mode: 0o600 });
      await fs.promises.rename(backupTmpFile, backupFile);
    }
    await fs.promises.writeFile(tmpFile, serialized, { mode: 0o600 });
    await fs.promises.rename(tmpFile, dataFile);
  } catch (error) {
    for (const file of [tmpFile, backupTmpFile]) {
      try {
        await fs.promises.rm(file, { force: true });
      } catch {
        // Preserve the original persist error.
      }
    }
    throw error;
  }

  lastSerialized = serialized;
}

let dataStoreMutationQueue = Promise.resolve();

// 串行 promise 队列：一次只跑一个 mutation。fn 直接作用于内存权威对象，随后
// 异步原子落盘；落盘完成后 promise 才 resolve（计费持久性：响应不能先于扣费
// 落盘）。fn 或落盘抛错时，把内存回滚到上一次成功持久化的状态，避免半截修改
// 污染权威副本，并让队列继续处理后续 mutation。
function withDataStoreMutation(fn) {
  if (typeof fn !== 'function') return Promise.reject(new TypeError('Data store mutation must be a function'));

  const mutation = dataStoreMutationQueue.then(async () => {
    const data = loadDataStore();
    const rollback = lastSerialized;
    try {
      const result = await fn(data);
      await persistDataStore(data);
      return result;
    } catch (error) {
      if (rollback !== null) {
        memoryStore = normalizeStore(JSON.parse(rollback));
        loadedDataDir = getDataDir();
        lastSerialized = rollback;
      }
      throw error;
    }
  });
  dataStoreMutationQueue = mutation.catch(() => {});
  return mutation;
}

// 启动时读盘一次并确保管理员存在后落盘。此后内存副本是唯一权威数据源，
// 运行期不再感知外部对 app-data.json 的手工修改（修改数据文件必须先停服务）。
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
