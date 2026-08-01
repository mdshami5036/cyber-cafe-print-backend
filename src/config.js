const path = require('path');
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  AGENT_AUTH_TOKEN: process.env.AGENT_AUTH_TOKEN || 'default-cafe-token-xyz',
  UPLOAD_DIR: path.join(__dirname, '..', 'uploads'),
  MAX_FILE_SIZE: 20 * 1024 * 1024, // 20 MB limit
  
  // Official Live Razorpay Credentials
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_live_TKRvuXkMviyVSX',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || 'gRJ0aBC8WKivpAZ5cfXCmgcL',

  // Dynamic Print Rates (Reads directly from Railway Environment Variables)
  PRICE_BW: (process.env.PRICE_BW !== undefined && process.env.PRICE_BW !== '') ? parseInt(process.env.PRICE_BW, 10) : 5,
  PRICE_COLOR: (process.env.PRICE_COLOR !== undefined && process.env.PRICE_COLOR !== '') ? parseInt(process.env.PRICE_COLOR, 10) : 10
};
