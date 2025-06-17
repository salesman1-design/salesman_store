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
const exif = require('exif-parser');
const sharp = require('sharp');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));


const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true', // should now be 'true' in .env with port 465
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
	  from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
	  to: process.env.OWNER_EMAIL,
	  subject: `🆕 New Order for ${product.name}`,
	  html: `
		<h2>📦 New Order Received</h2>
		<p><strong>Product:</strong> ${product.name}</p>
		<p><strong>Product ID:</strong> ${product.id}</p>
		<p><strong>Price:</strong> $${product.price}</p>
		<p><strong>Buyer Email:</strong> ${buyerEmail}</p>
		<p><strong>Buyer ID:</strong> ${buyerId}</p>
		<p><strong>Time:</strong> ${timestamp}</p>
	  `
	});

	await transporter.sendMail({
	  from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
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

// Admin Stats: Total Sales and Revenue
app.get('/api/admin/stats', isAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT COUNT(*) AS totalSales, SUM(p.price) AS totalRevenue
      FROM product_credentials pc
      JOIN products p ON pc.product_id = p.id
      WHERE pc.assigned = true
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('Stats Error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
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
	  from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
	  to: order.buyer_email,
	  subject: 'Payment Instructions',
	  text: `
	Hello,

	Please send your payment to CashApp:
	$shayIrl

	Include your Buyer ID in the note:
	${order.buyer_id}

	Then upload your screenshot on the site.

	Thank you,
	Salesman Empire
	`.trim()
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
	  from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
	  to: order.buyer_email,
	  subject: '❌ Your Order Has Been Declined',
	  text: `
	Hello,

	Unfortunately, your order has been declined.

	🧾 Buyer ID: ***${order.buyer_id}***

	If you believe this is a mistake or if you've already made a payment, please reach out to us for assistance.

	📧 Email: fastfire978@gmail.com  
	📱 Instagram: @salesman_empire

	Thank you for your understanding,  
	Salesman Empire
	  `.trim()
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
	  from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
	  to: order.buyer_email,
	  subject: 'Your Purchase Details & Login Credentials',
	  text: `
	Thank you for your purchase!

	Here are your credentials:

	Email: ${credential.email}
	Password: ${credential.password}

	⚠️ Please remember: This account is not yours to keep. Use it as instructed and do not change the password unless told.

	If you have any issues, contact us at fastfire978@gmail.com or on Instagram @salesman_empire.

	– Salesman Empire
	`.trim()
	});
	
	await transporter.sendMail({
	  from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
	  to: process.env.OWNER_EMAIL,
	  subject: `✅ Credential Sent: Buyer ID ${order.buyer_id}`,
	  text: `
	A buyer has been sent credentials.

	🧾 Buyer ID: ${order.buyer_id}
	📧 Email: ${credential.email}
	🔑 Password: ${credential.password}
	💰 Product ID: ${order.product_id}

	– Salesman Empire Bot
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

  function generateRandomPassword(length = 10) {
    const charset = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$_';
    let pass = '';
    for (let i = 0; i < length; i++) {
      pass += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return pass;
  }

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

      return res.json({ success: true, updated: true });
    } else {
      if (!name || !description || !price || !image_url) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const [result] = await db.query(
        'INSERT INTO products (name, description, price, image_url) VALUES (?, ?, ?, ?)',
        [name, description, price, image_url]
      );
      const productId = result.insertId;

      // ✅ Auto-generate 2 default credentials in correct alias format
      if (!Array.isArray(emailPasswords) || emailPasswords.length === 0) {
        const [[{ maxAlias } = { maxAlias: 0 }]] = await db.query(`
          SELECT MAX(CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(email, '+', -1), '@', 1) AS UNSIGNED)) AS maxAlias
          FROM product_credentials
          WHERE email LIKE 'salesmanempiremain+%@gmail.com'
        `);

        const next1 = (maxAlias || 0) + 1;
        const next2 = next1 + 1;

        emailPasswords = [
          {
            email: `salesmanempiremain+${String(next1).padStart(3, '0')}@gmail.com`,
            password: generateRandomPassword()
          },
          {
            email: `salesmanempiremain+${String(next2).padStart(3, '0')}@gmail.com`,
            password: generateRandomPassword()
          }
        ];
      }

      for (let cred of emailPasswords) {
        await db.query(
          'INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)',
          [productId, cred.email, cred.password]
        );
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

// Multer setup for memory upload
const upload = multer({ storage: multer.memoryStorage() });

async function notifyFlaggedImageEmail({
  rawText,
  reason,
  buyerIds,
  bestScore,
  tagMatch,
  priceMatch,
  imageBuffer,
  filename
}) {
  const message = `
🚩 OCR FLAGGED IMAGE DETECTED

🔍 Reason: ${reason}
🧾 Buyer ID(s): ${buyerIds || 'None'}
📊 Buyer Match Score: ${bestScore || 'N/A'}
🏷️ Tag Matched: ${tagMatch ? '✅ Yes' : '❌ No'}
💵 Price Matched: ${priceMatch ? '✅ Yes' : '❌ No'}

📄 OCR Extracted Text:
========================
${rawText}
========================
`.trim();

  await transporter.sendMail({
    from: `"Salesman Empire OCR Bot" <${process.env.SMTP_USER}>`,
    to: process.env.OWNER_EMAIL,
    subject: '🚨 OCR Flagged Screenshot',
    text: message,
    attachments: [
      {
        filename: filename || 'flagged_screenshot.png',
        content: imageBuffer
      }
    ]
  });
}


app.post('/api/upload-screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const imageBuffer = req.file.buffer;
    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

    const logDir = path.join(__dirname, 'ocr_logs', dayjs().format('YYYY-MM-DD'));
    fs.mkdirSync(logDir, { recursive: true });
    const timestamp = dayjs().format('YYYYMMDD_HHmmss');
    const flaggedPath = path.join(logDir, `flagged_${timestamp}${path.extname(req.file.originalname)}`);
    fs.writeFileSync(flaggedPath, imageBuffer); // Save flagged image for log

    const [duplicateCheck] = await db.query('SELECT id FROM flagged_images WHERE hash = ?', [imageHash]);

    const exifData = exif.create(imageBuffer).parse();
    const metadata = await sharp(imageBuffer).metadata();
    const entropyCheck = metadata.entropy || 0;
    const isTampered = entropyCheck < 3 || !exifData.tags || Object.keys(exifData.tags).length === 0;

    const result = await tesseract.recognize(imageBuffer, 'eng');
    const rawText = result.data.text;
    const rawTextFlat = rawText.replace(/[\r\n]+/g, ' ');

    const normalize = (str) => str
      .replace(/[^a-z0-9]/gi, '')
      .replace(/S/g, '5')
      .replace(/s/g, '5')
      .replace(/O/g, '0')
      .replace(/o/g, '0')
      .replace(/I/g, '1')
      .replace(/l/g, '1')
      .replace(/J/g, 'R')
      .toUpperCase();

    const primaryTag = process.env.CASHAPP_TAG_PRIMARY || '';
    const fallbackTags = (process.env.CASHAPP_TAG_FALLBACK || '').split(',').map(t => normalize(t.trim()));
    const normalizedText = normalize(rawTextFlat);
    const normalizedPrimary = normalize(primaryTag);

    let tagMatched = null;
    if (normalizedText.includes(normalizedPrimary)) tagMatched = normalizedPrimary;
    else {
      for (const fallback of fallbackTags) {
        if (normalizedText.includes(fallback)) {
          tagMatched = fallback;
          break;
        }
      }
    }

    if (!tagMatched) {
      const candidates = [normalizedPrimary, ...fallbackTags];
      for (const tag of candidates) {
        const score = fuzz.partial_ratio(normalizedText, tag);
        if (score >= 80) {
          tagMatched = tag;
          break;
        }
      }
    }

    const buyerIdCandidates = new Set();
    const words = rawTextFlat.split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      const combined = normalize(words[i] + words[i + 1]);
      if (/^[A-Z0-9]{8}$/.test(combined)) buyerIdCandidates.add(combined);
    }
    [...rawTextFlat.matchAll(/\b[A-Z0-9]{8}\b/gi)].forEach(m => buyerIdCandidates.add(normalize(m[0])));
    const buyerIdList = [...buyerIdCandidates];

    let extractedPrice = null;
    const match = rawTextFlat.match(/\$\s*(\d{1,3}(?:\.\d{1,2})?)/);
    if (match) extractedPrice = match[1];

    const [orders] = await db.query(`
      SELECT o.*, p.price AS product_price FROM orders o JOIN products p ON o.product_id = p.id
    `);

    let matchedOrder = null;
    let matchedBuyerId = null;
    let bestScore = 0;

    for (const order of orders) {
      const dbId = normalize(order.buyer_id);
      for (const candidate of buyerIdList) {
        const score = fuzz.ratio(dbId, candidate);
        if (score > bestScore && score >= 70) {
          bestScore = score;
          matchedOrder = order;
          matchedBuyerId = candidate;
        }
      }
    }

    const tagValid = !!tagMatched;
    const priceValid = extractedPrice && matchedOrder &&
      Math.abs(parseFloat(extractedPrice) - parseFloat(matchedOrder.product_price)) < 0.01;

    if (!matchedOrder || !tagValid || !priceValid || isTampered || bestScore < 85) {
      if (!duplicateCheck.length) {
        await db.query('INSERT INTO flagged_images (hash) VALUES (?)', [imageHash]);
      }

      if (matchedOrder) {
        await db.query('UPDATE orders SET status = ? WHERE id = ?', ['flagged', matchedOrder.id]);
      }

      await notifyFlaggedImageEmail({
        rawText,
        reason: isTampered ? 'Image appears tampered (low EXIF/pixel entropy)' :
                !matchedOrder ? 'No Buyer ID match' :
                `Low match score or data mismatch`,
        buyerIds: buyerIdList.join(', '),
        bestScore,
        tagMatch: tagValid,
        priceMatch: priceValid,
        imageBuffer,
        filename: `flagged_${timestamp}${path.extname(req.file.originalname)}`
      });

      return res.status(400).json({ error: 'Image flagged and emailed for review.' });
    }

    const [creds] = await db.query(`
      SELECT * FROM product_credentials WHERE product_id = ? AND assigned = false LIMIT 1
    `, [matchedOrder.product_id]);

    if (!creds.length) return res.status(400).json({ error: 'No credentials available' });

    const credential = creds[0];
    await db.query('UPDATE product_credentials SET assigned = true WHERE id = ?', [credential.id]);
	await transporter.sendMail({
	  from: `"Salesman Empire" <${process.env.SMTP_USER}>`,
	  to: matchedOrder.buyer_email,
	  subject: 'Your Credentials – Salesman Empire',
	  text: `
	Thank you for your purchase!

	Here are your login details:

	Email: ${credential.email}
	Password: ${credential.password}

	⚠️ Note: This account is for one-time use only. Please do not change the password unless instructed.

	Need help? Contact us at fastfire978@gmail.com or on Instagram @salesman_empire.

	– Salesman Empire
	`.trim()
	});
	
	await transporter.sendMail({
	  from: `"Salesman Empire Bot" <${process.env.SMTP_USER}>`,
	  to: process.env.OWNER_EMAIL,
	  subject: '✅ Credentials Sent to Buyer',
	  text: `
	A buyer has received credentials.

	🧾 Buyer ID: ${matchedOrder.buyer_id}
	📧 Email: ${credential.email}
	🔑 Password: ${credential.password}
	💰 Product ID: ${matchedOrder.product_id}
	`.trim()
	});

    await db.query('DELETE FROM orders WHERE id = ?', [matchedOrder.id]);

    return res.json({ success: true, message: 'Verified and credentials sent.' });

  } catch (err) {
    console.error('❌ OCR Error:', err);
    res.status(500).json({ error: 'Internal server error' });
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


