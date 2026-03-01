'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'orders.db'));

// Create table on startup
db.exec(`
  CREATE TABLE IF NOT EXISTS order_mappings (
    shopify_order_id     TEXT PRIMARY KEY,
    shopify_order_number TEXT NOT NULL,
    soocool_order_id     INTEGER,
    flow                 TEXT NOT NULL CHECK(flow IN ('pizza', 'meal')),
    pdf_path             TEXT,
    tracking_url         TEXT,
    created_at           DATETIME DEFAULT (datetime('now'))
  );
`);

const stmtInsert = db.prepare(`
  INSERT OR REPLACE INTO order_mappings
    (shopify_order_id, shopify_order_number, soocool_order_id, flow, pdf_path)
  VALUES
    (@shopify_order_id, @shopify_order_number, @soocool_order_id, @flow, @pdf_path)
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

const stmtUpdateTracking = db.prepare(`
  UPDATE order_mappings SET tracking_url = ? WHERE shopify_order_id = ?
`);

const stmtGetRecent = db.prepare(`
  SELECT * FROM order_mappings ORDER BY created_at DESC LIMIT ?
`);

function saveMapping({ shopifyOrderId, shopifyOrderNumber, soocoolOrderId, flow, pdfPath = null }) {
  stmtInsert.run({
    shopify_order_id: String(shopifyOrderId),
    shopify_order_number: String(shopifyOrderNumber),
    soocool_order_id: soocoolOrderId,
    flow,
    pdf_path: pdfPath,
  });
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
  updateTrackingUrl,
  getRecentMappings,
};
