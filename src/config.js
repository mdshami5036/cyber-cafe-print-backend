const path = require('path');
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  AGENT_AUTH_TOKEN: process.env.AGENT_AUTH_TOKEN || 'default-cafe-token-xyz',
  UPLOAD_DIR: path.join(__dirname, '..', 'uploads'),
  MAX_FILE_SIZE: 20 * 1024 * 1024 // 20 MB default limit
};
