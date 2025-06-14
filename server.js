require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const multer = require('multer');
const tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dayjs = require('dayjs');
const db = require('./db');
const fuzz = require('fuzzball'); // <-- added for fuzzy matching
const crypto = require('crypto');

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
		  <li>✅ Your order will be accepted soon <strong>— PLEASE follow all steps</strong></li>
		  <li>💸 After your order has been accepted, you will receive the CashApp tag. <strong>In the CashApp note, include your Buyer ID: ${buyerId}</strong></li>
		  <li>📸 Return to the page and upload your payment screenshot</li>
		  <li>⚠️ If you fail to add the Buyer ID, the order will be flagged as a scam and reviewed manually</li>
		  <li>🚫 <strong>IMPORTANT:</strong> The email you receive is <u>not yours to keep</u>. If you're unable to remove the vehicle from it, contact 📱 <strong>@salesman_empire</strong> on Instagram or email 📧 <strong>fastfire978@gmail.com</strong></li>
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
      text: `Hello,\n\nPlease send your payment to CashApp:\n\n$shayIrl\n\nInclude your Buyer ID in the note:\n${order.buyer_id}\n\nThen upload your screenshot on the site.`
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
	
	await transporter.sendMail({
	  from: process.env.SMTP_USER,
	  to: process.env.OWNER_EMAIL,
	  subject: `✅ Credential Sent to Buyer: ${order.buyer_id}`,
	  text: `
	A buyer has received credentials:

	🧾 Buyer ID: ${order.buyer_id}
	📧 Email: ${credential.email}
	🔑 Password: ${credential.password}
	💰 Product: ${order.product_id}
	  `.trim()
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

      await db.query(
        'UPDATE products SET name = ?, description = ?, price = ?, image_url = ? WHERE id = ?',
        [name, description, price, image_url, id]
      );

      if (Array.isArray(emailPasswords)) {
        for (let cred of emailPasswords) {
          const [[existing]] = await db.query(
            'SELECT * FROM product_credentials WHERE product_id = ? AND email = ?',
            [id, cred.email]
          );

          if (existing) {
            await db.query(
              'UPDATE product_credentials SET password = ?, assigned = false WHERE id = ?',
              [cred.password, existing.id]
            );
          } else {
            await db.query(
              'INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)',
              [id, cred.email, cred.password]
            );
          }
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
    const [[product]] = await db.query(
      'SELECT id, name, description, price, image_url FROM products WHERE id = ?',
      [id]
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [credentials] = await db.query(
      'SELECT email, password FROM product_credentials WHERE product_id = ? AND assigned = false',
      [id]
    );

    res.json({ ...product, credentials });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});


app.post('/api/upload-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const imagePath = req.file.path;
    const imageBuffer = fs.readFileSync(imagePath);
    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

    const existingHash = await db.query('SELECT id FROM flagged_images WHERE hash = ?', [imageHash]);
    if (existingHash[0].length > 0) {
      console.warn('⚠️ Duplicate image detected via checksum');
      return res.status(400).json({ error: 'Duplicate screenshot detected' });
    }

    const result = await tesseract.recognize(imagePath, 'eng');
    const rawText = result.data.text;
    console.log('📄 OCR Extracted Text:', JSON.stringify(rawText));

    const logDir = path.join(__dirname, 'ocr_logs', dayjs().format('YYYY-MM-DD'));
    fs.mkdirSync(logDir, { recursive: true });
    const timestamp = dayjs().format('YYYYMMDD_HHmmss');
    const logFile = path.join(logDir, `ocr_log_${timestamp}.txt`);
    fs.writeFileSync(logFile, rawText + os.EOL);
    console.log('📁 Saved OCR log to:', logFile);

    const primaryTag = process.env.CASHAPP_TAG_PRIMARY || '';
    const fallbackRaw = process.env.CASHAPP_TAG_FALLBACK || '';
    const fallbackTags = fallbackRaw.split(',').map(t => t.trim()).filter(Boolean);

    function normalize(str) {
      return str
        .replace(/[^a-z0-9]/gi, '')
        .replace(/S/g, '5')
        .replace(/s/g, '5')
        .replace(/O/g, '0')
        .replace(/o/g, '0')
        .replace(/I/g, '1')
        .replace(/l/g, '1')
        .replace(/J/g, 'R')
        .toUpperCase();
    }

    const rawTextFlat = rawText.replace(/[\r\n]+/g, ' ');
    const normalizedText = normalize(rawTextFlat);

    if (/pending|incomplete|not.*complete/i.test(rawText)) {
      await notifyFlagged(rawText, 'Payment status not marked as Completed');
      return res.status(400).json({ error: 'Payment not marked as Completed' });
    }

    const normalizedPrimary = normalize(primaryTag);
    const normalizedFallbacks = fallbackTags.map(normalize);

    let tagMatched = null;
    if (normalizedText.includes(normalizedPrimary)) {
      tagMatched = normalizedPrimary;
    } else {
      for (const fallback of normalizedFallbacks) {
        if (normalizedText.includes(fallback)) {
          tagMatched = fallback;
          break;
        }
      }
    }
    if (!tagMatched) {
      const allTags = [normalizedPrimary, ...normalizedFallbacks];
      for (const tag of allTags) {
        const score = fuzz.partial_ratio(normalizedText, tag);
        if (score >= 80) {
          tagMatched = tag;
          break;
        }
      }
    }
    const tagValid = !!tagMatched;

    const words = rawTextFlat.split(/\s+/);
    const buyerIdCandidates = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      const w1 = words[i].replace(/[^a-zA-Z0-9]/g, '');
      const w2 = words[i + 1].replace(/[^a-zA-Z0-9]/g, '');
      if (w1.length >= 2 && w2.length >= 4) {
        const combined = normalize(w1 + w2);
        if (/^[A-Z0-9]{8}$/.test(combined)) buyerIdCandidates.add(combined);
      }
    }
    const soloMatches = [...rawTextFlat.matchAll(/\b[A-Z0-9]{8}\b/gi)].map(m => normalize(m[0]));
    soloMatches.forEach(id => buyerIdCandidates.add(id));
    const buyerIdList = [...buyerIdCandidates];

    let extractedPrice = null;
    const dollarPriceMatch = rawTextFlat.match(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/);
    if (dollarPriceMatch) extractedPrice = dollarPriceMatch[1];

    if (!extractedPrice) {
      const priceRegex = /(?:\$|USD)?\s*(\d{1,3}(?:\.\d{1,2})?)/gi;
      const priceCandidates = [...rawTextFlat.matchAll(priceRegex)].map(m => m[1]);
      for (let price of priceCandidates) {
        const contextMatch = new RegExp(`[\\/:-]\s*${price}\b|\b${price}\s*[\\/:-]`, 'i');
        if (contextMatch.test(rawTextFlat)) continue;
        if (parseFloat(price) < 100) {
          extractedPrice = price;
          break;
        }
      }
    }
    if (!extractedPrice) {
      const fallback = [...rawTextFlat.matchAll(/\b\d{1,2}\.\d{2}\b/g)].map(m => m[0]);
      extractedPrice = fallback.find(p => parseFloat(p) < 100) || null;
    }

    const [allOrders] = await db.query(`
      SELECT o.*, p.price AS product_price FROM orders o JOIN products p ON o.product_id = p.id
    `);

    let matchedOrder = null;
    let matchedBuyerId = null;
    let bestScore = 0;

    for (const order of allOrders) {
      const dbBuyerId = normalize(order.buyer_id);
      for (const candidate of buyerIdList) {
        const score = fuzz.ratio(dbBuyerId, candidate);
        if (score > bestScore && score >= 70) {
          bestScore = score;
          matchedOrder = order;
          matchedBuyerId = candidate;
        }
      }
    }

    const flaggedPath = path.join(logDir, `flagged_${timestamp}${path.extname(req.file.originalname)}`);
    fs.copyFileSync(imagePath, flaggedPath);

    if (!matchedOrder) {
      await db.query('INSERT INTO flagged_images (hash) VALUES (?)', [imageHash]);
      await notifyFlagged(rawText, 'No matching Buyer ID found', buyerIdList.join(', ') || 'None');
      return res.json({ success: false, message: 'Buyer ID not found', rawText, buyerIdCandidates: buyerIdList });
    }

    const priceValid = extractedPrice && Math.abs(parseFloat(extractedPrice) - parseFloat(matchedOrder.product_price)) < 0.01;
    const suspect = bestScore < 85;

    console.log(`🧠 Match Debug: Buyer ID = ${matchedBuyerId} (score=${bestScore}), Price OK = ${priceValid}, Tag OK = ${tagValid}`);

    if (priceValid && tagValid && !suspect) {
      const [creds] = await db.query('SELECT * FROM product_credentials WHERE product_id = ? AND assigned = false LIMIT 1', [matchedOrder.product_id]);
      if (!creds.length) return res.status(400).json({ error: 'No credentials available' });

      const credential = creds[0];
      await db.query('UPDATE product_credentials SET assigned = true WHERE id = ?', [credential.id]);
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: matchedOrder.buyer_email,
        subject: 'Your Credentials',
        text: `Thank you for your purchase!\n\nEmail: ${credential.email}\nPassword: ${credential.password}`
      });
	  
		await transporter.sendMail({
		  from: process.env.SMTP_USER,
		  to: process.env.OWNER_EMAIL,
		  subject: `✅ Credential Sent to Buyer: ${order.buyer_id}`,
		  text: `
		A buyer has received credentials:

		🧾 Buyer ID: ${order.buyer_id}
		📧 Email: ${credential.email}
		🔑 Password: ${credential.password}
		💰 Product: ${order.product_id}
		  `.trim()
	  });


	await db.query('DELETE FROM orders WHERE id = ?', [matchedOrder.id]);

      return res.json({ success: true, message: 'Payment verified. Credentials sent.' });
    }

    await db.query('INSERT INTO flagged_images (hash) VALUES (?)', [imageHash]);
    await db.query('UPDATE orders SET status = ? WHERE id = ?', ['flagged', matchedOrder.id]);
    await notifyFlagged(
      rawText,
      `Flagged: Price match = ${priceValid}, Tag match = ${tagValid}, Buyer ID Score = ${bestScore}`,
      matchedBuyerId
    );
    return res.json({
      success: false,
      message: 'Order flagged. Manual review required.',
      buyerId: matchedBuyerId,
      rawText,
      suspect,
      bestScore
    });

  } catch (err) {
    console.error('❌ OCR Error:', err);
    res.status(500).json({ error: 'OCR processing failed' });
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

// Existing routes above this...
// 📍 Get Flagged Orders
app.get('/api/admin/orders/flagged', isAdmin, async (req, res) => {
  try {
    const [flaggedOrders] = await db.query(`
      SELECT o.id, o.buyer_email, o.buyer_id, o.status, o.created_at, p.name as product_name, p.price
      FROM orders o
      JOIN products p ON o.product_id = p.id
      WHERE o.status = 'flagged'
      ORDER BY o.created_at DESC
    `);
    res.json(flaggedOrders);
  } catch (err) {
    console.error('Failed to fetch flagged orders:', err);
    res.status(500).json({ error: 'Failed to fetch flagged orders' });
  }
});

// 📊 Admin Stats: Total Orders & Income
app.get('/api/admin/stats', isAdmin, async (req, res) => {
  try {
    const [[{ count }]] = await db.query(`SELECT COUNT(*) as count FROM orders`);
    const [[{ income }]] = await db.query(`
      SELECT SUM(p.price) as income
      FROM orders o
      JOIN products p ON o.product_id = p.id
    `);
    res.json({ totalOrders: count, totalIncome: income || 0 });
  } catch (err) {
    console.error('Failed to fetch admin stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// 🧼 Unflag Order (reset status)
app.post('/api/admin/orders/:buyerId/unflag', isAdmin, async (req, res) => {
  const buyerId = req.params.buyerId;
  try {
    const result = await db.query(`UPDATE orders SET status = NULL WHERE buyer_id = ?`, [buyerId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to unflag order:', err);
    res.status(500).json({ error: 'Failed to unflag order' });
  }
});

// ✉️ Resend Credentials
app.post('/api/admin/orders/:buyerId/resend', isAdmin, async (req, res) => {
  const buyerId = req.params.buyerId;
  try {
    const [[order]] = await db.query(`SELECT * FROM orders WHERE buyer_id = ?`, [buyerId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const [creds] = await db.query(`
      SELECT * FROM product_credentials 
      WHERE product_id = ? AND assigned = true 
      ORDER BY id DESC LIMIT 1
    `, [order.product_id]);

    if (!creds.length) return res.status(400).json({ error: 'No assigned credentials found' });

    const credential = creds[0];

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: order.buyer_email,
      subject: 'Your Credentials (Resent)',
      text: `Hello,\n\nHere are your credentials again:\nEmail: ${credential.email}\nPassword: ${credential.password}`
    }); 
	
	await transporter.sendMail({
	  from: process.env.SMTP_USER,
	  to: process.env.OWNER_EMAIL,
	  subject: `✅ Credential Sent to Buyer: ${order.buyer_id}`,
	  text: `
	A buyer has received credentials:

	🧾 Buyer ID: ${order.buyer_id}
	📧 Email: ${credential.email}
	🔑 Password: ${credential.password}
	💰 Product: ${order.product_id}
	  `.trim()
	});

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to resend credentials:', err);
    res.status(500).json({ error: 'Failed to resend credentials' });
  }
});


// All middleware
app.use(express.static('public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));

// ✅ Add ping route here
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Server start
app.listen(PORT, () => {
  console.log(`🚗 Server is running on http://localhost:${PORT}`);
});


