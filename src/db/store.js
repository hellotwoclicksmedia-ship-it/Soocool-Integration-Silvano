'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'orders.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS order_mappings (
    shopify_order_id     TEXT PRIMARY KEY,
    shopify_order_number TEXT NOT NULL,
    soocool_order_id     INTEGER,
    flow                 TEXT NOT NULL CHECK(flow IN ('pizza', 'meal')),
    pdf_path             TEXT,
    tracking_url         TEXT,
    delivery_date        TEXT,
    pdf_data             BLOB,
    label_data           BLOB,
    created_at           DATETIME DEFAULT (datetime('now'))
  );
`);

// Migration: add tracking_url column if it doesn't exist yet (for old DBs)
try {
  db.exec(`ALTER TABLE order_mappings ADD COLUMN tracking_url TEXT`);
} catch (_) {
  // Column already exists — ignore
}

// Migration: add delivery_date column if it doesn't exist yet
try {
  db.exec(`ALTER TABLE order_mappings ADD COLUMN delivery_date TEXT`);
} catch (_) {
  // Column already exists — ignore
}

// Migration: add pdf_data BLOB column
try {
  db.exec(`ALTER TABLE order_mappings ADD COLUMN pdf_data BLOB`);
} catch (_) { }

// Migration: add label_data BLOB column
try {
  db.exec(`ALTER TABLE order_mappings ADD COLUMN label_data BLOB`);
} catch (_) { }

const stmtInsert = db.prepare(`
  INSERT OR REPLACE INTO order_mappings
    (shopify_order_id, shopify_order_number, soocool_order_id, flow, pdf_path, delivery_date)
  VALUES
    (@shopify_order_id, @shopify_order_number, @soocool_order_id, @flow, @pdf_path, @delivery_date)
`);

const stmtUpdateDeliveryDate = db.prepare(`
  UPDATE order_mappings SET delivery_date = ? WHERE shopify_order_id = ?
`);

const stmtGetBySoocoolId = db.prepare(`
  SELECT * FROM order_mappings WHERE soocool_order_id = ?
`);

const stmtGetByShopifyId = db.prepare(`
  SELECT * FROM order_mappings WHERE shopify_order_id = ?
`);

const stmtGetByOrderNumber = db.prepare(`
  SELECT * FROM order_mappings WHERE shopify_order_number = ?
`);

const stmtUpdatePdf = db.prepare(`
  UPDATE order_mappings SET pdf_path = ? WHERE shopify_order_id = ?
`);

const stmtSavePdfData = db.prepare(`
  UPDATE order_mappings SET pdf_data = ?, label_data = ? WHERE shopify_order_id = ?
`);

const stmtGetPdfData = db.prepare(`
  SELECT pdf_data, label_data, shopify_order_number FROM order_mappings WHERE shopify_order_number = ?
`);

const stmtUpdateTracking = db.prepare(`
  UPDATE order_mappings SET tracking_url = ? WHERE shopify_order_id = ?
`);

const stmtGetRecent = db.prepare(`
  SELECT shopify_order_id, shopify_order_number, soocool_order_id, flow,
         pdf_path, tracking_url, delivery_date, created_at,
         CASE WHEN pdf_data IS NOT NULL THEN 1 ELSE 0 END AS has_pdf_data
  FROM order_mappings ORDER BY created_at DESC LIMIT ?
`);

function saveMapping({ shopifyOrderId, shopifyOrderNumber, soocoolOrderId, flow, pdfPath = null, deliveryDate = null }) {
  stmtInsert.run({
    shopify_order_id: String(shopifyOrderId),
    shopify_order_number: String(shopifyOrderNumber),
    soocool_order_id: soocoolOrderId,
    flow,
    pdf_path: pdfPath,
    delivery_date: deliveryDate,
  });
}

function updateDeliveryDate(shopifyOrderId, deliveryDate) {
  stmtUpdateDeliveryDate.run(deliveryDate, String(shopifyOrderId));
}

function getMappingBySoocoolId(soocoolOrderId) {
  return stmtGetBySoocoolId.get(soocoolOrderId) || null;
}

function getMappingByOrderNumber(orderNumber) {
  return stmtGetByOrderNumber.get(String(orderNumber)) || null;
}

function getMappingByShopifyId(shopifyOrderId) {
  return stmtGetByShopifyId.get(String(shopifyOrderId)) || null;
}

function updatePdfPath(shopifyOrderId, pdfPath) {
  stmtUpdatePdf.run(pdfPath, String(shopifyOrderId));
}

function savePdfData(shopifyOrderId, pdfBuffer, labelBuffer) {
  stmtSavePdfData.run(pdfBuffer || null, labelBuffer || null, String(shopifyOrderId));
}

function getPdfData(orderNumber) {
  return stmtGetPdfData.get(String(orderNumber)) || null;
}

function updateTrackingUrl(shopifyOrderId, trackingUrl) {
  stmtUpdateTracking.run(trackingUrl, String(shopifyOrderId));
}

function getRecentMappings(limit = 50) {
  return stmtGetRecent.all(limit);
}

module.exports = {
  saveMapping,
  getMappingBySoocoolId,
  getMappingByShopifyId,
  getMappingByOrderNumber,
  updatePdfPath,
  savePdfData,
  getPdfData,
  updateTrackingUrl,
  updateDeliveryDate,
  getRecentMappings,
};
