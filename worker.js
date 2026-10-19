// ═══════════════════════════════════════════════════════════════════════════
// PCN SEWING — WORKER (everything in one file, no imports needed)
// Same pattern as Bullmer: /api/* goes to the handlers below; everything
// else falls through to the ASSETS binding, which serves the HTML pages,
// config.js, manifest.json and OneSignalSDKWorker.js from the repo root
// (see wrangler.toml's [assets] block and .assetsignore).
// D1 database: pcn_app, bound as DB.
// ═══════════════════════════════════════════════════════════════════════════

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// "to" date filters: include the whole last day. ISO timestamps carry
// milliseconds + Z, so '…T23:59:59' alone would drop the final second.
const endOfDay = d => (d.length === 10 ? d + 'T23:59:59.999Z' : d);
const clampLimit = (v, def, max) => Math.min(Math.max(parseInt(v, 10) || def, 1), max);
const isUnique = e => String((e && e.message) || e).includes('UNIQUE');

// ── master_data ──────────────────────────────────────────────────────────
async function getMasterData(request, env) {
  const url = new URL(request.url);
  const assetNo = url.searchParams.get('asset_no');

  if (assetNo) {
    const row = await env.DB.prepare(
      'SELECT asset_no, asset_type FROM master_data WHERE asset_no = ?'
    ).bind(assetNo).first();
    return json(row || null);
  }

  // Distinct machine types (PM scheduling "by asset type" dropdown)
  if (url.searchParams.get('types')) {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT asset_type FROM master_data
       WHERE asset_type IS NOT NULL AND asset_type <> '' ORDER BY asset_type`
    ).all();
    return json(results.map(r => r.asset_type));
  }

  // All assets of one machine type
  const assetType = url.searchParams.get('asset_type');
  if (assetType) {
    const { results } = await env.DB.prepare(
      'SELECT asset_no, asset_type FROM master_data WHERE asset_type = ? ORDER BY asset_no'
    ).bind(assetType).all();
    return json(results);
  }

  // Assets whose LATEST scan is at a location (PM scheduling "by line")
  const location = url.searchParams.get('location');
  if (location) {
    const { results } = await env.DB.prepare(
      `SELECT m.asset_no, m.asset_type FROM master_data m
       JOIN (
         SELECT asset_no, location,
                ROW_NUMBER() OVER (PARTITION BY asset_no ORDER BY scan_timestamp DESC) AS rn
         FROM scan_log
       ) s ON s.asset_no = m.asset_no AND s.rn = 1
       WHERE s.location = ? ORDER BY m.asset_no`
    ).bind(location).all();
    return json(results);
  }

  const { results } = await env.DB.prepare(
    'SELECT asset_no, asset_type FROM master_data ORDER BY asset_no'
  ).all();
  return json(results);
}

// Upsert — used when a mechanic confirms the type of an "Unknown" asset.
async function postMasterData(request, env) {
  const body = await request.json();
  if (!body.asset_no || !body.asset_type) {
    return json({ error: 'asset_no and asset_type required' }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO master_data (asset_no, asset_type) VALUES (?, ?)
     ON CONFLICT(asset_no) DO UPDATE SET asset_type = excluded.asset_type`
  ).bind(body.asset_no, body.asset_type).run();
  return json({ success: true });
}

// ── scan_log ─────────────────────────────────────────────────────────────
async function getScanLog(request, env) {
  const url = new URL(request.url);
  const assetNo = url.searchParams.get('asset_no');
  const mode = url.searchParams.get('mode');

  // Last known location (Asset Tracker movement check)
  if (assetNo && url.searchParams.get('last')) {
    const row = await env.DB.prepare(
      `SELECT location, scan_timestamp FROM scan_log
       WHERE asset_no = ? ORDER BY scan_timestamp DESC LIMIT 1`
    ).bind(assetNo).first();
    return json(row || null);
  }

  // Full history for one asset, oldest first (Asset Profile)
  if (assetNo) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM scan_log WHERE asset_no = ? ORDER BY scan_timestamp ASC`
    ).bind(assetNo).all();
    return json(results);
  }

  // Most recent scans, newest first (Asset Tracking tab)
  if (mode === 'recent') {
    const limit = clampLimit(url.searchParams.get('limit'), 1000, 5000);
    const { results } = await env.DB.prepare(
      `SELECT asset_no, machine_type, mechanic, location, status, scan_timestamp, shift_date
       FROM scan_log ORDER BY scan_timestamp DESC LIMIT ?`
    ).bind(limit).all();
    return json(results);
  }

  // Scans grouped by asset in time order, for building movements (Line Change tab)
  if (mode === 'movements') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    let sql = `SELECT id, asset_no, machine_type, location, status, mechanic, scan_timestamp
               FROM scan_log WHERE 1=1`;
    const binds = [];
    if (from) { sql += ' AND scan_timestamp >= ?'; binds.push(from); }
    if (to)   { sql += ' AND scan_timestamp <= ?'; binds.push(endOfDay(to)); }
    sql += ' ORDER BY asset_no ASC, scan_timestamp ASC LIMIT 6000';
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results);
  }

  // Latest scan per asset, optionally only those currently at one location
  // ("Currently on line" snapshot). Done in SQL instead of shipping 2,000
  // rows to the browser to de-duplicate there.
  if (mode === 'latest') {
    const location = url.searchParams.get('location');
    let sql = `SELECT asset_no, machine_type, location, status, mechanic, scan_timestamp FROM (
                 SELECT *, ROW_NUMBER() OVER (PARTITION BY asset_no ORDER BY scan_timestamp DESC) AS rn
                 FROM scan_log
               ) WHERE rn = 1`;
    const binds = [];
    if (location) { sql += ' AND location = ?'; binds.push(location); }
    sql += ' ORDER BY asset_no';
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results);
  }

  return json({ error: 'Specify asset_no, asset_no+last=1, or mode=recent|movements|latest' }, 400);
}

async function postScanLog(request, env) {
  const b = await request.json();
  if (!b.asset_no || !b.location || !b.status) {
    return json({ error: 'asset_no, location and status required' }, 400);
  }
  const result = await env.DB.prepare(
    `INSERT INTO scan_log (asset_no, machine_type, mechanic, location, status, scan_timestamp, shift_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    b.asset_no, b.machine_type || null, b.mechanic || null, b.location, b.status,
    b.scan_timestamp || new Date().toISOString(), b.shift_date || null
  ).run();
  return json({ id: result.meta.last_row_id }, 201);
}

// ── downtime_log ─────────────────────────────────────────────────────────
async function getDowntimeLog(request, env) {
  const url = new URL(request.url);
  const assetNo = url.searchParams.get('asset_no');
  const mode = url.searchParams.get('mode');

  // Existing open ticket for an asset (duplicate check before logging)
  if (assetNo && url.searchParams.get('open')) {
    const row = await env.DB.prepare(
      `SELECT id, asset_no, line, fault, status, mechanic, reported_time
       FROM downtime_log
       WHERE asset_no = ? AND status IN ('Open','Investigating')
       ORDER BY reported_time DESC LIMIT 1`
    ).bind(assetNo).first();
    return json(row || null);
  }

  // Home screen "machines down" strip
  if (mode === 'open_count') {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM downtime_log WHERE status IN ('Open','Investigating')`
    ).first();
    return json({ count: row ? row.count : 0 });
  }

  // Mechanic job-card screen: everything still open + resolved since a time
  if (mode === 'mechanic') {
    const resolvedAfter = url.searchParams.get('resolvedAfter') || '1970-01-01';
    const { results } = await env.DB.prepare(
      `SELECT * FROM downtime_log
       WHERE status IN ('Open','Investigating')
          OR (status = 'Resolved' AND resolved_time >= ?)
       ORDER BY reported_time DESC`
    ).bind(resolvedAfter).all();
    return json(results);
  }

  // Reporting query — Downtime tab, Asset Profile, Mechanics tab
  if (mode === 'dashboard') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const line = url.searchParams.get('line');
    const order = url.searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
    const limit = clampLimit(url.searchParams.get('limit'), 6000, 20000);

    let sql = 'SELECT * FROM downtime_log WHERE 1=1';
    const binds = [];
    if (from)    { sql += ' AND reported_time >= ?'; binds.push(from); }
    if (to)      { sql += ' AND reported_time <= ?'; binds.push(endOfDay(to)); }
    if (line)    { sql += ' AND line = ?';           binds.push(line); }
    if (assetNo) { sql += ' AND asset_no = ?';       binds.push(assetNo); }
    sql += ` ORDER BY reported_time ${order} LIMIT ?`;
    binds.push(limit);

    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results);
  }

  return json({ error: 'Specify asset_no+open=1, or mode=open_count|mechanic|dashboard' }, 400);
}

async function postDowntimeLog(request, env) {
  const b = await request.json();
  if (!b.asset_no || !b.line || !b.fault) {
    return json({ error: 'asset_no, line and fault required' }, 400);
  }
  try {
    const result = await env.DB.prepare(
      `INSERT INTO downtime_log (asset_no, machine_type, line, fault, reported_by, reported_time, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Open')`
    ).bind(
      b.asset_no, b.machine_type || null, b.line, b.fault, b.reported_by || null,
      b.reported_time || new Date().toISOString()
    ).run();
    return json({ id: result.meta.last_row_id }, 201);
  } catch (e) {
    if (isUnique(e)) return json({ error: 'Asset already has an open ticket' }, 409);
    throw e;
  }
}

const DOWNTIME_LOG_FIELDS = [
  'machine_type', 'status', 'investigate_time', 'response_minutes', 'mechanic',
  'error_code', 'corrective_measures', 'resolved_time', 'repair_minutes', 'total_downtime_minutes'
];

async function patchDowntimeLog(request, env, id) {
  const body = await request.json();
  const fields = Object.keys(body).filter(k => DOWNTIME_LOG_FIELDS.includes(k));
  if (fields.length === 0) return json({ error: 'No valid fields to update' }, 400);

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);
  const result = await env.DB.prepare(`UPDATE downtime_log SET ${setClause} WHERE id = ?`)
    .bind(...values, id).run();

  if (!result.meta.changes) return json({ error: 'Job card not found' }, 404);
  return json({ success: true });
}

// ── parts_requests ───────────────────────────────────────────────────────
async function getPartsRequests(request, env) {
  const url = new URL(request.url);
  const jobCardId = url.searchParams.get('job_card_id');
  const assetNo = url.searchParams.get('asset_no');
  const status = url.searchParams.get('status');

  if (jobCardId) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM parts_requests WHERE job_card_id = ? ORDER BY requested_time`
    ).bind(jobCardId).all();
    return json(results);
  }

  if (assetNo) {
    let sql = 'SELECT * FROM parts_requests WHERE asset_no = ?';
    const binds = [assetNo];
    if (status) { sql += ' AND status = ?'; binds.push(status); }
    sql += ' ORDER BY requested_time DESC';
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results);
  }

  if (status) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM parts_requests WHERE status = ? ORDER BY requested_time DESC`
    ).bind(status).all();
    return json(results);
  }

  // No filter — Inventory tab (pending queue, today's issues, charts, history)
  const { results } = await env.DB.prepare(
    `SELECT * FROM parts_requests ORDER BY requested_time DESC LIMIT 5000`
  ).all();
  return json(results);
}

async function postPartsRequests(request, env) {
  const body = await request.json();
  const rows = Array.isArray(body) ? body : [body];
  if (rows.length === 0) return json({ error: 'No parts in request' }, 400);

  const stmt = env.DB.prepare(
    `INSERT INTO parts_requests
      (job_card_id, asset_no, machine_type, line, mechanic, part_no, part_description,
       quantity, status, requested_time, request_reason, notes, request_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const batch = rows.map(r => stmt.bind(
    r.job_card_id ?? null, r.asset_no || null, r.machine_type || null, r.line || null,
    r.mechanic || null, r.part_no || '', r.part_description || '', parseInt(r.quantity, 10) || 1,
    r.requested_time || now, r.request_reason || null, r.notes || null, r.request_batch_id || null
  ));

  try {
    await env.DB.batch(batch); // all-or-nothing
  } catch (e) {
    // Same batch already saved on an earlier attempt (dropped connection)
    if (isUnique(e)) return json({ error: 'This request batch was already submitted' }, 409);
    throw e;
  }
  return json({ success: true, count: rows.length }, 201);
}

const PARTS_REQUEST_FIELDS = [
  'status', 'issued_time', 'issued_by', 'part_no', 'quantity_returned', 'quantity_consumed'
];

async function patchPartsRequests(request, env, id) {
  const body = await request.json();
  const fields = Object.keys(body).filter(k => PARTS_REQUEST_FIELDS.includes(k));
  if (fields.length === 0) return json({ error: 'No valid fields to update' }, 400);

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);
  await env.DB.prepare(`UPDATE parts_requests SET ${setClause} WHERE id = ?`)
    .bind(...values, id).run();
  return json({ success: true });
}

// ── parts_returns ────────────────────────────────────────────────────────
async function getPartsReturns(request, env) {
  const url = new URL(request.url);
  const query = url.searchParams.get('awaiting_supplier')
    ? env.DB.prepare(`SELECT * FROM parts_returns WHERE supplier_return_status = 'Awaiting supplier return' ORDER BY return_time DESC`)
    : env.DB.prepare(`SELECT * FROM parts_returns ORDER BY return_time DESC LIMIT 2000`);
  const { results } = await query.all();
  return json(results);
}

// One atomic call for a return (mechanic from the job card, or clerk from
// the dashboard): writes the return record, updates the request's returned
// / consumed quantities, and restores stock for good-condition returns —
// all in one D1 batch, so a dropped connection can't leave it half-done.
async function postPartsReturns(request, env) {
  const body = await request.json();
  const qtyReturned = parseInt(body.quantity_returned, 10);
  if (!body.request_id || !qtyReturned || qtyReturned < 1 || !body.reason) {
    return json({ error: 'request_id, quantity_returned and reason required' }, 400);
  }

  const req = await env.DB.prepare(`SELECT * FROM parts_requests WHERE id = ?`)
    .bind(body.request_id).first();
  if (!req) return json({ error: 'Request not found' }, 404);

  const isFaulty = body.reason === 'Faulty / defective';
  const qtyIssued = body.quantity_issued != null ? body.quantity_issued : req.quantity;
  const consumed = body.quantity_consumed != null
    ? body.quantity_consumed
    : Math.max(0, (req.quantity || 0) - qtyReturned);
  const partNo = body.part_no || req.part_no || '';
  const nowISO = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `INSERT INTO parts_returns
        (request_id, job_card_id, asset_no, machine_type, line, part_no, part_description,
         quantity_issued, quantity_returned, quantity_consumed, return_reason, stock_restored,
         returned_by, received_by, return_time, supplier_return_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      req.id, req.job_card_id, req.asset_no, req.machine_type, req.line, partNo,
      body.part_description || req.part_description || '', qtyIssued, qtyReturned, consumed,
      body.reason, isFaulty ? 0 : 1, body.returned_by || req.mechanic || '',
      body.received_by || null, nowISO, isFaulty ? 'Awaiting supplier return' : null
    ),
    env.DB.prepare(
      `UPDATE parts_requests SET quantity_returned = ?, quantity_consumed = ? WHERE id = ?`
    ).bind(qtyReturned, consumed, req.id)
  ];

  if (!isFaulty && partNo) {
    statements.push(
      env.DB.prepare(
        `UPDATE parts_inventory SET stock_qty = stock_qty + ?, updated_at = ? WHERE part_no = ?`
      ).bind(qtyReturned, nowISO, partNo)
    );
  }

  await env.DB.batch(statements);
  return json({ success: true, stockRestored: !isFaulty && !!partNo });
}

async function patchPartsReturns(request, env, id) {
  const body = await request.json();
  if (!body.supplier_return_status) return json({ error: 'supplier_return_status required' }, 400);
  await env.DB.prepare(
    `UPDATE parts_returns SET supplier_return_status = ? WHERE id = ?`
  ).bind(body.supplier_return_status, id).run();
  return json({ success: true });
}

// ── parts_inventory ──────────────────────────────────────────────────────
const INVENTORY_FIELDS = [
  'part_no', 'description', 'stock_qty', 'min_qty', 'machine_type', 'supplier', 'draw_number', 'unit_price'
];

async function getPartsInventory(request, env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM parts_inventory ORDER BY description LIMIT 5000'
  ).all();
  return json(results);
}

// Upsert on part_no — one part (catalogue form) or an array (CSV import).
// Only the columns actually sent are written, so a CSV that leaves
// optional columns blank never wipes existing supplier / price data.
async function postPartsInventory(request, env) {
  const body = await request.json();
  const rows = Array.isArray(body) ? body : [body];
  const now = new Date().toISOString();

  const statements = [];
  for (const r of rows) {
    if (!r.part_no) return json({ error: 'part_no required on every row' }, 400);
    const cols = INVENTORY_FIELDS.filter(f => r[f] !== undefined);
    const updates = cols.filter(c => c !== 'part_no').map(c => `${c} = excluded.${c}`);
    updates.push('updated_at = excluded.updated_at');
    statements.push(
      env.DB.prepare(
        `INSERT INTO parts_inventory (${cols.join(', ')}, updated_at)
         VALUES (${cols.map(() => '?').join(', ')}, ?)
         ON CONFLICT(part_no) DO UPDATE SET ${updates.join(', ')}`
      ).bind(...cols.map(c => r[c]), now)
    );
  }

  await env.DB.batch(statements);
  return json({ success: true, count: rows.length }, 201);
}

// Stock change by part_no: either an absolute count (Adjust Stock screen)
// or a relative change (issuing / returning), never going below zero.
async function patchPartsInventory(request, env) {
  const body = await request.json();
  if (!body.part_no) return json({ error: 'part_no required' }, 400);
  const now = new Date().toISOString();

  if (body.stock_delta != null) {
    await env.DB.prepare(
      `UPDATE parts_inventory SET stock_qty = MAX(0, stock_qty + ?), updated_at = ? WHERE part_no = ?`
    ).bind(parseInt(body.stock_delta, 10) || 0, now, body.part_no).run();
    return json({ success: true });
  }

  if (body.stock_qty == null) return json({ error: 'stock_qty or stock_delta required' }, 400);
  await env.DB.prepare(
    `UPDATE parts_inventory SET stock_qty = ?, updated_at = ? WHERE part_no = ?`
  ).bind(Math.max(0, parseInt(body.stock_qty, 10) || 0), now, body.part_no).run();
  return json({ success: true });
}

async function deletePartsInventory(request, env) {
  const partNo = new URL(request.url).searchParams.get('part_no');
  if (!partNo) return json({ error: 'part_no required' }, 400);
  await env.DB.prepare(`DELETE FROM parts_inventory WHERE part_no = ?`).bind(partNo).run();
  return json({ success: true });
}

// ── pm_log (read by the dashboard; no PM app on the sewing floor yet) ────
async function getPmLog(request, env) {
  const url = new URL(request.url);
  const assetNo = url.searchParams.get('asset_no');

  if (assetNo) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM pm_log WHERE asset_no = ? ORDER BY completed_date DESC`
    ).bind(assetNo).all();
    return json(results);
  }

  const limit = clampLimit(url.searchParams.get('limit'), 500, 20000);
  const { results } = await env.DB.prepare(
    `SELECT * FROM pm_log ORDER BY completed_date DESC LIMIT ?`
  ).bind(limit).all();
  return json(results);
}

// ── preventative maintenance ─────────────────────────────────────────────
const addDays = (dateStr, days) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
};
// Today's date in South Africa (UTC+2), for when the page doesn't send one
const saToday = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

async function getPmChecklist(request, env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM pm_checklist_items WHERE active = 1 ORDER BY item_order'
  ).all();
  return json(results);
}

async function getPmSchedules(request, env) {
  const assetNo = new URL(request.url).searchParams.get('asset_no');
  if (assetNo) {
    const { results } = await env.DB.prepare(
      'SELECT * FROM pm_schedules WHERE asset_no = ? AND active = 1 ORDER BY next_due_date'
    ).bind(assetNo).all();
    return json(results);
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM pm_schedules WHERE active = 1 ORDER BY next_due_date LIMIT 300'
  ).all();
  return json(results);
}

// Create one or many schedules. A machine that already has an ACTIVE
// schedule of the same tier is skipped by the unique index (INSERT OR
// IGNORE), so double-taps and overlapping supervisors can't make duplicates.
async function postPmSchedules(request, env) {
  const body = await request.json();
  const rows = Array.isArray(body) ? body : [body];
  if (rows.length === 0) return json({ error: 'No schedules to create' }, 400);

  const tiers = ['minor', 'normal', 'major'];
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO pm_schedules
       (asset_no, asset_type, service_type, frequency_days, next_due_date,
        assigned_to, scope_origin, created_by, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     RETURNING *`
  );
  const batch = [];
  for (const r of rows) {
    const freq = parseInt(r.frequency_days, 10);
    if (!r.asset_no || !tiers.includes(r.service_type) || !freq || freq < 1) {
      return json({ error: 'Each schedule needs asset_no, service_type (minor/normal/major) and frequency_days ≥ 1' }, 400);
    }
    batch.push(stmt.bind(
      r.asset_no, r.asset_type || null, r.service_type, freq,
      isDate(r.next_due_date) ? r.next_due_date : saToday(),
      r.assigned_to || null, r.scope_origin || null, r.created_by || null, now, now
    ));
  }

  const results = await env.DB.batch(batch);
  const created = results.flatMap(r => r.results || []);
  return json({ created, skipped: rows.length - created.length }, 201);
}

// Only switching a schedule off is allowed from the page
async function patchPmSchedules(request, env, id) {
  const body = await request.json();
  if (body.active === undefined) return json({ error: 'active required' }, 400);
  const result = await env.DB.prepare(
    'UPDATE pm_schedules SET active = ?, updated_at = ? WHERE id = ?'
  ).bind(body.active ? 1 : 0, new Date().toISOString(), id).run();
  if (!result.meta.changes) return json({ error: 'Schedule not found' }, 404);
  return json({ success: true });
}

// Complete a PM in ONE atomic D1 batch: the log header, every checklist
// result, and the schedule's last/next dates either all save or none do.
// The next due date is worked out here from the schedule's own frequency.
async function postPmComplete(request, env) {
  const b = await request.json();
  const outcomes = ['ok', 'attention', 'na'];
  if (!b.schedule_id || !b.asset_no || !b.completed_by || !b.machine_condition) {
    return json({ error: 'schedule_id, asset_no, completed_by and machine_condition required' }, 400);
  }
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.some(i => !outcomes.includes(i.outcome))) {
    return json({ error: 'Every checklist item needs an outcome (ok / attention / na)' }, 400);
  }

  const sched = await env.DB.prepare(
    'SELECT id, service_type, frequency_days FROM pm_schedules WHERE id = ?'
  ).bind(b.schedule_id).first();
  if (!sched) return json({ error: 'Schedule not found' }, 404);

  const done = isDate(b.completed_date) ? b.completed_date : saToday();
  const nextDue = addDays(done, sched.frequency_days);
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `INSERT INTO pm_log
         (schedule_id, asset_no, machine_type, location, service_type, completed_by,
          completed_date, machine_condition, next_due_date, overall_note, was_scheduled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sched.id, b.asset_no, b.asset_type || null, b.line || null, sched.service_type,
      b.completed_by, done, b.machine_condition, nextDue, b.overall_note || null,
      b.was_scheduled === false ? 0 : 1
    )
  ];
  // Items attach to the log row just inserted. The batch runs as a single
  // transaction, so MAX(id) here is guaranteed to be that row.
  const itemStmt = env.DB.prepare(
    `INSERT INTO pm_log_items (pm_log_id, item_order, item_text, system_area, outcome, item_note)
     VALUES ((SELECT MAX(id) FROM pm_log), ?, ?, ?, ?, ?)`
  );
  for (const i of b.items) {
    statements.push(itemStmt.bind(
      i.item_order ?? null, i.item_text || '', i.system_area || null, i.outcome, i.item_note || null
    ));
  }
  statements.push(
    env.DB.prepare(
      'UPDATE pm_schedules SET last_done_date = ?, next_due_date = ?, updated_at = ? WHERE id = ?'
    ).bind(done, nextDue, now, sched.id)
  );

  const results = await env.DB.batch(statements);
  return json({ log_id: results[0].meta.last_row_id, next_due_date: nextDue }, 201);
}

// ── database size (dashboard storage bar) ────────────────────────────────
async function getDbSize(request, env) {
  const result = await env.DB.prepare('SELECT 1').run();
  const bytes = result.meta && result.meta.size_after != null ? result.meta.size_after : null;
  return json({ bytes });
}

// ── notify (OneSignal proxy) ─────────────────────────────────────────────
async function postNotify(request, env) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    return json({
      error: 'Missing OneSignal config in Worker environment',
      hasAppId: !!env.ONESIGNAL_APP_ID,
      hasRestApiKey: !!env.ONESIGNAL_REST_API_KEY
    }, 500);
  }

  const { title, message, url } = await request.json();

  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // New-format REST API keys (os_v2_app_...) use the "Key" scheme.
      'Authorization': `Key ${env.ONESIGNAL_REST_API_KEY}`
    },
    body: JSON.stringify({
      app_id: env.ONESIGNAL_APP_ID,
      // Every subscribed device directly (segment targeting proved unreliable
      // on Bullmer for a small, fixed mechanic team).
      filters: [{ field: 'session_count', relation: '>', value: '0' }],
      headings: { en: title },
      contents: { en: message },
      url
    })
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── ROUTER ────────────────────────────────────────────────────────────────
async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  let m;

  if (pathname === '/api/master-data') {
    if (method === 'GET')  return getMasterData(request, env);
    if (method === 'POST') return postMasterData(request, env);
  }

  if (pathname === '/api/scan-log') {
    if (method === 'GET')  return getScanLog(request, env);
    if (method === 'POST') return postScanLog(request, env);
  }

  if (pathname === '/api/downtime-log') {
    if (method === 'GET')  return getDowntimeLog(request, env);
    if (method === 'POST') return postDowntimeLog(request, env);
  }
  if ((m = pathname.match(/^\/api\/downtime-log\/(\d+)$/)) && method === 'PATCH') {
    return patchDowntimeLog(request, env, m[1]);
  }

  if (pathname === '/api/parts-requests') {
    if (method === 'GET')  return getPartsRequests(request, env);
    if (method === 'POST') return postPartsRequests(request, env);
  }
  if ((m = pathname.match(/^\/api\/parts-requests\/(\d+)$/)) && method === 'PATCH') {
    return patchPartsRequests(request, env, m[1]);
  }

  if (pathname === '/api/parts-returns') {
    if (method === 'GET')  return getPartsReturns(request, env);
    if (method === 'POST') return postPartsReturns(request, env);
  }
  if ((m = pathname.match(/^\/api\/parts-returns\/(\d+)$/)) && method === 'PATCH') {
    return patchPartsReturns(request, env, m[1]);
  }

  if (pathname === '/api/parts-inventory') {
    if (method === 'GET')    return getPartsInventory(request, env);
    if (method === 'POST')   return postPartsInventory(request, env);
    if (method === 'PATCH')  return patchPartsInventory(request, env);
    if (method === 'DELETE') return deletePartsInventory(request, env);
  }

  if (pathname === '/api/pm-log' && method === 'GET') return getPmLog(request, env);
  if (pathname === '/api/pm-checklist' && method === 'GET') return getPmChecklist(request, env);
  if (pathname === '/api/pm-schedules') {
    if (method === 'GET')  return getPmSchedules(request, env);
    if (method === 'POST') return postPmSchedules(request, env);
  }
  if ((m = pathname.match(/^\/api\/pm-schedules\/(\d+)$/)) && method === 'PATCH') {
    return patchPmSchedules(request, env, m[1]);
  }
  if (pathname === '/api/pm-complete' && method === 'POST') return postPmComplete(request, env);
  if (pathname === '/api/db-size' && method === 'GET') return getDbSize(request, env);
  if (pathname === '/api/notify' && method === 'POST') return postNotify(request, env);

  return json({ error: 'Not found: ' + method + ' ' + pathname }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/')) {
      try {
        return await route(request, env);
      } catch (e) {
        // Surface the real D1 error (e.g. "no such table") instead of a blank 500
        return json({ error: String((e && e.message) || e) }, 500);
      }
    }

    // Not an API route — serve the static site
    return env.ASSETS.fetch(request);
  }
};
