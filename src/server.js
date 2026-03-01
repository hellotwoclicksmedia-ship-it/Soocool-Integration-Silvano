'use strict';
const express = require('express');
const axios = require('axios');
const config = require('./config');
const shopifyWebhook = require('./webhooks/shopifyWebhook');
const shopifyCancelWebhook = require('./webhooks/shopifyCancelWebhook');
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
app.use('/webhooks/soocool', soocoolWebhook);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// TEMPORARY — remove after debugging
app.get('/debug/env', (_req, res) => {
    const token = config.shopify.accessToken || '';
    res.json({
        tokenPrefix: token.substring(0, 8),
        tokenSuffix: token.substring(token.length - 4),
        tokenLength: token.length,
        storeUrl: config.shopify.storeUrl,
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
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
    `;

    if (recent.length === 0) {
        html += `<tr><td colspan="4" class="empty">No recent orders found.</td></tr>`;
    } else {
        for (const row of recent) {
            const dateStr = new Date(row.created_at).toLocaleString();
            html += `
                <tr>
                    <td><strong>#${row.shopify_order_number}</strong></td>
                    <td>${row.flow.toUpperCase()}</td>
                    <td>${dateStr}</td>
                    <td>
                        ${row.pdf_path ? `<a class="btn" href="/download/order/${row.shopify_order_number}">Download PDF</a>` : '<span class="empty">No PDF</span>'}
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
 * DOWNLOAD — Download the PDF for a specific order
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

app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Listening on 0.0.0.0:${config.port}`);
});
