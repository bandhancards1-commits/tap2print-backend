const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Razorpay = require('razorpay');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Price calculation
function calculatePrice(settings) {
  const { pages, copies, color, duplex } = settings;
  const pricePerPage = color ? 5 : 1; // ₹5 color, ₹1 B&W
  const effectivePages = duplex ? Math.ceil(pages / 2) : pages;
  return effectivePages * copies * pricePerPage * 100; // paise
}

// Upload file + create order
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const settings = JSON.parse(req.body.settings);
    const price = calculatePrice(settings);

    const fileName = `${Date.now()}-${req.file.originalname}`;

    const { error } = await supabase.storage
      .from('print-files')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (error) return res.status(500).json({ error: error.message });

    const order = await razorpay.orders.create({
      amount: price,
      currency: 'INR',
      receipt: fileName,
    });

    const { data: job } = await supabase
      .from('print_jobs')
      .insert({
        file_url: fileName,
        settings,
        status: 'awaiting_payment',
        price,
        payment_id: order.id,
      })
      .select()
      .single();

    res.json({ orderId: order.id, amount: price, jobId: job.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Payment success webhook
app.post(
  '/api/payment-success',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = req.body;

      await supabase
        .from('print_jobs')
        .update({
          status: 'pending',
          payment_id: razorpay_payment_id,
        })
        .eq('payment_id', razorpay_order_id);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Get pending jobs
app.get('/api/jobs/pending', async (req, res) => {
  const { data } = await supabase
    .from('print_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at');

  res.json(data);
});

// Update job status
app.post('/api/jobs/:id/status', async (req, res) => {
  await supabase
    .from('print_jobs')
    .update({ status: req.body.status })
    .eq('id', req.params.id);

  res.json({ success: true });
});

// Download URL
app.get('/api/jobs/:id/download-url', async (req, res) => {
  const { data: job } = await supabase
    .from('print_jobs')
    .select('*')
    .eq('id', req.params.id)
    .single();

  const { data } = await supabase.storage
    .from('print-files')
    .createSignedUrl(job.file_url, 300);

  res.json({ url: data.signedUrl, settings: job.settings });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));