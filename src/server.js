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

app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Listening on 0.0.0.0:${config.port}`);
});
