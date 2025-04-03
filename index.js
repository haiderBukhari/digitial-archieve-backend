// 📦 Dependencies
import express from 'express';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import cors from 'cors'

config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const app = express();
app.use(express.json());
app.use(cors({origin: '*'}))
const PORT = process.env.PORT || 3000;

// 🌐 Health check
app.get('/', (req, res) => res.send('Supabase CRUD API is running'));

// ✅ Middleware to verify structure of required fields
const verifyStructure = (requiredFields) => (req, res, next) => {
  const missing = requiredFields.filter(field => !(field in req.body));
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }
  next();
};

// -------------------------
// 📁 PLANS ENDPOINTS
// -------------------------

app.get('/plans', async (req, res) => {
  const { data, error } = await supabase.from('plans').select('*');
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.get('/plans/:id', async (req, res) => {
  const { data, error } = await supabase.from('plans').select('*').eq('id', req.params.id).single();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/plans', verifyStructure(['name']), async (req, res) => {
  const { data, error } = await supabase.from('plans').insert([req.body]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

app.put('/plans/:id', async (req, res) => {
  const { data, error } = await supabase.from('plans').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.delete('/plans/:id', async (req, res) => {
  const { error } = await supabase.from('plans').delete().eq('id', req.params.id);
  if (error) return res.status(400).json(error);
  res.sendStatus(204);
});

// -------------------------
// 🏢 COMPANIES ENDPOINTS
// -------------------------

app.get('/companies', async (req, res) => {
  const { data, error } = await supabase.from('companies').select('*');
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.get('/companies/:id', async (req, res) => {
  const { data, error } = await supabase.from('companies').select('*').eq('id', req.params.id).single();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/companies', verifyStructure(['name', 'contact_email', 'password_hash', 'plan_id']), async (req, res) => {
  const { data, error } = await supabase.from('companies').insert([req.body]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

app.put('/companies/:id', async (req, res) => {
  const { data, error } = await supabase.from('companies').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.delete('/companies/:id', async (req, res) => {
  const { error } = await supabase.from('companies').delete().eq('id', req.params.id);
  if (error) return res.status(400).json(error);
  res.sendStatus(204);
});

// -------------------------
// 👤 USERS ENDPOINTS
// -------------------------

app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*');
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.get('/users/:id', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*').eq('id', req.params.id).single();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/users', verifyStructure(['company_id', 'name', 'email', 'password_hash', 'role']), async (req, res) => {
  const { data, error } = await supabase.from('users').insert([req.body]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

app.put('/users/:id', async (req, res) => {
  const { data, error } = await supabase.from('users').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.delete('/users/:id', async (req, res) => {
  const { error } = await supabase.from('users').delete().eq('id', req.params.id);
  if (error) return res.status(400).json(error);
  res.sendStatus(204);
});


//invoices

app.get('/send-invoice/:companyId', async (req, res) => {
  const companyId = req.params.companyId;

  const { data: company, error } = await supabase
    .from('companies')
    .select(`id, name, contact_email, status, storage_assigned, documents_viewed, documents_downloaded, documents_scanned, documents_indexed, documents_qa_passed, invoice_value_total`)
    .eq('id', companyId)
    .single();

  if (error || !company) {
    return res.status(404).json({ error: 'Company not found.' });
  }

  const transporter = nodemailer.createTransport({
    port: 587,
    host: 'smtp.gmail.com',
    secure: false,
    auth: {
      user: process.env.SERVICE,
      pass: process.env.ApplicationPassword,
    },
  });

  const subject = `Invoice Summary - ${company.name}`;

  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
      <div style="background-color: #0056D2; padding: 20px; text-align: center;">
        <h1 style="color: #fff; margin: 0;">Talo Innovations</h1>
      </div>
      <div style="padding: 20px; color: #333;">
        <h2>Hello ${company.name},</h2>
        <p>Here is your latest invoice summary based on the system usage:</p>
        <ul>
          <li><strong>Status:</strong> ${company.status}</li>
          <li><strong>Storage Assigned:</strong> ${company.storage_assigned} GB</li>
          <li><strong>Documents Viewed:</strong> ${company.documents_viewed}</li>
          <li><strong>Documents Downloaded:</strong> ${company.documents_downloaded}</li>
          <li><strong>Documents Scanned:</strong> ${company.documents_scanned}</li>
          <li><strong>Documents Indexed:</strong> ${company.documents_indexed}</li>
          <li><strong>QA Passed Documents:</strong> ${company.documents_qa_passed}</li>
          <li><strong>Invoice Value:</strong> $${company.invoice_value_total}</li>
        </ul>
        <p>If you have any questions, feel free to reply to this email.</p>
        <p>Thank you,<br>Talo Innovations Team</p>
      </div>
    </div>
  `;

  const mailOptions = {
    from: process.env.SERVICE,
    to: company.contact_email,
    subject,
    html: emailBody,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending email:', error);
      return res.status(500).json({ error: 'Failed to send email' });
    } else {
      console.log('Email sent successfully:', info.response);
      return res.status(200).json({ message: 'Invoice email sent successfully.' });
    }
  });
});

app.post('/send-welcome', async (req, res) => {
  const { companyName, email, password, loginLink } = req.body;
  if (!companyName || !email || !password || !loginLink) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const transporter = nodemailer.createTransport({
    port: 587,
    host: 'smtp.gmail.com',
    secure: false,
    auth: {
      user: process.env.SERVICE,
      pass: process.env.ApplicationPassword,
    },
  });

  const subject = `Welcome to Talo Innovations – ${companyName}`;

  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
      <div style="background-color: #22BC66; padding: 20px; text-align: center;">
        <h1 style="color: #fff; margin: 0;">Talo Innovations</h1>
      </div>
      <div style="padding: 20px; color: #333;">
        <h2>Welcome ${companyName}!</h2>
        <p>Your company account has been successfully created.</p>
        <p>Here are your login credentials:</p>
        <ul>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Password:</strong> ${password}</li>
        </ul>
        <div style="text-align: center; margin: 20px 0;">
          <a href="${loginLink}" style="background-color: #22BC66; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-size: 16px;">
            Login Now
          </a>
        </div>
        <p>If you have any questions, feel free to contact our support team.</p>
        <p>Cheers,<br>The Talo Innovations Team</p>
      </div>
    </div>
  `;

  const mailOptions = {
    from: process.env.SERVICE,
    to: email,
    subject,
    html: emailBody,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending welcome email:', error);
      return res.status(500).json({ error: 'Failed to send welcome email' });
    } else {
      console.log('Welcome email sent successfully:', info.response);
      return res.status(200).json({ message: 'Welcome email sent successfully.' });
    }
  });
});


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));