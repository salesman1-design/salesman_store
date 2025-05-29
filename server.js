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

// Rate limiter for login route
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many login attempts. Please try again later.'
});

// Create MySQL connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  charset: 'utf8mb4'
});

// Connect to MySQL and handle errors
db.connect((err) => {
  if (err) {
    console.error('MySQL connection error:', err);
    process.exit(1); // exit app if DB connection fails
  }
  console.log('Connected to MySQL database');
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

let loginAttempts = 0;

// Serve main pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public/admin-login.html')));
app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Admin login check
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
  if (loginAttempts >= 3) {
    transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.OWNER_EMAIL,
      subject: 'Admin Login Warning',
      text: 'There have been 3 failed login attempts to your car sales platform.'
    });
  }

  res.json({ success: false, attempts: loginAttempts });
});

app.get('/admin-login-check', (req, res) => {
  if (req.session.admin) return res.json({ loggedIn: true });
  res.status(401).json({ loggedIn: false });
});

// Get all products (public)
app.get('/products', (req, res) => {
  db.query('SELECT * FROM products', (err, results) => {
    if (err) {
      console.error('DB error:', err);
      return res.status(500).send('Something went wrong.');
    }
    res.json(results);
  });
});

// Place an order
app.post('/order', (req, res) => {
  const { product_id, customer_email } = req.body;
  if (!product_id || !customer_email) return res.status(400).send('Missing data');

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(customer_email)) return res.status(400).send('Invalid email format');

  const order_id = Math.floor(100000 + Math.random() * 900000);
  const timestamp = new Date();

  db.query(
    'INSERT INTO orders (product_id, customer_email, order_id, time, status) VALUES (?, ?, ?, ?, ?)',
    [product_id, customer_email, order_id, timestamp, 'pending'],
    (err) => {
      if (err) {
        console.error('Order insert error:', err);
        return res.status(500).send('Failed to place order');
      }

      db.query('SELECT * FROM products WHERE id = ?', [product_id], (err2, result) => {
        if (err2 || result.length === 0) {
          console.error('Product not found for order:', err2);
          return res.status(500).send('Invalid product');
        }
        const product = result[0];

        // Notify owner about new order
        transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.OWNER_EMAIL,
          subject: 'New Order Received',
          text: `Email: ${customer_email}\nProduct ID: ${product_id}\nCost: $${product.price}\nTime: ${timestamp}\nOrder ID: ${order_id}`
        });

        res.sendStatus(200);
      });
    }
  );
});

// Get all orders (admin only)
app.get('/get-orders', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  db.query('SELECT * FROM orders', (err, results) => {
    if (err) {
      console.error('Get orders error:', err);
      return res.status(500).send('Something went wrong.');
    }
    res.json(results);
  });
});

// Order actions (accept-sale, accept-payment, decline)
app.post('/order-action', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { action, order_id } = req.body;
  if (!action || !order_id) return res.status(400).send('Missing data');

  db.query('SELECT * FROM orders WHERE order_id = ?', [order_id], (err, orderResults) => {
    if (err || orderResults.length === 0) {
      console.error('Order not found:', err);
      return res.status(500).send('Order not found');
    }
    const order = orderResults[0];

    db.query('SELECT * FROM products WHERE id = ?', [order.product_id], (err2, productResults) => {
      if (err2 || productResults.length === 0) {
        console.error('Product not found:', err2);
        return res.status(500).send('Product not found');
      }
      const product = productResults[0];

      let subject = '', message = '';
      if (action === 'accept-sale') {
        subject = 'Next Step: Payment';
        message = `Please complete payment using our CashApp: https://cash.app/$YourTag\nThen wait for confirmation.`;
      } else if (action === 'accept-payment') {
        subject = 'Your Product Access Info';
        message = `Here are your login details:\nEmail 1: ${product.email1}, Password: ${product.password1}\nEmail 2: ${product.email2}, Password: ${product.password2}\nThank you for shopping with us!`;
      } else if (action === 'decline') {
        subject = 'Order Declined';
        message = `Order has been declined due to failure to pay or product unavailability.\nIf this is an error, please contact @salesman_empire on Instagram.`;
      } else {
        return res.status(400).send('Invalid action');
      }

      transporter.sendMail({
        from: process.env.SMTP_USER,
        to: order.customer_email,
        subject,
        text: message
      });

      // Delete order after action
      db.query('DELETE FROM orders WHERE order_id = ?', [order_id], (err3) => {
        if (err3) {
          console.error('Failed to delete order:', err3);
          return res.status(500).send('Failed to complete action');
        }
        res.sendStatus(200);
      });
    });
  });
});

// Add new product (admin)
app.post('/add-product', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { name, description, price, image, email1, password1, email2, password2 } = req.body;
  if (!name || !price) return res.status(400).send('Missing required fields');

  const sql = `INSERT INTO products (name, description, price, image, email1, password1, email2, password2) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  db.query(sql, [name, description || '', price, image || '', email1 || '', password1 || '', email2 || '', password2 || ''], (err) => {
    if (err) {
      console.error('Add product error:', err);
      return res.status(500).send('Failed to add product');
    }
    res.sendStatus(200);
  });
});

// Update product info (admin)
app.put('/update-product/:id', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { id } = req.params;
  const { name, description, price, image } = req.body;

  if (!name || !price) return res.status(400).send('Missing required fields');

  const sql = `UPDATE products SET name = ?, description = ?, price = ?, image = ? WHERE id = ?`;
  db.query(sql, [name, description || '', price, image || '', id], (err) => {
    if (err) {
      console.error('Update product error:', err);
      return res.status(500).send('Failed to update product');
    }
    res.sendStatus(200);
  });
});

// Update credentials (admin)
app.put('/update-credentials/:id', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { id } = req.params;
  const { email1, password1, email2, password2 } = req.body;

  const sql = `UPDATE products SET email1 = ?, password1 = ?, email2 = ?, password2 = ? WHERE id = ?`;
  db.query(sql, [email1 || '', password1 || '', email2 || '', password2 || '', id], (err) => {
    if (err) {
      console.error('Update credentials error:', err);
      return res.status(500).send('Failed to update credentials');
    }
    res.sendStatus(200);
  });
});

// Delete product (admin)
app.delete('/delete-product/:id', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { id } = req.params;

  db.query('DELETE FROM products WHERE id = ?', [id], (err) => {
    if (err) {
      console.error('Delete product error:', err);
      return res.status(500).send('Failed to delete product');
    }
    res.sendStatus(200);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
