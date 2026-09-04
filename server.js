/**
 * 飞机旅行 · 局域网联机服务器
 * 用法：node server.js [端口]  默认端口 8000
 * 同一局域网设备访问：http://本机IP:8000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT, 10) || parseInt(process.argv[2], 10) || 8000;
const ROOT = __dirname;

// ===== 云端数据存储（JSON文件） =====
const DATA_DIR = path.join(ROOT, 'server_data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
if (!fs.existsSync(LEADERBOARD_FILE)) fs.writeFileSync(LEADERBOARD_FILE, '[]');
if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '{}');

// ===== Redis 云端持久化（Render Key Value 免费数据库） =====
// 云端默认连接 Render 内部 Redis；无可用 Redis 时自动回落本地 JSON 文件
const REDIS_URL = process.env.REDIS_URL || 'redis://red-dad34v67bikc739fif40:6379';
let redisClient = null;
let redisReady = false;
try {
  const { createClient } = require('redis');
  if (REDIS_URL) {
    redisClient = createClient({
      url: REDIS_URL,
      socket: { connectTimeout: 8000, reconnectStrategy: (r) => Math.min(r * 300, 5000) }
    });
    redisClient.on('error', () => { redisReady = false; });
  }
} catch (e) { redisClient = null; }

function redisKey(file) { return 'feiji:' + path.basename(file); }

const _cache = {};
async function warmRedisCache() {
  if (!redisClient) return;
  try {
    await redisClient.connect();
    redisReady = true;
    for (const f of [USERS_FILE, LEADERBOARD_FILE, ACCOUNTS_FILE]) {
      try {
        const val = await redisClient.get(redisKey(f));
        if (val) _cache[f] = JSON.parse(val);
      } catch (e) {}
    }
    console.log('[Redis] 云端数据库已连接，存档缓存加载完成');
  } catch (e) {
    console.log('[Redis] 连接失败，使用本地文件存储: ' + e.message);
    redisReady = false;
  }
}

// 简单的密码哈希（使用Node.js内置crypto）
const crypto = require('crypto');
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function readJSON(file) {
  if (Object.prototype.hasOwnProperty.call(_cache, file)) return _cache[file];
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    _cache[file] = d;
    return d;
  } catch(e) { return {}; }
}
function writeJSON(file, data) {
  _cache[file] = data;
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
  // 同步到云端 Redis（确保重启后数据不丢）
  if (redisClient && redisReady) {
    redisClient.set(redisKey(file), JSON.stringify(data)).catch(() => {});
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ===== 静态文件服务（提供游戏页面） =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive'
};

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const query = new URLSearchParams(req.url.split('?')[1] || '');

  // ===== API 路由 =====
  // 账号注册接口
  if (urlPath === '/api/register' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const username = (body.username || '').trim();
      const password = body.password || '';
      if (!username || username.length < 2) { sendJSON(res, 400, { error: '用户名至少2个字符' }); return; }
      if (!password || password.length < 4) { sendJSON(res, 400, { error: '密码至少4个字符' }); return; }
      if (username.length > 20) { sendJSON(res, 400, { error: '用户名最多20个字符' }); return; }
      if (password.length > 50) { sendJSON(res, 400, { error: '密码最多50个字符' }); return; }
      
      const accounts = readJSON(ACCOUNTS_FILE);
      if (accounts[username]) { sendJSON(res, 409, { error: '用户名已存在' }); return; }
      
      const salt = generateSalt();
      const passwordHash = hashPassword(password, salt);
      accounts[username] = {
        username,
        passwordHash,
        salt,
        regDate: new Date().toISOString(),
        lastLogin: null,
        loginCount: 0
      };
      writeJSON(ACCOUNTS_FILE, accounts);
      sendJSON(res, 200, { success: true, message: '注册成功', username });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }
  
  // 账号登录接口
  if (urlPath === '/api/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const username = (body.username || '').trim();
      const password = body.password || '';
      if (!username || !password) { sendJSON(res, 400, { error: '用户名和密码不能为空' }); return; }
      
      const accounts = readJSON(ACCOUNTS_FILE);
      const account = accounts[username];
      if (!account) { sendJSON(res, 401, { error: '用户名不存在' }); return; }
      
      const passwordHash = hashPassword(password, account.salt);
      if (passwordHash !== account.passwordHash) { sendJSON(res, 401, { error: '密码错误' }); return; }
      
      // 更新登录信息
      account.lastLogin = new Date().toISOString();
      account.loginCount = (account.loginCount || 0) + 1;
      writeJSON(ACCOUNTS_FILE, accounts);
      
      sendJSON(res, 200, { 
        success: true, 
        message: '登录成功', 
        username,
        regDate: account.regDate,
        loginCount: account.loginCount
      });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }
  
  // 版本检查接口
  if (urlPath === '/api/version' && req.method === 'GET') {
    try {
      const versionFile = path.join(ROOT, 'version.json');
      if (fs.existsSync(versionFile)) {
        const versionData = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
        sendJSON(res, 200, versionData);
      } else {
        sendJSON(res, 404, { error: '版本信息文件不存在' });
      }
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // 保存用户数据到云端
  if (urlPath === '/api/save' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const username = (body.username || '').trim();
      if (!username) { sendJSON(res, 400, { error: '用户名不能为空' }); return; }
      const users = readJSON(USERS_FILE);
      users[username] = {
        data: body.data || {},
        updatedAt: Date.now()
      };
      writeJSON(USERS_FILE, users);
      sendJSON(res, 200, { success: true, message: '数据已保存到云端' });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // 从云端读取用户数据
  if (urlPath === '/api/load' && req.method === 'GET') {
    const username = (query.get('username') || '').trim();
    if (!username) { sendJSON(res, 400, { error: '用户名不能为空' }); return; }
    const users = readJSON(USERS_FILE);
    const user = users[username];
    if (user) {
      sendJSON(res, 200, { success: true, data: user.data, updatedAt: user.updatedAt });
    } else {
      sendJSON(res, 200, { success: true, data: null, message: '云端暂无数据' });
    }
    return;
  }

  // 提交排行榜成绩
  if (urlPath === '/api/leaderboard' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const username = (body.username || '').trim();
      if (!username) { sendJSON(res, 400, { error: '用户名不能为空' }); return; }
      const score = parseInt(body.score, 10) || 0;
      const level = parseInt(body.level, 10) || 0;
      const kills = parseInt(body.kills, 10) || 0;
      const leaderboard = readJSON(LEADERBOARD_FILE);
      // 查找该用户是否已有记录，取最高分
      const existing = leaderboard.findIndex(e => e.username === username);
      const entry = { username, score, level, kills, updatedAt: Date.now() };
      if (existing >= 0) {
        if (score > leaderboard[existing].score) {
          leaderboard[existing] = entry;
        }
      } else {
        leaderboard.push(entry);
      }
      // 按分数排序，保留前100名
      leaderboard.sort((a, b) => b.score - a.score);
      const top100 = leaderboard.slice(0, 100);
      writeJSON(LEADERBOARD_FILE, top100);
      sendJSON(res, 200, { success: true, message: '成绩已上传', rank: top100.findIndex(e => e.username === username) + 1 });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // 获取排行榜
  if (urlPath === '/api/leaderboard' && req.method === 'GET') {
    const leaderboard = readJSON(LEADERBOARD_FILE);
    sendJSON(res, 200, { success: true, leaderboard: leaderboard.slice(0, 50) });
    return;
  }

  // ===== 静态文件服务 =====
  let filePath = urlPath;
  if (filePath === '/') filePath = '/index.html';
  // 防止路径穿越
  const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(ROOT, safePath);
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ===== WebSocket 联机服务器 =====
const wss = new WebSocket.Server({ server });

// 房间表：code -> { host: ws, guest: ws|null, hostName, guestName, createdAt }
const rooms = new Map();

// 生成6位房间码
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ===== 匹配联机队列 =====
const matchQueue = []; // [{ ws, name, mode, createdAt }]

function removeFromQueue(ws) {
  const idx = matchQueue.findIndex(q => q.ws === ws);
  if (idx >= 0) { matchQueue.splice(idx, 1); return true; }
  return false;
}
function tryMatchPair() {
  if (matchQueue.length < 2) return;
  // 按模式分组配对（只有相同模式才能配对：合作coop / PvP对战pvp）
  const groups = {};
  matchQueue.forEach(q => {
    const m = q.mode || 'coop';
    if (!groups[m]) groups[m] = [];
    groups[m].push(q);
  });
  Object.keys(groups).forEach(mode => {
    const list = groups[mode];
    while (list.length >= 2) {
      const p1 = list.shift();
      const p2 = list.shift();
      removeFromQueue(p1.ws);
      removeFromQueue(p2.ws);
      const code = genRoomCode();
      rooms.set(code, { host: p1.ws, guest: p2.ws, hostName: p1.name, guestName: p2.name, mode: mode, createdAt: Date.now() });
      p1.ws.roomCode = code; p1.ws.isHost = true;
      p2.ws.roomCode = code; p2.ws.isHost = false;
      send(p1.ws, { type: 'matched', code: code, role: 'host', opponent: p2.name, mode: mode });
      send(p2.ws, { type: 'matched', code: code, role: 'client', opponent: p1.name, mode: mode });
      console.log('[' + new Date().toLocaleTimeString() + '] 🎯 匹配成功 ' + code + ' [' + mode + '] (' + p1.name + ' vs ' + p2.name + ')');
    }
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch(e) { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      // 创建房间
      case 'create': {
        if (ws.roomCode) return;
        const code = genRoomCode();
        rooms.set(code, { host: ws, guest: null, hostName: msg.name || '玩家', guestName: null, createdAt: Date.now() });
        ws.roomCode = code;
        ws.isHost = true;
        send(ws, { type: 'created', code: code });
        console.log('[' + new Date().toLocaleTimeString() + '] 创建房间 ' + code + ' (' + (msg.name || '玩家') + ')');
        break;
      }
      // 加入房间
      case 'join': {
        const code = (msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', msg: '房间不存在，请检查房间码' });
          return;
        }
        if (room.guest) {
          send(ws, { type: 'error', msg: '房间已满，无法加入' });
          return;
        }
        if (room.host === ws) { send(ws, { type: 'error', msg: '你已在房间中' }); return; }
        room.guest = ws;
        ws.roomCode = code;
        ws.isHost = false;
        room.guestName = msg.name || '玩家2';
        send(ws, { type: 'joined', code: code });
        // 通知主机有玩家加入
        send(room.host, { type: 'guest_joined', name: room.guestName });
        console.log('[' + new Date().toLocaleTimeString() + '] 玩家 (' + room.guestName + ') 加入房间 ' + code);
        break;
      }
      // 主机广播游戏状态给客户端
      case 'state': {
        const room = rooms.get(ws.roomCode);
        if (room && ws === room.host && room.guest) {
          send(room.guest, { type: 'state', data: msg.data });
        }
        break;
      }
      // 客户端操作转发给主机
      case 'op': {
        const room = rooms.get(ws.roomCode);
        if (room && ws === room.guest && room.host) {
          send(room.host, { type: 'op', data: msg.data });
        }
        break;
      }
      // 聊天 / 通用消息
      case 'chat': {
        const room = rooms.get(ws.roomCode);
        if (!room) break;
        const target = (ws === room.host) ? room.guest : room.host;
        send(target, { type: 'chat', data: msg.data });
        break;
      }
      // 匹配联机：加入匹配队列
      case 'match': {
        if (ws.roomCode) { send(ws, { type: 'error', msg: '你已在房间中' }); break; }
        removeFromQueue(ws);
        matchQueue.push({ ws, name: msg.name || '玩家', mode: msg.mode || 'coop', createdAt: Date.now() });
        send(ws, { type: 'match_waiting', queue: matchQueue.length, mode: msg.mode || 'coop' });
        console.log('[' + new Date().toLocaleTimeString() + '] 🎯 ' + (msg.name || '玩家') + ' 进入匹配队列（当前 ' + matchQueue.length + ' 人）');
        tryMatchPair();
        break;
      }
      // 取消匹配
      case 'match_cancel': {
        if (removeFromQueue(ws)) {
          console.log('[' + new Date().toLocaleTimeString() + '] 玩家取消匹配');
        }
        break;
      }
    }
  });

  // 断开连接
  ws.on('close', () => {
    removeFromQueue(ws); // 先从匹配队列移除
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (ws === room.host) {
      // 主机离开 → 房间销毁，通知客户端
      if (room.guest) send(room.guest, { type: 'host_left' });
      rooms.delete(code);
      console.log('[' + new Date().toLocaleTimeString() + '] 主机离开，房间 ' + code + ' 关闭');
    } else if (ws === room.guest) {
      room.guest = null;
      room.guestName = null;
      send(room.host, { type: 'guest_left' });
      console.log('[' + new Date().toLocaleTimeString() + '] 玩家离开房间 ' + code);
    }
  });
});

// 心跳保活
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// 自动清理超时空房间（10分钟无客户端）
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (now - room.createdAt > 10 * 60 * 1000 && !room.guest) {
      rooms.delete(code);
    }
  });
}, 60000);

// 匹配超时清理（60秒未匹配到，通知客户端自动AI陪玩）
setInterval(() => {
  const now = Date.now();
  for (let i = matchQueue.length - 1; i >= 0; i--) {
    if (now - matchQueue[i].createdAt > 60 * 1000) {
      send(matchQueue[i].ws, { type: 'match_timeout' });
      matchQueue.splice(i, 1);
      console.log('[' + new Date().toLocaleTimeString() + '] 匹配超时，移除玩家');
    }
  }
}, 5000);

function getIPs() {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

(async () => {
  if (redisClient) await warmRedisCache();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('==============================================');
    console.log(' 飞机旅行 · 联机服务器已启动' + (redisReady ? '（云端数据库已连接）' : '（本地文件存储）'));
    console.log('----------------------------------------------');
    console.log(' 本机访问: http://localhost:' + PORT);
    getIPs().forEach(ip => {
      console.log(' 局域网访问: http://' + ip + ':' + PORT);
    });
    console.log(' 其他设备连同一WiFi，浏览器打开上方局域网地址即可');
    console.log(' 房间码由游戏内创建/加入生成');
    console.log('==============================================');
  });
})();
