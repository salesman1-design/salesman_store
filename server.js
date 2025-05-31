require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const session = require('express-session');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'yoursecret',
  resave: false,
  saveUninitialized: true,
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Please try again later.',
});

// MySQL connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
});

db.connect((err) => {
  if (err) {
    console.error('MySQL connection error:', err);
    process.exit(1);
  }
  console.log('✅ Connected to MySQL database');
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email transport error:', error);
  } else {
    console.log('✅ Email transporter is ready to send messages.');
  }
});

let loginAttempts = 0;
const credentialUsage = {};

// ROUTES

// Serve frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public/admin-login.html')));
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// Admin login
app.post('/admin-login-check', loginLimiter, (req, res) => {
  const { code } = req.body;
  const adminUsername = process.env.ADMIN_USERNAME || 'fastfire9';
  const adminPassword = process.env.ADMIN_PASSWORD || '4014';

  if (code === adminUsername || (loginAttempts >= 3 && code === adminPassword)) {
    req.session.admin = true;
    loginAttempts = 0;
    return res.json({ success: true });
  }

  loginAttempts++;
  if (loginAttempts === 3) {
    transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.OWNER_EMAIL,
      subject: 'Admin Login Warning',
      text: 'There have been 3 failed login attempts to your car sales platform.',
    }, (err) => {
      if (err) console.error('❌ Failed to send login warning email:', err);
    });
  }

  res.json({ success: false, attempts: loginAttempts });
});

app.get('/admin-login-check', (req, res) => {
  if (req.session.admin) return res.json({ loggedIn: true });
  res.status(401).json({ loggedIn: false });
});

// Fetch products
app.get('/products', (req, res) => {
  db.query('SELECT * FROM products', (err, results) => {
    if (err) return res.status(500).send('Failed to fetch products');
    res.json(results);
  });
});

// Place order
app.post('/order', (req, res) => {
  const { product_id, customer_email } = req.body;
  if (!product_id || !customer_email) return res.status(400).send('Missing product_id or customer_email');

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(customer_email)) return res.status(400).send('Invalid email format');

  db.query('INSERT INTO orders (product_id, customer_email, status) VALUES (?, ?, ?)', [product_id, customer_email, 'pending'], (err, result) => {
    if (err) return res.status(500).send('Order placement failed');
    const insertedOrderId = result.insertId;

    db.query('SELECT * FROM products WHERE id = ?', [product_id], (err2, results2) => {
      if (err2 || results2.length === 0) return res.status(500).send('Product not found');
      const product = results2[0];
      const time = new Date().toISOString();

      // Notify OWNER
      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.OWNER_EMAIL,
        subject: 'New Order Received',
        text: `Email: ${customer_email}\nProduct: ${product.name}\nPrice: $${product.price}\nTime: ${time}\nOrder ID: ${insertedOrderId}`,
      });

      // Notify CUSTOMER
      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: customer_email,
        subject: 'Order Confirmation',
        text: `Thanks for your order!\nProduct: ${product.name}\nPrice: $${product.price}\nOrder ID: ${insertedOrderId}\nWe'll follow up with payment/login info shortly.`,
      });

      return res.status(200).json({ success: true, order_id: insertedOrderId });
    });
  });
});

// Get orders (admin only)
app.get('/get-orders', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  db.query('SELECT * FROM orders', (err, results) => {
    if (err) return res.status(500).send('Failed to get orders');
    res.json(results);
  });
});

// Handle order actions
app.post('/order-action', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { action, order_id } = req.body;
  if (!action || !order_id) return res.status(400).send('Missing action or order_id');

  db.query('SELECT * FROM orders WHERE id = ?', [order_id], (err, orders) => {
    if (err || orders.length === 0) return res.status(404).send('Order not found');
    const order = orders[0];

    db.query('SELECT * FROM products WHERE id = ?', [order.product_id], (err2, products) => {
      if (err2 || products.length === 0) return res.status(404).send('Product not found');
      const product = products[0];

      let subject = '';
      let message = '';

      if (action === 'accept-sale') {
        subject = 'Next Step: Payment';
        message = 'Please pay via CashApp. Your order will be completed once payment is confirmed: https://cash.app/$shayIrl';

        db.query('UPDATE orders SET status = ? WHERE id = ?', ['payment_pending', order_id], () => {
          transporter.sendMail({ from: process.env.SMTP_USER, to: order.customer_email, subject, text: message }, () => {
            res.json({ success: true });
          });
        });
        return;
      }

      if (action === 'accept-payment') {
        subject = 'Your Product Access Info';
        const key = `product_${product.id}`;
        credentialUsage[key] = (credentialUsage[key] || 0) + 1;

        if (credentialUsage[key] === 1) {
          message = `Login Info:\nEmail: ${product.email1}\nPassword: ${product.password1}`;
        } else if (credentialUsage[key] === 2) {
          message = `Login Info:\nEmail: ${product.email2}\nPassword: ${product.password2}`;
          transporter.sendMail({
            from: process.env.SMTP_USER,
            to: process.env.OWNER_EMAIL,
            subject: 'Credential Restock Needed',
            text: `⚠️ Both credentials for "${product.name}" (ID ${product.id}) have been used. Please update them.`,
          });
        } else {
          message = '⚠️ Credentials exhausted. Please contact @salesman_empire on Instagram.';
        }
      }

      if (action === 'decline') {
        subject = 'Order Declined';
        message = 'Order was declined due to failure to pay or product not available. Contact owner at @salesman_empire on Instagram';
      }

      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: order.customer_email,
        subject,
        text: message,
      }, () => {
        if (action === 'accept-payment' || action === 'decline') {
          db.query('DELETE FROM orders WHERE id = ?', [order_id], () => res.json({ success: true }));
        } else {
          res.json({ success: true });
        }
      });
    });
  });
});

// ADMIN PRODUCT MANAGEMENT

// Add product
app.post('/admin-products/add', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { name, description, price, image, email1, password1, email2, password2 } = req.body;
  if (!name || !price || !email1 || !password1 || !email2 || !password2) return res.status(400).send('Missing required product fields');

  db.query(
    'INSERT INTO products (name, description, price, image, email1, password1, email2, password2) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name, description || '', price, image || '', email1, password1, email2, password2],
    (err) => {
      if (err) return res.status(500).send('Failed to add product');
      res.json({ success: true });
    }
  );
});

// Delete product
app.post('/admin-products/delete', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { id } = req.body;
  if (!id) return res.status(400).send('Product ID is required');

  db.query('DELETE FROM products WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).send('Failed to delete product');
    res.json({ success: true });
  });
});

// Update product
app.post('/admin-products/update', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { id, name, description, price, image, email1, password1, email2, password2 } = req.body;
  if (!id || !name || !price || !email1 || !password1 || !email2 || !password2) return res.status(400).send('Missing product fields');

  db.query(
    'UPDATE products SET name = ?, description = ?, price = ?, image = ?, email1 = ?, password1 = ?, email2 = ?, password2 = ? WHERE id = ?',
    [name, description || '', price, image || '', email1, password1, email2, password2, id],
    (err) => {
      if (err) return res.status(500).send('Failed to update product');
      res.json({ success: true });
    }
  );
});

// Get all products (admin only)
app.get('/admin-products/get', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  db.query('SELECT * FROM products', (err, results) => {
    if (err) return res.status(500).send('Failed to fetch products');
    res.json(results);
  });
});

// Server startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚗 Server is running on http://localhost:${PORT}`);
});
