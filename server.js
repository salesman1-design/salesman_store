require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const tesseract = require('tesseract.js');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// Configure multer for screenshot uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

// Nodemailer setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Middleware to protect admin routes
function isAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).send('Unauthorized');
}

// ============ ROUTES ==============

// GET /api/products - list all products
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products');
    // rows should be an array of product objects
    res.json(rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// POST /api/order - place an order
app.post('/api/order', async (req, res) => {
  const { productId, buyerEmail } = req.body;
  if (!productId || !buyerEmail) return res.status(400).json({ error: 'Missing productId or buyerEmail' });

  try {
    // Generate a random buyer ID (8 chars alphanumeric)
    const buyerId = Math.random().toString(36).slice(2, 10).toUpperCase();

    // Insert order into DB with status 'pending'
    await db.query(
      'INSERT INTO orders (product_id, buyer_email, buyer_id, status, created_at) VALUES (?, ?, ?, ?, NOW())',
      [productId, buyerEmail, buyerId, 'pending']
    );

    // Get product details
    const [[product]] = await db.query('SELECT * FROM products WHERE id = ?', [productId]);

    // Send email to owner/admin with order info
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: process.env.OWNER_EMAIL,
      subject: `New order from ${buyerEmail}`,
      text: `New order details:\nProduct: ${product.name}\nPrice: $${product.price}\nBuyer Email: ${buyerEmail}\nBuyer ID: ${buyerId}\n\nPlease wait for payment verification instructions.`,
    };
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Error sending order email:', err);
      else console.log('Order email sent:', info.response);
    });

    // Respond to buyer with next steps
    res.json({
      message: `Thank you for your order! Your buyer ID is ${buyerId}. Please send payment with this ID in the CashApp note.`,
      buyerId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Order processing error' });
  }
});

// POST /api/admin/login - admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// POST /api/admin/logout - admin logout
app.post('/api/admin/logout', isAdmin, (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// GET /api/admin/orders - admin view all orders
app.get('/api/admin/orders', isAdmin, async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT o.id, o.buyer_email, o.buyer_id, o.status, o.created_at, p.name as product_name
       FROM orders o
       JOIN products p ON o.product_id = p.id
       ORDER BY o.created_at DESC`
    );
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// POST /api/admin/orders/:orderId/accept - accept order and send payment instructions
app.post('/api/admin/orders/:orderId/accept', isAdmin, async (req, res) => {
  const orderId = req.params.orderId;

  try {
    // Get order info
    const [[order]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Update status to 'accepted'
    await db.query('UPDATE orders SET status = ? WHERE id = ?', ['accepted', orderId]);

    // Send payment instructions to buyer
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: order.buyer_email,
      subject: 'Payment Instructions',
      text: `Hello,\n\nPlease send your payment to CashApp with the following note:\nBuyer ID: ${order.buyer_id}\n\nAfter payment, upload your screenshot for verification.`,
    };
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Error sending payment instructions:', err);
      else console.log('Payment instructions email sent:', info.response);
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept order' });
  }
});

// POST /api/admin/orders/:orderId/complete - accept sale, assign credentials and notify buyer
app.post('/api/admin/orders/:orderId/complete', isAdmin, async (req, res) => {
  const orderId = req.params.orderId;

  try {
    // Get order and product info
    const [[order]] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Fetch unassigned credentials for this product
    const [creds] = await db.query(
      'SELECT * FROM product_credentials WHERE product_id = ? AND assigned = false LIMIT 1',
      [order.product_id]
    );

    if (creds.length === 0) {
      return res.status(400).json({ error: 'No available credentials for this product' });
    }

    const credential = creds[0];

    // Mark credential as assigned
    await db.query('UPDATE product_credentials SET assigned = true WHERE id = ?', [credential.id]);

    // Update order status
    await db.query('UPDATE orders SET status = ? WHERE id = ?', ['completed', orderId]);

    // Send credentials to buyer email
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: order.buyer_email,
      subject: 'Your Purchase Credentials',
      text: `Thank you for your purchase!\n\nHere are your credentials:\nEmail: ${credential.email}\nPassword: ${credential.password}\n\nEnjoy!`,
    };
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) console.error('Error sending credentials email:', err);
      else console.log('Credentials email sent:', info.response);
    });

    res.json({ success: true, assignedCredential: credential });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete order' });
  }
});

// POST /api/admin/products - add or update product
app.post('/api/admin/products', isAdmin, async (req, res) => {
  const { id, name, description, price, image, emailPasswords } = req.body;

  if (!name || !description || !price || !image) {
    return res.status(400).json({ error: 'Missing required product fields' });
  }

  try {
    if (id) {
      // Update product
      await db.query(
        'UPDATE products SET name = ?, description = ?, price = ?, image = ? WHERE id = ?',
        [name, description, price, image, id]
      );
      // Update credentials for product
      if (Array.isArray(emailPasswords)) {
        for (let cred of emailPasswords) {
          if (cred.id) {
            await db.query(
              'UPDATE product_credentials SET email = ?, password = ? WHERE id = ?',
              [cred.email, cred.password, cred.id]
            );
          } else {
            await db.query(
              'INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)',
              [id, cred.email, cred.password]
            );
          }
        }
      }
      return res.json({ success: true, message: 'Product updated' });
    } else {
      // Insert new product
      const [result] = await db.query(
        'INSERT INTO products (name, description, price, image) VALUES (?, ?, ?, ?)',
        [name, description, price, image]
      );
      const productId = result.insertId;

      // Insert credentials if provided
      if (Array.isArray(emailPasswords)) {
        for (let cred of emailPasswords) {
          await db.query(
            'INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)',
            [productId, cred.email, cred.password]
          );
        }
      }
      return res.json({ success: true, message: 'Product added', productId });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add/update product' });
  }
});

// POST /api/upload-screenshot - buyer uploads screenshot for payment verification
app.post('/api/upload-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    // Run OCR on uploaded image
    const result = await tesseract.recognize(req.file.path, 'eng');
    const text = result.data.text;

    // For demo, simple check if buyer ID or payment info is mentioned
    // You can customize your verification logic here

    // Clean up uploaded file
    const fs = require('fs');
    fs.unlink(req.file.path, () => {});

    // Example: check if text contains buyer ID format (e.g. 8 chars alphanumeric)
    const buyerIdMatch = text.match(/[A-Z0-9]{8}/);
    if (buyerIdMatch) {
      return res.json({ success: true, message: 'Payment verified', buyerId: buyerIdMatch[0], rawText: text });
    } else {
      return res.json({ success: false, message: 'Payment verification failed', rawText: text });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'OCR processing failed' });
  }
});


app.listen(PORT, () => {
  console.log(`🚗 Server is running on http://localhost:${PORT}`);
});
