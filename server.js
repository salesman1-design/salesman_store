require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: 'supersecret',
  resave: false,
  saveUninitialized: false
}));

// Database
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'car_sales',
  charset: 'utf8mb4'
});

db.connect(err => {
  if (err) throw err;
  console.log('Connected to MySQL');
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'salesmanempire@gmail.com',
    pass: 'cgxb tiom lvek kzaq' // app password
  }
});

// Auth
const ADMIN_CODE = 'fastfire9';
const BACKUP_CODE = '4014';
let failedAttempts = 0;

// Admin login
app.post('/admin/login', (req, res) => {
  const { code } = req.body;
  if (code === ADMIN_CODE || (failedAttempts >= 3 && code === BACKUP_CODE)) {
    req.session.admin = true;
    failedAttempts = 0;
    res.json({ success: true });
  } else {
    failedAttempts++;
    res.json({ success: false });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Fetch products
app.get('/products', (req, res) => {
  db.query('SELECT * FROM products ORDER BY id DESC', (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(results);
  });
});

// Place order
app.post('/order', (req, res) => {
  const { name, email, productId } = req.body;
  if (!name || !email || !productId) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  db.query('INSERT INTO orders (name, email, product_id) VALUES (?, ?, ?)', [name, email, productId], (err) => {
    if (err) return res.status(500).json({ error: 'DB error' });

    // Notify owner
    const mailOptions = {
      from: 'salesmanempire@gmail.com',
      to: 'salesmanempire@gmail.com',
      subject: 'New Order Received',
      text: `New order placed by ${name} for product ID ${productId}. Customer email: ${email}`
    };
    transporter.sendMail(mailOptions, err => {
      if (err) console.log('Failed to notify owner:', err);
    });

    res.json({ success: true });
  });
});

// Admin-only: Get orders
app.get('/admin/orders', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const sql = `
    SELECT orders.id, orders.name, orders.email, orders.status, products.name AS product_name
    FROM orders
    JOIN products ON orders.product_id = products.id
    ORDER BY orders.id DESC
  `;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(results);
  });
});

// Admin-only: Process order
app.post('/admin/order', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { orderId, action } = req.body;

  db.query('SELECT * FROM orders WHERE id = ?', [orderId], (err, orderResults) => {
    if (err || orderResults.length === 0) return res.status(500).json({ error: 'Order not found' });
    const order = orderResults[0];

    db.query('SELECT * FROM products WHERE id = ?', [order.product_id], (err, productResults) => {
      if (err || productResults.length === 0) return res.status(500).json({ error: 'Product not found' });
      const product = productResults[0];

      if (action === 'accept_sale') {
        db.query('UPDATE orders SET status = ? WHERE id = ?', ['payment_pending', orderId], err => {
          if (err) return res.status(500).json({ error: 'Update failed' });

          // Send payment instructions
          const mailOptions = {
            from: 'salesmanempire@gmail.com',
            to: order.email,
            subject: 'Payment Instructions',
            text: `Thank you for your interest. Please pay via Cash App: $SalesmanEmpire`
          };
          transporter.sendMail(mailOptions);
          res.json({ success: true });
        });

      } else if (action === 'accept_payment') {
        // Decide which email/password to send
        const pairToSend = product.last_used === '1' ? 2 : 1;
        const emailToSend = pairToSend === 1 ? product.email1 : product.email2;
        const passToSend = pairToSend === 1 ? product.password1 : product.password2;

        // Send to customer
        const mailOptions = {
          from: 'salesmanempire@gmail.com',
          to: order.email,
          subject: 'Your Product Access Details',
          text: `Here are your credentials:\nEmail: ${emailToSend}\nPassword: ${passToSend}`
        };
        transporter.sendMail(mailOptions, err => {
          if (err) return res.status(500).json({ error: 'Failed to send email' });

          // Update last used
          db.query('UPDATE products SET last_used = ? WHERE id = ?', [pairToSend, product.id]);
          db.query('DELETE FROM orders WHERE id = ?', [orderId]);

          // Notify admin if both pairs used
          if (product.last_used === '2') {
            transporter.sendMail({
              from: 'salesmanempire@gmail.com',
              to: 'salesmanempire@gmail.com',
              subject: 'Product Credentials Exhausted',
              text: `Both credentials used for product: ${product.name}. Please update.`
            });
          }

          res.json({ success: true });
        });

      } else if (action === 'decline') {
        db.query('DELETE FROM orders WHERE id = ?', [orderId]);
        transporter.sendMail({
          from: 'salesmanempire@gmail.com',
          to: order.email,
          subject: 'Order Declined',
          text: `Order was declined due to failure to pay or product not available. Contact owner at @salesman_empire on Instagram`
        });
        res.json({ success: true });

      } else {
        res.status(400).json({ error: 'Invalid action' });
      }
    });
  });
});

// Admin-only: Add product
app.post('/admin/add', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { name, description, price, image, email1, password1, email2, password2 } = req.body;

  if (!name || !description || !price || !image || !email1 || !password1 || !email2 || !password2) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const sql = `
    INSERT INTO products (name, description, price, image, email1, password1, email2, password2, last_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2)
  `;
  const params = [name, description, price, image, email1, password1, email2, password2];

  db.query(sql, params, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to add product' });
    res.json({ success: true });
  });
});

// Admin-only: Update product
app.post('/admin/update', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { id, name, description, price, image, email1, password1, email2, password2 } = req.body;

  if (!id || !name || !description || !price || !image || !email1 || !password1 || !email2 || !password2) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const sql = `
    UPDATE products
    SET name = ?, description = ?, price = ?, image = ?, email1 = ?, password1 = ?, email2 = ?, password2 = ?
    WHERE id = ?
  `;
  const params = [name, description, price, image, email1, password1, email2, password2, id];

  db.query(sql, params, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to update product' });
    res.json({ success: true });
  });
});

// Admin-only: Get products
app.get('/admin/products', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  db.query('SELECT * FROM products ORDER BY id DESC', (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(results);
  });
});

// Admin-only: Delete product
app.post('/admin/delete', (req, res) => {
  if (!req.session.admin) return res.sendStatus(403);
  const { id } = req.body;

  if (!id) return res.status(400).json({ error: 'Missing ID' });

  db.query('DELETE FROM products WHERE id = ?', [id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to delete product' });
    res.json({ success: true });
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚗 Server is running on http://localhost:${PORT}`);
});