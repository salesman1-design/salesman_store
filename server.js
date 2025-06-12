require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const multer = require('multer');
const tesseract = require('tesseract.js');
const db = require('./db');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 } });

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).send('Unauthorized');
}

// Public: List products
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Public: Place an order
app.post('/api/orders', async (req, res) => {
  const { productId, buyerEmail } = req.body;
  if (!productId || !buyerEmail) return res.status(400).json({ error: 'Missing productId or buyerEmail' });

  try {
    const buyerId = Math.random().toString(36).slice(2, 10).toUpperCase();
    const timestamp = new Date().toLocaleString();

    await db.query(
      'INSERT INTO orders (product_id, buyer_email, buyer_id, status, created_at) VALUES (?, ?, ?, ?, NOW())',
      [productId, buyerEmail, buyerId, 'pending']
    );

    const [[product]] = await db.query('SELECT * FROM products WHERE id = ?', [productId]);

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.OWNER_EMAIL,
      subject: `New Order from ${buyerEmail}`,
      html: `
        <h2>New Order Received</h2>
        <p><strong>Product:</strong> ${product.name}</p>
        <p><strong>Price:</strong> $${product.price}</p>
        <p><strong>Buyer Email:</strong> ${buyerEmail}</p>
        <p><strong>Buyer ID:</strong> ${buyerId}</p>
        <p><strong>Time:</strong> ${timestamp}</p>
      `
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: buyerEmail,
      subject: `Your Order for ${product.name}`,
      html: `
        <h2>Thank you for your order!</h2>
        <p><strong>Product:</strong> ${product.name}</p>
        <p><strong>Price:</strong> $${product.price}</p>
        <p><strong>Buyer ID:</strong> ${buyerId}</p>
        <p><strong>Time:</strong> ${timestamp}</p>
        <h3>Next Steps:</h3>
        <ol>
          <li>Open CashApp and send the payment to <strong>$fastfire9</strong></li>
          <li>Include your <strong>Buyer ID: ${buyerId}</strong> in the note</li>
          <li>Upload your screenshot on the site</li>
        </ol>
      `
    });

    res.json({ message: 'Order placed. Check your email.', buyerId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Order processing error' });
  }
});

// Admin: Login/Logout
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    String(username) === String(process.env.ADMIN_USERNAME) &&
    String(password) === String(process.env.ADMIN_PASSWORD)
  ) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/api/admin/logout', isAdmin, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Admin: View Orders
app.get('/api/admin/orders', isAdmin, async (req, res) => {
  try {
    const [orders] = await db.query(`
      SELECT o.id, o.buyer_email, o.buyer_id, o.status, o.created_at, p.name as product_name, p.price
      FROM orders o
      JOIN products p ON o.product_id = p.id
      ORDER BY o.created_at DESC
    `);
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Accept Order → Email + DELETE
app.post('/api/admin/orders/:orderId/accept', isAdmin, async (req, res) => {
  const orderId = req.params.orderId;
  try {
    const [[order]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: order.buyer_email,
      subject: 'Payment Instructions',
      text: `Hello,\n\nPlease send your payment to CashApp with this note:\nBuyer ID: ${order.buyer_id}\n\nThen upload your screenshot.`
    });

    await db.query('DELETE FROM orders WHERE id = ?', [orderId]); // ✅ deletes order
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept order' });
  }
});

// Decline Order → Delete
app.post('/api/admin/orders/:orderId/decline', isAdmin, async (req, res) => {
  const orderId = req.params.orderId;
  try {
    const [[order]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await db.query('DELETE FROM orders WHERE id = ?', [orderId]); // ✅ deletes order
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to decline order' });
  }
});

// Accept Sale → Send credentials + delete order
app.post('/api/admin/orders/:orderId/complete', isAdmin, async (req, res) => {
  const orderId = req.params.orderId;
  try {
    const [[order]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const [creds] = await db.query(
      'SELECT * FROM product_credentials WHERE product_id = ? AND assigned = false LIMIT 1',
      [order.product_id]
    );
    if (!creds.length) return res.status(400).json({ error: 'No available credentials' });

    const credential = creds[0];
    await db.query('UPDATE product_credentials SET assigned = true WHERE id = ?', [credential.id]);

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: order.buyer_email,
      subject: 'Your Credentials',
      text: `Thank you! Your credentials:\nEmail: ${credential.email}\nPassword: ${credential.password}`
    });

    await db.query('DELETE FROM orders WHERE id = ?', [orderId]); // ✅ deletes order
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete order' });
  }
});

// Add or Update Product
app.post('/api/admin/products', isAdmin, async (req, res) => {
  let { id, name, description, price, image_url, emailPasswords } = req.body;

  try {
    if (id) {
      const [[current]] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
      if (!current) return res.status(404).json({ error: 'Product not found' });

      name = name || current.name;
      description = description || current.description;
      price = price || current.price;
      image_url = image_url || current.image_url;

      await db.query(
        'UPDATE products SET name = ?, description = ?, price = ?, image_url = ? WHERE id = ?',
        [name, description, price, image_url, id]
      );

      if (Array.isArray(emailPasswords)) {
        for (let cred of emailPasswords) {
          await db.query(
            'INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)',
            [id, cred.email, cred.password]
          );
        }
      }

      return res.json({ success: true });
    } else {
      if (!name || !description || !price || !image_url) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const [result] = await db.query(
        'INSERT INTO products (name, description, price, image_url) VALUES (?, ?, ?, ?)',
        [name, description, price, image_url]
      );
      const productId = result.insertId;

      if (Array.isArray(emailPasswords)) {
        for (let cred of emailPasswords) {
          await db.query(
            'INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)',
            [productId, cred.email, cred.password]
          );
        }
      }

      return res.json({ success: true, productId });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save product' });
  }
});

// Delete Product
app.delete('/api/products/:id', isAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    await db.query('DELETE FROM product_credentials WHERE product_id = ?', [id]);
    await db.query('DELETE FROM products WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Get Product by ID (Admin Edit)
app.get('/api/admin/product/:id', isAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const [[product]] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [credentials] = await db.query('SELECT id, email, password FROM product_credentials WHERE product_id = ?', [id]);
    res.json({ ...product, credentials });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// OCR Upload
app.post('/api/upload-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const result = await tesseract.recognize(req.file.path, 'eng');
    const text = result.data.text;
    fs.unlink(req.file.path, () => {});

    const buyerIdMatch = text.match(/[A-Z0-9]{8}/);

    if (buyerIdMatch) {
      return res.json({
        success: true,
        message: 'Payment verified',
        buyerId: buyerIdMatch[0],
        rawText: text
      });
    } else {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.OWNER_EMAIL,
        subject: '⚠️ OCR Payment Verification Failed',
        text: `A screenshot was uploaded, but no Buyer ID was detected.\n\nOCR Text:\n${text}`
      });

      return res.json({
        success: false,
        message: 'Payment verification failed. Manual review required.',
        rawText: text
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'OCR failed' });
  }
});

// Serve static frontend & fallback
app.use(express.static('public'));
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.listen(PORT, () => {
  console.log(`🚗 Server is running on http://localhost:${PORT}`);
});
