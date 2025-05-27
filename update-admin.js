const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

(async () => {
  const db = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'fastfire90',  // <-- Your MySQL root password here
    database: 'car_sales_platform'  // <-- Your database name here
  });

  const username = 'fastfire9';       // Admin username
  const plainPassword = 'fastfire900'; // Admin password (will be hashed)

  // Hash the password
  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  // Check if the admin user already exists
  const [rows] = await db.execute('SELECT * FROM admins WHERE username = ?', [username]);

  if (rows.length > 0) {
    // User exists, update password
    await db.execute('UPDATE admins SET password = ? WHERE username = ?', [hashedPassword, username]);
    console.log('Admin password updated.');
  } else {
    // User doesn't exist, create new admin
    await db.execute('INSERT INTO admins (username, password) VALUES (?, ?)', [username, hashedPassword]);
    console.log('Admin user created.');
  }

  console.log('Username:', username);
  console.log('Password:', plainPassword);

  await db.end();
})();
