const express = require('express');
const router = express.Router();
const db = require('../db');
const nodemailer = require('nodemailer');

// Middleware to protect admin routes
function isAdmin(req, res, next) {
  if (req.session.admin) next();
  else res.status(401).json({ message: 'Unauthorized' });
}

// Admin login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await db.query('SELECT * FROM admin WHERE username = ? AND password = ?', [username, password]);

  if (rows.length > 0) {
    req.session.admin = true;
    res.json({ message: 'Login successful' });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

// Admin logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

// Get all orders
router.get('/orders', isAdmin, async (req, res) => {
  const [orders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(orders);
});

// Accept an order
router.post('/orders/:id/accept', isAdmin, async (req, res) => {
  await db.query('UPDATE orders SET status = ? WHERE id = ?', ['accepted', req.params.id]);
  res.sendStatus(200);
});

// Complete an order
router.post('/orders/:id/complete', isAdmin, async (req, res) => {
  await db.query('UPDATE orders SET status = ? WHERE id = ?', ['completed', req.params.id]);
  res.sendStatus(200);
});

// Decline an order
router.post('/orders/:id/decline', isAdmin, async (req, res) => {
  await db.query('UPDATE orders SET status = ? WHERE id = ?', ['declined', req.params.id]);
  res.sendStatus(200);
});

// Send email
router.post('/send-email', isAdmin, async (req, res) => {
  const { to, subject, text } = req.body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'GGSALEMAN0001@gmail.com',
      pass: 'shliuhmkpvtkffkt'
    }
  });

  const mailOptions = {
    from: 'GGSALEMAN0001@gmail.com',
    to,
    subject,
    text
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: 'Email sent successfully' });
  } catch (error) {
    console.error('Email send error:', error);
    res.status(500).json({ message: 'Email sending failed' });
  }
});

// Get product by ID
router.get('/product/:id', isAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  res.json(rows[0] || null);
});

// Add or update a product
router.post('/product', isAdmin, async (req, res) => {
  const {
    id,
    name,
    description,
    price,
    image_url,
    email1,
    email2,
    password1,
    password2
  } = req.body;

  try {
    if (id) {
      // Update existing product
      await db.query(
        `UPDATE products SET name=?, description=?, price=?, image_url=?, email1=?, email2=?, password1=?, password2=? WHERE id=?`,
        [name, description, price, image_url, email1, email2, password1, password2, id]
      );
    } else {
      // Insert new product
      await db.query(
        `INSERT INTO products (name, description, price, image_url, email1, email2, password1, password2)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description, price, image_url, email1, email2, password1, password2]
      );
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Product save error:', err);
    res.status(500).json({ message: 'Server error saving product' });
  }
});

module.exports = router;
