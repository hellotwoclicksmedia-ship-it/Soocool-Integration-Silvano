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
async function generateOrderPdf({ order, deliveryWindow, labelBuffer, boxGroups }) {
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

        const colX = { name: 45, sku: 290, qty: 450 };

        if (boxGroups && boxGroups.length > 0) {
            // Render items grouped by box
            for (const group of boxGroups) {
                // Determine how many boxes this group spans
                for (let boxIndex = 1; boxIndex <= group.boxCount; boxIndex++) {
                    doc.moveDown(0.5);
                    doc.fontSize(11).font('Helvetica-Bold');
                    doc.text(`Box: ${group.bundleName}` + (group.boxCount > 1 ? ` (Box ${boxIndex} of ${group.boxCount})` : ''), 40, doc.y);
                    doc.moveDown(0.2);

                    // Table header
                    doc.fontSize(10).font('Helvetica-Bold');
                    doc.text('Product', colX.name, doc.y, { continued: false, width: 240 });
                    const headerY = doc.y - doc.currentLineHeight();
                    doc.text('SKU', colX.sku, headerY, { width: 140 });
                    doc.text('Qty', colX.qty, headerY, { width: 55 });
                    doc.moveDown(0.2);
                    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#cccccc');
                    doc.moveDown(0.2);

                    // Render items for this box (distribute items evenly if multiple boxes)
                    doc.font('Helvetica').fontSize(10);
                    const itemsInThisBox = distributeItemsForBox(group.items, group.boxCount, boxIndex);

                    for (const item of itemsInThisBox) {
                        const rowY = doc.y;
                        doc.text(item.title || item.name, colX.name, rowY, { width: 240 });
                        const lineH = doc.y - rowY;
                        doc.text(item.sku || '—', colX.sku, rowY, { width: 140 });
                        doc.text(String(item.quantity), colX.qty, rowY, { width: 55 });
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
            doc.text('SKU', colX.sku, headerY, { width: 140 });
            doc.text('Qty', colX.qty, headerY, { width: 55 });
            doc.moveDown(0.2);
            doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#cccccc');
            doc.moveDown(0.2);

            doc.font('Helvetica').fontSize(10);
            for (const item of (order.line_items || [])) {
                const rowY = doc.y;
                doc.text(item.title || item.name, colX.name, rowY, { width: 240 });
                const lineH = doc.y - rowY;
                doc.text(item.sku || '—', colX.sku, rowY, { width: 140 });
                doc.text(String(item.quantity), colX.qty, rowY, { width: 55 });
                doc.y = Math.max(doc.y, rowY + lineH) + 2;
            }
        }

        doc.moveDown(1);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.5);

        doc.end();

        stream.on('finish', async () => {
            console.log(`[pdfGenerator] Initial PDF kit document saved to ${outputPath}`);

            // ── SooCool Shipping Label PDF Merging ─────────────────────────────────────
            try {
                if (labelBuffer && labelBuffer.length > 0) {
                    const { PDFDocument: PDFLibDoc } = require('pdf-lib');

                    // Load the packing slip PDF generated by pdfkit
                    const mainPdfBytes = fs.readFileSync(outputPath);
                    const mainPdf = await PDFLibDoc.load(mainPdfBytes);

                    // Load the SooCool label PDF
                    const labelPdf = await PDFLibDoc.load(labelBuffer);

                    // Copy all pages from label PDF to main PDF
                    const copiedPages = await mainPdf.copyPages(labelPdf, labelPdf.getPageIndices());
                    for (const page of copiedPages) {
                        mainPdf.addPage(page);
                    }

                    // Save the merged PDF back to the original output path
                    const mergedPdfBytes = await mainPdf.save();
                    fs.writeFileSync(outputPath, mergedPdfBytes);
                    console.log(`[pdfGenerator] Successfully merged SooCool label into ${outputPath}`);

                    // Also save the label separately (for the separate download button on dashboard)
                    const labelPath = path.join(LABELS_DIR, `label-${order.order_number}.pdf`);
                    fs.writeFileSync(labelPath, labelBuffer);
                }

                resolve(outputPath);
            } catch (err) {
                console.error(`[pdfGenerator] Error merging PDF:`, err);
                // Resolve with the unmerged PDF anyway to avoid failing the whole flow
                resolve(outputPath);
            }
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
