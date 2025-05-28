require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const nodemailer = require('nodemailer');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// MySQL pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Session store
const sessionStore = new MySQLStore({}, pool);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  key: 'session_cookie',
  secret: process.env.SESSION_SECRET || 'supersecret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 2 * 60 * 60 * 1000 }
}));

// Set UTF-8 header for all routes except static files (adjusted)
app.use((req, res, next) => {
  if (!req.path.startsWith('/public')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  next();
});

// Admin info
const adminUser = {
  username: 'fastfire9',
  passwordHash: '$2b$10$MS3zX/p7QVSHTaQbbhu4/.ZnfJBELLOp9hjybpX/QfvTbklQkQ1ZK',
};

// Mail setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to, subject, html) {
  if (!to) return;
  await transporter.sendMail({
    from: `"Car Parking Store" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
}

// Admin login/logout
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== adminUser.username) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, adminUser.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.adminLoggedIn = true;
  res.json({ message: 'Logged in' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

// Admin auth middleware
function adminAuth(req, res, next) {
  if (req.session.adminLoggedIn) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.use('/admin', adminAuth);

// Admin pages
app.get('/admin/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-orders.html'));
});
app.get('/admin/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-products.html'));
});

// Public: Get products
app.get('/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, description, price, image_url FROM products ORDER BY id ASC LIMIT 1000');
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Internal error' });
  }
});

// Public: Place order
app.post('/order', async (req, res) => {
  const { product_id, customer_email } = req.body;
  if (!product_id || !customer_email) return res.status(400).json({ error: 'Missing data' });

  try {
    const [result] = await pool.query('INSERT INTO orders (product_id, customer_email) VALUES (?, ?)', [product_id, customer_email]);

    await sendEmail(
      process.env.SMTP_USER,
      `New Order (ID: ${result.insertId})`,
      `<p>Product ID: ${product_id}</p><p>Email: ${customer_email}</p><p>Status: Pending</p>`
    );

    await sendEmail(
      customer_email,
      'Order Received - Awaiting Payment',
      `<p>Thanks! Please wait for confirmation.</p>
       <p>You’ll receive a CashApp link if accepted.</p>
       <p>Login info will follow after payment.</p>`
    );

    res.json({ message: 'Order placed', orderId: result.insertId });
  } catch {
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// Admin: List all products
app.get('/admin/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// Admin: Add product
app.post('/admin/products', async (req, res) => {
  const { name, description, price, image_url } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price required' });

  try {
    const [result] = await pool.query('INSERT INTO products (name, description, price, image_url) VALUES (?, ?, ?, ?)', [name, description || '', price, image_url || '']);
    res.json({ message: 'Product added', id: result.insertId });
  } catch {
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// Admin: Delete product
app.delete('/admin/products/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // Delete related credentials first
    await pool.query('DELETE FROM product_credentials WHERE product_id = ?', [id]);
    // Delete product
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

/**
 * Product Credentials routes:
 *  - GET all credentials for product
 *  - POST add new credential
 *  - PUT update credential by id
 *  - DELETE credential by id
 */

app.get('/admin/products/:productId/credentials', async (req, res) => {
  try {
    const productId = req.params.productId;
    const [rows] = await pool.query('SELECT * FROM product_credentials WHERE product_id = ?', [productId]);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to load credentials' });
  }
});

app.post('/admin/products/:productId/credentials', async (req, res) => {
  try {
    const productId = req.params.productId;
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const [result] = await pool.query(
      'INSERT INTO product_credentials (product_id, email, password) VALUES (?, ?, ?)',
      [productId, email, password]
    );

    res.json({ message: 'Credential added', id: result.insertId });
  } catch {
    res.status(500).json({ error: 'Failed to add credential' });
  }
});

app.put('/admin/products/:productId/credentials/:credId', async (req, res) => {
  try {
    const { productId, credId } = req.params;
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const [result] = await pool.query(
      'UPDATE product_credentials SET email = ?, password = ? WHERE id = ? AND product_id = ?',
      [email, password, credId, productId]
    );

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Credential not found' });
    res.json({ message: 'Credential updated' });
  } catch {
    res.status(500).json({ error: 'Failed to update credential' });
  }
});

app.delete('/admin/products/:productId/credentials/:credId', async (req, res) => {
  try {
    const { productId, credId } = req.params;
    const [result] = await pool.query('DELETE FROM product_credentials WHERE id = ? AND product_id = ?', [credId, productId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Credential not found' });
    res.json({ message: 'Credential deleted' });
  } catch {
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Orders management routes and other code can remain unchanged...

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
