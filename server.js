require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const nodemailer = require('nodemailer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// DB connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'car_sales_platform',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

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

app.get('/api/orders', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT o.id, o.product_id, o.customer_email, o.status, o.created_at, 
             o.credential_id, p.name as product_name, p.price
      FROM orders o
      JOIN products p ON o.product_id = p.id
      ORDER BY o.created_at DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/admin/orders/:id/accept-sale', async (req, res) => {
  const orderId = req.params.id;
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await sendEmail(
      order.customer_email,
      'Your Payment Link',
      `<p>Please pay using this CashApp link:</p>
       <a href="https://cash.app/$shayIrl" target="_blank">https://cash.app/$shayIrl</a>`
    );

    await pool.query('UPDATE orders SET status = ? WHERE id = ?', ['payment_pending', orderId]);
    res.json({ message: 'CashApp payment link sent.' });
  } catch (error) {
    console.error('Error accepting sale:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/admin/orders/:id/accept-order', async (req, res) => {
  const orderId = req.params.id;

  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'payment_pending') {
      return res.status(400).json({ error: 'Order must be in payment_pending state' });
    }

    const [[credential]] = await pool.query(
      'SELECT * FROM product_credentials WHERE product_id = ? AND used = FALSE LIMIT 1',
      [order.product_id]
    );

    if (!credential) {
      return res.status(400).json({ error: 'No available credentials for this product' });
    }

    await sendEmail(
      order.customer_email,
      'Your Product Access Credentials',
      `<p>Thank you. Here are your credentials:</p>
       <p>Email: <strong>${credential.email}</strong></p>
       <p>Password: <strong>${credential.password}</strong></p>`
    );

    await pool.query('UPDATE product_credentials SET used = TRUE WHERE id = ?', [credential.id]);
    await pool.query('DELETE FROM orders WHERE id = ?', [orderId]);

    res.json({ message: 'Order completed and removed from system.' });
  } catch (error) {
    console.error('Error accepting order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/admin/orders/:id/decline', async (req, res) => {
  const orderId = req.params.id;

  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await sendEmail(
      order.customer_email,
      'Order Declined',
      `<p>Order was declined due to failure to pay or product not available.</p>
       <p>Contact owner at <strong>@salesman_empire</strong> on Instagram.</p>`
    );

    await pool.query('DELETE FROM orders WHERE id = ?', [orderId]);
    res.json({ message: 'Order declined and deleted.' });
  } catch (error) {
    console.error('Error declining order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================== START SERVER =========================
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
