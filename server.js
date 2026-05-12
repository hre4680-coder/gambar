const express = require('express');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'game_rahasia_lomba_gambar',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));stikan baris ini ada di awal file, bersama require lainnya

// Tentukan lokasi database: jika ada environment variable DATA_DIR, pakai itu, jika tidak pakai folder lokal
const dataDir = process.env.DATA_DIR || '.';
const dbPath = path.join(dataDir, 'game.db');
const db = new sqlite3.Database(dbPath);
console.log(`Database will be stored at: ${dbPath}`);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    host_id INTEGER,
    status TEXT DEFAULT 'waiting',
    theme TEXT DEFAULT 'Bebas',
    drawing_duration INTEGER DEFAULT 90,
    rating_duration INTEGER DEFAULT 60,
    drawing_end_time INTEGER,
    rating_end_time INTEGER,
    winner_id INTEGER,
    FOREIGN KEY(host_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS game_participants (
    game_id INTEGER,
    user_id INTEGER,
    PRIMARY KEY (game_id, user_id),
    FOREIGN KEY(game_id) REFERENCES games(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS drawings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER,
    user_id INTEGER,
    image_data TEXT,
    submitted_at INTEGER,
    FOREIGN KEY(game_id) REFERENCES games(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drawing_id INTEGER,
    user_id INTEGER,
    rating_value INTEGER,
    UNIQUE(drawing_id, user_id),
    FOREIGN KEY(drawing_id) REFERENCES drawings(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
});

function generateGameCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ========== Rute dengan respons JSON semua ==========
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
    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function(err) {
      if (err) {
        return res.status(400).json({ success: false, message: 'Username sudah terdaftar' });
      }
      res.json({ success: true, message: 'Registrasi berhasil' });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password harus diisi' });
  }
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) {
      return res.status(401).json({ success: false, message: 'Username tidak ditemukan' });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Password salah' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true, message: 'Login berhasil' });
  });
});

app.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.post('/create-game', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: 'Harus login' });
  }
  const code = generateGameCode();
  const drawingDuration = parseInt(req.body.drawingDuration) || 90;
  const ratingDuration = parseInt(req.body.ratingDuration) || 60;
  const theme = req.body.theme || 'Bebas';
  db.run(`INSERT INTO games (code, host_id, drawing_duration, rating_duration, theme)
          VALUES (?, ?, ?, ?, ?)`, [code, req.session.userId, drawingDuration, ratingDuration, theme],
    function(err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Gagal membuat game', error: err.message });
      }
      db.run('INSERT INTO game_participants (game_id, user_id) VALUES (?, ?)', [this.lastID, req.session.userId]);
      res.json({ success: true, gameId: this.lastID, code, theme });
    });
});

app.post('/join-game', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: 'Harus login' });
  }
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ success: false, message: 'Kode game diperlukan' });
  }
  db.get('SELECT id, status, theme FROM games WHERE code = ?', [code.toUpperCase()], (err, game) => {
    if (err || !game) {
      return res.status(404).json({ success: false, message: 'Game tidak ditemukan' });
    }
    if (game.status !== 'waiting') {
      return res.status(400).json({ success: false, message: 'Game sudah dimulai atau selesai' });
    }
    db.run('INSERT OR IGNORE INTO game_participants (game_id, user_id) VALUES (?, ?)',
      [game.id, req.session.userId], (err) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Gagal join game' });
        }
        res.json({ success: true, gameId: game.id, theme: game.theme });
      });
  });
});

app.get('/game/:gameId', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'game.html'));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ id: req.session.userId, username: req.session.username });
});

app.get('/api/user/:id', (req, res) => {
  db.get('SELECT username FROM users WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'User not found' });
    res.json({ username: row.username });
  });
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

  function broadcastPlayers(gameId) {
    db.get('SELECT host_id FROM games WHERE id = ?', [gameId], (err, game) => {
      if (err || !game) return;
      db.all(`
        SELECT u.id, u.username 
        FROM game_participants gp
        JOIN users u ON gp.user_id = u.id
        WHERE gp.game_id = ?
      `, [gameId], (err, players) => {
        if (err) return;
        io.to(`game_${gameId}`).emit('players-list', { players, hostId: game.host_id });
      });
    });
  }

  function startTimerBroadcast(gameId, drawingDuration, ratingDuration) {
    if (timers.has(gameId)) clearInterval(timers.get(gameId));
    const interval = setInterval(() => {
      db.get('SELECT status, drawing_end_time, rating_end_time FROM games WHERE id = ?', [gameId], (err, game) => {
        if (err || !game) return;
        if (game.status === 'drawing' && game.drawing_end_time) {
          let remaining = Math.max(0, Math.floor((game.drawing_end_time - Date.now()) / 1000));
          io.to(`game_${gameId}`).emit('timer-update', { remaining, phase: 'drawing' });
          if (remaining === 0) {
            const ratingEndTime = Date.now() + (ratingDuration * 1000);
            db.run('UPDATE games SET status = "rating", rating_end_time = ? WHERE id = ?', [ratingEndTime, gameId], () => {
              io.to(`game_${gameId}`).emit('phase-change', { status: 'rating', endTime: ratingEndTime });
            });
          }
        } else if (game.status === 'rating' && game.rating_end_time) {
          let remaining = Math.max(0, Math.floor((game.rating_end_time - Date.now()) / 1000));
          io.to(`game_${gameId}`).emit('timer-update', { remaining, phase: 'rating' });
          if (remaining === 0) {
            db.all(`
              SELECT d.user_id, u.username, COALESCE(SUM(r.rating_value), 0) as total_rating, d.image_data
              FROM drawings d
              JOIN users u ON d.user_id = u.id
              LEFT JOIN ratings r ON r.drawing_id = d.id
              WHERE d.game_id = ?
              GROUP BY d.user_id
              ORDER BY total_rating DESC
              LIMIT 3
            `, [gameId], (err, winners) => {
              if (err || !winners.length) {
                db.run('UPDATE games SET status = "finished" WHERE id = ?', [gameId]);
                io.to(`game_${gameId}`).emit('game-finished', { winners: [] });
              } else {
                const winnerIds = winners.map(w => w.user_id);
                db.run('UPDATE games SET status = "finished", winner_id = ? WHERE id = ?', [winnerIds[0], gameId]);
                io.to(`game_${gameId}`).emit('game-finished', { winners });
              }
              clearInterval(interval);
              timers.delete(gameId);
            });
          }
        } else {
          clearInterval(interval);
          timers.delete(gameId);
        }
      });
    }, 1000);
    timers.set(gameId, interval);
  }

  socket.on('join-game', ({ gameId, userId, username }) => {
    if (!userId) return;
    currentUser = { id: userId, username };
    currentGame = gameId;
    socket.join(`game_${gameId}`);
    db.get('SELECT *, (SELECT theme FROM games WHERE id = ?) as theme FROM games WHERE id = ?', [gameId, gameId], (err, game) => {
      if (err || !game) return;
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
    });
    broadcastPlayers(gameId);
  });

  socket.on('request-players', ({ gameId }) => {
    broadcastPlayers(gameId);
  });

  socket.on('start-game', ({ gameId }) => {
    db.get('SELECT host_id, status, drawing_duration, rating_duration, theme FROM games WHERE id = ?', [gameId], (err, game) => {
      if (err || !game) return;
      if (game.host_id !== currentUser.id) return socket.emit('error', 'Hanya host yang bisa memulai');
      if (game.status !== 'waiting') return socket.emit('error', 'Game sudah dimulai');
      const drawingEndTime = Date.now() + (game.drawing_duration * 1000);
      db.run('UPDATE games SET status = "drawing", drawing_end_time = ? WHERE id = ?', [drawingEndTime, gameId], () => {
        io.to(`game_${gameId}`).emit('phase-change', { status: 'drawing', endTime: drawingEndTime, theme: game.theme });
        startTimerBroadcast(gameId, game.drawing_duration, game.rating_duration);
      });
    });
  });

  socket.on('submit-drawing', ({ gameId, imageData }) => {
    if (!currentUser) return;
    db.get('SELECT status FROM games WHERE id = ?', [gameId], (err, game) => {
      if (err || !game || game.status !== 'drawing') return;
      const submittedAt = Date.now();
      db.run(`INSERT INTO drawings (game_id, user_id, image_data, submitted_at)
              VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET image_data = ?, submitted_at = ?`,
        [gameId, currentUser.id, imageData, submittedAt, imageData, submittedAt]);
    });
  });

  socket.on('request-drawings', ({ gameId }) => {
    db.all(`
      SELECT d.id, d.image_data, d.user_id, u.username
      FROM drawings d
      JOIN users u ON d.user_id = u.id
      WHERE d.game_id = ?
    `, [gameId], (err, drawings) => {
      if (err) return;
      socket.emit('drawings-list', { drawings });
    });
  });

  socket.on('submit-rating', ({ drawingId, ratingValue }) => {
    if (!currentUser) return;
    db.run(`INSERT INTO ratings (drawing_id, user_id, rating_value)
            VALUES (?, ?, ?) ON CONFLICT(drawing_id, user_id) DO UPDATE SET rating_value = ?`,
      [drawingId, currentUser.id, ratingValue, ratingValue]);
  });

  socket.on('disconnect', () => {
    if (currentGame) broadcastPlayers(currentGame);
  });
});

// Gunakan port dari environment variable, default ke 3000 untuk testing lokal
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));