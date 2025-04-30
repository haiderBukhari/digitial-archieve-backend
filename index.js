// 📦 Dependencies
import express from 'express';
import nodemailer from 'nodemailer';
import { createClient } from '@supabase/supabase-js';
import { differenceInMonths, addMonths, differenceInDays } from 'date-fns';
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
    // Check in clients table if not found in users
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, email, password, company_id, name, status')
      .eq('email', email)
      .single();

    if (client && client.password === password) {
      // Check if company is active
      const { data: company, error: companyError } = await supabase
        .from('companies')
        .select('status')
        .eq('id', client.company_id)
        .single();

      if (companyError || !company || company.status !== 'Active') {
        return res.status(403).json({ error: 'Company is not active. Please contact support.' });
      }

      if (client.status !== 'active') {
        return res.status(403).json({ error: 'Your client account is not active. Contact your company admin.' });
      }

      user = {
        ...client,
        role: 'Client'
      };
    } else {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

  } else {
    // User exists but not an Admin
    if (user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only Admin users are allowed to login here.' });
    }

    if (user.password !== password) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Check if company is active
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('status')
      .eq('id', user.company_id)
      .single();

    if (companyError || !company || company.status !== 'Active') {
      return res.status(403).json({ error: 'Company is not active. Please contact support.' });
    }
  }

  // JWT token generation
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

app.get('/get-plan-information', authenticateToken, async (req, res) => {
  const { userId, companyId, role } = req.user;

  let planId = null;
  let planTable = '';
  let planFields = '';

  if (role === 'Client') {
    // Get plan_id from clients table
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('plan_id')
      .eq('id', userId)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found or has no associated plan.' });
    }

    planId = client.plan_id;
    planTable = 'client_plans';
    planFields = 'can_download, can_share, can_view_reports, can_view_activity_logs';
  } else {
    // Get plan_id from companies table
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('plan_id')
      .eq('id', companyId)
      .single();

    if (companyError || !company) {
      return res.status(404).json({ error: 'Company not found or has no associated plan.' });
    }

    planId = company.plan_id;
    planTable = 'plans';
    planFields = 'can_share_document, can_view_activity_logs, can_add_client, number_of_clients';
  }

  // Fetch the plan details
  const { data: plan, error: planError } = await supabase
    .from(planTable)
    .select(planFields)
    .eq('id', planId)
    .single();

  if (planError || !plan) {
    return res.status(404).json({ error: 'Plan not found.' });
  }

  res.status(200).json({ plan });
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
  const companyId = req.params.id;

  // 1. Get Company
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .single();
  if (companyError || !company) return res.status(404).json({ error: 'Company not found' });

  // 2. Get Users
  const { data: users, error: userError } = await supabase
    .from('users')
    .select('id, name, email, phone, role, documents_reviewed, status')
    .eq('company_id', companyId);
  if (userError) return res.status(400).json({ error: 'Failed to fetch users' });

  // 3. Get Plan
  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('id, name, price_description, can_share_document, can_view_activity_logs, can_add_client, number_of_clients, upload_price_per_ten, share_price_per_thousand, download_price_per_thousand')
    .eq('id', company.plan_id)
    .single();
  if (planError) return res.status(400).json({ error: 'Failed to fetch plan info' });

  // 4. Get Invoices
  const { data: invoices, error: invoiceError } = await supabase
    .from('invoices')
    .select('id, invoice_month, invoice_value, monthly, invoice_submitted, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (invoiceError) return res.status(400).json({ error: 'Failed to fetch invoices' });

  // 5. Get Total Documents Uploaded
  const { count: total_documents_uploaded, error: docCountError } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId);
  if (docCountError) return res.status(400).json({ error: 'Failed to count uploaded documents' });

  // 6. Get Total Documents Published
  const { count: total_documents_published, error: pubCountError } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_published', true);
  if (pubCountError) return res.status(400).json({ error: 'Failed to count published documents' });

  // ✅ Final response
  res.status(200).json({
    ...company,
    users,
    plan,
    invoices,
    total_documents_uploaded,
    total_documents_published
  });
});

app.get('/client/:id', async (req, res) => {
  const clientId = req.params.id;

  // 1. Get client by ID
  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)

  if (clientError || !client) {
    return res.status(404).json({ error: 'Client not found.' });
  }

  // 2. Get plan info
  const { data: plan, error: planError } = await supabase
    .from('client_plans')
    .select('id, name, monthly_bill, upload_price_per_ten, share_price_per_thousand, download_price_per_thousand')
    .eq('id', client[0].plan_id)
    .single();

  if (planError) {
    return res.status(400).json({ error: 'Failed to fetch client plan' });
  }

  // 3. Get invoices for the client
  const { data: invoices, error: invoiceError } = await supabase
    .from('client_invoices')
    .select('id, invoice_month, invoice_value, monthly, invoice_submitted, created_at')
    .eq('email', client[0].email)
    .order('created_at', { ascending: false });

  if (invoiceError) {
    return res.status(400).json({ error: 'Failed to fetch client invoices' });
  }

  // ✅ Final response
  res.status(200).json({
    ...client[0],
    plan,
    invoices
  });
});

app.post('/companies', verifyStructure(['name', 'contact_email', 'password_hash', 'plan_id', 'admin_name']), async (req, res) => {
  const { name, contact_email, password_hash, plan_id, admin_name } = req.body;

  // Step 1: Check for existing company
  const { data: existingCompany, error: checkError } = await supabase
    .from('companies')
    .select('id')
    .eq('contact_email', contact_email)
    .single();

  if (existingCompany) {
    return res.status(409).json({ error: 'Company already exists with this email.' });
  }

  // Step 2: Fetch plan details to get price_description
  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('price_description')
    .eq('id', plan_id)
    .single();

  if (planError || !plan) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }

  // Step 3: Insert company
  const { data: companyData, error: createError } = await supabase
    .from('companies')
    .insert([{ name, contact_email, password_hash, plan_id, admin_name }])
    .select();

  if (createError) return res.status(400).json(createError);
  const company = companyData[0];

  // Step 4: Create admin user
  const { error: userError } = await supabase.from('users').insert([{
    name: admin_name,
    email: contact_email,
    phone: '',
    role: 'Owner',
    password: password_hash,
    company_id: company.id,
    status: 'active'
  }]);

  if (userError) {
    return res.status(500).json({ error: 'Company created but failed to create admin user.' });
  }

  // Step 5: Send welcome email
  await sendWelcomeEmail(name, contact_email, password_hash, `${process.env.FRONTEND_URL}`);

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
      .eq('is_published', true);

    const { count: incomplete_documents } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('tag_id', tag.id)
      .eq('is_published', false);

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

app.get('/current-users', authenticateToken, async (req, res) => {
  const { companyId, userId } = req.user;

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', userId);

  if (error) return res.status(400).json(error);
  res.json(data);
});

app.post('/users', authenticateToken, verifyStructure(['name', 'email', 'phone', 'role', 'password']), async (req, res) => {
  const { name, email, phone, role, password, allow_to_publish, create_dispute } = req.body;
  const company_id = req.user.companyId;

  const { data, error } = await supabase.from('users').insert([{
    name,
    email,
    phone,
    role,
    password,
    allow_to_publish,
    create_dispute,
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

  let query = supabase
    .from('documents')
    .select('*')
    .order('created_at', { ascending: false }); // 🆕 Sort by newest first

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

  // 👤 Fetch users and clients
  const { data: users, error: userError } = await supabase.from('users').select('id, name, role');
  const { data: clients, error: clientError } = await supabase.from('clients').select('id, name');

  if (userError || clientError) return res.status(400).json(userError || clientError);

  const usersMap = {};
  users.forEach(u => {
    usersMap[u.id] = { name: u.name, role: u.role };
  });
  clients.forEach(c => {
    usersMap[c.id] = { name: c.name, role: 'Client' };
  });

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

  // 1. Fetch document tag to build properties
  const { data: tagData, error: tagError } = await supabase
    .from('document_tags')
    .select('properties')
    .eq('id', tag_id)
    .single();

  if (tagError || !tagData) {
    return res.status(400).json({ error: 'Invalid tag selected.' });
  }

  const propertiesWithValues = tagData.properties.map(prop => ({
    ...prop,
    value: ''
  }));

  // 2. Prepare document
  const document = {
    url,
    company_id,
    title: title,
    progress: 'Incomplete',
    tag_id,
    progress_number: (['Owner', 'Manager', 'Client'].includes(role)) ? 1 : 1,
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

  // 3. Insert document
  const { data: insertedDoc, error: insertError } = await supabase.from('documents').insert([document]).select();
  if (insertError) return res.status(400).json(insertError);

  // 4. Update document_uploaded
  if (role.toLowerCase() === 'client') {
    // 👉 Update in clients table
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('document_uploaded')
      .eq('id', added_by)
      .single();

    if (!clientError && client) {
      const currentUploaded = client.document_uploaded || 0;
      await supabase
        .from('clients')
        .update({ document_uploaded: currentUploaded + 1 })
        .eq('id', added_by);
    }
  } else {
    // 👉 Update in companies table
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('document_uploaded')
      .eq('id', company_id)
      .single();

    if (!companyError && company) {
      const currentUploaded = company.document_uploaded || 0;
      await supabase
        .from('companies')
        .update({ document_uploaded: currentUploaded + 1 })
        .eq('id', company_id);
    }
  }

  res.status(201).json(insertedDoc);
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

app.put('/documents/:id/add-comment', authenticateToken, verifyStructure(['comment']), async (req, res) => {
  const documentId = req.params.id;
  const { comment } = req.body;
  const { userId, role } = req.user;

  // Get user's name based on role
  let userName = '';
  if (role.toLowerCase() === 'client') {
    const { data: client, error } = await supabase
      .from('clients')
      .select('name')
      .eq('id', userId)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    userName = client.name;
  } else {
    const { data: user, error } = await supabase
      .from('users')
      .select('name')
      .eq('id', userId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });
    userName = user.name;
  }

  // Fetch existing comments from the document
  const { data: doc, error: docError } = await supabase
    .from('documents')
    .select('comments')
    .eq('id', documentId)
    .single();

  if (docError || !doc) return res.status(404).json({ error: 'Document not found' });

  const existingComments = doc.comments || [];

  // Append new comment
  const updatedComments = [
    ...existingComments,
    {
      comment,
      added_by: userId,
      role,
      name: userName,
      timestamp: new Date().toISOString()
    }
  ];

  // Update the document
  const { data, error: updateError } = await supabase
    .from('documents')
    .update({ comments: updatedComments })
    .eq('id', documentId)
    .select();

  if (updateError) return res.status(400).json(updateError);
  res.status(200).json({ message: 'Comment added successfully', data });
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

app.get('/document-history/:document_id', async (req, res) => {
  const { document_id } = req.params;

  // Fetch document edit history
  const { data: history, error: historyError } = await supabase
    .from('document_edit_history')
    .select('*')
    .eq('document_id', document_id)
    .order('created_at', { ascending: false });

  if (historyError) return res.status(400).json(historyError);

  // Get all unique edited_by user IDs from history
  const editedByIds = [...new Set(history.map(h => h.edited_by).filter(Boolean))];

  // Fetch user names from users table
  const { data: users } = await supabase
    .from('users')
    .select('id, name')
    .in('id', editedByIds);

  // Fetch client names from clients table
  const { data: clients } = await supabase
    .from('clients')
    .select('id, name')
    .in('id', editedByIds);

  // Combine users and clients into a single lookup
  const userMap = {};
  [...(users || []), ...(clients || [])].forEach(person => {
    userMap[person.id] = person.name;
  });

  // Merge name into each history record
  const enrichedHistory = history.map(entry => ({
    ...entry,
    edited_by_name: userMap[entry.edited_by] || 'Unknown'
  }));

  res.json(enrichedHistory);
});

app.post('/document-history', authenticateToken, verifyStructure(['document_id', 'edit_description']), async (req, res) => {
  const { document_id, edit_description, edit_details } = req.body;
  const edited_by = req.user.userId;
  const role = req.user.role;

  const { data, error } = await supabase
    .from('document_edit_history')
    .insert([
      { document_id, edited_by, role, edit_description, edit_details }
    ])
    .select();

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
app.post('/client-plans', authenticateToken, verifyStructure(['name', 'monthly_bill']), async (req, res) => {
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
app.delete('/clients/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const companyId = req.user.companyId;

  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('id', id)
    .eq('company_id', companyId);

  console.log(error)

  if (error) return res.status(400).json(error);
  res.sendStatus(200);
});


//invoices

app.post('/generate-invoices', async (req, res) => {
  const currentDate = new Date();
  const currentMonth = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  const { data: companies, error: companyError } = await supabase
    .from('companies')
    .select(`
      id, name, contact_email, status, admin_name, plan_id,
      document_shared, document_downloaded, document_uploaded,
      created_at, last_invoice_paid
    `)
    .eq('status', 'Active');

  if (companyError) return res.status(400).json({ error: 'Failed to fetch companies' });

  const results = [];

  for (const company of companies) {
    // Check if it's time to generate an invoice
    const lastPaid = company.last_invoice_paid ? new Date(company.last_invoice_paid) : new Date(company.created_at);

    // Get plan to check billing duration
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('price_description, billing_duration, download_price_per_thousand, share_price_per_thousand, upload_price_per_ten, upload_count, download_count, share_count')
      .eq('id', company.plan_id)
      .single();

    if (planError || !plan) {
      results.push({ company: company.name, status: 'Failed to fetch plan info' });
      continue;
    }

    const durationMonths = plan.billing_duration || 1;
    const nextBillingDate = addMonths(lastPaid, durationMonths);
    const daysUntilNextBilling = differenceInDays(nextBillingDate, currentDate);

    if (daysUntilNextBilling > 5) {
      results.push({ company: company.name, status: `Invoice not due yet (due in ${daysUntilNextBilling} days)` });
      continue;
    }

    // Check for existing invoice for this month
    const { data: existingInvoice } = await supabase
      .from('invoices')
      .select('id')
      .eq('company_id', company.id)
      .eq('invoice_month', currentMonth)
      .single();

    if (existingInvoice) {
      results.push({ company: company.name, status: 'Invoice already exists' });
      continue;
    }

    // Calculate charges
    const monthly = parseFloat(plan.price_description) || 0;
    const upload_count = parseFloat(plan.upload_count) || 0;
    const download_count = parseFloat(plan.download_count) || 0;
    const share_count = parseFloat(plan.share_count) || 0;
    const docShared = company.document_shared || 0;
    const docDownloaded = company.document_downloaded || 0;
    const docUploaded = company.document_uploaded || 0;

    const shared_amount = parseFloat(((docShared / share_count) * parseFloat(plan.share_price_per_thousand || 0)).toFixed(4));
    const download_amount = parseFloat(((docDownloaded / download_count) * parseFloat(plan.download_price_per_thousand || 0)).toFixed(4));
    const upload_amount = parseFloat(((docUploaded / upload_count) * parseFloat(plan.upload_price_per_ten || 0)).toFixed(4));
    const total = parseFloat((monthly + shared_amount + download_amount + upload_amount).toFixed(4));

    // Insert invoice
    const { error: insertError } = await supabase
      .from('invoices')
      .insert([{
        company_id: company.id,
        company_name: company.name,
        email: company.contact_email,
        invoice_month: currentMonth,
        owner_name: company.admin_name || 'Owner',
        invoice_value: total,
        monthly,
        document_shared: docShared,
        shared_amount,
        document_downloaded: docDownloaded,
        download_amount,
        document_uploaded: docUploaded,
        upload_amount,
        invoice_submitted: false
      }]);

    if (insertError) {
      results.push({ company: company.name, status: 'Failed to create invoice' });
      continue;
    }

    results.push({ company: company.name, status: 'Invoice created' });
  }

  res.json({ results });
});

app.put('/invoices/:id/other-invoices', async (req, res) => {
  const { id } = req.params;
  const { other_invoices = [] } = req.body;

  try {
    // Fetch existing invoice
    const { data: invoice, error: fetchError } = await supabase
      .from('invoices')
      .select('invoice_value, other_invoices')
      .eq('id', id)
      .single();

    if (fetchError || !invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const oldOtherInvoices = invoice.other_invoices || [];
    const oldSum = oldOtherInvoices.reduce((sum, item) => sum + parseFloat(item.ammount || 0), 0);
    const newSum = other_invoices.reduce((sum, item) => sum + parseFloat(item.ammount || 0), 0);

    const updatedInvoiceValue = parseFloat((invoice.invoice_value - oldSum + newSum).toFixed(4));

    // Update the invoice
    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        other_invoices,
        invoice_value: updatedInvoiceValue
      })
      .eq('id', id);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update invoice' });
    }

    res.status(200).json({
      message: 'Invoice updated successfully',
      updated_invoice_value: updatedInvoiceValue
    });
  } catch (err) {
    console.error("Error in updating other_invoices:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/remind-invoices', async (req, res) => {
  const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

  const { data: invoices, error: invoiceError } = await supabase
    .from('invoices')
    .select('id, company_id, company_name, email, owner_name, invoice_value')
    .eq('invoice_month', currentMonth)
    .eq('invoice_submitted', false);

  if (invoiceError) return res.status(400).json({ error: 'Failed to fetch unpaid invoices' });

  const results = [];

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.EMAIL_HOST,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: process.env.OAUTH_REFRESH_TOKEN,
    },
  });

  for (const invoice of invoices) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_HOST,
        to: invoice.email,
        subject: `Reminder: Invoice - ${invoice.company_name} - ${currentMonth}`,
        html: `
          <div style="font-family: Arial;">
            <h2>Hi ${invoice.company_name},</h2>
            <p>This is a reminder that your invoice for <strong>${currentMonth}</strong> is still unpaid.</p>
            <ul>
              <li><strong>Owner:</strong> ${invoice.owner_name || 'Owner'}</li>
              <li><strong>Invoice Amount:</strong> $${invoice.invoice_value}</li>
            </ul>
            <p>Please settle your invoice to continue uninterrupted service.</p>
            <p>Thanks,<br/>Talo Innovations</p>
          </div>
        `
      });

      results.push({ company: invoice.company_name, status: 'Reminder email sent' });
    } catch (err) {
      results.push({ company: invoice.company_name, status: 'Failed to send reminder', error: err.message });
    }
  }

  res.status(200).json(results);
});

app.post('/generate-client-invoices', authenticateToken, async (req, res) => {
  const companyId = req.user.companyId;
  const companyName = req.user.name || 'Company';
  const currentDate = new Date();
  const currentMonth = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  const { data: clients, error: clientError } = await supabase
    .from('clients')
    .select('id, name, email, document_shared, document_downloaded, document_uploaded, plan_id, created_at, last_invoice_paid')
    .eq('company_id', companyId);

  if (clientError) return res.status(400).json({ error: 'Failed to fetch clients' });

  const results = [];

  for (const client of clients) {
    const { data: plan, error: planError } = await supabase
      .from('client_plans')
      .select('monthly_bill, upload_price_per_ten, share_price_per_thousand, download_price_per_thousand, upload_count, download_count, share_count, billing_duration')
      .eq('id', client.plan_id)
      .single();

    if (planError || !plan) {
      results.push({ client: client.name, status: 'Failed to fetch plan info' });
      continue;
    }

    const billingDuration = plan.billing_duration || 1;
    const lastPaidDate = client.last_invoice_paid ? new Date(client.last_invoice_paid) : new Date(client.created_at);
    const nextBillingDate = addMonths(lastPaidDate, billingDuration);
    const daysUntilDue = differenceInDays(nextBillingDate, currentDate);

    if (daysUntilDue > 5) {
      results.push({ client: client.name, status: `Invoice not due yet (due in ${daysUntilDue} days)` });
      continue;
    }

    // Avoid duplicate invoice for this month
    const { data: existing } = await supabase
      .from('client_invoices')
      .select('id')
      .eq('company_id', companyId)
      .eq('email', client.email)
      .eq('invoice_month', currentMonth)
      .single();

    if (existing) {
      results.push({ client: client.name, status: 'Invoice already exists' });
      continue;
    }

    const monthly = parseFloat(plan.monthly_bill) || 0;
    const docShared = client.document_shared || 0;
    const docDownloaded = client.document_downloaded || 0;
    const docUploaded = client.document_uploaded || 0;
    const upload_count = parseFloat(plan.upload_count) || 1;
    const download_count = parseFloat(plan.download_count) || 1;
    const share_count = parseFloat(plan.share_count) || 1;

    const shared_amount = parseFloat(((docShared / share_count) * parseFloat(plan.share_price_per_thousand || 0)).toFixed(4));
    const download_amount = parseFloat(((docDownloaded / download_count) * parseFloat(plan.download_price_per_thousand || 0)).toFixed(4));
    const upload_amount = parseFloat(((docUploaded / upload_count) * parseFloat(plan.upload_price_per_ten || 0)).toFixed(4));
    const total = parseFloat((monthly + shared_amount + download_amount + upload_amount).toFixed(4));

    const { error: insertError } = await supabase
      .from('client_invoices')
      .insert([{
        company_id: companyId,
        company_name: companyName,
        email: client.email,
        invoice_month: currentMonth,
        owner_name: client.name,
        invoice_value: total,
        monthly,
        document_shared: docShared,
        shared_amount,
        document_downloaded: docDownloaded,
        download_amount,
        document_uploaded: docUploaded,
        upload_amount,
        invoice_submitted: false
      }]);

    if (insertError) {
      results.push({ client: client.name, status: 'Failed to create invoice' });
    } else {
      results.push({ client: client.name, status: 'Invoice created' });
    }
  }

  res.json({ results });
});

app.put('/client-invoices/:id/other-invoices', authenticateToken, async (req, res) => {
  const invoiceId = req.params.id;
  const { other_invoices } = req.body;

  if (!Array.isArray(other_invoices)) {
    return res.status(400).json({ error: 'other_invoices must be an array' });
  }

  // Calculate sum of new other_invoices
  const newOtherTotal = other_invoices.reduce((sum, item) => {
    return sum + (parseFloat(item.ammount) || 0);
  }, 0);

  try {
    // Fetch the existing invoice
    const { data: existingInvoice, error: fetchError } = await supabase
      .from('client_invoices')
      .select('invoice_value, other_invoices')
      .eq('id', invoiceId)
      .single();

    if (fetchError || !existingInvoice) {
      return res.status(404).json({ error: 'Client invoice not found' });
    }

    const oldOtherInvoices = Array.isArray(existingInvoice.other_invoices)
      ? existingInvoice.other_invoices
      : [];

    // Calculate old other invoices total
    const oldOtherTotal = oldOtherInvoices.reduce((sum, item) => {
      return sum + (parseFloat(item.ammount) || 0);
    }, 0);

    // Update invoice_value
    const updatedInvoiceValue =
      parseFloat(existingInvoice.invoice_value || 0) - oldOtherTotal + newOtherTotal;

    // Update in DB
    const { error: updateError } = await supabase
      .from('client_invoices')
      .update({
        other_invoices,
        invoice_value: parseFloat(updatedInvoiceValue.toFixed(4))
      })
      .eq('id', invoiceId);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update client invoice' });
    }

    res.status(200).json({
      message: 'Client invoice updated successfully',
      updated_invoice_value: parseFloat(updatedInvoiceValue.toFixed(4))
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/remind-unpaid-client-invoices', authenticateToken, async (req, res) => {
  const companyId = req.user.companyId;
  const currentMonth = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });

  const { data: unpaidInvoices, error } = await supabase
    .from('client_invoices')
    .select('email, owner_name, invoice_month, invoice_value')
    .eq('company_id', companyId)
    .eq('invoice_month', currentMonth)
    .eq('invoice_submitted', false);

  if (error) return res.status(400).json({ error: 'Failed to fetch unpaid invoices' });
  if (!unpaidInvoices || unpaidInvoices.length === 0) return res.status(200).json({ message: 'No unpaid invoices found.' });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.EMAIL_HOST,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: process.env.OAUTH_REFRESH_TOKEN,
    },
  });

  const results = [];

  for (const invoice of unpaidInvoices) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_HOST,
        to: invoice.email,
        subject: `Reminder: Unpaid Invoice - ${invoice.owner_name} - ${invoice.invoice_month}`,
        html: `
          <div style="font-family: Arial;">
            <h2>Hello ${invoice.owner_name},</h2>
            <p>This is a friendly reminder that your invoice for <strong>${invoice.invoice_month}</strong> is still unpaid.</p>
            <p><strong>Invoice Amount:</strong> $${invoice.invoice_value}</p>
            <p>Please make payment at your earliest convenience to continue uninterrupted service.</p>
            <p>Thank you,<br/>Talo Innovations</p>
          </div>
        `
      });

      results.push({ email: invoice.email, status: 'Reminder sent' });
    } catch (err) {
      results.push({ email: invoice.email, status: 'Failed to send reminder', error: err.message });
    }
  }

  res.status(200).json(results);
});

app.get('/client-invoices', authenticateToken, async (req, res) => {
  const { companyId } = req.user;

  const { data: invoices, error } = await supabase
    .from('client_invoices')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: 'Failed to fetch client invoices' });

  res.status(200).json(invoices);
});

app.get('/invoices', authenticateToken, async (req, res) => {
  const { role, companyId, userId } = req.user;
  const roleLower = role.toLowerCase();

  // If client, fetch their email first
  if (roleLower === 'client') {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('email')
      .eq('id', userId)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { data: clientInvoices, error: invoiceError } = await supabase
      .from('client_invoices')
      .select('*')
      .eq('email', client.email)
      .order('created_at', { ascending: false });

    if (invoiceError) return res.status(400).json(invoiceError);
    return res.json(clientInvoices);
  }

  // If owner/admin, fetch all company invoices
  let query = supabase.from('invoices').select('*');
  if (roleLower === 'owner') {
    query = query.eq('company_id', companyId);
  }

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return res.status(400).json(error);
  res.json(data);
});

app.put('/invoices/:id/submit', authenticateToken, async (req, res) => {
  const invoiceId = req.params.id;
  const role = req.user.role.toLowerCase();
  const companyid = req.user.companyId;
  const userid = req.user.userId;

  const { data: invoice, error: fetchError } = await supabase
    .from('invoices')
    .select('id, invoice_submitted')
    .eq('id', invoiceId)
    .single();

  if (invoice) {
    if (role === 'admin') {
      if (invoice.invoice_submitted === true) {
        const { data, error } = await supabase
          .from('invoices')
          .update({ invoice_submitted_admin: true })
          .eq('id', invoiceId)
          .select();
        if (error) return res.status(400).json(error);
        return res.json({ message: 'Admin confirmed invoice submission.', data });
      } else {
        return res.status(400).json({ error: 'Invoice must be submitted first by the company.' });
      }
    } else {
      const { data, error } = await supabase
        .from('invoices')
        .update({ invoice_submitted: true })
        .eq('id', invoiceId)
        .select();
      if (data) {
        const { data: companyData, error: companyError } = await supabase
          .from('companies')
          .select('*')
          .eq('id', companyid)
          .single();

        if (companyError || !companyData) {
          console.error("Failed to fetch company:", companyError);
          return;
        }

        const { data: updateData, error: updateError } = await supabase
          .from('companies')
          .update({ last_invoice_paid: new Date().toISOString() })
          .eq('id', companyid);

        const { error: companyUpdateError } = await supabase
          .from('companies')
          .update({
            document_shared: 0,
            document_downloaded: 0,
            document_uploaded: 0
          })
          .eq('id', companyid);

      }

      if (!data) {
        const { data: clientInvoice, error: clientError } = await supabase
          .from('client_invoices')
          .select('id, invoice_submitted')
          .eq('id', invoiceId)
          .single();

        if (clientError || !clientInvoice) {
          return res.status(404).json({ error: 'Invoice not found in either table.' });
        }

        if (role === 'owner') {
          if (clientInvoice.invoice_submitted === true) {
            const { data, error } = await supabase
              .from('client_invoices')
              .update({ invoice_submitted_admin: true })
              .eq('id', invoiceId)
              .select();
            if (error) return res.status(400).json(error);
            return res.json({ message: 'Admin confirmed client invoice submission.', data });
          } else {
            return res.status(400).json({ error: 'Client invoice must be submitted first.' });
          }
        } else {
          const { data, error } = await supabase
            .from('client_invoices')
            .update({ invoice_submitted: true })
            .eq('id', invoiceId)
            .select();

          const { data: updateClient, error: updateClientError } = await supabase
            .from('clients')
            .update({ last_invoice_paid: new Date().toISOString() })
            .eq('id', userid);

          const { error: resetDocsError } = await supabase
            .from('clients')
            .update({
              document_shared: 0,
              document_downloaded: 0,
              document_uploaded: 0
            })
            .eq('id', userid);

          if (error) return res.status(400).json(error);
          return res.json({ role: role, message: 'Client invoice marked as submitted.', data });
        }
      }

      if (error) return res.status(400).json(error);
      return res.json({ message: 'Invoice marked as submitted by company.', data });
    }
  }

  const { data: clientInvoice, error: clientError } = await supabase
    .from('client_invoices')
    .select('id, invoice_submitted')
    .eq('id', invoiceId)
    .single();

  if (clientError || !clientInvoice) {
    return res.status(404).json({ error: 'Invoice not found in either table.' });
  }

  if (role === 'owner') {
    if (clientInvoice.invoice_submitted === true) {
      const { data, error } = await supabase
        .from('client_invoices')
        .update({ invoice_submitted_admin: true })
        .eq('id', invoiceId)
        .select();
      if (error) return res.status(400).json(error);
      return res.json({ message: 'Admin confirmed client invoice submission.', data });
    } else {
      return res.status(400).json({ error: 'Client invoice must be submitted first.' });
    }
  } else {
    const { data, error } = await supabase
      .from('client_invoices')
      .update({ invoice_submitted: true })
      .eq('id', invoiceId)
      .select();

    const { data: updateClient, error: updateClientError } = await supabase
      .from('clients')
      .update({ last_invoice_paid: new Date().toISOString() })
      .eq('id', userid);

    const { error: resetDocsError } = await supabase
      .from('clients')
      .update({
        document_shared: 0,
        document_downloaded: 0,
        document_uploaded: 0
      })
      .eq('id', userid);


    if (error) return res.status(400).json(error);
    return res.json({ message: 'Client invoice marked as submitted.', data });
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

  // 1. Get company data
  const { data: companyData, error: companyError } = await supabase
    .from('companies')
    .select('document_shared')
    .eq('id', companyId)
    .single();

  if (companyError || !companyData) {
    return res.status(400).json({ error: 'Company not found or failed to retrieve.' });
  }

  // 2. Update document_shared manually
  const currentCount = companyData.document_shared || 0;

  const { error: updateCompanyError } = await supabase
    .from('companies')
    .update({ document_shared: currentCount + 1 })
    .eq('id', companyId);

  if (updateCompanyError) {
    return res.status(400).json({ error: 'Failed to update company document_shared count.' });
  }

  // 3. Insert into shareddoc
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

  // 4. Mark the document as shared
  const { error: updateDocError } = await supabase
    .from('documents')
    .update({ shared: true })
    .eq('id', document_id)
    .eq('company_id', companyId);

  if (updateDocError) return res.status(400).json(updateDocError);

  res.status(201).json({ message: 'Document shared and count updated successfully.', shared });
});

app.post('/get-shared-document', verifyStructure(['document_id', 'document_password']), async (req, res) => {
  const { document_id, document_password } = req.body;

  const { data: shared, error } = await supabase
    .from('shareddoc')
    .select('*')
    .eq('id', document_id)
    .eq('document_password', document_password)
    .single();

  if (error || !shared) return res.status(404).json({ error: 'Invalid link or password' });

  res.status(200).json({ message: 'Document access granted.', shared });
});

// 📥 Get Shared Document URL (Client only)
app.get('/get-shared-url/:document_id', authenticateToken, async (req, res) => {
  const { userId, role, companyId } = req.user;
  const { document_id } = req.params;

  const { data, error } = await supabase
    .from('shareddoc')
    .select('id')
    .eq('document_id', document_id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Shared document not found.' });
  }

  // ✅ Increment download count
  if (role.toLowerCase() === 'client') {
    const { data: client } = await supabase
      .from('clients')
      .select('document_downloaded')
      .eq('id', userId)
      .single();

    if (client) {
      await supabase
        .from('clients')
        .update({ document_downloaded: (client.document_downloaded || 0) + 1 })
        .eq('id', userId);
    }
  } else {
    const { data: company } = await supabase
      .from('companies')
      .select('document_downloaded')
      .eq('id', companyId)
      .single();

    if (company) {
      await supabase
        .from('companies')
        .update({ document_downloaded: (company.document_downloaded || 0) + 1 })
        .eq('id', companyId);
    }
  }

  res.status(200).json({
    document_link: `https://archiveinnovators.vercel.app/pdf-view/${data.id}`
  });
});

app.get('/download-document/:document_id', authenticateToken, async (req, res) => {
  const { document_id } = req.params;
  const { companyId, userId, role } = req.user;

  const { data: document, error: docError } = await supabase
    .from('documents')
    .select('url')
    .eq('id', document_id)
    .single();

  if (docError || !document) {
    return res.status(404).json({ error: 'Document not found.' });
  }

  // ✅ Increment download count
  if (role.toLowerCase() === 'client') {
    const { data: client } = await supabase
      .from('clients')
      .select('document_downloaded')
      .eq('id', userId)
      .single();

    if (client) {
      await supabase
        .from('clients')
        .update({ document_downloaded: (client.document_downloaded || 0) + 1 })
        .eq('id', userId);
    }
  } else {
    const { data: company } = await supabase
      .from('companies')
      .select('document_downloaded')
      .eq('id', companyId)
      .single();

    if (company) {
      await supabase
        .from('companies')
        .update({ document_downloaded: (company.document_downloaded || 0) + 1 })
        .eq('id', companyId);
    }
  }

  res.status(200).json({ document_url: document.url });
});

app.get('/get-profile', authenticateToken, async (req, res) => {
  const { userId } = req.user;

  // Try users table
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('name, email, password, phone, documents_reviewed, profile_picture')
    .eq('id', userId)
    .single();

  if (user && !userError) {
    return res.json({ role: 'User', profile: user });
  }

  // If not found, try clients table
  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('email, password, phone, profile_picture')
    .eq('id', userId)
    .single();

  if (client && !clientError) {
    return res.json({ role: 'Client', profile: client });
  }

  return res.status(404).json({ error: 'Profile not found.' });
});

// 📤 Update current user's profile
app.put('/get-profile', authenticateToken, async (req, res) => {
  const { userId } = req.user;
  const { name, password, phone, profile_picture } = req.body;

  // Only these fields are allowed to be updated
  const updateFields = {};
  if (name !== undefined) updateFields.name = name;
  if (password !== undefined) updateFields.password = password;
  if (phone !== undefined) updateFields.phone = phone;
  if (profile_picture !== undefined) updateFields.profile_picture = profile_picture;

  // Update users table first
  const { data: updatedUser, error: userUpdateError } = await supabase
    .from('users')
    .update(updateFields)
    .eq('id', userId)
    .select()
    .single();

  if (updatedUser && !userUpdateError) {
    return res.status(200).json({ message: 'User profile updated.', profile: updatedUser });
  }

  // If not in users table, try clients
  const { data: updatedClient, error: clientUpdateError } = await supabase
    .from('clients')
    .update(updateFields)
    .eq('id', userId)
    .select()
    .single();

  if (updatedClient && !clientUpdateError) {
    return res.status(200).json({ message: 'Client profile updated.', profile: updatedClient });
  }

  return res.status(400).json({ error: 'Failed to update profile.' });
});

app.get('/document-progress', authenticateToken, async (req, res) => {
  const { userId } = req.user;

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday

  // Fetch all edit history by current user since start of week
  const { data: history, error } = await supabase
    .from('document_edit_history')
    .select('created_at, edit_description')
    .eq('edited_by', userId)
    .gte('created_at', startOfWeek.toISOString());

  if (error) return res.status(400).json(error);

  // 🗓️ Daily progress chart
  const progress = {
    Sunday: 0, Monday: 0, Tuesday: 0, Wednesday: 0,
    Thursday: 0, Friday: 0, Saturday: 0
  };

  // 📊 Category counts
  let documents_indexed = 0;
  let documents_viewed = 0;
  let documents_changed = 0;
  let documents_published = 0;

  history.forEach(entry => {
    const day = new Date(entry.created_at).toLocaleDateString('en-US', { weekday: 'long' });
    progress[day]++;

    const desc = entry.edit_description?.toLowerCase() || "";

    if (desc.includes('submitted document for indexing')) documents_indexed++;
    else if (desc.includes('opened the document')) documents_viewed++;
    else if (desc.includes('changed') || desc.includes('edited')) documents_changed++;
    else if (desc.includes('published')) documents_published++;
  });

  res.json({
    userId,
    progress,
    summary: {
      documents_indexed,
      documents_viewed,
      documents_changed,
      documents_published
    }
  });
});

// ✅ Create a Dispute
app.post('/disputes', authenticateToken, verifyStructure(['document_id', 'dispute_description']), async (req, res) => {
  const { document_id, dispute_description } = req.body;
  const { userId, companyId } = req.user;

  const { data, error } = await supabase
    .from('disputes')
    .insert([{
      user_id: userId,
      company_id: companyId,
      document_id,
      dispute_description
    }])
    .select();

  if (error) return res.status(400).json(error);
  res.status(201).json({ message: 'Dispute created successfully.', data });
});

// ✅ Get All Disputes (Role-Based Access)
app.get('/disputes', authenticateToken, async (req, res) => {
  const { userId, companyId, role } = req.user;
  const roleLower = role.toLowerCase();

  // 📥 Step 1: Fetch disputes for the company or user
  let query = supabase
    .from('disputes')
    .select('*')
    .eq('company_id', companyId);

  if (['client', 'qa', 'scanner', 'indexer'].includes(roleLower)) {
    query = query.eq('user_id', userId);
  }

  const { data: disputes, error } = await query;
  if (error) return res.status(400).json(error);

  if (!disputes.length) return res.json([]);

  // 📥 Step 2: Fetch users and clients for names
  const { data: users } = await supabase.from('users').select('id, name');
  const { data: clients } = await supabase.from('clients').select('id, name');

  const userMap = {};
  (users || []).forEach(u => userMap[u.id] = u.name);
  (clients || []).forEach(c => userMap[c.id] = c.name);

  // 📥 Step 3: Fetch document titles
  const documentIds = disputes.map(d => d.document_id);
  const { data: docs } = await supabase
    .from('documents')
    .select('id, title')
    .in('id', documentIds);

  const docMap = {};
  (docs || []).forEach(doc => docMap[doc.id] = doc.title);

  // 🧠 Step 4: Enrich disputes with names + document title
  const enriched = disputes.map(d => ({
    ...d,
    created_by_name: userMap[d.user_id] || 'Unknown',
    document_name: docMap[d.document_id] || 'Unknown Document'
  }));

  res.status(200).json(enriched);
});


// ✅ Resolve a Dispute
app.put('/disputes/:id/resolve', authenticateToken, async (req, res) => {
  const disputeId = req.params.id;

  const { data, error } = await supabase
    .from('disputes')
    .update({ resolve: true })
    .eq('id', disputeId)
    .select();

  if (error) return res.status(400).json(error);
  res.status(200).json({ message: 'Dispute marked as resolved.', data });
});

app.get('/stats', async (req, res) => {
  try {
    // 1. Get all invoices
    const { data: invoices, error: invoiceError } = await supabase
      .from('invoices')
      .select('invoice_value');

    if (invoiceError) return res.status(400).json({ error: 'Failed to fetch invoices', details: invoiceError });

    const totalInvoiceAmount = invoices.reduce((sum, inv) => sum + parseFloat(inv.invoice_value || 0), 0);

    // 2. Get all documents
    const { data: documents, error: docError } = await supabase
      .from('documents')
      .select('is_published');

    if (docError) return res.status(400).json({ error: 'Failed to fetch documents', details: docError });

    const totalDocumentsUploaded = documents.length;
    const totalDocumentsPublished = documents.filter(doc => doc.is_published === true).length;

    // 3. Return system-wide stats
    res.status(200).json({
      totalInvoiceAmount: totalInvoiceAmount.toFixed(2),
      totalDocumentsUploaded,
      totalDocumentsPublished
    });

  } catch (err) {
    res.status(500).json({ error: 'Unexpected error', message: err.message });
  }
});

app.get('/client-overview-metrics', authenticateToken, async (req, res) => {
  const { companyId } = req.user;

  // Step 1: Get all clients under the company
  const { data: clients, error: clientError } = await supabase
    .from('clients')
    .select('id, name, email, document_downloaded')
    .eq('company_id', companyId);

  if (clientError) {
    return res.status(400).json({ error: 'Failed to fetch clients', clientError });
  }

  let totalInvoiceValue = 0;
  let totalInvoicesPaid = 0;
  let totalPaidAmount = 0;
  let totalDocumentsDownloaded = 0;

  const clientEmails = clients.map(client => client.email);

  // Step 2: Fetch all invoices using client emails
  const { data: invoices, error: invoiceError } = await supabase
    .from('client_invoices')
    .select('invoice_value, invoice_submitted, email')
    .in('email', clientEmails);

  if (invoiceError) {
    return res.status(400).json({ error: 'Failed to fetch invoices', invoiceError });
  }

  // Step 3: Aggregate values
  for (const invoice of invoices) {
    const value = parseFloat(invoice.invoice_value || 0);
    totalInvoiceValue += value;

    if (invoice.invoice_submitted) {
      totalInvoicesPaid++;
      totalPaidAmount += value;
    }
  }

  for (const client of clients) {
    totalDocumentsDownloaded += client.document_downloaded || 0;
  }

  res.status(200).json({
    totalInvoiceValue: totalInvoiceValue.toFixed(2),
    totalInvoicesPaid: totalPaidAmount.toFixed(2),
    totalDocumentsDownloaded,
    clients: clients.map(c => ({
      id: c.id,
      name: c.name,
      email: c.email
    }))
  });
});


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));