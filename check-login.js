const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

async function login(username, enteredPassword) {
  const db = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'fastfire90',    // Your MySQL root password here
    database: 'car_sales_platform'
  });

  // Get password hash from DB for given username
  const [rows] = await db.execute('SELECT password FROM admins WHERE username = ?', [username]);
  await db.end();

  if (rows.length === 0) {
    // No such user found
    return false;
  }

  const storedHash = rows[0].password;
  // Compare entered password with stored hash
  return await bcrypt.compare(enteredPassword, storedHash);
}

// Test the login function
(async () => {
  const username = 'fastfire9';
  const password = 'fastfire900';

  const isValid = await login(username, password);
  if (isValid) {
    console.log('Login successful');
  } else {
    console.log('Invalid username or password');
  }
})();
