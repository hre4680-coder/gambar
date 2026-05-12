const express = require('express');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'game_rahasia_lomba_gambar',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// ========== DATABASE POSTGRESQL ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE,
        host_id INTEGER REFERENCES users(id),
        status TEXT DEFAULT 'waiting',
        theme TEXT DEFAULT 'Bebas',
        drawing_duration INTEGER DEFAULT 90,
        rating_duration INTEGER DEFAULT 60,
        drawing_end_time BIGINT,
        rating_end_time BIGINT,
        winner_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS game_participants (
        game_id INTEGER REFERENCES games(id),
        user_id INTEGER REFERENCES users(id),
        PRIMARY KEY (game_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS drawings (
        id SERIAL PRIMARY KEY,
        game_id INTEGER REFERENCES games(id),
        user_id INTEGER REFERENCES users(id),
        image_data TEXT,
        submitted_at BIGINT
      );
      CREATE TABLE IF NOT EXISTS ratings (
        id SERIAL PRIMARY KEY,
        drawing_id INTEGER REFERENCES drawings(id),
        user_id INTEGER REFERENCES users(id),
        rating_value INTEGER,
        UNIQUE(drawing_id, user_id)
      );
    `);
    console.log('Database tables ready');
  } catch (err) {
    console.error('Database init error:', err);
  } finally {
    client.release();
  }
}
initDb();

function generateGameCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ========== Rute ==========
app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password harus diisi' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hash]);
    res.json({ success: true, message: 'Registrasi berhasil' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: 'Username sudah terdaftar' });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password harus diisi' });
  }
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) {
    return res.status(401).json({ success: false, message: 'Username tidak ditemukan' });
  }
  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ success: false, message: 'Password salah' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, message: 'Login berhasil' });
});

app.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.post('/create-game', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: 'Harus login' });
  }
  const code = generateGameCode();
  const drawingDuration = parseInt(req.body.drawingDuration) || 90;
  const ratingDuration = parseInt(req.body.ratingDuration) || 60;
  const theme = req.body.theme || 'Bebas';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const gameRes = await client.query(
      'INSERT INTO games (code, host_id, drawing_duration, rating_duration, theme) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [code, req.session.userId, drawingDuration, ratingDuration, theme]
    );
    const gameId = gameRes.rows[0].id;
    await client.query('INSERT INTO game_participants (game_id, user_id) VALUES ($1, $2)', [gameId, req.session.userId]);
    await client.query('COMMIT');
    res.json({ success: true, gameId, code, theme });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: 'Gagal membuat game', error: err.message });
  } finally {
    client.release();
  }
});

app.post('/join-game', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: 'Harus login' });
  }
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ success: false, message: 'Kode game diperlukan' });
  }
  const gameRes = await pool.query('SELECT id, status, theme FROM games WHERE code = $1', [code.toUpperCase()]);
  if (gameRes.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Game tidak ditemukan' });
  }
  const game = gameRes.rows[0];
  if (game.status !== 'waiting') {
    return res.status(400).json({ success: false, message: 'Game sudah dimulai atau selesai' });
  }
  await pool.query('INSERT INTO game_participants (game_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [game.id, req.session.userId]);
  res.json({ success: true, gameId: game.id, theme: game.theme });
});

app.get('/game/:gameId', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'game.html'));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ id: req.session.userId, username: req.session.username });
});

app.get('/api/user/:id', async (req, res) => {
  const result = await pool.query('SELECT username FROM users WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ username: result.rows[0].username });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logout berhasil' });
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  let currentUser = null;
  let currentGame = null;
  const timers = new Map();

  async function broadcastPlayers(gameId) {
    const gameRes = await pool.query('SELECT host_id FROM games WHERE id = $1', [gameId]);
    if (gameRes.rows.length === 0) return;
    const hostId = gameRes.rows[0].host_id;
    const playersRes = await pool.query(`
      SELECT u.id, u.username 
      FROM game_participants gp
      JOIN users u ON gp.user_id = u.id
      WHERE gp.game_id = $1
    `, [gameId]);
    io.to(`game_${gameId}`).emit('players-list', { players: playersRes.rows, hostId });
  }

  async function startTimerBroadcast(gameId, drawingDuration, ratingDuration) {
    if (timers.has(gameId)) clearInterval(timers.get(gameId));
    const interval = setInterval(async () => {
      const gameRes = await pool.query('SELECT status, drawing_end_time, rating_end_time FROM games WHERE id = $1', [gameId]);
      if (gameRes.rows.length === 0) return;
      const game = gameRes.rows[0];
      if (game.status === 'drawing' && game.drawing_end_time) {
        let remaining = Math.max(0, Math.floor((game.drawing_end_time - Date.now()) / 1000));
        io.to(`game_${gameId}`).emit('timer-update', { remaining, phase: 'drawing' });
        if (remaining === 0) {
          const ratingEndTime = Date.now() + (ratingDuration * 1000);
          await pool.query('UPDATE games SET status = $1, rating_end_time = $2 WHERE id = $3', ['rating', ratingEndTime, gameId]);
          io.to(`game_${gameId}`).emit('phase-change', { status: 'rating', endTime: ratingEndTime });
        }
      } else if (game.status === 'rating' && game.rating_end_time) {
        let remaining = Math.max(0, Math.floor((game.rating_end_time - Date.now()) / 1000));
        io.to(`game_${gameId}`).emit('timer-update', { remaining, phase: 'rating' });
        if (remaining === 0) {
          const winnersRes = await pool.query(`
            SELECT d.user_id, u.username, COALESCE(SUM(r.rating_value), 0) as total_rating, d.image_data
            FROM drawings d
            JOIN users u ON d.user_id = u.id
            LEFT JOIN ratings r ON r.drawing_id = d.id
            WHERE d.game_id = $1
            GROUP BY d.user_id, u.username, d.image_data
            ORDER BY total_rating DESC
            LIMIT 3
          `, [gameId]);
          await pool.query('UPDATE games SET status = $1 WHERE id = $2', ['finished', gameId]);
          io.to(`game_${gameId}`).emit('game-finished', { winners: winnersRes.rows });
          clearInterval(interval);
          timers.delete(gameId);
        }
      } else {
        clearInterval(interval);
        timers.delete(gameId);
      }
    }, 1000);
    timers.set(gameId, interval);
  }

  socket.on('join-game', async ({ gameId, userId, username }) => {
    if (!userId) return;
    currentUser = { id: userId, username };
    currentGame = gameId;
    socket.join(`game_${gameId}`);
    const gameRes = await pool.query('SELECT * FROM games WHERE id = $1', [gameId]);
    if (gameRes.rows.length === 0) return;
    const game = gameRes.rows[0];
    socket.emit('game-status', {
      status: game.status,
      drawingEndTime: game.drawing_end_time,
      ratingEndTime: game.rating_end_time,
      drawingDuration: game.drawing_duration,
      ratingDuration: game.rating_duration,
      hostId: game.host_id,
      winnerId: game.winner_id,
      theme: game.theme
    });
    if (game.status === 'drawing' || game.status === 'rating') {
      startTimerBroadcast(gameId, game.drawing_duration, game.rating_duration);
    }
    broadcastPlayers(gameId);
  });

  socket.on('request-players', ({ gameId }) => broadcastPlayers(gameId));

  socket.on('start-game', async ({ gameId }) => {
    const gameRes = await pool.query('SELECT host_id, status, drawing_duration, rating_duration, theme FROM games WHERE id = $1', [gameId]);
    if (gameRes.rows.length === 0) return;
    const game = gameRes.rows[0];
    if (game.host_id !== currentUser.id) return socket.emit('error', 'Hanya host yang bisa memulai');
    if (game.status !== 'waiting') return socket.emit('error', 'Game sudah dimulai');
    const drawingEndTime = Date.now() + (game.drawing_duration * 1000);
    await pool.query('UPDATE games SET status = $1, drawing_end_time = $2 WHERE id = $3', ['drawing', drawingEndTime, gameId]);
    io.to(`game_${gameId}`).emit('phase-change', { status: 'drawing', endTime: drawingEndTime, theme: game.theme });
    startTimerBroadcast(gameId, game.drawing_duration, game.rating_duration);
  });

  socket.on('submit-drawing', async ({ gameId, imageData }) => {
    if (!currentUser) return;
    const gameRes = await pool.query('SELECT status FROM games WHERE id = $1', [gameId]);
    if (gameRes.rows.length === 0 || gameRes.rows[0].status !== 'drawing') return;
    const submittedAt = Date.now();
    await pool.query(`
      INSERT INTO drawings (game_id, user_id, image_data, submitted_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET image_data = $3, submitted_at = $4
    `, [gameId, currentUser.id, imageData, submittedAt]);
  });

  socket.on('request-drawings', async ({ gameId }) => {
    const drawingsRes = await pool.query(`
      SELECT d.id, d.image_data, d.user_id, u.username
      FROM drawings d
      JOIN users u ON d.user_id = u.id
      WHERE d.game_id = $1
    `, [gameId]);
    socket.emit('drawings-list', { drawings: drawingsRes.rows });
  });

  socket.on('submit-rating', async ({ drawingId, ratingValue }) => {
    if (!currentUser) return;
    await pool.query(`
      INSERT INTO ratings (drawing_id, user_id, rating_value)
      VALUES ($1, $2, $3)
      ON CONFLICT (drawing_id, user_id) DO UPDATE SET rating_value = $3
    `, [drawingId, currentUser.id, ratingValue]);
  });

  socket.on('disconnect', () => {
    if (currentGame) broadcastPlayers(currentGame);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));