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

// MySQL connection pool with utf8mb4 support
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'car_sales_platform',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
});

pool.on('connection', (connection) => {
  connection.query("SET NAMES utf8mb4");
});

// Adjust CORS to allow cookies and origin (if needed)
app.use(cors({
  origin: true, // adjust to your frontend origin if needed
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use('/api', (req, res, next) => {
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
    maxAge: 1000 * 60 * 60 * 2,
  },
}));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to, subject, html) {
  if (!to) return;
  try {
    await transporter.sendMail({
      from: `"Car Sales Platform" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
  } catch (error) {
    console.error('Email send failed:', error);
  }
}

const adminUser = {
  username: 'fastfire9',
  passwordHash: '$2b$10$MS3zX/p7QVSHTaQbbhu4/.ZnfJBELLOp9hjybpX/QfvTbklQkQ1ZK',
};

// AUTH
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== adminUser.username || !await bcrypt.compare(password, adminUser.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
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
  if (req.session.adminLoggedIn) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.use('/admin/api', adminAuth);

app.get('/admin/orders', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-orders.html'));
});

app.get('/admin/products', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-products.html'));
});

// PRODUCTS
app.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'products.html'));
});

app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, description, price, image_url FROM products ORDER BY id ASC LIMIT 1000');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/order', async (req, res) => {
  try {
    const { product_id, customer_email, customer_name } = req.body;
    if (!product_id || !customer_email) {
      return res.status(400).json({ error: 'Product and email are required' });
    }
    // Insert customer_name if you want to show it later in admin orders:
    await pool.query('INSERT INTO orders (product_id, customer_email, customer_name) VALUES (?, ?, ?)', [product_id, customer_email, customer_name || null]);
    res.json({ message: 'Order placed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ADMIN API - Orders

// Return orders including customer_name and product_name alias
app.get('/admin/api/orders', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT o.id, o.customer_email, o.customer_name, o.status, p.name AS product_name, p.description 
      FROM orders o 
      JOIN products p ON o.product_id = p.id 
      ORDER BY o.id DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept sale
app.post('/admin/api/orders/:id/accept-sale', async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query('UPDATE orders SET status = ? WHERE id = ?', ['payment_pending', id]);

    // Send Cash App link email
    const [rows] = await pool.query(`
      SELECT customer_email FROM orders WHERE id = ?
    `, [id]);

    if (rows.length > 0) {
      await sendEmail(
        rows[0].customer_email,
        'Cash App Payment Request',
        `<p>Please send payment to Cash App $fastfire9 for your purchase.</p>`
      );
    }
    res.json({ message: 'Sale accepted' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accept order and send credentials
app.post('/admin/api/orders/:id/accept-order', async (req, res) => {
  const id = req.params.id;
  try {
    // Find the credentials for the product associated with the order
    const [[order]] = await pool.query('SELECT product_id, customer_email FROM orders WHERE id = ?', [id]);

    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Get two email-password pairs for the product that are unused
    const [creds] = await pool.query(`
      SELECT id, email, password FROM credentials 
      WHERE product_id = ? AND used = 0 
      LIMIT 2
    `, [order.product_id]);

    if (creds.length === 0) {
      return res.status(400).json({ error: 'No available credentials' });
    }

    // Send each credential to the customer
    for (const cred of creds) {
      await sendEmail(
        order.customer_email,
        'Your Product Credentials',
        `<p>Email: ${cred.email}</p><p>Password: ${cred.password}</p>`
      );
      // Mark credential as used
      await pool.query('UPDATE credentials SET used = 1 WHERE id = ?', [cred.id]);
    }

    // Mark order as completed and delete it after sending credentials
    await pool.query('DELETE FROM orders WHERE id = ?', [id]);

    res.json({ message: 'Credentials sent and order completed' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Decline order: delete order and send decline email
app.post('/admin/api/orders/:id/decline', async (req, res) => {
  const id = req.params.id;
  const { email } = req.body;
  try {
    await pool.query('DELETE FROM orders WHERE id = ?', [id]);

    if (email) {
      await sendEmail(
        email,
        'Order Declined',
        `<p>Order was declined due to failure to pay or product not available.</p><p>Contact owner at @salesman_empire on Instagram</p>`
      );
    }

    res.json({ message: 'Order declined and customer notified' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
