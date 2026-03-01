'use strict';
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LABELS_DIR = path.join(process.cwd(), 'tmp', 'labels');

/**
 * Generates a PDF containing the SooCool shipping label + product list.
 * Saves to tmp/labels/{orderNumber}.pdf and returns the file path.
 *
 * @param {object} opts
 * @param {object} opts.order         - Shopify order object
 * @param {object} opts.deliveryWindow - { startTime, endTime }
 * @param {Buffer|null} opts.labelBuffer - PDF buffer from SooCool (may be null)
 * @returns {Promise<string>} path to generated PDF
 */
async function generateOrderPdf({ order, deliveryWindow, labelBuffer }) {
    // Ensure output directory exists
    if (!fs.existsSync(LABELS_DIR)) {
        fs.mkdirSync(LABELS_DIR, { recursive: true });
    }

    const outputPath = path.join(LABELS_DIR, `order-${order.order_number}.pdf`);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        const stream = fs.createWriteStream(outputPath);

        doc.pipe(stream);

        // ── Header ────────────────────────────────────────────────────────────────
        doc
            .fontSize(20)
            .font('Helvetica-Bold')
            .text('Silvano — Shipping Document', { align: 'center' });

        doc.moveDown(0.5);
        doc
            .fontSize(12)
            .font('Helvetica')
            .text(`Order #${order.order_number}`, { align: 'center' })
            .text(`Generated: ${new Date().toISOString()}`, { align: 'center' });

        doc.moveDown(1);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.5);

        // ── Customer & Delivery Info ───────────────────────────────────────────────
        doc.fontSize(13).font('Helvetica-Bold').text('Delivery Details');
        doc.moveDown(0.3);
        doc.fontSize(11).font('Helvetica');

        const sa = order.shipping_address || {};
        doc.text(`Name:      ${sa.first_name || ''} ${sa.last_name || ''}`.trim());
        doc.text(`Address:   ${sa.address1}${sa.address2 ? ', ' + sa.address2 : ''}`);
        doc.text(`City:      ${sa.city}, ${sa.zip}`);
        doc.text(`Country:   ${sa.country_code}`);
        doc.text(`Phone:     ${sa.phone || '—'}`);
        doc.text(`Email:     ${order.email || '—'}`);
        doc.moveDown(0.5);
        doc.text(`Delivery window:`);
        doc.text(`  From: ${formatDateTime(deliveryWindow.startTime)}`);
        doc.text(`  To:   ${formatDateTime(deliveryWindow.endTime)}`);

        doc.moveDown(1);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.5);

        // ── Product List ──────────────────────────────────────────────────────────
        doc.fontSize(13).font('Helvetica-Bold').text('Products in Order');
        doc.moveDown(0.3);

        const colX = { name: 45, sku: 290, qty: 430, price: 490 };

        if (boxGroups && boxGroups.length > 0) {
            // Render items grouped by box
            for (const group of boxGroups) {
                // Determine how many boxes this group spans
                for (let boxIndex = 1; boxIndex <= group.boxCount; boxIndex++) {
                    doc.moveDown(0.5);
                    doc.fontSize(11).font('Helvetica-Bold')
                        .text(`Box: ${group.bundleName}` + (group.boxCount > 1 ? ` (Box ${boxIndex} of ${group.boxCount})` : ''));
                    doc.moveDown(0.2);

                    // Table header
                    doc.fontSize(10).font('Helvetica-Bold');
                    doc.text('Product', colX.name, doc.y, { continued: false, width: 240 });
                    const headerY = doc.y - doc.currentLineHeight();
                    doc.text('SKU', colX.sku, headerY, { width: 130 });
                    doc.text('Qty', colX.qty, headerY, { width: 55 });
                    doc.text('Price', colX.price, headerY, { width: 60 });
                    doc.moveDown(0.2);
                    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#cccccc');
                    doc.moveDown(0.2);

                    // Render items for this box (distribute items evenly if multiple boxes)
                    // We split the items array into roughly equal chunks per box
                    doc.font('Helvetica').fontSize(10);
                    const itemsInThisBox = distributeItemsForBox(group.items, group.boxCount, boxIndex);

                    for (const item of itemsInThisBox) {
                        const rowY = doc.y;
                        doc.text(item.title || item.name, colX.name, rowY, { width: 240 });
                        const lineH = doc.y - rowY;
                        doc.text(item.sku || '—', colX.sku, rowY, { width: 130 });
                        doc.text(String(item.quantity), colX.qty, rowY, { width: 55 });
                        doc.text(
                            item.price ? `€${parseFloat(item.price).toFixed(2)}` : '—',
                            colX.price,
                            rowY,
                            { width: 60 }
                        );
                        doc.y = Math.max(doc.y, rowY + lineH) + 2;
                    }
                    doc.moveDown(0.3);
                }
            }
        } else {
            // Fallback to flat list if no groupings provided
            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('Product', colX.name, doc.y, { continued: false, width: 240 });
            const headerY = doc.y - doc.currentLineHeight();
            doc.text('SKU', colX.sku, headerY, { width: 130 });
            doc.text('Qty', colX.qty, headerY, { width: 55 });
            doc.text('Price', colX.price, headerY, { width: 60 });
            doc.moveDown(0.2);
            doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#cccccc');
            doc.moveDown(0.2);

            doc.font('Helvetica').fontSize(10);
            for (const item of (order.line_items || [])) {
                const rowY = doc.y;
                doc.text(item.title || item.name, colX.name, rowY, { width: 240 });
                const lineH = doc.y - rowY;
                doc.text(item.sku || '—', colX.sku, rowY, { width: 130 });
                doc.text(String(item.quantity), colX.qty, rowY, { width: 55 });
                doc.text(
                    item.price ? `€${parseFloat(item.price).toFixed(2)}` : '—',
                    colX.price,
                    rowY,
                    { width: 60 }
                );
                doc.y = Math.max(doc.y, rowY + lineH) + 2;
            }
        }

        doc.moveDown(1);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.5);

        // ── SooCool Shipping Label ─────────────────────────────────────────────────
        if (labelBuffer && labelBuffer.length > 0) {
            doc.addPage();
            doc.fontSize(13).font('Helvetica-Bold').text('SooCool Shipping Label');
            doc.moveDown(0.5);
            try {
                // Embed the SooCool label image/PDF content as an image if it's an image buffer
                // For PDF buffers we note it for the operator
                doc
                    .fontSize(10)
                    .font('Helvetica')
                    .text('[SooCool label PDF attached. Print separately or combine with a PDF merger.]');
                doc.moveDown(0.5);
                doc.text(`Label size: ${(labelBuffer.length / 1024).toFixed(1)} KB`);
            } catch (e) {
                doc.fontSize(10).font('Helvetica').text('(Label could not be embedded)');
            }

            // Save label separately for easy printing
            const labelPath = path.join(LABELS_DIR, `label-${order.order_number}.pdf`);
            fs.writeFileSync(labelPath, labelBuffer);
            doc.moveDown(0.5);
            doc.text(`Label also saved to: ${labelPath}`);
        } else {
            doc
                .fontSize(10)
                .font('Helvetica')
                .text('(No SooCool shipping label available for this order)');
        }

        doc.end();

        stream.on('finish', () => {
            console.log(`[pdfGenerator] PDF saved to ${outputPath}`);
            resolve(outputPath);
        });
        stream.on('error', reject);
    });
}

function formatDateTime(isoString) {
    if (!isoString) return '—';
    return isoString.replace('T', ' ').slice(0, 16);
}

/**
 * Distributes a list of items across a given number of boxes.
 * Returns the subset of items that belong in the specified boxIndex (1-indexed).
 */
function distributeItemsForBox(items, totalBoxes, boxIndex) {
    if (totalBoxes <= 1) return items;

    // Expand items with quantity > 1 into individual pieces
    const expandedItems = [];
    for (const item of items) {
        for (let i = 0; i < item.quantity; i++) {
            expandedItems.push({ ...item, quantity: 1 });
        }
    }

    // Calculate items per box (ceil to ensure all items fit)
    const itemsPerBox = Math.ceil(expandedItems.length / totalBoxes);

    // Get items for this specific box
    const startIndex = (boxIndex - 1) * itemsPerBox;
    const endIndex = Math.min(startIndex + itemsPerBox, expandedItems.length);
    const boxPieces = expandedItems.slice(startIndex, endIndex);

    // Re-collapse identical items in this box
    const collapsed = [];
    for (const piece of boxPieces) {
        const existing = collapsed.find(c => c.id === piece.id);
        if (existing) {
            existing.quantity++;
        } else {
            collapsed.push({ ...piece });
        }
    }

    return collapsed;
}

module.exports = { generateOrderPdf };
