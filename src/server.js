'use strict';
const express = require('express');
const axios = require('axios');
const config = require('./config');
const shopifyWebhook = require('./webhooks/shopifyWebhook');
const shopifyCancelWebhook = require('./webhooks/shopifyCancelWebhook');
const shopifyUpdateWebhook = require('./webhooks/shopifyUpdateWebhook');
const soocoolWebhook = require('./webhooks/soocoolWebhook');
const { detectFlow } = require('./utils/flowDetector');
const { runPizzaFlow } = require('./flows/pizzaFlow');
const { runMealFlow } = require('./flows/mealFlow');

const app = express();

// Raw body needed for Shopify HMAC verification
app.use('/webhooks/shopify', express.raw({ type: 'application/json' }));
// Normal JSON for SooCool callbacks
app.use('/webhooks/soocool', express.json());

app.use('/webhooks/shopify', shopifyWebhook);
app.use('/webhooks/shopify', shopifyCancelWebhook);
app.use('/webhooks/shopify', shopifyUpdateWebhook);
app.use('/webhooks/soocool', soocoolWebhook);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// TEMPORARY — remove after debugging
app.get('/debug/env', (_req, res) => {
    const token = config.shopify.accessToken || '';
    const soocoolKey = config.soocool.apiKey || '';
    res.json({
        tokenPrefix: token.substring(0, 8),
        tokenSuffix: token.substring(token.length - 4),
        tokenLength: token.length,
        storeUrl: config.shopify.storeUrl,
        soocoolKeyPrefix: soocoolKey.substring(0, 8),
        soocoolKeySuffix: soocoolKey.substring(soocoolKey.length - 4),
        soocoolKeyLength: soocoolKey.length,
        soocoolBaseUrl: config.soocool.baseUrl,
    });
});

/**
 * TEST ENDPOINT — Fetch a Shopify order by ID and run it through the flow.
 * Usage: GET /test/order/12087813833048
 * Optional: ?flow=meal or ?flow=pizza to override auto-detection
 */
app.get('/test/order/:orderId', async (req, res) => {
    const { orderId } = req.params;
    const flowOverride = req.query.flow || null;
    const tag = `[testEndpoint][order:${orderId}]`;

    try {
        console.log(`${tag} Fetching order from Shopify...`);
        const shopifyClient = axios.create({
            baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
            headers: { 'X-Shopify-Access-Token': config.shopify.accessToken },
        });

        const orderRes = await shopifyClient.get(`/orders/${orderId}.json`);
        const order = orderRes.data.order;
        console.log(`${tag} Order #${order.order_number} found`);

        // Detect flow
        let flow = flowOverride;
        if (!flow) {
            flow = await detectFlow(order.line_items);
        }
        if (flow === 'unknown') {
            return res.status(400).json({ error: 'Could not detect flow', hint: 'Add ?flow=meal or ?flow=pizza' });
        }

        console.log(`${tag} Running ${flow} flow...`);
        const runner = flow === 'pizza' ? runPizzaFlow : runMealFlow;
        const result = await runner(order);

        console.log(`${tag} Done!`, result);
        res.json({ status: 'ok', flow, result });
    } catch (err) {
        console.error(`${tag} Error:`, err.message);
        res.status(500).json({
            error: err.message,
            soocoolError: err.response?.data || null,
        });
    }
});

/**
 * TEST ENDPOINT — Test the order update flow (delivery date change).
 * Usage: GET /test/update-order/12087813833048
 * Optional: ?newDate=2026/03/10&newTime=8:00 AM - 6:00 PM
 *   to override the note_attributes values
 */
app.get('/test/update-order/:orderId', async (req, res) => {
    const { orderId } = req.params;
    const tag = `[testUpdateEndpoint][order:${orderId}]`;

    try {
        const store = require('./db/store');
        const soocool = require('./soocool/client');
        const shopify = require('./shopify/client');
        const { parseDeliveryWindow, buildPizzaPayload, buildMealPayload, groupItemsIntoBoxes } = require('./utils/orderMapper');

        console.log(`${tag} Fetching order from Shopify...`);
        const shopifyClient = axios.create({
            baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
            headers: { 'X-Shopify-Access-Token': config.shopify.accessToken },
        });

        const orderRes = await shopifyClient.get(`/orders/${orderId}.json`);
        const order = orderRes.data.order;
        console.log(`${tag} Order #${order.order_number} found`);

        // Look up existing mapping
        const mapping = store.getMappingByShopifyId(order.id);
        if (!mapping) {
            return res.status(404).json({
                error: 'No SooCool mapping found for this order',
                hint: `First create the order via /test/order/${orderId}`,
            });
        }

        console.log(`${tag} Found SooCool mapping: soocoolOrderId=${mapping.soocool_order_id}, flow=${mapping.flow}, storedDate=${mapping.delivery_date}`);

        // Allow overriding the delivery date/time via query params for testing
        if (req.query.newDate) {
            const dateAttr = order.note_attributes.find(a => a.name === 'Delivery-Date');
            if (dateAttr) dateAttr.value = req.query.newDate;
            else order.note_attributes.push({ name: 'Delivery-Date', value: req.query.newDate });
        }
        if (req.query.newTime) {
            const timeAttr = order.note_attributes.find(a => a.name === 'Delivery-Time');
            if (timeAttr) timeAttr.value = req.query.newTime;
            else order.note_attributes.push({ name: 'Delivery-Time', value: req.query.newTime });
        }

        // Parse delivery window
        const newDeliveryWindow = parseDeliveryWindow(order.note_attributes);
        const newDate = newDeliveryWindow.startTime.split('T')[0];
        const oldDate = mapping.delivery_date;

        console.log(`${tag} Old date: ${oldDate || '(none)'}, New date: ${newDate}`);

        // Build payload based on flow type
        let payload;
        if (mapping.flow === 'meal') {
            const productIds = order.line_items.map(i => i.product_id);
            const tagsMap = await shopify.getProductTags(productIds);
            const boxGroups = groupItemsIntoBoxes(order.line_items, tagsMap);
            payload = buildMealPayload(order, newDeliveryWindow, boxGroups);
        } else {
            payload = buildPizzaPayload(order, newDeliveryWindow);
        }

        console.log(`${tag} Sending update to SooCool order ${mapping.soocool_order_id}...`);
        const updateResult = await soocool.updateOrder(mapping.soocool_order_id, payload);
        console.log(`${tag} ✅ SooCool update successful`);

        // Regenerate PDF with updated delivery date + fresh shipping label
        let pdfPath = null;
        if (mapping.flow === 'meal') {
            const { generateOrderPdf } = require('./utils/pdfGenerator');
            let labelBuffer = null;
            try {
                labelBuffer = await soocool.getShippingLabel(mapping.soocool_order_id);
                console.log(`${tag} Fresh shipping label fetched (${labelBuffer.length} bytes)`);
            } catch (err) {
                console.warn(`${tag} Could not fetch updated shipping label: ${err.message}`);
            }

            const productIds2 = order.line_items.map(i => i.product_id);
            const tagsMap2 = await shopify.getProductTags(productIds2);
            const boxGroups2 = groupItemsIntoBoxes(order.line_items, tagsMap2);

            pdfPath = await generateOrderPdf({ order, deliveryWindow: newDeliveryWindow, labelBuffer, boxGroups: boxGroups2 });
            console.log(`${tag} PDF regenerated: ${pdfPath}`);
            store.updatePdfPath(order.id, pdfPath);
        }

        // Persist new date
        store.updateDeliveryDate(order.id, newDate);

        res.json({
            status: 'ok',
            flow: mapping.flow,
            soocoolOrderId: mapping.soocool_order_id,
            oldDeliveryDate: oldDate,
            newDeliveryDate: newDate,
            pdfPath,
            soocoolResponse: updateResult,
        });
    } catch (err) {
        console.error(`${tag} Error:`, err.message);
        res.status(500).json({
            error: err.message,
            soocoolError: err.response?.data || null,
        });
    }
});

/**
 * DASHBOARD — View recent orders and download PDFs
 */
app.get('/dashboard', (req, res) => {
    const store = require('./db/store');
    const recent = store.getRecentMappings(50);

    let html = `
        <html>
        <head>
            <title>Silvano Orders</title>
            <style>
                body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th, td { text-align: left; padding: 12px; border-bottom: 1px solid #ddd; }
                th { background-color: #f5f5f5; }
                a.btn { display: inline-block; padding: 6px 12px; background: #007bff; color: white; text-decoration: none; border-radius: 4px; font-size: 14px; }
                a.btn:hover { background: #0056b3; }
                .empty { color: #666; font-style: italic; }
            </style>
        </head>
        <body>
            <h1>Silvano Latest Orders</h1>
            <p><strong>Note:</strong> PDFs are only retained between server updates (ephemeral storage).</p>
            <table>
                <thead>
                    <tr>
                        <th>Order</th>
                        <th>Type</th>
                        <th>Date</th>
                        <th>Tracking</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
    `;

    if (recent.length === 0) {
        html += `<tr><td colspan="5" class="empty">No recent orders found.</td></tr>`;
    } else {
        for (const row of recent) {
            const dateStr = new Date(row.created_at).toLocaleString();
            html += `
                <tr>
                    <td><strong>#${row.shopify_order_number}</strong></td>
                    <td>${row.flow.toUpperCase()}</td>
                    <td>${dateStr}</td>
                    <td>
                        ${row.tracking_url ? `<a href="${row.tracking_url}" target="_blank">Track Order</a>` : '<span class="empty">Pending</span>'}
                    </td>
                    <td>
                        ${row.pdf_path ? `<a class="btn" href="/download/order/${row.shopify_order_number}">Download combined PDF</a>
                        <a class="btn" style="background:#28a745; margin-left: 5px;" href="/download/label/${row.shopify_order_number}">Download shipping label</a>` : '<span class="empty">No PDF</span>'}
                    </td>
                </tr>
            `;
        }
    }

    html += `
                </tbody>
            </table>
        </body>
        </html>
    `;

    res.send(html);
});

/**
 * DOWNLOAD — Download the combined PDF for a specific order
 */
app.get('/download/order/:orderNumber', (req, res) => {
    const store = require('./db/store');
    const fs = require('fs');
    const mapping = store.getMappingByOrderNumber(req.params.orderNumber);

    if (!mapping || !mapping.pdf_path) {
        return res.status(404).send('PDF not found for this order.');
    }

    if (!fs.existsSync(mapping.pdf_path)) {
        return res.status(404).send('PDF file no longer exists on the server (it may have been cleared by a server update).');
    }

    res.download(mapping.pdf_path, `Silvano-Order-${mapping.shopify_order_number}.pdf`);
});

/**
 * DOWNLOAD — Download the raw SooCool label for a specific order
 */
app.get('/download/label/:orderNumber', (req, res) => {
    const store = require('./db/store');
    const fs = require('fs');
    const path = require('path');
    const mapping = store.getMappingByOrderNumber(req.params.orderNumber);

    if (!mapping || !mapping.pdf_path) {
        return res.status(404).send('Label not found for this order.');
    }

    // Label path is in the same directory as pdf_path but named 'label-{orderNumber}.pdf'
    const labelPath = path.join(path.dirname(mapping.pdf_path), `label-${mapping.shopify_order_number}.pdf`);

    if (!fs.existsSync(labelPath)) {
        return res.status(404).send('Shipping label file no longer exists on the server (it may have been cleared by a server update, or SooCool did not provide one).');
    }

    res.download(labelPath, `Silvano-Label-${mapping.shopify_order_number}.pdf`);
});

app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Listening on 0.0.0.0:${config.port}`);
});
