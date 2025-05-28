require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const nodemailer = require('nodemailer');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// DB connection pool with UTF8MB4 support for emoji
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'car_sales_platform',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'  // use utf8mb4 here
});

// Force utf8mb4 on every new connection
pool.on('connection', (connection) => {
  connection.query("SET NAMES utf8mb4");
});

// Middleware to enforce JSON UTF-8 response header
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

const sessionStore = new MySQLStore({}, pool);

app.use(session({
  key: 'session_cookie_name',
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 2 // 2 hours
  }
}));

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Email sending function
async function sendEmail(to, subject, html) {
  if (!to) {
    console.error('Missing email recipient!');
    return;
  }

  await transporter.sendMail({
    from: `"Car Sales Platform" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
}

// Admin credentials
const adminUser = {
  username: 'fastfire9',
  passwordHash: '$2b$10$MS3zX/p7QVSHTaQbbhu4/.ZnfJBELLOp9hjybpX/QfvTbklQkQ1ZK' // hashed password
};

// ======================== AUTH =========================
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== adminUser.username) return res.status(401).json({ error: 'Invalid username or password' });

  const match = await bcrypt.compare(password, adminUser.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid username or password' });

  req.session.adminLoggedIn = true;
  res.json({ message: 'Logged in successfully' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ message: 'Logged out' });
  });
});

function adminAuth(req, res, next) {
  if (req.session.adminLoggedIn) next();
  else res.status(401).json({ error: 'Unauthorized' });
}

app.use('/admin', adminAuth);

// ======================== ADMIN PAGES =========================
app.get('/admin/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-orders.html'));
});

app.get('/admin/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-products.html'));
});

// ======================== PUBLIC ROUTES =========================
app.get('/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, description, price, image_url FROM products ORDER BY id ASC LIMIT 1000');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/order', async (req, res) => {
  const { product_id, customer_email } = req.body;
  if (!product_id || !customer_email) {
    return res.status(400).json({ error: 'Missing product_id or customer_email' });
  }

  try {
    const [result] = await pool.query('INSERT INTO orders (product_id, customer_email) VALUES (?, ?)', [product_id, customer_email]);

    await sendEmail(
      process.env.SMTP_USER,
      `New Order Placed (Order ID: ${result.insertId})`,
      `<p>New order placed.</p>
       <p>Order ID: ${result.insertId}</p>
       <p>Product ID: ${product_id}</p>
       <p>Email: ${customer_email}</p>
       <p>Status: Pending</p>`
    );

    await sendEmail(
      customer_email,
      'Order Received - Next Steps',
      `<p>Thank you for your order. Please wait for confirmation.</p>
       <p>You’ll receive a CashApp link if accepted.</p>
       <p>Credentials are sent after payment.</p>
       <p>The password resets in 1 hour and the email must not be reused.</p>`
    );

    res.json({ message: 'Order placed', order_id: result.insertId });
  } catch (error) {
    console.error('Error placing order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================== ADMIN API =========================
app.get('/admin/api/products', async (req, res) => {
  try {
    const [products] = await pool.query('SELECT id, name, description, price, image_url FROM products ORDER BY id ASC LIMIT 1000');
    res.json(products);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/admin/products', async (req, res) => {
  const { name, description, price, image_url } = req.body;
  if (!name || !price) {
    return res.status(400).json({ error: 'Missing required fields: name or price' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO products (name, description, price, image_url) VALUES (?, ?, ?, ?)',
      [name, description || '', price, image_url || '']
    );
    res.status(201).json({ message: 'Product added', productId: result.insertId });
  } catch (error) {
    console.error('Error adding product:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/admin/products/:id', async (req, res) => {
  const productId = req.params.id;

  try {
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [productId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Product not found' });

    res.json({ message: 'Product deleted' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======= NEW: PRODUCT CREDENTIALS CRUD =======

// Get all credentials for a product
app.get('/admin/products/:id/credentials', async (req, res) => {
  const productId = req.params.id;
  try {
    const [creds] = await pool.query(
      'SELECT id, email, password, used FROM product_credentials WHERE product_id = ?',
      [productId]
    );
    res.json(creds);
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Add a new credential for a product
app.post('/admin/products/:id/credentials', async (req, res) => {
  const productId = req.params.id;
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO product_credentials (product_id, email, password, used) VALUES (?, ?, ?, FALSE)',
      [productId, email, password]
    );
    res.status(201).json({ message: 'Credential added', credentialId: result.insertId });
  } catch (error) {
    console.error('Error adding credential:', error);
    res.status(500).json({ error: 'Failed to add credential' });
  }
});

// Update an existing credential
app.put('/admin/products/:productId/credentials/:credId', async (req, res) => {
  const { productId, credId } = req.params;
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const [result] = await pool.query(
      'UPDATE product_credentials SET email = ?, password = ? WHERE id = ? AND product_id = ?',
      [email, password, credId, productId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    res.json({ message: 'Credential updated' });
  } catch (error) {
    console.error('Error updating credential:', error);
    res.status(500).json({ error: 'Failed to update credential' });
  }
});

// Delete a credential
app.delete('/admin/products/:productId/credentials/:credId', async (req, res) => {
  const { productId, credId } = req.params;
  try {
    const [result] = await pool.query(
      'DELETE FROM product_credentials WHERE id = ? AND product_id = ?',
      [credId, productId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    res.json({ message: 'Credential deleted' });
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
