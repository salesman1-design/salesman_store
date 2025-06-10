const express = require('express');
const router = express.Router();
const db = require('../db');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

// Load environment variables
const {
  OWNER_EMAIL,
  SMTP_USER,
  SMTP_PASS,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE
} = process.env;

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: parseInt(SMTP_PORT),
  secure: SMTP_SECURE === 'true',
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
});

// Handle placing an order
router.post('/place-order', async (req, res) => {
  const { product_id, buyer_email, buyer_id } = req.body;

  try {
    const [productRows] = await db.query('SELECT * FROM products WHERE id = ?', [product_id]);
    if (productRows.length === 0) return res.status(404).json({ error: 'Product not found' });

    const product = productRows[0];

    // Insert order into database
    await db.query(
      'INSERT INTO orders (product_id, buyer_email, buyer_id, status) VALUES (?, ?, ?, ?)',
      [product_id, buyer_email, buyer_id, 'pending']
    );

    // Email admin
    await transporter.sendMail({
      from: SMTP_USER,
      to: OWNER_EMAIL,
      subject: 'New Order Received',
      text: `New order:\nProduct: ${product.name}\nBuyer Email: ${buyer_email}\nBuyer ID: ${buyer_id}`
    });

    // Email buyer
    await transporter.sendMail({
      from: SMTP_USER,
      to: buyer_email,
      subject: 'Your Order Request Received',
      text: `Thank you for your order!\n\nProduct: ${product.name}\nPrice: $${product.price}\n\nYour Buyer ID: ${buyer_id}\nInclude this in the CashApp note.\nUpload a payment screenshot on our site after payment.`
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error placing order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload and OCR CashApp screenshot
router.post('/verify-payment/:order_id', async (req, res) => {
  const { order_id } = req.params;
  if (!req.files || !req.files.screenshot) {
    return res.status(400).json({ error: 'No screenshot uploaded' });
  }

  const screenshot = req.files.screenshot;
  const tempPath = path.join(__dirname, '../uploads', `${Date.now()}-${screenshot.name}`);

  // Save file to uploads/
  await screenshot.mv(tempPath);

  try {
    // Extract text using OCR
    const { data: { text } } = await Tesseract.recognize(tempPath, 'eng');

    // Store verification text in DB
    await db.query(
      'UPDATE orders SET screenshot_text = ?, screenshot_path = ? WHERE id = ?',
      [text, tempPath, order_id]
    );

    res.status(200).json({ success: true, text });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(500).json({ error: 'OCR failed' });
  }
});

module.exports = router;
