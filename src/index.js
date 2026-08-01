const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const config = require('./config');

// Initialize Express App
const app = express();

// Initialize Razorpay Client
const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

// Enable CORS for all requests (public client and agent)
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
if (!fs.existsSync(config.UPLOAD_DIR)) {
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // Save with unique name to prevent collisions
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
});

// In-Memory Job Queue Store
const jobs = new Map();

// Helper to delete physical PDF file
const deleteFile = (filename) => {
  const filePath = path.join(config.UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error deleting file ${filename}:`, err);
      else console.log(`Successfully deleted file: ${filename}`);
    });
  }
};

// Periodic Job & File Cleanup (runs every 10 minutes)
setInterval(() => {
  const now = Date.now();
  const expirationTime = 30 * 60 * 1000; // 30 minutes

  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > expirationTime) {
      console.log(`Cleaning up expired job: ${id}`);
      deleteFile(job.filename);
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

// Print Agent Authorization Middleware
const authorizeAgent = (req, res, next) => {
  const token = req.headers['x-agent-token'];
  if (!token || token !== config.AGENT_AUTH_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid Agent Token' });
  }
  next();
};

// ==========================================
// CLIENT PUBLIC & PAYMENT ENDPOINTS
// ==========================================

/**
 * @api {get} /api/config/rates Get Live Print Rates
 * @apiDescription Returns live rates for B&W and Color printing.
 */
app.get('/api/config/rates', (req, res) => {
  res.json({
    success: true,
    priceBw: config.PRICE_BW,
    priceColor: config.PRICE_COLOR
  });
});

/**
 * @api {post} /api/payment/create-order Create Razorpay Order
 * @apiDescription Frontend calls this to get a Razorpay Order ID and price total.
 */
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { pagesCount, copies, colorMode } = req.body;
    const parsedPages = parseInt(pagesCount, 10);
    const parsedCopies = parseInt(copies, 10);

    if (isNaN(parsedPages) || parsedPages < 1 || isNaN(parsedCopies) || parsedCopies < 1) {
      return res.status(400).json({ success: false, error: 'Invalid pages or copies count' });
    }

    const ratePerPage = colorMode === 'color' ? config.PRICE_COLOR : config.PRICE_BW;
    const totalPages = parsedPages * parsedCopies;
    const amountInRupees = totalPages * ratePerPage;
    const amountInPaise = amountInRupees * 100; // Razorpay expects amount in paise

    const options = {
      amount: amountInPaise,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    };

    const order = await razorpay.orders.create(options);

    console.log(`Razorpay Order Created: ${order.id} (Amount: ₹${amountInRupees}, Rate: ₹${ratePerPage}/pg)`);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: config.RAZORPAY_KEY_ID,
      amountInRupees: amountInRupees,
      ratePerPage: ratePerPage
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @api {post} /api/payment/verify-and-print Verify Payment Signature & Submit Job
 * @apiDescription Verifies Razorpay HMAC SHA256 signature and queues the print job.
 */
app.post('/api/payment/verify-and-print', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded' });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, pages, copies, colorMode } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      deleteFile(req.file.filename);
      return res.status(400).json({ success: false, error: 'Payment verification details missing' });
    }

    // Verify HMAC-SHA256 Signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.error(`Invalid Razorpay signature! Order: ${razorpay_order_id}`);
      deleteFile(req.file.filename);
      return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }

    console.log(`Payment Verified Successfully! Payment ID: ${razorpay_payment_id}`);

    const parsedCopies = parseInt(copies, 10) || 1;
    const jobId = uuidv4();
    const newJob = {
      id: jobId,
      filename: req.file.filename,
      originalName: req.file.originalname,
      pages: (pages || 'all').trim(),
      copies: parsedCopies,
      colorMode: colorMode === 'color' ? 'color' : 'bw',
      paymentId: razorpay_payment_id,
      status: 'pending',
      error: null,
      createdAt: Date.now()
    };

    jobs.set(jobId, newJob);
    console.log(`Job Queued: ${jobId} (Pages: ${newJob.pages}, Copies: ${newJob.copies}, Mode: ${newJob.colorMode})`);

    res.status(201).json({
      success: true,
      jobId: jobId,
      message: 'Payment verified & print job queued successfully.'
    });
  } catch (err) {
    console.error('Error verifying payment:', err);
    if (req.file) {
      deleteFile(req.file.filename);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * @api {get} /api/print/status/:id Get Job Status
 * @apiDescription Frontend checks status of their print job
 */
app.get('/api/print/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or already completed/cleaned up' });
  }
  res.json({
    success: true,
    status: job.status,
    error: job.error
  });
});

// ==========================================
// SECURE PRINT AGENT ENDPOINTS
// ==========================================

/**
 * @api {get} /api/agent/jobs Poll for Pending Jobs
 * @apiDescription Agent checks for any pending print jobs. Returns the oldest pending job.
 */
app.get('/api/agent/jobs', authorizeAgent, (req, res) => {
  let oldestPendingJob = null;
  for (const job of jobs.values()) {
    if (job.status === 'pending') {
      if (!oldestPendingJob || job.createdAt < oldestPendingJob.createdAt) {
        oldestPendingJob = job;
      }
    }
  }

  if (!oldestPendingJob) {
    return res.json({ success: true, job: null });
  }

  oldestPendingJob.status = 'processing';
  
  res.json({
    success: true,
    job: {
      id: oldestPendingJob.id,
      pages: oldestPendingJob.pages,
      copies: oldestPendingJob.copies,
      colorMode: oldestPendingJob.colorMode || 'bw',
      originalName: oldestPendingJob.originalName
    }
  });
});

/**
 * @api {get} /api/agent/jobs/:id/download Download Job PDF
 */
app.get('/api/agent/jobs/:id/download', authorizeAgent, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  const filePath = path.join(config.UPLOAD_DIR, job.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'PDF file not found on disk' });
  }

  res.sendFile(filePath);
});

/**
 * @api {post} /api/agent/jobs/:id/complete Report Print Success
 */
app.post('/api/agent/jobs/:id/complete', authorizeAgent, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  job.status = 'completed';
  deleteFile(job.filename);
  console.log(`Job ${job.id} marked COMPLETED by agent`);

  setTimeout(() => {
    jobs.delete(job.id);
  }, 5 * 60 * 1000);

  res.json({ success: true, message: 'Job completion recorded' });
});

/**
 * @api {post} /api/agent/jobs/:id/error Report Print Error
 */
app.post('/api/agent/jobs/:id/error', authorizeAgent, (req, res) => {
  const { error } = req.body;
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  job.status = 'error';
  job.error = error || 'Unknown print error';
  deleteFile(job.filename);
  console.error(`Job ${job.id} failed with error: ${job.error}`);

  setTimeout(() => {
    jobs.delete(job.id);
  }, 10 * 60 * 1000);

  res.json({ success: true, message: 'Job error recorded' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);
  res.status(500).json({ success: false, error: err.message });
});

// Start Server
app.listen(config.PORT, () => {
  console.log(`Cyber Cafe Backend running on port ${config.PORT}`);
  console.log(`Uploads folder: ${config.UPLOAD_DIR}`);
});
