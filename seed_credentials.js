require('dotenv').config();
const mysql = require('mysql2/promise');

const db = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE
});

function generatePassword(length = 10) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$_';
  return Array.from({ length }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
}

(async () => {
  try {
    const prefix = 'salesmanempiremain';
    let aliasCounter = 1;

    const [products] = await db.query('SELECT id FROM products ORDER BY id');

    for (const product of products) {
      for (let i = 0; i < 2; i++) {
        const email = `${prefix}+${aliasCounter.toString().padStart(3, '0')}@gmail.com`;
        const password = generatePassword();

        await db.query(
          'INSERT INTO product_credentials (product_id, email, password, assigned) VALUES (?, ?, ?, false)',
          [product.id, email, password]
        );

        console.log(`✅ Assigned to Product ${product.id}: ${email}`);
        aliasCounter++;
      }
    }

    console.log('🎉 All credentials seeded successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
