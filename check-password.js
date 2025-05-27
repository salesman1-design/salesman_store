const bcrypt = require('bcryptjs');

const password = 'fastfire900'; // password you think is correct
const hash = '$2a$10$Flxx.YRx4NpYcbA3bhYxnuH6iL65Flnb/VV1yV3Im9g2tDMSLCdQ2';

bcrypt.compare(password, hash, (err, res) => {
  if (err) throw err;
  console.log('Password match:', res);
});
