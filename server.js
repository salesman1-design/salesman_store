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

app.use(cors());
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
  const { product_id, customer_email } = req.body;
  if (!product_id || !customer_email) return res.status(400).json({ error: 'Missing product_id or customer_email' });

  try {
    const [result] = await pool.query('INSERT INTO orders (product_id, customer_email) VALUES (?, ?)', [product_id, customer_email]);

    await sendEmail(
      process.env.SMTP_USER,
      `New Order Placed (Order ID: ${result.insertId})`,
      `<p>New order placed.</p><p>Order ID: ${result.insertId}</p><p>Product ID: ${product_id}</p><p>Email: ${customer_email}</p>`
    );

    await sendEmail(
      customer_email,
      'Order Received - Next Steps',
      `<p>Thanks for your order!</p><p>You will get a Cash App link if the order is accepted.</p><p>Credentials are delivered after payment.</p><p>Email must not be reused.</p>`
    );

    res.json({ message: 'Order placed', order_id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ADMIN APIs
app.get('/admin/api/orders', async (req, res) => {
  try {
    const [orders] = await pool.query(
      `SELECT o.id, o.customer_email, o.product_id, o.status, p.name, p.description 
       FROM orders o 
       JOIN products p ON o.product_id = p.id 
       ORDER BY o.id DESC`
    );
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/admin/api/orders/:id/accept-sale', async (req, res) => {
  const orderId = req.params.id;
  try {
    const [orderData] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (orderData.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = orderData[0];
    await pool.query('UPDATE orders SET status = ? WHERE id = ?', ['payment_pending', orderId]);

    await sendEmail(order.customer_email, 'Cash App Payment Request', `
      <p>Payment link: <a href="${process.env.CASHAPP_LINK}" target="_blank">Click here to pay</a></p>
      <p>After payment, your credentials will be delivered.</p>`);

    res.json({ message: 'Payment link sent' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to accept sale' });
  }
});

app.post('/admin/api/orders/:id/accept-order', async (req, res) => {
  const orderId = req.params.id;
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const [creds] = await pool.query(
      'SELECT id, email, password FROM product_credentials WHERE product_id = ? AND used = FALSE LIMIT 1',
      [order.product_id]
    );

    if (creds.length === 0) return res.status(400).json({ error: 'No available credentials' });

    const credential = creds[0];

    await pool.query('UPDATE product_credentials SET used = TRUE WHERE id = ?', [credential.id]);
    await pool.query('DELETE FROM orders WHERE id = ?', [orderId]);

    await sendEmail(order.customer_email, 'Order Completed - Access Info', `
      <p>Here are your credentials:</p>
      <p><strong>Email:</strong> ${credential.email}</p>
      <p><strong>Password:</strong> ${credential.password}</p>
      <p>Reset your password. Access may expire in 1 hour.</p>`);

    res.json({ message: 'Credentials sent and order completed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete order' });
  }
});

app.post('/admin/api/orders/:id/decline', async (req, res) => {
  const orderId = req.params.id;
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await pool.query('DELETE FROM orders WHERE id = ?', [orderId]);

    await sendEmail(order.customer_email, 'Order Declined', `
      <p>Your order was declined due to failure to pay or product unavailability.</p>
      <p>Contact @salesman_empire on Instagram for assistance.</p>`);

    res.json({ message: 'Order declined and deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to decline order' });
  }
});

// PRODUCT MGMT
app.get('/admin/api/products', async (req, res) => {
  try {
    const [products] = await pool.query('SELECT id, name, description, price, image_url FROM products ORDER BY id ASC LIMIT 1000');
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/admin/products', async (req, res) => {
  const { name, description, price, image_url } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Missing name or price' });

  try {
    const [result] = await pool.query('INSERT INTO products (name, description, price, image_url) VALUES (?, ?, ?, ?)', [name, description || '', price, image_url || '']);
    res.status(201).json({ message: 'Product added', productId: result.insertId });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/admin/products/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// CREDENTIAL MGMT
app.get('/admin/products/:id/credentials', async (req, res) => {
  try {
    const [creds] = await pool.query('SELECT id, email, password, used FROM product_credentials WHERE product_id = ?', [req.params.id]);
    res.json(creds);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

app.post('/admin/products/:id/credentials', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const [result] = await pool.query('INSERT INTO product_credentials (product_id, email, password, used) VALUES (?, ?, ?, FALSE)', [req.params.id, email, password]);
    res.status(201).json({ message: 'Credential added', credentialId: result.insertId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add credential' });
  }
});

app.put('/admin/products/:productId/credentials/:credId', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const [result] = await pool.query('UPDATE product_credentials SET email = ?, password = ? WHERE id = ? AND product_id = ?', [email, password, req.params.credId, req.params.productId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Credential not found' });
    res.json({ message: 'Credential updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update credential' });
  }
});

app.delete('/admin/products/:productId/credentials/:credId', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM product_credentials WHERE id = ? AND product_id = ?', [req.params.credId, req.params.productId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Credential not found' });
    res.json({ message: 'Credential deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
