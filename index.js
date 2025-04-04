// 📦 Dependencies
import express from 'express';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken'
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

app.post('/login', verifyStructure(['email', 'password']), async (req, res) => {
  const { email, password } = req.body;

  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, password, company_id')
    .eq('email', email)
    .single();

  if (error || !user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign(
    {
      userId: user.id,
      companyId: user.company_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  res.json({ token });
});


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

app.post('/companies', verifyStructure(['name', 'contact_email', 'password_hash', 'plan_id', 'admin_name']), async (req, res) => {
  // Check if company with the same email already exists
  const { data: existingCompany, error: checkError } = await supabase
    .from('companies')
    .select('id')
    .eq('contact_email', req.body.contact_email)
    .single();

  if (existingCompany) {
    return res.status(409).json({ error: 'Company already exists with this email.' });
  }

  const { data: companyData, error: createError } = await supabase
    .from('companies')
    .insert([req.body])
    .select();

  if (createError) return res.status(400).json(createError);
  const company = companyData[0];

  const { error: userError } = await supabase.from('users').insert([{
    name: req.body.admin_name,
    email: req.body.contact_email,
    phone: '',
    role: 'Owner',
    password: req.body.password_hash,
    company_id: company.id,
    status: 'active'
  }]);

  if (userError) return res.status(500).json({ error: 'Company created but failed to create admin user.' });

  await sendWelcomeEmail(req.body.name, req.body.contact_email, req.body.password_hash, `${process.env.FRONTEND_URL}/login`);

  res.status(201).json(companyData);
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
// 📁 DOCUMENT TAGS
// -------------------------
app.get('/document-tags', async (req, res) => {
  const { data, error } = await supabase.from('document_tags').select('*');
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/document-tags', verifyStructure(['title', 'properties']), async (req, res) => {
  const { data, error } = await supabase.from('document_tags').insert([req.body]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

app.put('/document-tags/:id', async (req, res) => {
  const { data, error } = await supabase.from('document_tags').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.delete('/document-tags/:id', async (req, res) => {
  const { error } = await supabase.from('document_tags').delete().eq('id', req.params.id);
  if (error) return res.status(400).json(error);
  res.sendStatus(204);
});

// -------------------------
// 📁 USERS
// -------------------------
app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*');
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/users', verifyStructure(['name', 'email', 'phone', 'role', 'password']), async (req, res) => {
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

// -------------------------
// 📁 DOCUMENTS
// -------------------------
app.get('/documents', async (req, res) => {
  const { data, error } = await supabase.from('documents').select('*');
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/documents', verifyStructure(['url', 'company_id', 'title', 'progress', 'tag_id', 'tag_name', 'added_by', 'role', 'properties']), async (req, res) => {
  const { data, error } = await supabase.from('documents').insert([req.body]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

app.put('/documents/:id', async (req, res) => {
  const { data, error } = await supabase.from('documents').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.delete('/documents/:id', async (req, res) => {
  const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (error) return res.status(400).json(error);
  res.sendStatus(204);
});

// -------------------------
// 📁 DOCUMENT EDIT HISTORY
// -------------------------
app.get('/document-history', async (req, res) => {
  const { data, error } = await supabase.from('document_edit_history').select('*');
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/document-history', verifyStructure(['document_id', 'edited_by', 'role', 'edit_description']), async (req, res) => {
  const { data, error } = await supabase.from('document_edit_history').insert([req.body]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

//invoices

app.post('/send-invoice/:companyId', async (req, res) => {
  const companyId = req.params.companyId;

  const { data: company, error } = await supabase
    .from('companies')
    .select(`
      id, name, contact_email, status, storage_assigned,
      documents_viewed, documents_downloaded, documents_scanned,
      documents_indexed, documents_qa_passed, invoice_value_total
    `)
    .eq('id', companyId)
    .single();

  if (error || !company) {
    return res.status(404).json({ error: 'Company not found.' });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: process.env.EMAIL_HOST,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: process.env.OAUTH_REFRESH_TOKEN,
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
    from: process.env.EMAIL_HOST,
    to: company.contact_email,
    subject,
    html: emailBody,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.response);
    return res.status(200).json({ message: 'Invoice email sent successfully.' });
  } catch (err) {
    console.error('Error sending email:', err);
    return res.status(500).json({ error: 'Failed to send email' });
  }
});

const sendWelcomeEmail = async (companyName, email, password, loginLink) => {
  if (!companyName || !email || !password || !loginLink) {
    return { error: 'Missing required fields.' };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: process.env.EMAIL_HOST,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: process.env.OAUTH_REFRESH_TOKEN,
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
    from: process.env.EMAIL_HOST,
    to: email,
    subject,
    html: emailBody,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Welcome email sent successfully:', info.response);
    return { message: 'Welcome email sent successfully.' };
  } catch (error) {
    console.error('Error sending welcome email:', error);
    return { error: 'Failed to send welcome email' };
  }
};



app.listen(PORT, () => console.log(`Server running on port ${PORT}`));