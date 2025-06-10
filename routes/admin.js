// routes/admin.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Middleware to check admin session
function isAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    next();
  } else {
    res.status(403).send('Unauthorized');
  }
}

// Admin login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    req.session.admin = true;
    res.sendStatus(200);
  } else {
    res.sendStatus(401);
  }
});

// Admin logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin.html'));
});

// Get all pending orders
router.get('/orders', isAdmin, async (req, res) => {
  const [orders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(orders);
});

// Accept order (send CashApp instructions)
router.post('/orders/:id/accept', isAdmin, async (req, res) => {
  const orderId = req.params.id;
  const [orders] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = orders[0];

  if (!order) return res.sendStatus(404);

  await db.query('UPDATE orders SET status = "accepted" WHERE id = ?', [orderId]);

  const mailOptions = {
    from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
    to: order.email,
    subject: 'Payment Instructions - Salesman Empire',
    text: `Please pay $${order.price} to our CashApp and upload the screenshot with your Buyer ID: ${order.buyer_id}`,
  };

  await transporter.sendMail(mailOptions);
  res.sendStatus(200);
});

// Deliver credentials (final approval)
router.post('/orders/:id/deliver', isAdmin, async (req, res) => {
  const orderId = req.params.id;
  const [orders] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = orders[0];

  if (!order) return res.sendStatus(404);

  const [products] = await db.query('SELECT * FROM products WHERE id = ?', [order.product_id]);
  const product = products[0];
  if (!product) return res.sendStatus(404);

  await db.query('UPDATE orders SET status = "completed" WHERE id = ?', [orderId]);

  const mailOptions = {
    from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
    to: order.email,
    subject: 'Your Product from Salesman Empire',
    text: `Thank you for your payment!\n\nHere are your product credentials:\n\nEmail 1: ${product.email1}\nPassword 1: ${product.password1}\n\nEmail 2: ${product.email2}\nPassword 2: ${product.password2}\n\nEnjoy!\n— Salesman Empire Team`,
  };

  await transporter.sendMail(mailOptions);
  res.sendStatus(200);
});

module.exports = router;
