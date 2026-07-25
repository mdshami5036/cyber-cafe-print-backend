const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Initialize Express App
const app = express();

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
// job structure: { id, filename, originalName, pages, copies, status, error, createdAt }
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
// Deletes any jobs and their associated files that are older than 30 minutes
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
// CLIENT PUBLIC ENDPOINTS
// ==========================================

/**
 * @api {post} /api/print Submit Print Job
 * @apiDescription Frontend uploads PDF and select print options.
 */
app.post('/api/print', upload.single('pdf'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No PDF file uploaded' });
    }

    const { pages, copies } = req.body;

    if (!pages) {
      deleteFile(req.file.filename);
      return res.status(400).json({ success: false, error: 'Pages parameter is required' });
    }

    const parsedCopies = parseInt(copies, 10);
    if (isNaN(parsedCopies) || parsedCopies < 1) {
      deleteFile(req.file.filename);
      return res.status(400).json({ success: false, error: 'Copies must be a positive integer' });
    }

    const jobId = uuidv4();
    const newJob = {
      id: jobId,
      filename: req.file.filename,
      originalName: req.file.originalname,
      pages: pages.trim(), // e.g. "all", "1-3", "1,3,5"
      copies: parsedCopies,
      status: 'pending',
      error: null,
      createdAt: Date.now()
    };

    jobs.set(jobId, newJob);
    console.log(`New job added: ${jobId} (Pages: ${newJob.pages}, Copies: ${newJob.copies})`);

    res.status(201).json({
      success: true,
      jobId: jobId,
      message: 'Print job queued successfully.'
    });
  } catch (err) {
    console.error('Error submitting print job:', err);
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
  // Find oldest pending job
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

  // Set status to processing so it's not picked up by parallel polls
  oldestPendingJob.status = 'processing';
  
  res.json({
    success: true,
    job: {
      id: oldestPendingJob.id,
      pages: oldestPendingJob.pages,
      copies: oldestPendingJob.copies,
      originalName: oldestPendingJob.originalName
    }
  });
});

/**
 * @api {get} /api/agent/jobs/:id/download Download Job PDF
 * @apiDescription Agent downloads the print job PDF file.
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
 * @apiDescription Agent reports that the job was printed successfully.
 * The backend marks it complete and immediately deletes the physical file.
 */
app.post('/api/agent/jobs/:id/complete', authorizeAgent, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }

  job.status = 'completed';
  deleteFile(job.filename);
  console.log(`Job ${job.id} marked COMPLETED by agent`);

  // We can keep the job in status memory for a short time, then remove it
  setTimeout(() => {
    jobs.delete(job.id);
  }, 5 * 60 * 1000); // Delete job metadata after 5 minutes

  res.json({ success: true, message: 'Job completion recorded' });
});

/**
 * @api {post} /api/agent/jobs/:id/error Report Print Error
 * @apiDescription Agent reports that the print job failed.
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

  // Keep error status for a bit longer so frontend can read it, then clean up
  setTimeout(() => {
    jobs.delete(job.id);
  }, 10 * 60 * 1000); // Keep error metadata for 10 minutes

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
