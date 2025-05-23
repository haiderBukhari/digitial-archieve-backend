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

  if (!user) {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, email, password, company_id, name, status')
      .eq('email', email)
      .single();

    if (client && client.password === password) {
      const { data: company, error: companyError } = await supabase
        .from('companies')
        .select('status')
        .eq('id', client.company_id)
        .single();

      if (companyError || !company || company.status !== 'Active') {
        return res.status(403).json({ error: 'Company is not active. Please contact support.' });
      }

      if (client.status !== 'active') {
        return res.status(403).json({ error: 'Your account is not active. Please contact your company admin.' });
      }

      user = {
        ...client,
        role: 'Client'
      };
    } else {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
  } else if (user.password !== password) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  } else if (user.role != 'admin') {
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('status')
      .eq('id', user.company_id)
      .single();

    if (companyError || !company || company.status !== 'Active') {
      return res.status(403).json({ error: 'Company is not active. Please contact support.' });
    }
  }

  // Generate token
  const token = jwt.sign(
    {
      userId: user.id,
      companyId: user.company_id || null,
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
  const planId = req.params.id;

  const { data: companies, error: fetchError } = await supabase
    .from('companies')
    .select('id, name, contact_email, admin_name')
    .eq('plan_id', planId);

  if (fetchError) return res.status(400).json(fetchError);

  if (companies.length > 0) {
    return res.status(400).json({
      message: 'Cannot delete plan. The following companies are currently using this plan.',
      companies: companies.map(company => ({
        company_name: company.name,
        admin_name: company.admin_name,
        contact_email: company.contact_email
      }))
    });
  }

  const { error: deleteError } = await supabase
    .from('plans')
    .delete()
    .eq('id', planId);

  if (deleteError) return res.status(400).json(deleteError);

  res.status(200).json({ message: 'Plan successfully deleted.' });
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
    planFields = 'can_download, can_share, can_view_reports, can_view_activity_logs, can_view_chat';
  } else {
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
    planFields = 'can_share_document, can_view_activity_logs, can_add_client, number_of_clients, can_view_reports, allow_multiple_uploads, can_view_chat';
  }

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
  const planId = req.params.id;

  const { data: clients, error: fetchError } = await supabase
    .from('clients')
    .select('id, name, status, email')
    .eq('plan_id', planId)
    .eq('company_id', companyId);

  if (fetchError) return res.status(400).json(fetchError);

  if (clients.length > 0) {
    return res.status(400).json({
      message: 'Cannot delete plan. The following clients are currently using this plan.',
      clients: clients.map(client => ({
        client_name: client.name,
        status: client.status,
        contact_email: client.email || 'N/A'
      }))
    });
  }

  const { error: deleteError } = await supabase
    .from('client_plans')
    .delete()
    .eq('id', planId)
    .eq('company_id', companyId);

  if (deleteError) return res.status(400).json(deleteError);

  res.status(200).json({ message: 'Client plan successfully deleted.' });
});

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

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

const differenceInDays = (a, b) => {
  const diffTime = a.getTime() - b.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};


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

  const { data: allPlans, error: planFetchError } = await supabase
    .from('plans')
    .select('*');

  if (planFetchError) return res.status(400).json({ error: 'Failed to fetch plans' });

  const { data: existingInvoices, error: invoiceFetchError } = await supabase
    .from('invoices')
    .select('company_id')
    .eq('invoice_month', currentMonth);

  if (invoiceFetchError) return res.status(400).json({ error: 'Failed to fetch existing invoices' });

  const results = [];

  for (const company of companies) {
    const alreadyInvoiced = existingInvoices.some(inv => inv.company_id === company.id);
    if (alreadyInvoiced) {
      results.push({ company: company.name, status: 'Invoice already exists' });
      continue;
    }

    const plan = allPlans.find(p => p.id === company.plan_id);
    if (!plan) {
      results.push({ company: company.name, status: 'Plan not found' });
      continue;
    }

    const referenceDate = new Date(company.last_invoice_paid || company.created_at);
    const currentMonthIndex = currentDate.getMonth();
    const referenceMonthIndex = referenceDate.getMonth();
    const currentYear = currentDate.getFullYear();
    const referenceYear = referenceDate.getFullYear();

    const monthDifference = (currentYear - referenceYear) * 12 + (currentMonthIndex - referenceMonthIndex);

    if (monthDifference < (plan.billing_duration || 1)) {
      results.push({ company: company.name, status: `Invoice not due yet (waiting ${plan.billing_duration - monthDifference} more month(s))` });
      continue;
    }

    const monthly = parseFloat(plan.price_description) || 0;
    const upload_count = parseFloat(plan.upload_count) || 1;
    const download_count = parseFloat(plan.download_count) || 1;
    const share_count = parseFloat(plan.share_count) || 1;

    const docShared = company.document_shared || 0;
    const docDownloaded = company.document_downloaded || 0;
    const docUploaded = company.document_uploaded || 0;

    const shared_amount = parseFloat(((docShared / share_count) * parseFloat(plan.share_price_per_thousand || 0)).toFixed(4));
    const download_amount = parseFloat(((docDownloaded / download_count) * parseFloat(plan.download_price_per_thousand || 0)).toFixed(4));
    const upload_amount = parseFloat(((docUploaded / upload_count) * parseFloat(plan.upload_price_per_ten || 0)).toFixed(4));

    const total = parseFloat((monthly + shared_amount + download_amount + upload_amount).toFixed(4));

    const nextDueDate = new Date();
    nextDueDate.setDate(currentDate.getDate() + 15);

    const { data: invoiceData, error: invoiceInsertError } = await supabase
      .from('invoices')
      .insert({
        company_id: company.id,
        company_name: company.name,
        email: company.contact_email,
        invoice_month: currentMonth,
        invoice_value: total,
        monthly,
        document_shared: docShared,
        shared_amount,
        document_downloaded: docDownloaded,
        download_amount,
        document_uploaded: docUploaded,
        upload_amount,
        invoice_submitted: false,
        owner_name: company.admin_name ? company.admin_name : company.name,
        is_submitted: false,
        last_date: nextDueDate.toISOString()
      })
      .select();

      console.log(invoiceInsertError)

    if (invoiceInsertError) {
      results.push({ company: company.name, status: 'Invoice creation failed' });
    } else {
      results.push({ company: company.name, status: 'Invoice created', invoice: invoiceData });
    }
  }

  return res.status(200).json(results);
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

    // Calculate month difference
    const billingDuration = plan.billing_duration || 1;
    const referenceDate = new Date(client.last_invoice_paid || client.created_at);
    const monthDifference =
      (currentDate.getFullYear() - referenceDate.getFullYear()) * 12 +
      (currentDate.getMonth() - referenceDate.getMonth());

    if (monthDifference < billingDuration) {
      results.push({ client: client.name, status: `Invoice not due yet (waiting ${billingDuration - monthDifference} more month(s))` });
      continue;
    }

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


    const nextDueDate = new Date();
    nextDueDate.setDate(currentDate.getDate() + 15);

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
        invoice_submitted: false,
        is_submitted: false,
        last_date: nextDueDate.toISOString()
      }]);

    if (insertError) {
      results.push({ client: client.name, status: 'Failed to insert invoice' });
      continue;
    }

    results.push({ client: client.name, status: 'Invoice generated successfully' });
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

  try {
    const [standardRes, customRes] = await Promise.all([
      supabase
        .from('client_invoices')
        .select('*')
        .eq('company_id', companyId),

      supabase
        .from('custom_invoices')
        .select('*')
        .eq('company_id', companyId)
        .eq('is_client', true)
    ]);

    if (standardRes.error || customRes.error) {
      return res.status(400).json({
        error: standardRes.error?.message || customRes.error?.message || 'Failed to fetch invoices'
      });
    }

    const standardInvoices = (standardRes.data || []).map(inv => ({
      ...inv,
      type: 'standard',
      invoice_month: inv.invoice_month || 'Unknown',
    }));

    const customInvoices = (customRes.data || []).map(inv => ({
      ...inv,
      type: 'custom',
      invoice_month: 'Custom Invoice',
    }));

    const combined = [...standardInvoices, ...customInvoices].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    res.status(200).json(combined);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/invoices', authenticateToken, async (req, res) => {
  const { role, companyId, userId } = req.user;
  const roleLower = role.toLowerCase();

  try {
    if (roleLower === 'client') {
      const { data: client, error: clientError } = await supabase
        .from('clients')
        .select('email')
        .eq('id', userId)
        .single();

      if (clientError || !client) {
        return res.status(404).json({ error: 'Client not found' });
      }

      const [clientInvoices, customClientInvoices] = await Promise.all([
        supabase
          .from('client_invoices')
          .select('*')
          .eq('email', client.email)
          .eq('is_submitted', true),
        supabase
          .from('custom_invoices')
          .select('*')
          .eq('is_client', true)
          .eq('user_id', userId)
      ]);

      if (clientInvoices.error || customClientInvoices.error) {
        return res.status(400).json({
          error: clientInvoices.error?.message || customClientInvoices.error?.message
        });
      }

      const standard = (clientInvoices.data || []).map(inv => ({
        ...inv,
        type: 'standard',
        invoice_month: inv.invoice_month || 'Unknown',
      }));

      const custom = (customClientInvoices.data || []).map(inv => ({
        ...inv,
        type: 'custom',
        invoice_month: 'Custom Invoice',
      }));

      const combined = [...standard, ...custom].sort((a, b) => {
        return Date.parse(b.created_at) - Date.parse(a.created_at);
      });

      return res.json(combined);
    }

    if (roleLower === 'owner') {
      if (!companyId) {
        return res.status(400).json({ error: 'Missing company ID for owner' });
      }

      const [standardInvoices, customInvoices] = await Promise.all([
        supabase.from('invoices').select('*').eq('company_id', companyId).eq('is_submitted', true),
        supabase.from('custom_invoices').select('*').eq('company_id', companyId).eq('is_client', false)
      ]);

      if (standardInvoices.error || customInvoices.error) {
        return res.status(400).json({ error: standardInvoices.error || customInvoices.error });
      }

      const standard = (standardInvoices.data || []).map(inv => ({
        ...inv,
        type: 'standard',
        invoice_month: inv.invoice_month || 'Unknown',
      }));

      const custom = (customInvoices.data || []).map(inv => ({
        ...inv,
        type: 'custom',
        invoice_month: 'Custom Invoice',
      }));

      const combined = [...standard, ...custom].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      return res.json(combined);
    }

    if (roleLower === 'admin') {
      const [standardInvoices, customInvoices] = await Promise.all([
        supabase.from('invoices').select('*'),
        supabase.from('custom_invoices').select('*').eq('is_client', false)
      ]);

      if (standardInvoices.error || customInvoices.error) {
        return res.status(400).json({ error: standardInvoices.error || customInvoices.error });
      }

      const standard = (standardInvoices.data || []).map(inv => ({
        ...inv,
        type: 'standard',
        invoice_month: inv.invoice_month || 'Unknown',
      }));

      const custom = (customInvoices.data || []).map(inv => ({
        ...inv,
        type: 'custom',
        invoice_month: 'Custom Invoice',
      }));

      const combined = [...standard, ...custom].sort((a, b) => {
        return Date.parse(b.created_at) - Date.parse(a.created_at);
      });

      return res.json(combined);
    }

    return res.status(403).json({ error: 'Unauthorized role' });

  } catch (err) {
    console.error('Invoice fetch error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/check-invoice-submission', authenticateToken, async (req, res) => {
  const { role, companyId } = req.user;
  const roleLower = role.toLowerCase();

  try {
    let hasUnsubmitted = false;

    if (roleLower === 'admin') {
      const { data: invoices, error } = await supabase
        .from('invoices')
        .select('is_submitted');

      if (error) {
        console.error('Supabase error (admin):', error);
        return res.status(500).json({ message: 'Failed to fetch invoices' });
      }

      hasUnsubmitted = invoices.some(inv => inv.is_submitted !== true);
    }

    else if (roleLower === 'owner') {
      const { data: clientInvoices, error } = await supabase
        .from('client_invoices')
        .select('is_submitted')
        .eq('company_id', companyId);


      if (error) {
        console.error('Supabase error (owner):', error);
        return res.status(500).json({ message: 'Failed to fetch client invoices' });
      }

      hasUnsubmitted = clientInvoices.some(inv => inv.is_submitted !== true);
    }

    return res.status(200).json({ showSendInvoice: hasUnsubmitted });
  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.post('/submit-all-companies', authenticateToken, async (req, res) => {
  const { role, companyId } = req.user;
  const roleLower = role.toLowerCase();

  try {
    let error;

    if (roleLower === 'admin') {
      const update = await supabase
        .from('invoices')
        .update({ is_submitted: true })
        .not('id', 'is', null);

      error = update.error;
    }

    else if (roleLower === 'owner') {
      const update = await supabase
        .from('client_invoices')
        .update({ is_submitted: true })
        .eq('company_id', companyId);

      error = update.error;
    }

    if (error) {
      console.error('Supabase update error:', error);
      return res.status(500).json({ message: 'Failed to mark invoices as submitted' });
    }

    return res.status(200).json({ message: 'Invoices marked as submitted' });
  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.put('/invoices/:id/submit', authenticateToken, async (req, res) => {
  const invoiceId = req.params.id;
  const { role, companyId, userId } = req.user;
  const roleLower = role.toLowerCase();

  let { data: invoice, error: fetchError } = await supabase
    .from('invoices')
    .select('id, invoice_submitted')
    .eq('id', invoiceId)
    .single();

  if (invoice) {
    if (roleLower === 'admin') {
      if (invoice.invoice_submitted === true) {
        const { data, error } = await supabase
          .from('invoices')
          .update({ invoice_submitted_admin: true })
          .eq('id', invoiceId)
          .select();
        return error ? res.status(400).json(error) : res.json({ message: 'Admin confirmed invoice submission.', data });
      } else {
        return res.status(400).json({ error: 'Invoice must be submitted first by the company.' });
      }
    } else {
      const { data, error } = await supabase
        .from('invoices')
        .update({ invoice_submitted: true })
        .eq('id', invoiceId)
        .select();

      if (error) return res.status(400).json(error);

      await supabase.from('companies').update({
        last_invoice_paid: new Date().toISOString(),
        document_shared: 0,
        document_downloaded: 0,
        document_uploaded: 0
      }).eq('id', companyId);

      return res.json({ message: 'Invoice submitted successfully.', data });
    }
  }

  const { data: customInvoice, error: customError } = await supabase
    .from('custom_invoices')
    .select('id, is_client, invoice_submitted, invoice_submitted_admin')
    .eq('id', invoiceId)
    .single();

  if (customInvoice) {
    if (roleLower === 'client') {
      if (customInvoice.is_client) {
        const { data, error } = await supabase
          .from('custom_invoices')
          .update({ invoice_submitted: true })
          .eq('id', invoiceId)
          .select();
        return error ? res.status(400).json(error) : res.json({ message: 'Client submitted invoice.', data });
      } else {
        return res.status(403).json({ error: 'Client cannot submit this invoice.' });
      }
    }

    if (roleLower === 'owner') {
      if (customInvoice.is_client && customInvoice.invoice_submitted) {
        const { data, error } = await supabase
          .from('custom_invoices')
          .update({ invoice_submitted_admin: true })
          .eq('id', invoiceId)
          .select();
        return error ? res.status(400).json(error) : res.json({ message: 'Owner approved client invoice.', data });
      }

      if (!customInvoice.is_client) {
        const { data, error } = await supabase
          .from('custom_invoices')
          .update({ invoice_submitted: true })
          .eq('id', invoiceId)
          .select();
        return error ? res.status(400).json(error) : res.json({ message: 'Owner submitted invoice.', data });
      }
    }

    if (roleLower === 'admin') {
      if (customInvoice.invoice_submitted === true) {
        const { data, error } = await supabase
          .from('custom_invoices')
          .update({ invoice_submitted_admin: true })
          .eq('id', invoiceId)
          .select();
        return error ? res.status(400).json(error) : res.json({ message: 'Admin approved custom invoice.', data });
      } else {
        return res.status(400).json({ error: 'Invoice must be submitted first.' });
      }
    }
  }

  // 3. Try client_invoices
  // 3. Try client_invoices
  const { data: clientInvoice, error: clientInvoiceError } = await supabase
    .from('client_invoices')
    .select('id, invoice_submitted, invoice_submitted_admin')
    .eq('id', invoiceId)
    .single();

  if (clientInvoice) {
    if (roleLower === 'client') {
      // Mark invoice_submitted true
      const { data, error } = await supabase
        .from('client_invoices')
        .update({ invoice_submitted: true })
        .eq('id', invoiceId)
        .select();

      if (error) return res.status(400).json(error);

      const updateFields = {
        document_shared: 0,
        document_downloaded: 0,
        document_uploaded: 0,
        last_invoice_paid: new Date().toISOString()
      };

      const { error: updateError } = await supabase
        .from('clients')
        .update(updateFields)
        .eq('id', userId);

      if (updateError) return res.status(400).json(updateError);

      return res.json({ message: 'Client invoice submitted and stats reset.', data });
    }

    if (roleLower === 'owner') {
      if (clientInvoice.invoice_submitted === true) {
        const { data, error } = await supabase
          .from('client_invoices')
          .update({ invoice_submitted_admin: true })
          .eq('id', invoiceId)
          .select();

        return error ? res.status(400).json(error) : res.json({ message: 'Owner approved client invoice.', data });
      } else {
        return res.status(400).json({ error: 'Client must submit the invoice first.' });
      }
    }
  }
  // 4. If not found in any table
  return res.status(404).json({ error: 'Invoice not found in any table.' });
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
    return res.status(400).json({ error: 'Shared document not found.' });
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
  const { type = 'week' } = req.query; // default is 'week'

  const now = new Date();
  let startDate;
  let groupByDayName = false;

  if (type === 'week') {
    // Start from last Sunday
    startDate = new Date(now);
    startDate.setDate(now.getDate() - now.getDay());
    groupByDayName = true;
  } else if (type === '15days') {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - 14); // Includes today (15 days total)
  } else if (type === 'month') {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - 29); // Includes today (30 days total)
  } else {
    return res.status(400).json({ error: 'Invalid type. Must be one of: week, 15days, month.' });
  }

  // Fetch edit history since the determined start date
  const { data: history, error } = await supabase
    .from('document_edit_history')
    .select('created_at, edit_description')
    .eq('edited_by', userId)
    .gte('created_at', startDate.toISOString());

  if (error) return res.status(400).json(error);

  const progress = {};
  const documents_indexed = history.filter(e => e.edit_description?.toLowerCase().includes('submitted document for indexing')).length;
  const documents_viewed = history.filter(e => e.edit_description?.toLowerCase().includes('opened the document')).length;
  const documents_changed = history.filter(e => {
    const desc = e.edit_description?.toLowerCase();
    return desc?.includes('changed') || desc?.includes('edited');
  }).length;
  const documents_published = history.filter(e => e.edit_description?.toLowerCase().includes('published')).length;

  // Initialize progress structure
  if (groupByDayName) {
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach(day => {
      progress[day] = 0;
    });
  } else {
    for (let i = 0; i < (type === '15days' ? 15 : 30); i++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + i);
      const key = date.toISOString().split('T')[0]; // YYYY-MM-DD
      progress[key] = 0;
    }
  }

  // Tally history into the progress object
  history.forEach(entry => {
    const date = new Date(entry.created_at);
    const key = groupByDayName
      ? date.toLocaleDateString('en-US', { weekday: 'long' })
      : date.toISOString().split('T')[0]; // YYYY-MM-DD
    if (progress[key] !== undefined) {
      progress[key]++;
    }
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
    // 1. Get all invoices (generic)
    const { data: invoices, error: invoiceError } = await supabase
      .from('invoices')
      .select('invoice_value');

    if (invoiceError) {
      return res.status(400).json({ error: 'Failed to fetch invoices', details: invoiceError });
    }

    const totalInvoiceAmountFromInvoices = invoices.reduce(
      (sum, inv) => sum + parseFloat(inv.invoice_value || 0),
      0
    );

    // 2. Get custom_invoices where isclient = false
    const { data: customInvoices, error: customError } = await supabase
      .from('custom_invoices')
      .select('total')
      .eq('is_client', false);

    if (customError) {
      return res.status(400).json({ error: 'Failed to fetch custom invoices', details: customError });
    }

    const totalInvoiceAmountFromCustom = customInvoices.reduce(
      (sum, inv) => sum + parseFloat(inv.total || 0),
      0
    );

    // 3. Get documents
    const { data: documents, error: docError } = await supabase
      .from('documents')
      .select('is_published');

    if (docError) {
      return res.status(400).json({ error: 'Failed to fetch documents', details: docError });
    }

    const totalDocumentsUploaded = documents.length;
    const totalDocumentsPublished = documents.filter(doc => doc.is_published === true).length;

    // 4. Return combined stats
    res.status(200).json({
      totalInvoiceAmount: (totalInvoiceAmountFromInvoices + totalInvoiceAmountFromCustom).toFixed(2),
      totalDocumentsUploaded,
      totalDocumentsPublished
    });

  } catch (err) {
    res.status(500).json({ error: 'Unexpected error', message: err.message });
  }
});

app.get('/client-overview-metrics', authenticateToken, async (req, res) => {
  const { companyId } = req.user;

  // Fetch client_invoices
  const { data: invoices, error: error1 } = await supabase
    .from('client_invoices')
    .select('invoice_value, invoice_submitted, document_downloaded, company_name, owner_name, email')
    .eq('company_id', companyId);

  // Fetch custom_invoices
  const { data: customInvoices, error: error2 } = await supabase 
    .from('custom_invoices')
    .select('total, invoice_submitted')
    .eq('company_id', companyId)
    .eq('is_client', true);

  if (error1 || error2) {
    return res.status(400).json({ error: 'Failed to fetch invoices', details: [error1, error2] });
  }

  // Initialize totals
  let totalInvoiceValue = 0;
  let totalPaidAmount = 0;
  let totalInvoicesPaid = 0;
  let totalDocumentsDownloaded = 0;
  const clients = [];

  // Process client_invoices
  for (const invoice of invoices) {
    const value = Number(invoice.invoice_value) || 0;
    const docs = Number(invoice.document_downloaded) || 0;

    totalInvoiceValue += value;
    totalDocumentsDownloaded += docs;

    if (invoice.invoice_submitted) {
      totalInvoicesPaid++;
      totalPaidAmount += value;
    }

    clients.push({
      company_name: invoice.company_name || "N/A",
      owner_name: invoice.owner_name || "N/A",
      email: invoice.email || "N/A"
    });
  }

  // Process custom_invoices
  for (const invoice of customInvoices) {
    const value = Number(invoice.total) || 0;
    totalInvoiceValue += value;

    if (invoice.invoice_submitted) {
      totalInvoicesPaid++;
      totalPaidAmount += value;
    }
  }

  // Return metrics
  res.status(200).json({
    totalInvoiceValue: totalInvoiceValue.toFixed(2),
    totalInvoicesPaid: totalPaidAmount.toFixed(2),
    totalDocumentsDownloaded,
    clients
  });
});


app.get('/invoice-preview', authenticateToken, async (req, res) => {
  const { companyId } = req.user;
  const currentDate = new Date();

  try {
    // 1. Fetch company
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('id, name, plan_id, document_shared, document_downloaded, document_uploaded, created_at, last_invoice_paid')
      .eq('id', companyId)
      .single();
    if (companyError || !company) return res.status(400).json({ error: 'Company not found' });

    // 2. Fetch plan
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('*')
      .eq('id', company.plan_id)
      .single();
    if (planError || !plan) return res.status(400).json({ error: 'Plan not found' });

    // 3. Invoice calculation
    const lastPaid = new Date(company.last_invoice_paid || company.created_at);
    const nextBillingDate = addMonths(lastPaid, plan.billing_duration || 1);
    const daysUntilDue = differenceInDays(nextBillingDate, currentDate);

    const monthly = parseFloat(plan.price_description) || 0;
    const upload_count = parseFloat(plan.upload_count) || 1;
    const download_count = parseFloat(plan.download_count) || 1;
    const share_count = parseFloat(plan.share_count) || 1;

    const shared_amount = parseFloat(((company.document_shared || 0) / share_count) * (plan.share_price_per_thousand || 0)).toFixed(2);
    const download_amount = parseFloat(((company.document_downloaded || 0) / download_count) * (plan.download_price_per_thousand || 0)).toFixed(2);
    const upload_amount = parseFloat(((company.document_uploaded || 0) / upload_count) * (plan.upload_price_per_ten || 0)).toFixed(2);

    const totalInvoiceAmount = parseFloat((parseFloat(monthly) + parseFloat(shared_amount) + parseFloat(download_amount) + parseFloat(upload_amount)).toFixed(2));

    // 4. Fetch clients
    const { data: clients, error: clientError } = await supabase
      .from('clients')
      .select('email')
      .eq('company_id', companyId);
    if (clientError) return res.status(400).json({ error: 'Failed to fetch clients' });

    const totalClients = clients.length;
    const clientEmails = clients.map(c => c.email);

    // 5. Fetch client invoices
    const { data: clientInvoices, error: invoiceError } = await supabase
      .from('client_invoices')
      .select('invoice_value, invoice_submitted, email')
      .in('email', clientEmails);
    if (invoiceError) return res.status(400).json({ error: 'Failed to fetch invoices' });

    let totalInvoiceValue = 0;
    let totalPaid = 0;
    for (const invoice of clientInvoices) {
      const val = parseFloat(invoice.invoice_value || 0);
      totalInvoiceValue += val;
      if (invoice.invoice_submitted) totalPaid += val;
    }

    // 6. Fetch documents
    const { data: documents, error: docError } = await supabase
      .from('documents')
      .select('is_published')
      .eq('company_id', companyId);
    if (docError) return res.status(400).json({ error: 'Failed to fetch documents', docError });

    const totalDocuments = documents.length;
    const completeDocuments = documents.filter(doc => doc.is_published === true).length;
    const incompleteDocuments = totalDocuments - completeDocuments;

    // 7. Fetch disputes
    const { data: disputes, error: disputeError } = await supabase
      .from('disputes')
      .select('resolve')
      .eq('company_id', companyId);
    if (disputeError) return res.status(400).json({ error: 'Failed to fetch disputes' });

    const resolvedDisputes = disputes.filter(d => d.resolve === true).length;
    const activeDisputes = disputes.length - resolvedDisputes;

    // ✅ Final Response
    return res.json({
      company: company.name,
      planName: plan.name,
      nextBillingDueInDays: daysUntilDue,
      invoiceBreakdown: {
        monthlyCharge: parseFloat(monthly),
        uploadCharge: parseFloat(upload_amount),
        downloadCharge: parseFloat(download_amount),
        shareCharge: parseFloat(shared_amount),
        totalInvoiceAmount
      },
      metrics: {
        totalInvoiceValue: totalInvoiceValue.toFixed(2),
        totalInvoicesPaid: totalPaid.toFixed(2),
        totalClients,
        totalDocuments,
        completeDocuments,
        incompleteDocuments,
        documentsDownloaded: company.document_downloaded || 0,
        documentsShared: company.document_shared || 0,
        documentsUploaded: company.document_uploaded || 0,
        activeDisputes,
        resolvedDisputes
      }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

app.post('/custom-invoice', authenticateToken, async (req, res) => {
  const role = req.user.role.toLowerCase();
  const companyId = req.user.companyId;

  const {
    company_id,
    date,
    payment_term,
    due_date,
    company_name,
    client_name,
    user_id,
    bill_to,
    quantities,
    subtotal,
    discount_percent,
    tax_percent,
    total,
    notes
  } = req.body;

  let admin_name = null;
  let recipient_email = null;

  if (role === "admin") {
    const { data: companyData, error: companyError } = await supabase
      .from('companies')
      .select('admin_name, contact_email')
      .eq('id', company_id)
      .single();

    if (companyError) {
      return res.status(400).json({ error: companyError.message });
    }

    admin_name = companyData.admin_name;
    recipient_email = companyData.contact_email;
  }

  if (role === "owner") {
    const { data: clientData, error: clientError } = await supabase
      .from('clients')
      .select('email')
      .eq('id', user_id)
      .single();

    if (clientError) {
      return res.status(400).json({ error: clientError.message });
    }

    recipient_email = clientData.email;
  }

  // Insert invoice
  const { data, error } = await supabase
    .from('custom_invoices')
    .insert([{
      company_id: role === "admin" ? company_id : companyId,
      is_client: role === "admin" ? false : true,
      date,
      user_id,
      payment_term,
      due_date,
      company_name,
      client_name,
      bill_to,
      quantities,
      subtotal,
      discount_percent,
      tax_percent,
      total,
      notes,
      owner_name: role === "admin" ? admin_name : client_name
    }])
    .select();

  if (error) return res.status(400).json({ error });

  // Send email
  try {
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

    const subject = `🧾 New Invoice from ${company_name}`;

    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
        <div style="background-color: #22BC66; padding: 20px; text-align: center;">
          <h1 style="color: #fff; margin: 0;">Talo Innovations</h1>
        </div>
        <div style="padding: 20px; color: #333;">
          <h2>Hello ${client_name},</h2>
          <p>You’ve received a new invoice from <strong>${company_name}</strong>.</p>
          <p><strong>Invoice Date:</strong> ${date}</p>
          <p><strong>Due Date:</strong> ${due_date}</p>
          <p><strong>Total:</strong> $${total}</p>
          <p>Please log in to your account to view and pay the invoice.</p>
          <div style="text-align: center; margin: 20px 0;">
            <a href="${process.env.LOGIN_LINK || '#'}" style="background-color: #22BC66; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-size: 16px;">
              View Invoice
            </a>
          </div>
          <p>Thank you for choosing Talo Innovations.</p>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: `"Talo Innovations" <${process.env.EMAIL_HOST}>`,
      to: recipient_email,
      subject,
      html: emailBody,
    });
  } catch (mailError) {
    console.error("Email error:", mailError);
  }

  res.status(201).json(data[0]);
});

app.put('/custom-invoice/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { companyId } = req.user;
  const updates = req.body;

  const { data, error } = await supabase
    .from('custom_invoices')
    .update(updates)
    .eq('id', id)
    .eq('company_id', companyId)
    .select();

  if (error) return res.status(400).json({ error });
  res.json(data[0]);
});

app.get('/custom-invoices', authenticateToken, async (req, res) => {
  const { companyId } = req.user;

  const { data, error } = await supabase
    .from('custom_invoices')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error });
  res.json(data);
});

app.get('/custom-invoice/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('custom_invoices')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return res.status(400).json({ error });
  res.json(data);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));