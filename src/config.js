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

  // Print Rates (in INR per page)
  PRICE_BW: 5,     // ₹5 per page
  PRICE_COLOR: 10  // ₹10 per page
};
