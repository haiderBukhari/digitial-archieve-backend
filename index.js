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
app.use(cors({ origin: '*' }))
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

// 🔐 JWT Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token missing from Authorization header.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = decoded; // Attach decoded payload to request
    next();
  });
};

app.post('/login', verifyStructure(['email', 'password']), async (req, res) => {
  const { email, password } = req.body;

  let { data: user, error } = await supabase
    .from('users')
    .select('id, email, password, company_id, role, name')
    .eq('email', email)
    .single();

  if (!user || error) {
    const clientResult = await supabase
      .from('clients')
      .select('id, email, password, company_id, name')
      .eq('email', email)
      .single();

    if (clientResult.data && clientResult.data.password === password) {
      user = {
        ...clientResult.data,
        role: 'Client'
      };
    } else {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
  } else if (user.password !== password) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign(
    {
      userId: user.id,
      companyId: user.company_id,
      role: user.role,
      name: user.name
    },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  res.json({
    token,
    role: user.role,
    userId: user.id,
    companyId: user.company_id,
    name: user.name
  });
});

app.post('/verify-token', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.status(200).json({ valid: true, user: decoded });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
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
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .order('created_at', { ascending: false });

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

  await sendWelcomeEmail(req.body.name, req.body.contact_email, req.body.password_hash, `${process.env.FRONTEND_URL}`);

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
app.post('/document-tags', authenticateToken, verifyStructure(['title', 'properties']), async (req, res) => {
  const { title, properties } = req.body;
  const company_id = req.user.companyId;

  const { data, error } = await supabase.from('document_tags').insert([{
    title,
    properties,
    company_id
  }]).select();

  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

app.get('/document-tags', authenticateToken, async (req, res) => {
  const company_id = req.user.companyId;

  if (!company_id) {
    return res.status(400).json({ error: 'Missing company ID in token.' });
  }

  const { data: tags, error: tagError } = await supabase
    .from('document_tags')
    .select('*')
    .eq('company_id', company_id);

  if (tagError) return res.status(400).json(tagError);

  const enrichedTags = await Promise.all(tags.map(async (tag) => {
    if (!tag.id) return { ...tag, complete_documents: 0, incomplete_documents: 0 };

    const { count: complete_documents } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('tag_id', tag.id)
      .eq('progress', 'Complete');

    const { count: incomplete_documents } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('tag_id', tag.id)
      .eq('progress', 'Incomplete');

    return {
      ...tag,
      complete_documents: complete_documents || 0,
      incomplete_documents: incomplete_documents || 0,
    };
  }));

  res.json(enrichedTags);
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
app.get('/users', authenticateToken, async (req, res) => {
  const { companyId, userId } = req.user;

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('company_id', companyId)
    .neq('id', userId);

  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/users', authenticateToken, verifyStructure(['name', 'email', 'phone', 'role', 'password']), async (req, res) => {
  const { name, email, phone, role, password } = req.body;
  const company_id = req.user.companyId;

  const { data, error } = await supabase.from('users').insert([{
    name,
    email,
    phone,
    role,
    password,
    company_id,
    documents_reviewed: 0,
    status: 'active'
  }]).select();

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
app.get('/documents', authenticateToken, async (req, res) => {
  const { companyId, userId, role } = req.user;
  const roleLower = role.toLowerCase();

  let query = supabase.from('documents').select('*');

  // 🔐 Role-based filtering
  if (roleLower === 'owner' || roleLower === 'manager') {
    query = query.eq('company_id', companyId);
  } else if (roleLower === 'scanner') {
    query = query.eq('company_id', companyId).eq('added_by', userId);
  } else if (roleLower === 'indexer') {
    query = query.eq('company_id', companyId).eq('indexer_passed_id', userId);
  } else if (roleLower === 'qa') {
    query = query.eq('company_id', companyId).eq('qa_passed_id', userId);
  } else if (roleLower === 'client') {
    query = query.eq('company_id', companyId).eq('added_by', userId);
  } else {
    return res.status(403).json({ error: 'Unauthorized role access.' });
  }

  // 📄 Fetch documents
  const { data: documents, error } = await query;
  if (error) return res.status(400).json(error);

  // 👤 Fetch users and clients for enrichment
  const { data: users, error: userError } = await supabase.from('users').select('id, name, role');
  const { data: clients, error: clientError } = await supabase.from('clients').select('id, name');

  if (userError || clientError) return res.status(400).json(userError || clientError);

  // 🔄 Map user/client IDs for easy lookup
  const usersMap = {};
  users.forEach(u => {
    usersMap[u.id] = { name: u.name, role: u.role };
  });
  clients.forEach(c => {
    usersMap[c.id] = { name: c.name, role: 'Client' };
  });

  // 🧠 Enhance documents with added_by and requested_by info
  const enhancedDocs = documents.map(doc => {
    const addedBy = usersMap[doc.added_by] || null;

    let requestedById = doc.added_by;
    if (roleLower === 'qa') {
      requestedById = doc.indexer_passed_id || doc.added_by;
    }

    const requestedBy = requestedById && usersMap[requestedById]
      ? {
          name: usersMap[requestedById].name,
          role: usersMap[requestedById].role
        }
      : null;

    return {
      ...doc,
      added_by_user: addedBy,
      requested_by: requestedBy
    };
  });

  res.json(enhancedDocs);
});

app.post('/documents', authenticateToken, verifyStructure(['url', 'tag_id', 'tag_name', 'file_id']), async (req, res) => {
  const { url, tag_id, tag_name, file_id, title } = req.body;
  const company_id = req.user.companyId;
  const added_by = req.user.userId;
  const role = req.user.role;

  const { data: tagData, error: tagError } = await supabase
    .from('document_tags')
    .select('properties')
    .eq('id', tag_id)
    .single();

  if (tagError || !tagData) return res.status(400).json({ error: 'Invalid tag selected.' });

  const propertiesWithValues = tagData.properties.map(prop => ({
    ...prop,
    value: ''
  }));

  const document = {
    url,
    company_id,
    title: title,
    progress: 'Incomplete',
    tag_id,
    progress_number: (role === 'Owner' || role === 'Manager' || role == 'Client') ? 1 : role === 'Scanner' ? 1 : 1,
    indexer_passed_id: null,
    qa_passed_id: null,
    passed_to: null,
    tag_name,
    is_published: false,
    added_by,
    role,
    properties: propertiesWithValues,
    file_id
  };

  const { data, error } = await supabase.from('documents').insert([document]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

app.get('/documents/:id', authenticateToken, async (req, res) => {
  const documentId = req.params.id;
  const currentUserId = req.user.userId;
  const role = req.user.role.toLowerCase();

  const { data: document, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .single();

  if (error || !document) return res.status(404).json({ error: 'Document not found' });

  let showMore = false;

  if (document.added_by === currentUserId || role == 'manager' || role == 'owner') {
    showMore = !document.passed_to; // true if not passed yet
  } else {
    if (document.indexer_passed_id === currentUserId || document.qa_passed_id === currentUserId) {
      showMore = (document.passed_to === document.indexer_passed_id || document.passed_to === document.qa_passed_id) && !document.is_published;
    } else {
      showMore = false;
    }
  }

  res.json({ ...document, showMore });
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

app.get('/get-assignee', authenticateToken, async (req, res) => {
  const { companyId } = req.user;
  const role = req.user.role.toLowerCase();

  let targetRole;

  if (role === 'owner' || role === 'manager' || role === 'scanner' || role === 'client') {
    targetRole = 'indexer';
  } else if (role === 'indexer') {
    targetRole = 'qa';
  } else {
    return res.json([]); // QA gets no one
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role')
    .eq('company_id', companyId)
    .ilike('role', targetRole);

  if (error) return res.status(400).json(error);
  res.json(data);
});

// -------------------------
// 🔁 POST ASSIGNEE ENDPOINT
// -------------------------
app.post('/post-assignee', authenticateToken, verifyStructure(['document_id', 'assignee_id']), async (req, res) => {
  const { document_id, assignee_id } = req.body;
  const { companyId } = req.user;
  const role = req.user.role.toLowerCase();

  const { data: doc, error: docError } = await supabase
    .from('documents')
    .select('*')
    .eq('id', document_id)
    .eq('company_id', companyId)
    .single();

  if (docError || !doc) return res.status(404).json({ error: 'Document not found for this company.' });

  let updateFields = { passed_to: assignee_id };

  if (role.toLowerCase() === 'owner' || role.toLowerCase() === 'manager' || role.toLowerCase() === 'scanner' || role.toLowerCase() === 'client') {
    updateFields.indexer_passed_id = assignee_id;
  } else if (role.toLowerCase() === 'indexer') {
    updateFields.qa_passed_id = assignee_id;
    updateFields.progress_number = 2;
  } else {
    return res.status(403).json({ error: 'You are not allowed to assign from your role.' });
  }

  const { data, error } = await supabase
    .from('documents')
    .update(updateFields)
    .eq('id', document_id)
    .select();

  if (error) return res.status(400).json(error);
  res.status(200).json({ message: 'Assignee updated successfully.', data });
});


app.post('/save-draft', authenticateToken, verifyStructure(['document_id']), async (req, res) => {
  const { document_id } = req.body;
  const { companyId, role } = req.user;

  if (role.toLowerCase() !== 'qa') {
    return res.status(403).json({ error: 'Only QA role can save drafts.' });
  }

  const { data, error } = await supabase
    .from('documents')
    .update({ progress_number: 3 })
    .eq('id', document_id)
    .eq('company_id', companyId)
    .select();

  if (error) return res.status(400).json(error);
  res.status(200).json({ message: 'Document draft saved successfully.', data });
});

// -------------------------
// 🚀 PUBLISH DOCUMENT (QA only)
// -------------------------
app.post('/publish', authenticateToken, verifyStructure(['document_id']), async (req, res) => {
  const { document_id } = req.body;
  const { companyId, role } = req.user;

  if (role.toLowerCase() !== 'qa') {
    return res.status(403).json({ error: 'Only QA role can publish documents.' });
  }

  const { data, error } = await supabase
    .from('documents')
    .update({ progress_number: 3, is_published: true })
    .eq('id', document_id)
    .eq('company_id', companyId)
    .select();

  if (error) return res.status(400).json(error);
  res.status(200).json({ message: 'Document published successfully.', data });
});

// Get all client plans
app.get('/client-plans', authenticateToken, async (req, res) => {
  const companyId = req.user.companyId;

  const { data, error } = await supabase
    .from('client_plans')
    .select('*')
    .eq('company_id', companyId);

  if (error) return res.status(400).json(error);
  res.json(data);
});


// Get a specific plan
app.get('/client-plans/:id', authenticateToken, async (req, res) => {
  const companyId = req.user.companyId;

  const { data, error } = await supabase
    .from('client_plans')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', companyId)
    .single();

  if (error) return res.status(400).json(error);
  res.json(data);
});

// Create a plan
app.post('/client-plans', authenticateToken, verifyStructure(['name', 'monthly_bill', 'subscription_begin']), async (req, res) => {
  const companyId = req.user.companyId;
  const payload = {
    ...req.body,
    company_id: companyId
  };

  const { data, error } = await supabase.from('client_plans').insert([payload]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

// Update a plan
app.put('/client-plans/:id', authenticateToken, async (req, res) => {
  const companyId = req.user.companyId;

  const { data, error } = await supabase
    .from('client_plans')
    .update(req.body)
    .eq('id', req.params.id)
    .eq('company_id', companyId)
    .select();

  if (error) return res.status(400).json(error);
  res.json(data);
});

// Delete a plan
app.delete('/client-plans/:id', authenticateToken, async (req, res) => {
  const companyId = req.user.companyId;

  const { error } = await supabase
    .from('client_plans')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', companyId);

  if (error) return res.status(400).json(error);
  res.sendStatus(204);
});

// Get all clients for the current user's company
app.get('/clients', authenticateToken, async (req, res) => {
  const companyId = req.user.companyId;
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('company_id', companyId);

  if (error) return res.status(400).json(error);
  res.json(data);
});

// Get one client by ID, scoped to company
app.get('/clients/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single();

  if (error) return res.status(400).json(error);
  res.json(data);
});

// Create a new client
app.post('/clients', authenticateToken, verifyStructure(['name', 'status', 'plan_id']), async (req, res) => {
  const companyId = req.user.companyId;
  const payload = {
    ...req.body,
    company_id: companyId,
  };

  const { data, error } = await supabase.from('clients').insert([payload]).select();
  if (error) return res.status(400).json(error);
  res.status(201).json(data);
});

// Update client (only within the user's company)
app.put('/clients/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;

  const { data, error } = await supabase
    .from('clients')
    .update(req.body)
    .eq('id', id)
    .eq('company_id', companyId)
    .select();

  if (error) return res.status(400).json(error);
  res.json(data);
});

// Delete client
app.delete('/clients/:id', async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;

  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId);

  if (error) return res.status(400).json(error);
  res.sendStatus(204);
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

app.post('/share-document', authenticateToken, verifyStructure(['document_link', 'document_password', 'document_id']), async (req, res) => {
  const { document_link, document_password, document_id } = req.body;
  const { userId, companyId } = req.user;

  const { data: shared, error: shareError } = await supabase
    .from('shareddoc')
    .insert([{
      document_link,
      document_password,
      user_id: userId,
      document_id: document_id,
      company_id: companyId
    }])
    .select();

  if (shareError) return res.status(400).json(shareError);

  const { error: updateError } = await supabase
    .from('documents')
    .update({ shared: true })
    .eq('id', document_id)
    .eq('company_id', companyId);

  if (updateError) return res.status(400).json(updateError);

  res.status(201).json({ message: 'Document shared successfully.', shared });
});

app.post('/get-shared-document', verifyStructure(['id', 'document_password']), async (req, res) => {
  const { id, document_password } = req.body;

  const { data: shared, error } = await supabase
    .from('shareddoc')
    .select('*')
    .eq('id', id)
    .eq('document_password', document_password)
    .single();

  if (error || !shared) return res.status(404).json({ error: 'Invalid link or password' });

  res.status(200).json({ message: 'Document access granted.', shared });
});

// 📥 Get Shared Document URL (Client only)
app.get('/get-shared-url/:document_id', authenticateToken, async (req, res) => {
  const { userId, role } = req.user;
  const { document_id } = req.params;

  if (role !== 'Client') {
    return res.status(403).json({ error: 'Only clients are allowed to access this route.' });
  }

  const { data, error } = await supabase
    .from('shareddoc')
    .select('document_link')
    .eq('document_id', document_id)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Shared document not found for this client.' });
  }

  res.status(200).json({ document_link: data.document_link });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));