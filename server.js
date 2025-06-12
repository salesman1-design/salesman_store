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

// Products
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

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
          <li>Send payment to <strong>$fastfire9</strong></li>
          <li>Include Buyer ID: <strong>${buyerId}</strong> in the note</li>
          <li>Upload your screenshot</li>
        </ol>
      `
    });

    res.json({ message: 'Order placed. Check your email.', buyerId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Order processing error' });
  }
});

// Admin
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

// Accept Order — sends CashApp link, does NOT delete
app.post('/api/admin/orders/:buyerId/accept', isAdmin, async (req, res) => {
  const buyerId = req.params.buyerId;
  try {
    const [[order]] = await db.query('SELECT * FROM orders WHERE buyer_id = ?', [buyerId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: order.buyer_email,
      subject: 'Payment Instructions',
      text: `Hello,\n\nPlease send your payment to CashApp:\n\n$fastfire9\n\nInclude your Buyer ID in the note:\n${order.buyer_id}\n\nThen upload your screenshot on the site.`
    });

    res.json({ success: true }); // ✅ DO NOT delete order
  } catch (err) {
    console.error('Accept Order Error:', err);
    res.status(500).json({ error: 'Failed to accept order' });
  }
});

// Decline Order — sends email + deletes
app.post('/api/admin/orders/:buyerId/decline', isAdmin, async (req, res) => {
  const buyerId = req.params.buyerId;

  try {
    const [[order]] = await db.query('SELECT * FROM orders WHERE buyer_id = ?', [buyerId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: order.buyer_email,
      subject: 'Order Declined',
      text: `Hello,\n\nYour order with Buyer ID ${order.buyer_id} has been declined.\nIf this was a mistake or you believe you paid, please contact support.`
    });

    await db.query('DELETE FROM orders WHERE buyer_id = ?', [buyerId]);

    res.json({ success: true });
  } catch (err) {
    console.error('Decline Order Error:', err);
    res.status(500).json({ error: 'Failed to decline order' });
  }
});

// Complete Order — sends credentials + deletes
app.post('/api/admin/orders/:buyerId/complete', isAdmin, async (req, res) => {
  const buyerId = req.params.buyerId;
  try {
    const [[order]] = await db.query('SELECT * FROM orders WHERE buyer_id = ?', [buyerId]);
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
      text: `Thank you for your purchase!\n\nHere are your credentials:\nEmail: ${credential.email}\nPassword: ${credential.password}`
    });

    await db.query('DELETE FROM orders WHERE buyer_id = ?', [buyerId]); // ✅ fixed here
    res.json({ success: true });
  } catch (err) {
    console.error('Complete Order Error:', err);
    res.status(500).json({ error: 'Failed to complete order' });
  }
});


// Add or Update Product
app.post('/api/admin/products', isAdmin, async (req, res) => {
  let { id, name, description, price, image, image_url, emailPasswords } = req.body;
  image_url = image_url || image || '';

  try {
    if (id) {
      const [[current]] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
      if (!current) return res.status(404).json({ error: 'Product not found' });

      name = name || current.name;
      description = description || current.description;
      price = price || current.price;

      await db.query('UPDATE products SET name = ?, description = ?, price = ?, image_url = ? WHERE id = ?', [name, description, price, image_url, id]);

      if (Array.isArray(emailPasswords)) {
        for (let cred of emailPasswords) {
          await db.query('INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)', [id, cred.email, cred.password]);
        }
      }

      return res.json({ success: true });
    } else {
      if (!name || !description || !price || !image_url) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const [result] = await db.query('INSERT INTO products (name, description, price, image_url) VALUES (?, ?, ?, ?)', [name, description, price, image_url]);
      const productId = result.insertId;

      if (Array.isArray(emailPasswords)) {
        for (let cred of emailPasswords) {
          await db.query('INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)', [productId, cred.email, cred.password]);
        }
      }

      return res.json({ success: true, productId });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save product' });
  }
});

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

app.post('/api/upload-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const result = await tesseract.recognize(req.file.path, 'eng');
    const rawText = result.data.text;
    fs.unlink(req.file.path, () => {});
    console.log('📄 OCR Extracted Text:', JSON.stringify(rawText));

    // Normalize function
    function normalize(text) {
      return text
        .replace(/[^a-z0-9]/gi, '')       // remove non-alphanumerics
        .replace(/S/g, '5')               // S → 5
        .replace(/O/g, '0')               // O → 0
        .replace(/I/g, '1')               // I → 1
        .toUpperCase();
    }

    // Extract buyer ID candidates
    const buyerIdMatches = [...rawText.matchAll(/\b[A-Z0-9]{8}\b/g)];
    const buyerIdCandidates = buyerIdMatches.map(m => normalize(m[0]));

    // Extract price
    const priceMatch = rawText.match(/[$S]?\s*(\d+(\.\d{1,2})?)/);
    const extractedPrice = priceMatch?.[1] || null;

    // CashApp tag check
    const tagValid = /[$S][fF]astfire9/.test(rawText);

    let matchedOrder = null;
    let matchedBuyerId = null;

    // Try each candidate
    for (const candidate of buyerIdCandidates) {
      const [[order]] = await db.query(`
        SELECT o.*, p.price 
        FROM orders o 
        JOIN products p ON o.product_id = p.id 
        WHERE o.buyer_id = ?
      `, [candidate]);

      if (order) {
        matchedOrder = order;
        matchedBuyerId = candidate;
        break;
      }
    }

    if (!matchedOrder) {
      await notifyFlagged(rawText, 'No matching Buyer ID found', buyerIdCandidates.join(', '));
      return res.json({ success: false, message: 'Buyer ID not found', rawText });
    }

    // Price match (within a few cents)
    const priceValid =
      extractedPrice &&
      Math.abs(parseFloat(extractedPrice) - parseFloat(matchedOrder.price)) < 0.01;

    if (priceValid && tagValid) {
      const [creds] = await db.query(`
        SELECT * FROM product_credentials 
        WHERE product_id = ? AND assigned = false LIMIT 1
      `, [matchedOrder.product_id]);

      if (!creds.length) {
        return res.status(400).json({ error: 'No credentials available' });
      }

      const credential = creds[0];
      await db.query('UPDATE product_credentials SET assigned = true WHERE id = ?', [credential.id]);

      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: matchedOrder.buyer_email,
        subject: 'Your Credentials',
        text: `Email: ${credential.email}\nPassword: ${credential.password}`
      });

      await db.query('DELETE FROM orders WHERE id = ?', [matchedOrder.id]);

      return res.json({ success: true, message: 'Payment verified. Credentials sent.' });
    } else {
      await db.query('UPDATE orders SET status = ? WHERE id = ?', ['flagged', matchedOrder.id]);
      await notifyFlagged(rawText, `Flagged: Price match: ${priceValid}, Tag match: ${tagValid}`, matchedBuyerId);
      return res.json({ success: false, message: 'Order flagged. Manual review required.', buyerId: matchedBuyerId });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'OCR failed' });
  }
});


async function notifyFlagged(ocrText, reason, buyerId = 'UNKNOWN') {
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.OWNER_EMAIL,
    subject: '🚨 OCR Payment Flagged',
    text: `Buyer ID: ${buyerId}\nReason: ${reason}\n\nFull OCR Text:\n${ocrText}`
  });
}

app.use(express.static('public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

app.listen(PORT, () => {
  console.log(`🚗 Server is running on http://localhost:${PORT}`);
});
